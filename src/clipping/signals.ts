import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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

export interface MotionSample {
  t: number;
  motion: number;
}

export interface EmotionSample {
  t: number;
  emotion: string | null;
  confidence: number;
}

export interface MediaSignals {
  durationSeconds: number;
  loudness: LoudnessSample[];
  loudPeaks: TimeRange[];
  sceneCuts: number[];
  cutDense: TimeRange[];
  /** Frame-difference energy (visual activity), when a video source was probed. */
  motion: MotionSample[];
  visualPeaks: TimeRange[];
  /** Facial-expression samples and their peaks, when the FER model was available. */
  emotion: EmotionSample[];
  emotionPeaks: TimeRange[];
  /** Chat-velocity spikes, when a live-chat replay was available. */
  chatSpikes: TimeRange[];
  medianLoudness: number;
  dynamicRangeDb: number;
}

export interface SignalDeps {
  runner?: ProcessRunner;
  ffmpegCommand?: string;
  timeoutMs?: number;
  pythonPath?: string;
  emotionScript?: string;
  emotionModelPath?: string;
  emotionModelUrl?: string;
  emotionSamples?: number;
  emotionEverySeconds?: number;
  emotionTimeoutMs?: number;
}

export const DEFAULT_EMOTION_MODEL_URL = 'https://github.com/onnx/models/raw/main/validated/vision/body_analysis/emotion_ferplus/model/emotion-ferplus-8.onnx';

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
  motion: [],
  visualPeaks: [],
  emotion: [],
  emotionPeaks: [],
  chatSpikes: [],
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

/** Parse `metadata=print:key=lavfi.signalstats.YAVG` output (frame-difference energy). */
export function parseMotion(text: string): MotionSample[] {
  const samples: MotionSample[] = [];
  let pendingTime: number | null = null;
  for (const line of text.split('\n')) {
    const timeMatch = line.match(/pts_time:\s*([\d.]+)/);
    if (timeMatch) { pendingTime = Number(timeMatch[1]); continue; }
    const valueMatch = line.match(/YAVG=([\d.]+)/);
    if (valueMatch && pendingTime !== null) {
      samples.push({ t: pendingTime, motion: Number(valueMatch[1]) });
      pendingTime = null;
    }
  }
  return samples;
}

