import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultProcessRunner, type ProcessRunner } from './youtube.js';

export interface SectionRange {
  start: number;
  end: number;
}

export interface MediaProbe {
  path: string;
  durationSeconds: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  sizeBytes: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export type MediaKind = 'audio' | 'video';

export interface MediaAsset {
  videoId: string;
  kind: MediaKind;
  section: SectionRange | null;
  path: string;
  probe: MediaProbe;
  fromCache: boolean;
  fetchedAt: string;
}

export interface MediaSourceLike {
  id: string;
  url?: string | null;
}

export interface MediaCacheOptions {
  dir?: string;
  command?: string;
  probeCommand?: string;
  runner?: ProcessRunner;
  downloadTimeoutMs?: number;
  probeTimeoutMs?: number;
  now?: () => number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : null);

function parseRate(value: unknown): number | null {
  const text = typeof value === 'string' ? value : null;
  if (!text || !text.includes('/')) return asNumber(value);
  const [numerator, denominator] = text.split('/').map(Number);
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0 ? numerator / denominator : null;
}

export function parseFfprobeJson(raw: string): Omit<MediaProbe, 'path'> {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error('ffprobe returned a non-object JSON payload');
  const streams = (Array.isArray(parsed.streams) ? parsed.streams : []).filter(isRecord);
  const format = isRecord(parsed.format) ? parsed.format : {};
  const video = streams.find(stream => stream.codec_type === 'video' && !(isRecord(stream.disposition) && stream.disposition.attached_pic === 1)) ?? streams.find(stream => stream.codec_type === 'video') ?? null;
  const audio = streams.find(stream => stream.codec_type === 'audio') ?? null;
  const durationSeconds = asNumber(format.duration) ?? asNumber(video?.duration) ?? asNumber(audio?.duration) ?? 0;
  return {
    durationSeconds,
    width: video ? asNumber(video.width) : null,
    height: video ? asNumber(video.height) : null,
    fps: video ? parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate) : null,
    videoCodec: video && typeof video.codec_name === 'string' ? video.codec_name : null,
    audioCodec: audio && typeof audio.codec_name === 'string' ? audio.codec_name : null,
    sizeBytes: asNumber(format.size) ?? 0,
    hasVideo: video !== null,
    hasAudio: audio !== null,
  };
}

export function toFileRelative(absoluteSeconds: number, section: SectionRange): number {
  return absoluteSeconds - section.start;
}

export function formatSectionArg(section: SectionRange): string {
  return `*${section.start.toFixed(3)}-${section.end.toFixed(3)}`;
}

const sourceUrl = (video: MediaSourceLike): string => video.url && video.url.trim() ? video.url.trim() : `https://www.youtube.com/watch?v=${video.id}`;

export async function probeMedia(path: string, options: { command?: string; runner?: ProcessRunner; timeoutMs?: number } = {}): Promise<MediaProbe> {
  const command = options.command ?? 'ffprobe';
  const runner = options.runner ?? defaultProcessRunner;
  const result = await runner(command, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], options.timeoutMs ?? 60_000);
  if (result.code !== 0 || !result.stdout.trim()) {
    throw new Error(`ffprobe failed for ${path} (exit ${result.code}): ${result.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300) || 'no output'}`);
  }
  const parsed = parseFfprobeJson(result.stdout);
  const info = await stat(path).catch(() => null);
  return { ...parsed, path, sizeBytes: info?.size ?? parsed.sizeBytes };
}

const keyOf = (section: SectionRange): string => `section-${section.start.toFixed(3)}-${section.end.toFixed(3)}`;

