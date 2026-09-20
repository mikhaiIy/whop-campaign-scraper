import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cutClip, type CutResult } from './cut.js';
import type { ClipSpec } from './extract.js';
import type { TextLlm } from './llm.js';
import { MediaCache, type MediaAsset, type SectionRange } from './media.js';
import {
  selectMoments, snapCandidate, specProvenanceFor, transcriptExcerpt, refineHookStart,
  type Assumption, type MomentCandidate, type MomentSelection, type MomentSelectionOptions, type SnapOptions, type SnapResult,
} from './moments.js';
import { collectEmotionSignals, collectSignals, mergeSignals, sourcePotential, type MediaSignals, type SourcePotential } from './signals.js';
import { collectChatSignals } from './chat.js';
import { renderClip, renderOutputPaths, type CaptionOptions, type LoudnessOptions, type PacingOptions, type RenderResult, type TightenOptions } from './render.js';
import { TranscriptionCache, flattenWords, shiftTranscript, transcriptDuration, type Transcript } from './transcribe.js';
import type { ProcessRunner } from './youtube.js';

export interface ClipVideo {
  id: string;
  url?: string | null;
}

export interface PrepareOptions extends MomentSelectionOptions {
  audioSection?: SectionRange;
  transcriptModel?: string;
  refreshAudio?: boolean;
  refreshTranscript?: boolean;
  snap?: SnapOptions;
  /** Download a low-res proxy to derive visual (scene/motion) signals. Default true. */
  visualSignals?: boolean;
  /** Try to download a live-chat replay for chat-velocity signals. Default true. */
  chatSignals?: boolean;
}

export interface PreparedMoments {
  videoId: string;
  sourceUrl: string;
  audio: MediaAsset;
  transcript: Transcript;
  selection: MomentSelection;
  assumptions: Assumption[];
  candidates: { candidate: MomentCandidate; snap: SnapResult; hookRefine: { start: number; moved: boolean; reason: string } }[];
  signals: MediaSignals;
  potential: SourcePotential;
  warnings: string[];
}

export interface AssembleOptions extends PrepareOptions {
  momentLimit?: number;
  paddingSeconds?: number;
  outDir?: string;
  refreshSections?: boolean;
  refreshCuts?: boolean;
  /** When true, run the render layer (tighten, captions, loudness) on each cut. */
  enhance?: boolean;
  captions?: CaptionOptions;
  loudness?: LoudnessOptions;
  tighten?: TightenOptions;
  /** Beat-driven punch-ins; defaults on when enhance is set. */
  pacing?: PacingOptions;
}

export interface ClipArtifact {
  candidate: MomentCandidate;
  snapped: SnapResult;
  fetch: SectionRange;
  result: CutResult;
  render: RenderResult | null;
}

export interface AssembleResult {
  campaignId: string;
  videoId: string;
  sourceUrl: string;
  audio: { path: string; durationSeconds: number; fromCache: boolean; section: SectionRange | null };
  transcript: { model: string; language: string | null; segments: number; words: number; offsetSeconds: number; durationSeconds: number };
  selection: { candidates: number; windows: number; model: MomentSelection['model']; assumptions: Assumption[]; potential: SourcePotential };
  clips: ClipArtifact[];
  warnings: string[];
}

export interface ClipAssemblerDeps {
  campaignId: string;
  llm: TextLlm | null;
  media?: MediaCache;
  transcriber?: TranscriptionCache;
  runner?: ProcessRunner;
  ffmpegCommand?: string;
  probeCommand?: string;
  durationToleranceSeconds?: number;
  now?: () => number;
}

const rangeKey = (range: SectionRange): string => `${range.start.toFixed(3)}-${range.end.toFixed(3)}`;