/** Visual-activity peaks: frame-difference energy well above the clip's own baseline. */
export function motionPeaks(samples: MotionSample[], options: PeakOptions = {}): TimeRange[] {
  const minDurSec = options.minDurSec ?? 1;
  const mergeGapSec = options.mergeGapSec ?? 2;
  if (samples.length < 10) return [];
  const values = samples.map(sample => sample.motion).sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  const max = values[values.length - 1];
  if (max - median < 0.5) return [];
  const threshold = median + 0.4 * (max - median);
  const ranges: TimeRange[] = [];
  let current: TimeRange | null = null;
  for (const sample of samples) {
    if (sample.motion >= threshold) {
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

/**
 * Energy onsets: local loudness maxima well above the programme median,
 * spaced at least `minGapSec` apart. Unlike `loudnessPeaks`, this fires on a
 * brief emphasis spike, which is what a punch-in should land on.
 */
export function loudnessOnsets(samples: LoudnessSample[], options: { riseDb?: number; minGapSec?: number } = {}): number[] {
  const riseDb = options.riseDb ?? 3;
  const minGapSec = options.minGapSec ?? 1.5;
  const usable = samples.filter(sample => sample.m > SILENCE_FLOOR_DB).sort((a, b) => a.t - b.t);
  if (usable.length < 5) return [];
  const sorted = usable.map(sample => sample.m).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = median + riseDb;
  const onsets: number[] = [];
  for (let index = 1; index < usable.length - 1; index++) {
    const current = usable[index];
    if (current.m < threshold) continue;
    if (current.m < usable[index - 1].m || current.m <= usable[index + 1].m) continue;
    if (onsets.length && current.t - onsets[onsets.length - 1] < minGapSec) continue;
    onsets.push(current.t);
  }
  return onsets;
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
  const extra = (signals.visualPeaks?.length ?? 0) + (signals.emotionPeaks?.length ?? 0) + (signals.chatSpikes?.length ?? 0);
  if ((range >= 10 && peaks.length >= 2) || extra >= 6) {
    return { level: 'high', dynamicRangeDb: range, peakSeconds: peaks, reason: `dynamic range ${range.toFixed(1)} dB, ${peaks.length} loud and ${extra} visual/chat window(s)` };
  }
  if (range >= 6 || peaks.length >= 1 || extra >= 2) {
    return { level: 'medium', dynamicRangeDb: range, peakSeconds: peaks, reason: `dynamic range ${range.toFixed(1)} dB, ${peaks.length} loud and ${extra} visual/chat window(s)` };
  }
  return { level: 'low', dynamicRangeDb: range, peakSeconds: peaks, reason: `flat mix: dynamic range only ${range.toFixed(1)} dB and no loud, visual or chat windows` };
}

/**
 * Collect loudness (and, for video inputs, scene + motion) signals. Fail-open:
 * any probe error yields empty signals so detection never dies because a source
 * has no audio/video stream.
 */
export async function collectSignals(inputPath: string, deps: SignalDeps = {}, options: { motion?: boolean } = {}): Promise<MediaSignals> {
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
  const probes: Array<Promise<string>> = [
    run(['-hide_banner', '-nostdin', '-i', inputPath, '-vn', '-af', 'ebur128', '-f', 'null', '-']),
    run(['-hide_banner', '-nostdin', '-i', inputPath, '-an', '-vf', "fps=4,scale=160:-2,select='gt(scene,0.3)',showinfo", '-f', 'null', '-']),
  ];
  if (options.motion) {
    probes.push(run(['-hide_banner', '-nostdin', '-i', inputPath, '-an', '-vf', 'fps=4,scale=160:-2,tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-']));
  }
  const [loudErr, sceneErr, motionErr] = await Promise.all(probes);
  const loudness = parseEbur128(loudErr);
  const sceneCuts = parseSceneChanges(sceneErr);
  const motion = options.motion ? parseMotion(motionErr ?? '') : [];
  const { medianLoudness, dynamicRangeDb } = summarize(loudness);
  const durationSeconds = loudness.length ? loudness[loudness.length - 1].t : (sceneCuts.length ? sceneCuts[sceneCuts.length - 1] : 0);
  return {
    durationSeconds,
    loudness,
    loudPeaks: loudnessPeaks(loudness),
    sceneCuts,
    cutDense: cutDensity(sceneCuts),
    motion,
    visualPeaks: motionPeaks(motion),
    emotion: [],
    emotionPeaks: [],
    chatSpikes: [],
    medianLoudness,
    dynamicRangeDb,
  };
}

/** Parse the JSON emitted by tools/emotion.py. */
export function parseEmotionOutput(stdout: string): { samples: EmotionSample[]; frames: number } | null {
  const match = stdout.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { samples?: unknown; frames?: unknown };
    const list = Array.isArray(parsed.samples) ? parsed.samples : [];
    const samples: EmotionSample[] = [];
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const t = Number(record.t);
      if (!Number.isFinite(t)) continue;
      const emotion = typeof record.emotion === 'string' ? record.emotion : null;
      const confidence = Number(record.confidence);
      samples.push({ t, emotion, confidence: Number.isFinite(confidence) ? confidence : 0 });
    }
    return { samples, frames: typeof parsed.frames === 'number' ? parsed.frames : samples.length };
  } catch {
    return null;
  }
}

/** Runs of strong non-neutral expressions, as time ranges. */
export function emotionPeaks(samples: EmotionSample[], options: { minConfidence?: number; minDurSec?: number; mergeGapSec?: number } = {}): TimeRange[] {
  const minConfidence = options.minConfidence ?? 0.6;
  const minDurSec = options.minDurSec ?? 1;
  const mergeGapSec = options.mergeGapSec ?? 4;
  const strong = samples.filter(sample => sample.emotion && sample.emotion !== 'neutral' && sample.confidence >= minConfidence);
  if (strong.length < 2) return [];
  const times = samples.map(sample => sample.t).sort((a, b) => a - b);
  const spacing = times.length > 1 ? (times[times.length - 1] - times[0]) / (times.length - 1) : 1;
  const half = Math.max(0.5, spacing / 2);
  const ranges = strong.map(sample => ({ start: Math.max(0, sample.t - half), end: sample.t + half })).sort((a, b) => a.start - b.start);
  const merged: TimeRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + mergeGapSec) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged.filter(range => range.end - range.start >= minDurSec);
}

