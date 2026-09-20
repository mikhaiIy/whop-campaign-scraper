import { defaultProcessRunner, type ProcessRunner } from './youtube.js';

/**
 * Tier-0 audiovisual signals for highlight detection. These are cheap, fully
 * local, and independent of the transcript: a loudness envelope (emotional
 * bursts, laughter, shouting) and scene-cut density (visual action). All
 * parsers are pure so they can be tested without running ffmpeg.
 */

export interface TimeRange {
  start: number;
  end: number;
}

export interface LoudnessSample {
  t: number;
  m: number;
}

export interface MediaSignals {
  durationSeconds: number;
  loudness: LoudnessSample[];
  loudPeaks: TimeRange[];
  sceneCuts: number[];
  cutDense: TimeRange[];
  medianLoudness: number;
  dynamicRangeDb: number;
}

export interface SignalDeps {
  runner?: ProcessRunner;
  ffmpegCommand?: string;
  timeoutMs?: number;
}

export interface PeakOptions {
  /** dB above the median that counts as an emotional burst. */
  riseDb?: number;
  minDurSec?: number;
  mergeGapSec?: number;
}

export interface DensityOptions {
  windowSeconds?: number;
  minCuts?: number;
  mergeGapSec?: number;
}

export const EMPTY_SIGNALS: MediaSignals = {
  durationSeconds: 0,
  loudness: [],
  loudPeaks: [],
  sceneCuts: [],
  cutDense: [],
  medianLoudness: -70,
  dynamicRangeDb: 0,
};

const SILENCE_FLOOR_DB = -70;

export function parseEbur128(stderr: string): LoudnessSample[] {
  const samples: LoudnessSample[] = [];
  const pattern = /t:\s*([\d.]+)\s+.*?M:\s*(-?[\d.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stderr))) {
    const t = Number(match[1]);
    const m = Number(match[2]);
    if (Number.isFinite(t) && Number.isFinite(m)) samples.push({ t, m });
  }
  return samples;
}

export function parseSceneChanges(stderr: string): number[] {
  const times: number[] = [];
  const pattern = /pts_time:\s*([\d.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stderr))) {
    const t = Number(match[1]);
    if (Number.isFinite(t)) times.push(t);
  }
  return [...new Set(times)].sort((a, b) => a - b);
}

/** Sustained loudness bursts above the programme median. */
export function loudnessPeaks(samples: LoudnessSample[], options: PeakOptions = {}): TimeRange[] {
  const riseDb = options.riseDb ?? 4;
  const minDurSec = options.minDurSec ?? 1.2;
  const mergeGapSec = options.mergeGapSec ?? 2;
  const usable = samples.filter(sample => sample.m > SILENCE_FLOOR_DB);
  if (usable.length < 10) return [];
  const sorted = usable.map(sample => sample.m).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = median + riseDb;
  const ranges: TimeRange[] = [];
  let current: TimeRange | null = null;
  for (const sample of usable) {
    if (sample.m >= threshold) {
      if (current && sample.t - current.end <= mergeGapSec) current.end = sample.t;
      else {
        if (current) ranges.push(current);
        current = { start: sample.t, end: sample.t };
      }
    }
  }
  if (current) ranges.push(current);
  return ranges.filter(range => range.end - range.start >= minDurSec);
}

/** Windows with dense scene cuts (fast visual pace). */
export function cutDensity(times: number[], options: DensityOptions = {}): TimeRange[] {
  const windowSeconds = options.windowSeconds ?? 6;
  const minCuts = options.minCuts ?? 4;
  if (times.length < minCuts) return [];
  const sorted = [...times].sort((a, b) => a - b);
  const clusters: number[][] = [];
  let current: number[] = [];
  for (const t of sorted) {
    if (current.length && t - current[current.length - 1] <= windowSeconds) current.push(t);
    else {
      if (current.length) clusters.push(current);
      current = [t];
    }
  }
  if (current.length) clusters.push(current);
  return clusters.filter(cluster => cluster.length >= minCuts).map(cluster => ({ start: cluster[0], end: cluster[cluster.length - 1] }));
}

export function summarize(samples: LoudnessSample[]): { medianLoudness: number; dynamicRangeDb: number } {
  const usable = samples.filter(sample => sample.m > SILENCE_FLOOR_DB).map(sample => sample.m);
  if (usable.length < 10) return { medianLoudness: SILENCE_FLOOR_DB, dynamicRangeDb: 0 };
  const sorted = [...usable].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const high = sorted[Math.floor(sorted.length * 0.95)];
  return { medianLoudness: median, dynamicRangeDb: Number((high - median).toFixed(2)) };
}

/** Mean momentary loudness inside a range; null when there are no samples. */
export function energyAt(signals: MediaSignals, start: number, end: number): number | null {
  const inside = signals.loudness.filter(sample => sample.t >= start - 1e-6 && sample.t <= end + 1e-6 && sample.m > SILENCE_FLOOR_DB);
  if (!inside.length) return null;
  return inside.reduce((sum, sample) => sum + sample.m, 0) / inside.length;
}