export function mergeRanges(ranges: SectionRange[], gapSeconds = 1): SectionRange[] {
  if (!ranges.length) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: SectionRange[] = [{ ...sorted[0] }];
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.start <= last.end + gapSeconds) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export class ClipAssembler {
  private readonly campaignId: string;
  private readonly llm: TextLlm | null;
  private readonly media: MediaCache;
  private readonly transcriber: TranscriptionCache;
  private readonly runner: ProcessRunner | undefined;
  private readonly ffmpegCommand: string | undefined;
  private readonly probeCommand: string | undefined;
  private readonly durationToleranceSeconds: number | undefined;
  private readonly now: (() => number) | undefined;

  constructor(deps: ClipAssemblerDeps) {
    this.campaignId = deps.campaignId;
    this.llm = deps.llm;
    this.media = deps.media ?? new MediaCache();
    this.transcriber = deps.transcriber ?? new TranscriptionCache();
    this.runner = deps.runner;
    this.ffmpegCommand = deps.ffmpegCommand;
    this.probeCommand = deps.probeCommand;
    this.durationToleranceSeconds = deps.durationToleranceSeconds;
    this.now = deps.now;
  }

  async prepare(video: ClipVideo, spec: ClipSpec, options: PrepareOptions = {}): Promise<PreparedMoments> {
    if (!this.llm) throw new Error('Moment selection requires an LLM (TextLlm); none is configured.');
    const sourceUrl = video.url?.trim() || `https://www.youtube.com/watch?v=${video.id}`;
    const audio = await this.media.ingestAudio(video, { section: options.audioSection, refresh: options.refreshAudio });
    const raw = await this.transcriber.transcribe(audio, { refresh: options.refreshTranscript, model: options.transcriptModel });
    const transcript = shiftTranscript(raw, audio.section?.start ?? 0);
    const warnings: string[] = [];

    const audioSignals = await collectSignals(audio.path, { runner: this.runner, ffmpegCommand: this.ffmpegCommand });
    let signals = audioSignals;
    if (options.visualSignals !== false && !options.audioSection) {
      try {
        const proxy = await this.media.ingestProxy(video, { refresh: options.refreshAudio });
        const videoSignals = await collectSignals(proxy.path, { runner: this.runner, ffmpegCommand: this.ffmpegCommand }, { motion: true });
        const emotion = await collectEmotionSignals(proxy.path, { runner: this.runner, ffmpegCommand: this.ffmpegCommand });
        signals = mergeSignals(audioSignals, videoSignals, [], emotion);
        if (emotion.peaks.length) warnings.push(`Facial-expression model found ${emotion.peaks.length} expression peak(s).`);
      } catch (error) {
        warnings.push(`Visual signals unavailable (${error instanceof Error ? error.message : String(error)}); using audio only.`);
      }
    }
    if (options.chatSignals !== false) {
      const chatSpikes = await collectChatSignals(sourceUrl, { runner: this.runner });
      if (chatSpikes.length) {
        signals = mergeSignals(signals, null, chatSpikes);
        warnings.push(`Chat velocity found ${chatSpikes.length} spike window(s).`);
      }
    }

    const selection = await selectMoments(this.llm, transcript, spec, { ...options, signals });
    const candidates = selection.candidates.map(candidate => {
      const snap = snapCandidate(candidate, transcript, options.snap);
      const hookRefine = refineHookStart({ ...candidate, start: snap.start }, transcript, signals);
      const refinedSnap = hookRefine.moved ? snapCandidate({ start: hookRefine.start, end: snap.end }, transcript, options.snap) : snap;
      return { candidate, snap: refinedSnap, hookRefine };
    });
    warnings.push(...selection.warnings);
    const potential = sourcePotential(signals);
    if (potential.level === 'low') warnings.push(`Source looks flat (${potential.reason}); clips from it are unlikely to feel energetic.`);
    for (const item of candidates) {
      warnings.push(...item.snap.warnings.map(warning => `candidate ${item.candidate.start.toFixed(1)}s: ${warning}`));
      if (item.hookRefine.moved) warnings.push(`candidate ${item.candidate.start.toFixed(1)}s: ${item.hookRefine.reason}.`);
    }
    return { videoId: video.id, sourceUrl, audio, transcript, selection, assumptions: selection.assumptions, candidates, signals, potential, warnings };
  }

  async assemble(video: ClipVideo, spec: ClipSpec, options: AssembleOptions = {}): Promise<AssembleResult> {
    const prepared = await this.prepare(video, spec, options);
    const warnings = [...prepared.warnings];
    const duration = transcriptDuration(prepared.transcript);
    const padding = options.paddingSeconds ?? 3;
    const chosen = prepared.candidates.slice(0, options.momentLimit ?? 3);
    const fetchRanges = mergeRanges(chosen.map(item => ({ start: Math.max(0, item.snap.start - padding), end: Math.min(duration, item.snap.end + padding) })), 1);
    const outDir = options.outDir ?? join(process.cwd(), 'out/clips', this.campaignId, video.id);
    await mkdir(outDir, { recursive: true });

    const sections = new Map<string, MediaAsset>();
    for (const range of fetchRanges) {
      try {
        sections.set(rangeKey(range), await this.media.ingestSection(video, range, { refresh: options.refreshSections }));
      } catch (error) {
        warnings.push(`Section fetch ${range.start.toFixed(1)}-${range.end.toFixed(1)}s failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const clips: ClipArtifact[] = [];
    for (const item of chosen) {
      const range = fetchRanges.find(candidate => item.snap.start >= candidate.start - 1e-6 && item.snap.end <= candidate.end + 1e-6);
      if (!range) { warnings.push(`No fetch range covered candidate ${item.snap.start.toFixed(1)}-${item.snap.end.toFixed(1)}s; skipped.`); continue; }
      const asset = sections.get(rangeKey(range));
      if (!asset) { warnings.push(`Section asset missing for ${range.start.toFixed(1)}-${range.end.toFixed(1)}s; candidate skipped.`); continue; }
      const fileIn = item.snap.start - range.start;
      const clipDuration = item.snap.end - item.snap.start;
      if (asset.probe.durationSeconds > 0 && fileIn + clipDuration > asset.probe.durationSeconds + 0.2) {
        warnings.push(`Candidate at ${item.snap.start.toFixed(1)}s extends past the fetched section; the cut may be short.`);
      }
      const base = `${item.snap.start.toFixed(2)}-${item.snap.end.toFixed(2)}`;
      try {
        const result = await cutClip({
          campaignId: this.campaignId,
          videoId: video.id,
          sourceUrl: prepared.sourceUrl,
          section: options.audioSection ? `${options.audioSection.start}-${options.audioSection.end}` : null,
          fetch: range,
          mediaPath: asset.path,
          outputPath: join(outDir, `${base}.mp4`),
          sidecarPath: join(outDir, `${base}.json`),
          inSeconds: fileIn,
          durationSeconds: clipDuration,
          transcriptExcerpt: transcriptExcerpt(prepared.transcript, item.snap.start, item.snap.end),
          specRulesChecked: item.candidate.rulesChecked,
          specProvenance: specProvenanceFor(spec, item.candidate.rulesChecked),
          moment: item.candidate,
          snapping: item.snap,
          assumptions: prepared.assumptions,
          transcript: { model: prepared.transcript.model, language: prepared.transcript.language, offsetSeconds: prepared.transcript.offsetSeconds },
        }, { runner: this.runner, ffmpegCommand: this.ffmpegCommand, probeCommand: this.probeCommand, durationToleranceSeconds: this.durationToleranceSeconds, refresh: options.refreshCuts, now: this.now });
        let render: RenderResult | null = null;
        if (options.enhance) {
          const paths = renderOutputPaths(outDir, base);
          try {
            render = await renderClip({
              campaignId: this.campaignId,
              videoId: video.id,
              inputPath: result.outputPath,
              outputPath: paths.outputPath,
              sidecarPath: paths.sidecarPath,
              assPath: paths.assPath,
              transcript: prepared.transcript,
              clipStart: item.snap.start,
              clipEnd: item.snap.end,
              captions: options.captions,
              loudness: options.loudness,
              tighten: options.tighten,
              pacing: options.pacing ?? { enabled: true },
              coldOpen: item.candidate.signalPeakSeconds !== null && item.candidate.signalPeakSeconds !== undefined
                ? { enabled: true, startSeconds: Math.max(0, item.candidate.signalPeakSeconds - item.snap.start), durationSeconds: 0.8 }
                : undefined,
            }, { runner: this.runner, ffmpegCommand: this.ffmpegCommand, probeCommand: this.probeCommand, durationToleranceSeconds: this.durationToleranceSeconds, refresh: options.refreshCuts, now: this.now });
            warnings.push(...render.stages.captions.warnings.map(warning => `render ${base}: ${warning}`));
            if (render.stages.tighten.warning) warnings.push(`render ${base}: ${render.stages.tighten.warning}`);
          } catch (error) {
            warnings.push(`Vertical render failed for ${base}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        clips.push({ candidate: item.candidate, snapped: item.snap, fetch: range, result, render });
      } catch (error) {
        warnings.push(`Cut ${base} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!clips.length) warnings.push(`No clip-worthy moments survived selection for ${video.id}; source potential is ${prepared.potential.level}.`);
    return {
      campaignId: this.campaignId,
      videoId: video.id,
      sourceUrl: prepared.sourceUrl,
      audio: { path: prepared.audio.path, durationSeconds: prepared.audio.probe.durationSeconds, fromCache: prepared.audio.fromCache, section: prepared.audio.section },
      transcript: { model: prepared.transcript.model, language: prepared.transcript.language, segments: prepared.transcript.segments.length, words: flattenWords(prepared.transcript).length, offsetSeconds: prepared.transcript.offsetSeconds, durationSeconds: duration },
      selection: { candidates: prepared.candidates.length, windows: prepared.selection.windows, model: prepared.selection.model, assumptions: prepared.assumptions, potential: prepared.potential },
      clips,
      warnings,
    };
  }
}