async function ensureFile(url: string, path: string): Promise<boolean> {
  if (await stat(path).catch(() => null)) return true;
  try {
    await mkdir(dirname(path), { recursive: true });
    const response = await fetch(url);
    if (!response.ok) return false;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1_000_000) return false;
    await writeFile(path, buffer);
    return true;
  } catch {
    return false;
  }
}

/** Sample facial expressions with the FER+ ONNX model; fail-open to empty. */
export async function collectEmotionSignals(videoPath: string, deps: SignalDeps = {}): Promise<{ samples: EmotionSample[]; peaks: TimeRange[] }> {
  const runner = deps.runner ?? defaultProcessRunner;
  const python = deps.pythonPath ?? join(process.cwd(), '.venv/bin/python');
  const script = deps.emotionScript ?? join(process.cwd(), 'tools/emotion.py');
  const model = deps.emotionModelPath ?? join(process.cwd(), '.cache/clipping/models/emotion-ferplus-8.onnx');
  if (!(await stat(python).catch(() => null)) || !(await stat(script).catch(() => null))) return { samples: [], peaks: [] };
  if (!(await ensureFile(deps.emotionModelUrl ?? DEFAULT_EMOTION_MODEL_URL, model))) return { samples: [], peaks: [] };
  try {
    const result = await runner(python, [script, videoPath, '--model', model, '--samples', String(deps.emotionSamples ?? 24), '--every-seconds', String(deps.emotionEverySeconds ?? 3)], deps.emotionTimeoutMs ?? 600_000);
    if (result.code !== 0) return { samples: [], peaks: [] };
    const parsed = parseEmotionOutput(result.stdout);
    if (!parsed) return { samples: [], peaks: [] };
    return { samples: parsed.samples, peaks: emotionPeaks(parsed.samples) };
  } catch {
    return { samples: [], peaks: [] };
  }
}

/** Combine loudness (from audio) with visual, emotion and chat signals. */
export function mergeSignals(audio: MediaSignals, video?: MediaSignals | null, chatSpikes: TimeRange[] = [], emotion?: { samples: EmotionSample[]; peaks: TimeRange[] } | null): MediaSignals {
  if (!video && !chatSpikes.length && !emotion) return audio;
  return {
    ...audio,
    sceneCuts: video?.sceneCuts ?? audio.sceneCuts,
    cutDense: video?.cutDense ?? audio.cutDense,
    motion: video?.motion ?? audio.motion,
    visualPeaks: video?.visualPeaks ?? audio.visualPeaks,
    emotion: emotion?.samples ?? video?.emotion ?? audio.emotion,
    emotionPeaks: emotion?.peaks ?? video?.emotionPeaks ?? audio.emotionPeaks,
    chatSpikes,
    durationSeconds: Math.max(audio.durationSeconds, video?.durationSeconds ?? 0),
  };
}

/** All peak windows (loud + visual + emotion + chat) for candidate generation. */
export function allPeaks(signals: MediaSignals): TimeRange[] {
  const ranges = [...signals.loudPeaks, ...(signals.visualPeaks ?? []), ...(signals.emotionPeaks ?? []), ...(signals.chatSpikes ?? [])].sort((a, b) => a.start - b.start);
  const merged: TimeRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * Candidate cut points from real emphasis inside [start, end]: the onset of
 * every loudness, visual, emotion and chat peak, plus source scene cuts. Used
 * by the render pacing pass to land a punch-in on a beat when the transcript
 * offers no sentence boundary.
 */
export function beatTimes(signals: MediaSignals, start: number, end: number): number[] {
  const times: number[] = [...loudnessOnsets(signals.loudness)];
  for (const range of [...signals.loudPeaks, ...(signals.visualPeaks ?? []), ...(signals.emotionPeaks ?? []), ...(signals.chatSpikes ?? [])]) {
    times.push(range.start);
  }
  for (const cut of signals.sceneCuts ?? []) times.push(cut);
  return [...new Set(times.filter(time => Number.isFinite(time) && time >= start && time <= end))].sort((a, b) => a - b);
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