export class MediaCache {
  private readonly dir: string;
  private readonly command: string;
  private readonly probeCommand: string;
  private readonly runner: ProcessRunner;
  private readonly downloadTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: MediaCacheOptions = {}) {
    this.dir = options.dir ?? join(process.cwd(), '.cache/clipping/media');
    this.command = options.command ?? 'yt-dlp';
    this.probeCommand = options.probeCommand ?? 'ffprobe';
    this.runner = options.runner ?? defaultProcessRunner;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? 1_800_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  private downloadDir(videoId: string, section: SectionRange | null): string {
    return section ? join(this.dir, videoId, keyOf(section)) : join(this.dir, videoId, 'audio');
  }

  private async exists(path: string): Promise<boolean> {
    try { await stat(path); return true; } catch { return false; }
  }

  private async probeCached(path: string, refresh: boolean): Promise<MediaProbe> {
    const probePath = `${path}.probe.json`;
    if (!refresh) {
      try {
        const parsed = JSON.parse(await readFile(probePath, 'utf8')) as MediaProbe;
        if (parsed.path === path && typeof parsed.durationSeconds === 'number') return parsed;
      } catch { /* fall through to a fresh probe */ }
    }
    const probe = await probeMedia(path, { command: this.probeCommand, runner: this.runner, timeoutMs: this.probeTimeoutMs });
    try { await writeFile(probePath, JSON.stringify(probe), 'utf8'); } catch { /* probe cache is best-effort */ }
    return probe;
  }

  async ingestAudio(video: MediaSourceLike, options: { section?: SectionRange; refresh?: boolean } = {}): Promise<MediaAsset> {
    const section = options.section ?? null;
    if (section && !(section.end > section.start)) throw new Error(`Audio section end must exceed start: ${JSON.stringify(section)}`);
    const dir = this.downloadDir(video.id, section);
    const path = join(dir, 'source.mp3');
    const fromCache = !options.refresh && (await this.exists(path));
    if (!fromCache) {
      await mkdir(dir, { recursive: true });
      const args = [
        '-f', 'bestaudio', '-x', '--audio-format', 'mp3', '--audio-quality', '5',
        '--no-playlist', '--no-warnings', '--retries', '3',
        '-o', join(dir, 'source.%(ext)s'),
        ...(section ? ['--download-sections', formatSectionArg(section), '--force-keyframes-at-cuts'] : []),
        sourceUrl(video),
      ];
      const result = await this.runner(this.command, args, this.downloadTimeoutMs);
      if (result.code !== 0) throw new Error(`yt-dlp audio download failed (exit ${result.code}): ${result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400) || 'no stderr'}`);
      if (!(await this.exists(path))) throw new Error(`yt-dlp reported success but ${path} is missing.`);
    }
    return { videoId: video.id, kind: 'audio', section, path, probe: await this.probeCached(path, Boolean(options.refresh)), fromCache, fetchedAt: new Date(this.now()).toISOString() };
  }

  /** Low-resolution full-length proxy, used only to derive visual signals. */
  async ingestProxy(video: MediaSourceLike, options: { refresh?: boolean; maxHeight?: number } = {}): Promise<MediaAsset> {
    const height = options.maxHeight ?? 360;
    const dir = join(this.dir, video.id, 'proxy');
    const path = join(dir, 'source.mp4');
    const fromCache = !options.refresh && (await this.exists(path));
    if (!fromCache) {
      await mkdir(dir, { recursive: true });
      const args = [
        '-f', `bv*[height<=${height}]+ba/b[height<=${height}]/b/worst`,
        '--merge-output-format', 'mp4', '--remux-video', 'mp4',
        '--no-playlist', '--no-warnings', '--retries', '2',
        '-o', join(dir, 'source.%(ext)s'),
        sourceUrl(video),
      ];
      const result = await this.runner(this.command, args, this.downloadTimeoutMs);
      if (result.code !== 0) throw new Error(`yt-dlp proxy download failed (exit ${result.code}): ${result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400) || 'no stderr'}`);
      if (!(await this.exists(path))) throw new Error(`yt-dlp reported success but ${path} is missing.`);
    }
    return { videoId: video.id, kind: 'video', section: null, path, probe: await this.probeCached(path, Boolean(options.refresh)), fromCache, fetchedAt: new Date(this.now()).toISOString() };
  }

  async ingestSection(video: MediaSourceLike, section: SectionRange, options: { refresh?: boolean; maxHeight?: number } = {}): Promise<MediaAsset> {
    if (!(section.end > section.start)) throw new Error(`Video section end must exceed start: ${JSON.stringify(section)}`);
    const height = options.maxHeight ?? 1080;
    const dir = this.downloadDir(video.id, section);
    const path = join(dir, 'source.mp4');
    const fromCache = !options.refresh && (await this.exists(path));
    if (!fromCache) {
      await mkdir(dir, { recursive: true });
      const args = [
        '-f', `bv*[height<=${height}]+ba/b[height<=${height}]/b`,
        '--merge-output-format', 'mp4', '--remux-video', 'mp4',
        '--no-playlist', '--no-warnings', '--retries', '3',
        '--download-sections', formatSectionArg(section), '--force-keyframes-at-cuts',
        '-o', join(dir, 'source.%(ext)s'),
        sourceUrl(video),
      ];
      const result = await this.runner(this.command, args, this.downloadTimeoutMs);
      if (result.code !== 0) throw new Error(`yt-dlp section download failed (exit ${result.code}): ${result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400) || 'no stderr'}`);
      if (!(await this.exists(path))) throw new Error(`yt-dlp reported success but ${path} is missing.`);
    }
    return { videoId: video.id, kind: 'video', section, path, probe: await this.probeCached(path, Boolean(options.refresh)), fromCache, fetchedAt: new Date(this.now()).toISOString() };
  }
}
