import { readFile } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import { z } from 'zod';
import { ClipAssembler, type ClipArtifact } from './clipping/clipper.js';
import type { ClipSpec } from './clipping/extract.js';
import type { TextLlm } from './clipping/llm.js';
import { ClippingPipeline, type CampaignDetailLike } from './clipping/pipeline.js';
import { ClippingIndex } from './db/index.js';
import { JobRunner, jobSummary, type Job } from './jobs.js';

/** State the console holds per campaign so a page reload keeps what is known. */
export interface CampaignWorkspace {
  campaignId: string;
  title: string | null;
  brief: { sources: unknown[]; coverage: unknown; characters: number; needsBrowser: number; usedBrowser: boolean } | null;
  clipSpec: ClipSpec | null;
  clipSpecWarnings: string[];
  footage: { videos: unknown[]; channels: number; deferred: string[] } | null;
  moments: { videoId: string; candidates: unknown[]; assumptions: unknown[]; warnings: string[] } | null;
  clips: ClipArtifact[];
}

const CLIP_ROOT = resolve(process.cwd(), 'out/clips');

/** True when the path stays inside out/clips. Blocks path traversal from a request. */
export function isInsideClipRoot(candidate: string): boolean {
  const full = resolve(normalize(candidate));
  return full === CLIP_ROOT || full.startsWith(CLIP_ROOT + sep);
}

export const runBodySchema = z.object({
  campaignId: z.string().trim().min(1).max(200),
  refresh: z.boolean().optional(),
  browser: z.boolean().optional(),
  videoId: z.string().trim().min(1).max(64).optional(),
  videoUrl: z.string().trim().max(500).optional(),
  maxClips: z.number().int().min(1).max(20).optional(),
  audioSection: z.object({ start: z.number().min(0), end: z.number().min(0) }).optional(),
  /** Run the render layer: tighten, burn captions, normalize loudness. */
  enhance: z.boolean().optional(),
});

export type RunBody = z.infer<typeof runBodySchema>;

/** One clip as the console draws it, whether it was just cut or read from disk. */
export interface DisplayClip {
  path: string;
  sidecarPath: string | null;
  videoId: string;
  durationSeconds: number | null;
  expectedDurationSeconds: number | null;
  start: number | null;
  end: number | null;
  reason: string | null;
  fromDisk: boolean;
  /** Vertical, captioned render output, when the render layer ran. */
  verticalPath: string | null;
}

export interface ClippingApiDeps {
  pipeline: ClippingPipeline;
  jobs: JobRunner;
  llm: TextLlm | null;
  loadDetail: (campaignId: string) => Promise<CampaignDetailLike>;
  /** Omit to run without the on-disk clip index. */
  index?: ClippingIndex | null;
}

export class ClippingApi {
  private readonly pipeline: ClippingPipeline;
  private readonly jobs: JobRunner;
  private readonly llm: TextLlm | null;
  private readonly loadDetail: (campaignId: string) => Promise<CampaignDetailLike>;
  private readonly index: ClippingIndex | null;
  private readonly workspaces = new Map<string, CampaignWorkspace>();

  constructor(deps: ClippingApiDeps) {
    this.pipeline = deps.pipeline;
    this.jobs = deps.jobs;
    this.llm = deps.llm;
    this.loadDetail = deps.loadDetail;
    this.index = deps.index ?? null;
  }

  /**
   * Clips cut in this session, plus clips already on disk from earlier runs.
   * A clip present in both is listed once; the session copy wins.
   */
  private displayClips(campaignId: string): DisplayClip[] {
    const workspace = this.workspace(campaignId);
    const live: DisplayClip[] = workspace.clips.map(artifact => ({
      path: artifact.result.outputPath,
      sidecarPath: artifact.result.sidecarPath,
      videoId: workspace.moments?.videoId ?? '',
      durationSeconds: artifact.result.actualDurationSeconds,
      expectedDurationSeconds: artifact.result.expectedDurationSeconds,
      start: artifact.snapped.start,
      end: artifact.snapped.end,
      reason: artifact.candidate.reason ?? null,
      fromDisk: false,
      verticalPath: artifact.render?.outputPath ?? null,
    }));
    if (!this.index) return live;
    const seen = new Set(live.map(clip => clip.path));
    let stored: DisplayClip[];
    try {
      stored = this.index.clipsForCampaign(campaignId)
        .filter(row => !seen.has(row.file_path))
        .map(row => ({
          path: row.file_path,
          sidecarPath: row.sidecar_path,
          videoId: row.video_id,
          durationSeconds: row.duration_seconds,
          expectedDurationSeconds: null,
          start: row.source_abs_in,
          end: row.source_abs_out,
          reason: row.moment_reason,
          fromDisk: true,
          verticalPath: null,
        }));
    } catch {
      // The index is a convenience. A read failure must not break the page.
      stored = [];
    }
    return [...live, ...stored];
  }

