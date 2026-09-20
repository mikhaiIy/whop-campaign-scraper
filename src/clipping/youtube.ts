import { execFile } from 'node:child_process';

export interface SourceVideo {
  id: string;
  title: string;
  durationSeconds: number | null;
  uploadDate: string | null;
  url: string;
  channel: string | null;
  viewCount: number | null;
}

export interface ChannelListing {
  channel: string | null;
  channelId: string | null;
  channelUrl: string;
  videos: SourceVideo[];
  truncated: boolean;
  warnings: string[];
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export type ProcessRunner = (command: string, args: string[], timeoutMs: number) => Promise<ProcessResult>;

export const defaultProcessRunner: ProcessRunner = (command, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, cwd: process.cwd() }, (error, stdout, stderr) => {
    if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      reject(new Error(`Command "${command}" was not found on PATH.`));
      return;
    }
    resolve({
      stdout: String(stdout),
      stderr: String(stderr),
      code: error ? ((error as { code?: number }).code ?? 1) : 0,
      timedOut: Boolean(error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed),
    });
  });
});

const YOUTUBE_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;
const CHANNEL_PATH = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/;

export interface ChannelUrl {
  isChannel: boolean;
  url: string;
}

export function normalizeChannelUrl(rawUrl: string): ChannelUrl {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { isChannel: false, url: rawUrl }; }
  if (!YOUTUBE_HOSTS.test(url.hostname)) return { isChannel: false, url: url.toString() };
  if (!CHANNEL_PATH.test(url.pathname)) return { isChannel: false, url: url.toString() };
  const path = url.pathname.replace(/\/+$/, '');
  if (!/\/videos$/.test(path) && !/\/shorts$/.test(path) && !/\/streams$/.test(path)) {
    url.pathname = `${path}/videos`;
  }
  url.search = '';
  url.hash = '';
  return { isChannel: true, url: url.toString() };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const asNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

function toUploadDate(entry: Record<string, unknown>): string | null {
  const uploadDate = asString(entry.upload_date);
  if (uploadDate && /^\d{8}$/.test(uploadDate)) return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
  const timestamp = asNumber(entry.timestamp) ?? asNumber(entry.release_timestamp);
  if (timestamp === null || timestamp <= 0) return null;
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

export function flattenEntries(raw: unknown): Record<string, unknown>[] {
  if (!isRecord(raw)) return [];
  const direct = Array.isArray(raw.entries) ? raw.entries : [];
  const output: Record<string, unknown>[] = [];
  for (const entry of direct) {
    if (!isRecord(entry)) continue;
    if (Array.isArray(entry.entries)) {
      for (const nested of entry.entries) if (isRecord(nested)) output.push(nested);
    } else {
      output.push(entry);
    }
  }
  return output;
}

export function toSourceVideo(entry: Record<string, unknown>): SourceVideo | null {
  const id = asString(entry.id);
  if (!id) return null;
  const url = asString(entry.url) ?? asString(entry.webpage_url) ?? `https://www.youtube.com/watch?v=${id}`;
  return {
    id,
    title: asString(entry.title) ?? '(untitled)',
    durationSeconds: asNumber(entry.duration) ?? asNumber(entry.duration_seconds),
    uploadDate: toUploadDate(entry),
    url,
    channel: asString(entry.channel) ?? asString(entry.uploader),
    viewCount: asNumber(entry.view_count),
  };
}

export function parseYtDlpJson(raw: string): { channel: string | null; channelId: string | null; videos: SourceVideo[] } {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error('yt-dlp returned a non-object JSON payload');
  if (parsed._type === 'playlist' || Array.isArray(parsed.entries)) {
    return {
      channel: asString(parsed.channel) ?? asString(parsed.uploader) ?? asString(parsed.title),
      channelId: asString(parsed.channel_id),
      videos: flattenEntries(parsed).map(toSourceVideo).filter((video): video is SourceVideo => video !== null),
    };
  }
  const single = toSourceVideo(parsed);
  return {
    channel: asString(parsed.channel) ?? asString(parsed.uploader),
    channelId: asString(parsed.channel_id),
    videos: single ? [single] : [],
  };
}

export interface ResolveOptions {
  limit?: number;
  timeoutMs?: number;
}

export class YouTubeFootageResolver {
  constructor(private readonly options: { command?: string; runner?: ProcessRunner; timeoutMs?: number } = {}) {}

  async resolve(channelUrl: string, options: ResolveOptions = {}): Promise<ChannelListing> {
    const normalized = normalizeChannelUrl(channelUrl);
    if (!normalized.isChannel) {
      return { channel: null, channelId: null, channelUrl, videos: [], truncated: false, warnings: [`Not a recognisable YouTube channel URL: ${channelUrl}`] };
    }
    const command = this.options.command ?? 'yt-dlp';
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 180_000;
    const args = [
      '--flat-playlist', '-J', '--no-warnings', '--ignore-errors',
      '--extractor-args', 'youtubetab:approximate_date',
      ...(options.limit ? ['--playlist-end', String(options.limit)] : []),
      normalized.url,
    ];
    const result = await (this.options.runner ?? defaultProcessRunner)(command, args, timeoutMs);
    if (result.timedOut) throw new Error(`yt-dlp timed out after ${timeoutMs}ms for ${normalized.url}`);
    if (!result.stdout.trim()) {
      const detail = result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400);
      throw new Error(`yt-dlp returned no JSON for ${normalized.url} (exit ${result.code})${detail ? `: ${detail}` : ''}`);
    }
    const parsed = parseYtDlpJson(result.stdout);
    const warnings: string[] = [];
    if (!parsed.videos.length) warnings.push(`No videos were listed for ${normalized.url}.`);
    if (result.code !== 0) warnings.push(`yt-dlp exited ${result.code}; the listing may be partial.`);
    const limited = options.limit && parsed.videos.length > options.limit ? parsed.videos.slice(0, options.limit) : parsed.videos;
    return {
      channel: parsed.channel,
      channelId: parsed.channelId,
      channelUrl: normalized.url,
      videos: limited,
      truncated: Boolean(options.limit && parsed.videos.length >= options.limit),
      warnings,
    };
  }

  async resolveAll(channelUrls: string[], options: ResolveOptions = {}): Promise<ChannelListing[]> {
    const listings: ChannelListing[] = [];
    for (const url of channelUrls) {
      try {
        listings.push(await this.resolve(url, options));
      } catch (error) {
        listings.push({ channel: null, channelId: null, channelUrl: url, videos: [], truncated: false, warnings: [error instanceof Error ? error.message : String(error)] });
      }
    }
    return listings;
  }
}
