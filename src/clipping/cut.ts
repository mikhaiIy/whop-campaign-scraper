import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Provenance } from './extract.js';
import { probeMedia, type MediaProbe, type SectionRange } from './media.js';
import type { Assumption, MomentCandidate, SnapResult, TranscriptExcerpt } from './moments.js';
import { defaultProcessRunner, type ProcessRunner } from './youtube.js';

export interface ClipSidecar {
  campaignId: string;
  videoId: string;
  sourceUrl: string;
  section: string | null;
  fetch: SectionRange;
  timecodes: {
    sourceAbsolute: { in: number; out: number };
    fileRelative: { in: number; out: number };
  };
  durationSeconds: number;
  transcriptExcerpt: TranscriptExcerpt;
  specRulesChecked: string[];
  specProvenance: Record<string, Provenance[]>;
  moment: MomentCandidate;
  snapping: Omit<SnapResult, 'warnings'> & { warnings: string[] };
  assumptions: Assumption[];
  transcript: { model: string | null; language: string | null; offsetSeconds: number };
  cut: { reencode: true; ffmpegArgs: string[]; outputProbe: MediaProbe };
  createdAt: string;
}

export interface CutRequest {
  campaignId: string;
  videoId: string;
  sourceUrl: string;
  section: string | null;
  fetch: SectionRange;
  mediaPath: string;
  outputPath: string;
  sidecarPath: string;
  inSeconds: number;
  durationSeconds: number;
  transcriptExcerpt: TranscriptExcerpt;
  specRulesChecked: string[];
  specProvenance: Record<string, Provenance[]>;
  moment: MomentCandidate;
  snapping: SnapResult;
  assumptions: Assumption[];
  transcript: { model: string | null; language: string | null; offsetSeconds: number };
}

export interface CutDeps {
  runner?: ProcessRunner;
  ffmpegCommand?: string;
  probeCommand?: string;
  timeoutMs?: number;
  durationToleranceSeconds?: number;
  refresh?: boolean;
  now?: () => number;
}

export interface CutResult {
  outputPath: string;
  sidecarPath: string;
  probe: MediaProbe;
  expectedDurationSeconds: number;
  actualDurationSeconds: number;
  fromCache: boolean;
}

const fmt = (value: number): string => value.toFixed(3);

export function buildCutArgs(mediaPath: string, outputPath: string, inSeconds: number, durationSeconds: number): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-ss', fmt(inSeconds), '-i', mediaPath, '-t', fmt(durationSeconds),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', '-y', outputPath,
  ];
}

function buildSidecar(request: CutRequest, outputProbe: MediaProbe, ffmpegArgs: string[], now: () => number): ClipSidecar {
  return {
    campaignId: request.campaignId,
    videoId: request.videoId,
    sourceUrl: request.sourceUrl,
    section: request.section,
    fetch: request.fetch,
    timecodes: {
      sourceAbsolute: { in: request.snapping.start, out: request.snapping.end },
      fileRelative: { in: request.inSeconds, out: request.inSeconds + request.durationSeconds },
    },
    durationSeconds: request.durationSeconds,
    transcriptExcerpt: request.transcriptExcerpt,
    specRulesChecked: request.specRulesChecked,
    specProvenance: request.specProvenance,
    moment: request.moment,
    snapping: request.snapping,
    assumptions: request.assumptions,
    transcript: request.transcript,
    cut: { reencode: true, ffmpegArgs, outputProbe },
    createdAt: new Date(now()).toISOString(),
  };
}

export async function cutClip(request: CutRequest, deps: CutDeps = {}): Promise<CutResult> {
  const runner = deps.runner ?? defaultProcessRunner;
  const ffmpeg = deps.ffmpegCommand ?? 'ffmpeg';
  const probeCommand = deps.probeCommand ?? 'ffprobe';
  const timeoutMs = deps.timeoutMs ?? 300_000;
  const tolerance = deps.durationToleranceSeconds ?? 0.2;
  const now = deps.now ?? Date.now;
  await mkdir(dirname(request.outputPath), { recursive: true });

  if (!deps.refresh && (await stat(request.outputPath).catch(() => null))) {
    try {
      const probe = await probeMedia(request.outputPath, { command: probeCommand, runner, timeoutMs: 60_000 });
      if (probe.durationSeconds > 0 && Math.abs(probe.durationSeconds - request.durationSeconds) <= tolerance) {
        await writeFile(request.sidecarPath, JSON.stringify(buildSidecar(request, probe, [], now), null, 2), 'utf8');
        return { outputPath: request.outputPath, sidecarPath: request.sidecarPath, probe, expectedDurationSeconds: request.durationSeconds, actualDurationSeconds: probe.durationSeconds, fromCache: true };
      }
    } catch { /* unreadable output; fall through and re-cut */ }
  }

  const args = buildCutArgs(request.mediaPath, request.outputPath, request.inSeconds, request.durationSeconds);
  const result = await runner(ffmpeg, args, timeoutMs);
  if (result.code !== 0) {
    throw new Error(`ffmpeg failed (exit ${result.code}): ${result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500) || 'no stderr'}`);
  }
  const probe = await probeMedia(request.outputPath, { command: probeCommand, runner, timeoutMs: 60_000 });
  if (!(probe.durationSeconds > 0)) {
    throw new Error(`ffmpeg produced a zero-length clip at ${request.outputPath} (ffprobe duration ${probe.durationSeconds}).`);
  }
  const delta = Math.abs(probe.durationSeconds - request.durationSeconds);
  if (delta > tolerance) {
    throw new Error(`Cut duration mismatch: requested ${request.durationSeconds.toFixed(3)}s, ffprobe reports ${probe.durationSeconds.toFixed(3)}s (delta ${delta.toFixed(3)}s > ${tolerance}s). ${request.outputPath} is not trustworthy.`);
  }
  await writeFile(request.sidecarPath, JSON.stringify(buildSidecar(request, probe, args, now), null, 2), 'utf8');
  return { outputPath: request.outputPath, sidecarPath: request.sidecarPath, probe, expectedDurationSeconds: request.durationSeconds, actualDurationSeconds: probe.durationSeconds, fromCache: false };
}