/** Timestamp of the loudest sample inside a range; null when there are none. */
export function peakTimeWithin(signals: MediaSignals, start: number, end: number): number | null {
  let best: LoudnessSample | null = null;
  for (const sample of signals.loudness) {
    if (sample.t < start - 1e-6 || sample.t > end + 1e-6 || sample.m <= SILENCE_FLOOR_DB) continue;
    if (!best || sample.m > best.m) best = sample;
  }
  return best ? best.t : null;
}

export interface SourcePotential {
  level: 'high' | 'medium' | 'low';
  dynamicRangeDb: number;
  peakSeconds: TimeRange[];
  reason: string;
}

/**
 * Decide whether a source contains any hype at all. A flat mix (narrow dynamic
 * range, no loud windows) cannot produce a lively clip no matter how it is cut.
 */
export function sourcePotential(signals: MediaSignals): SourcePotential {
  const range = signals.dynamicRangeDb;
  const peaks = signals.loudPeaks;
  if (range >= 10 && peaks.length >= 2) {
    return { level: 'high', dynamicRangeDb: range, peakSeconds: peaks, reason: `dynamic range ${range.toFixed(1)} dB with ${peaks.length} loud window(s)` };
  }
  if (range >= 6 || peaks.length >= 1) {
    return { level: 'medium', dynamicRangeDb: range, peakSeconds: peaks, reason: `dynamic range ${range.toFixed(1)} dB with ${peaks.length} loud window(s)` };
  }
  return { level: 'low', dynamicRangeDb: range, peakSeconds: peaks, reason: `flat mix: dynamic range only ${range.toFixed(1)} dB and no loud windows` };
}

/**
 * Collect loudness and scene signals. Fail-open: any probe error yields empty
 * signals so detection never dies because a source has no audio/video stream.
 */
export async function collectSignals(inputPath: string, deps: SignalDeps = {}): Promise<MediaSignals> {
  const runner = deps.runner ?? defaultProcessRunner;
  const ffmpeg = deps.ffmpegCommand ?? 'ffmpeg';
  const timeoutMs = deps.timeoutMs ?? 600_000;
  const run = async (args: string[]): Promise<string> => {
    try {
      const result = await runner(ffmpeg, args, timeoutMs);
      return `${result.stderr}\n${result.stdout}`;
    } catch {
      return '';
    }
  };
  const [loudErr, sceneErr] = await Promise.all([
    run(['-hide_banner', '-nostdin', '-i', inputPath, '-vn', '-af', 'ebur128', '-f', 'null', '-']),
    run(['-hide_banner', '-nostdin', '-i', inputPath, '-an', '-vf', "fps=4,scale=160:-2,select='gt(scene,0.3)',showinfo", '-f', 'null', '-']),
  ]);
  const loudness = parseEbur128(loudErr);
  const sceneCuts = parseSceneChanges(sceneErr);
  const { medianLoudness, dynamicRangeDb } = summarize(loudness);
  const durationSeconds = loudness.length ? loudness[loudness.length - 1].t : (sceneCuts.length ? sceneCuts[sceneCuts.length - 1] : 0);
  return {
    durationSeconds,
    loudness,
    loudPeaks: loudnessPeaks(loudness),
    sceneCuts,
    cutDense: cutDensity(sceneCuts),
    medianLoudness,
    dynamicRangeDb,
  };
}

/** Top energy windows, used to anchor the model to real peaks instead of prose. */
export function topEnergyWindows(signals: MediaSignals, options: { windowSeconds?: number; count?: number } = {}): Array<TimeRange & { meanDb: number }> {
  const windowSeconds = options.windowSeconds ?? 8;
  const count = options.count ?? 8;
  const usable = signals.loudness.filter(sample => sample.m > SILENCE_FLOOR_DB);
  if (usable.length < 20) return [];
  const duration = usable[usable.length - 1].t;
  const scored: Array<TimeRange & { meanDb: number }> = [];
  for (let start = 0; start + windowSeconds <= duration; start += windowSeconds / 2) {
    const inside = usable.filter(sample => sample.t >= start && sample.t < start + windowSeconds);
    if (inside.length < windowSeconds * 4) continue;
    const meanDb = inside.reduce((sum, sample) => sum + sample.m, 0) / inside.length;
    scored.push({ start, end: start + windowSeconds, meanDb });
  }
  scored.sort((a, b) => b.meanDb - a.meanDb);
  const chosen: Array<TimeRange & { meanDb: number }> = [];
  for (const window of scored) {
    if (chosen.every(existing => Math.abs(existing.start - window.start) >= windowSeconds)) chosen.push(window);
    if (chosen.length >= count) break;
  }
  return chosen.sort((a, b) => a.start - b.start);
}