  workspace(campaignId: string): CampaignWorkspace {
    let workspace = this.workspaces.get(campaignId);
    if (!workspace) {
      workspace = { campaignId, title: null, brief: null, clipSpec: null, clipSpecWarnings: [], footage: null, moments: null, clips: [] };
      this.workspaces.set(campaignId, workspace);
    }
    return workspace;
  }

  /** The workspace plus every job for this campaign. One request fills the whole page. */
  view(campaignId: string): { workspace: CampaignWorkspace; clips: DisplayClip[]; jobs: ReturnType<typeof jobSummary>[]; busy: Record<string, boolean> } {
    const stages = ['brief', 'extract', 'footage', 'moments', 'clips'] as const;
    const busy: Record<string, boolean> = {};
    for (const stage of stages) busy[stage] = this.jobs.isBusy(campaignId, stage);
    return {
      workspace: this.workspace(campaignId),
      clips: this.displayClips(campaignId),
      jobs: this.jobs.list({ campaignId }).map(jobSummary),
      busy,
    };
  }

  job(id: string): Job | null {
    return this.jobs.get(id);
  }

  /** Stops a queued or running job. Returns false when the job already finished. */
  cancel(id: string): boolean {
    return this.jobs.cancel(id);
  }

  /** Reads one clip sidecar. The caller must pass a path taken from a stored artifact. */
  async sidecar(path: string): Promise<unknown> {
    if (!isInsideClipRoot(path)) throw new Error('That path is outside out/clips.');
    return JSON.parse(await readFile(path, 'utf8'));
  }

  private start(stage: Job['stage'], campaignId: string, label: string, body: Parameters<JobRunner['submit']>[0]['body']): Job {
    if (this.jobs.isBusy(campaignId, stage)) throw new Error(`A ${stage} job for this campaign is already running. Wait for it to finish.`);
    return this.jobs.submit({ stage, campaignId, label, body });
  }

  crawlBrief(input: RunBody): Job {
    return this.start('brief', input.campaignId, input.browser ? 'Crawl brief with browser' : 'Crawl brief', async context => {
      const workspace = this.workspace(input.campaignId);
      context.progress('Loading the campaign detail page');
      const detail = await this.loadDetail(input.campaignId);
      workspace.title = detail.title ?? null;
      context.progress(input.browser ? 'Fetching sources, browser tier on' : 'Fetching sources');
      const bundle = await this.pipeline.brief(detail, { refresh: input.refresh, browser: input.browser });
      const sources = bundle.sources as { status?: string; text?: string | null }[];
      const needsBrowser = sources.filter(source => source.status === 'needs_browser').length;
      for (const source of sources) context.log(`${source.status}: ${(source as { url?: string }).url ?? '(no url)'}`);
      workspace.brief = {
        sources: bundle.sources,
        coverage: bundle.coverage,
        characters: bundle.briefText?.length ?? 0,
        needsBrowser,
        usedBrowser: Boolean(input.browser),
      };
      return { characters: workspace.brief.characters, sources: sources.length, needsBrowser, warnings: bundle.warnings };
    });
  }

  extractSpec(input: RunBody): Job {
    return this.start('extract', input.campaignId, 'Extract the clip spec', async context => {
      if (!this.llm) throw new Error('No model is configured. Set WHOP_LLM or install the opencode CLI.');
      const workspace = this.workspace(input.campaignId);
      context.progress('Loading the campaign detail page');
      const detail = await this.loadDetail(input.campaignId);
      context.progress('Crawling the brief');
      const bundle = await this.pipeline.brief(detail, { refresh: input.refresh, browser: input.browser });
      context.progress(`Reading ${bundle.briefText?.length ?? 0} characters with ${this.llm.model ?? this.llm.id}`);
      const { clipSpec, warnings } = await this.pipeline.extract(bundle, detail);
      workspace.clipSpec = clipSpec;
      workspace.clipSpecWarnings = warnings;
      for (const warning of warnings) context.log(warning);
      return { filled: countFilled(clipSpec), warnings: warnings.length };
    });
  }

