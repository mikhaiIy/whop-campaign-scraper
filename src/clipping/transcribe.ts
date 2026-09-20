import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultProcessRunner, type ProcessRunner } from './youtube.js';

export interface WordTiming {
  start: number;
  end: number;
  word: string;
  probability: number | null;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words: WordTiming[];
}

export interface Transcript {
  videoId: string;
  model: string;
  device: string;
  computeType: string;
  language: string | null;
  durationSeconds: number;
  offsetSeconds: number;
  segments: TranscriptSegment[];
}

export const DEFAULT_TRANSCRIPTION_MODEL = 'large-v3';

export interface TranscriptionOptions {
  dir?: string;
  pythonPath?: string;
  scriptPath?: string;
  model?: string;
  device?: string;
  computeType?: string;
  language?: string;
  timeoutMs?: number;
  runner?: ProcessRunner;
  now?: () => number;
}

const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const asString = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

function parseWords(value: unknown): WordTiming[] {
  if (!Array.isArray(value)) return [];
  const words: WordTiming[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const word = typeof record.word === 'string' ? record.word : null;
    if (word === null) continue;
    words.push({ start: asNumber(record.start), end: asNumber(record.end), word, probability: typeof record.probability === 'number' ? record.probability : null });
  }
  return words;
}

export function parseTranscriptJson(raw: string, videoId: string, model: string): Transcript {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('transcribe.py returned a non-object JSON payload');
  const record = parsed as Record<string, unknown>;
  const segments: TranscriptSegment[] = [];
  for (const item of Array.isArray(record.segments) ? record.segments : []) {
    if (typeof item !== 'object' || item === null) continue;
    const segment = item as Record<string, unknown>;
    segments.push({ start: asNumber(segment.start), end: asNumber(segment.end), text: typeof segment.text === 'string' ? segment.text : '', words: parseWords(segment.words) });
  }
  return {
    videoId,
    model: asString(record.model) ?? model,
    device: asString(record.device) ?? 'cuda',
    computeType: asString(record.compute_type) ?? 'int8_float16',
    language: asString(record.language),
    durationSeconds: asNumber(record.duration) || (segments.length ? segments[segments.length - 1].end : 0),
    offsetSeconds: 0,
    segments,
  };
}

export function transcriptDuration(transcript: Transcript): number {
  if (transcript.durationSeconds > 0) return transcript.durationSeconds;
  return transcript.segments.length ? transcript.segments[transcript.segments.length - 1].end : 0;
}

export function shiftTranscript(transcript: Transcript, offsetSeconds: number): Transcript {
  if (!offsetSeconds) return transcript;
  return {
    ...transcript,
    offsetSeconds: transcript.offsetSeconds + offsetSeconds,
    durationSeconds: transcript.durationSeconds + offsetSeconds,
    segments: transcript.segments.map(segment => ({
      ...segment,
      start: segment.start + offsetSeconds,
      end: segment.end + offsetSeconds,
      words: segment.words.map(word => ({ ...word, start: word.start + offsetSeconds, end: word.end + offsetSeconds })),
    })),
  };
}

export function flattenWords(transcript: Transcript): WordTiming[] {
  const words: WordTiming[] = [];
  for (const segment of transcript.segments) words.push(...segment.words);
  return words;
}

export class TranscriptionCache {
  private readonly dir: string;
  private readonly pythonPath: string;
  private readonly scriptPath: string;
  private readonly model: string;
  private readonly device: string;
  private readonly computeType: string;
  private readonly language: string;
  private readonly timeoutMs: number;
  private readonly runner: ProcessRunner;

  constructor(options: TranscriptionOptions = {}) {
    this.dir = options.dir ?? join(process.cwd(), '.cache/clipping/media');
    this.pythonPath = options.pythonPath ?? join(process.cwd(), '.venv/bin/python');
    this.scriptPath = options.scriptPath ?? join(process.cwd(), 'tools/transcribe.py');
    this.model = options.model ?? DEFAULT_TRANSCRIPTION_MODEL;
    this.device = options.device ?? 'cuda';
    this.computeType = options.computeType ?? 'int8_float16';
    this.language = options.language ?? 'en';
    this.timeoutMs = options.timeoutMs ?? 1_800_000;
    this.runner = options.runner ?? defaultProcessRunner;
  }

  pathFor(videoId: string, model: string): string {
    return join(this.dir, videoId, `transcript.${model}.json`);
  }

  async transcribe(asset: { videoId: string; path: string; section?: unknown }, options: { refresh?: boolean; model?: string } = {}): Promise<Transcript> {
    const model = options.model ?? this.model;
    const output = this.pathFor(asset.videoId, model);
    if (!options.refresh) {
      try {
        const cached = await readFile(output, 'utf8');
        return parseTranscriptJson(cached, asset.videoId, model);
      } catch { /* cache miss or corrupt; re-transcribe */ }
    }
    const temp = `${output}.tmp`;
    const args = [this.scriptPath, asset.path, '--model', model, '--device', this.device, '--compute-type', this.computeType, '--language', this.language, '-o', temp];
    const result = await this.runner(this.pythonPath, args, this.timeoutMs);
    if (result.code !== 0) throw new Error(`transcription failed (exit ${result.code}): ${result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500) || 'no stderr'}`);
    const raw = await readFile(temp, 'utf8').catch(() => null);
    if (!raw) throw new Error(`transcription exited 0 but produced no output at ${temp}`);
    const transcript = parseTranscriptJson(raw, asset.videoId, model);
    await rename(temp, output).catch(async () => { await writeFile(output, raw, 'utf8').catch(() => {}); });
    return transcript;
  }
}