  resolveFootage(input: RunBody): Job {
    return this.start('footage', input.campaignId, 'Find source videos', async context => {
      const workspace = this.workspace(input.campaignId);
      context.progress('Loading the campaign detail page');
      const detail = await this.loadDetail(input.campaignId);
      context.progress('Crawling the brief');
      const bundle = await this.pipeline.brief(detail, { refresh: false, browser: input.browser });
      context.progress('Listing channel videos with yt-dlp');
      const footage = await this.pipeline.footage(bundle, { resolveVideos: true, videoLimit: 40 });
      for (const note of footage.deferred) context.log(note);
      workspace.footage = { videos: footage.videos, channels: footage.channels.length, deferred: footage.deferred };
      return { videos: footage.videos.length, channels: footage.channels.length, deferred: footage.deferred.length };
    });
  }

  selectMoments(input: RunBody): Job {
    return this.start('moments', input.campaignId, 'Select moments', async context => {
      const workspace = this.workspace(input.campaignId);
      const spec = workspace.clipSpec;
      if (!spec) throw new Error('Extract the clip spec first. Moment selection reads the spec.');
      if (!input.videoId) throw new Error('Choose a video first.');
      const assembler = this.assembler(input.campaignId);
      context.progress('Downloading audio, then transcribing');
      const prepared = await assembler.prepare(
        { id: input.videoId, url: input.videoUrl ?? `https://www.youtube.com/watch?v=${input.videoId}` },
        spec,
        { audioSection: input.audioSection },
      );
      for (const warning of prepared.warnings) context.log(warning);
      workspace.moments = {
        videoId: prepared.videoId,
        candidates: prepared.candidates,
        assumptions: prepared.assumptions,
        warnings: prepared.warnings,
      };
      const words = prepared.transcript.segments.reduce((total, segment) => total + segment.words.length, 0);
      return { candidates: prepared.candidates.length, words, assumptions: prepared.assumptions.length };
    });
  }

  produceClips(input: RunBody): Job {
    return this.start('clips', input.campaignId, 'Cut clips', async context => {
      const workspace = this.workspace(input.campaignId);
      const spec = workspace.clipSpec;
      if (!spec) throw new Error('Extract the clip spec first. Cutting reads the spec.');
      if (!input.videoId) throw new Error('Choose a video first.');
      const assembler = this.assembler(input.campaignId);
      context.progress('Transcribing, selecting moments, then cutting with ffmpeg');
      const result = await assembler.assemble(
        { id: input.videoId, url: input.videoUrl ?? `https://www.youtube.com/watch?v=${input.videoId}` },
        spec,
        { audioSection: input.audioSection, momentLimit: input.maxClips, enhance: input.enhance },
      );
      for (const warning of result.warnings) context.log(warning);
      for (const clip of result.clips) context.log(`cut ${clip.result.actualDurationSeconds.toFixed(2)}s to ${clip.result.outputPath}`);
      const existing = workspace.clips.filter(clip => !result.clips.some(fresh => fresh.result.outputPath === clip.result.outputPath));
      workspace.clips = [...existing, ...result.clips];
      return { clips: result.clips.length, warnings: result.warnings.length };
    });
  }

  private assembler(campaignId: string): ClipAssembler {
    return new ClipAssembler({ campaignId, llm: this.llm });
  }
}

export function countFilled(spec: ClipSpec): number {
  let filled = 0;
  for (const value of Object.values(spec as unknown as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) { if (value.length > 0) filled += 1; continue; }
    if (typeof value === 'object' && 'value' in (value as object)) {
      const inner = (value as { value: unknown }).value;
      if (inner === null || inner === undefined) continue;
      if (Array.isArray(inner) && inner.length === 0) continue;
      filled += 1;
      continue;
    }
  }
  return filled;
}

export const CLIP_MEDIA_ROOT = CLIP_ROOT;
export const clipPathJoin = (...parts: string[]) => join(CLIP_ROOT, ...parts);
