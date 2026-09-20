import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TimeRange } from './signals.js';
import { defaultProcessRunner, type ProcessRunner } from './youtube.js';

/**
 * Chat-velocity signals. A live chat that suddenly floods is one of the most
 * reliable markers of a moment worth clipping. We download the platform's chat
 * replay (YouTube live chat via yt-dlp) and turn message density into spike
 * windows. Absent chat (regular uploads, unsupported platforms) yields nothing.
 */

export interface ChatDeps {
  runner?: ProcessRunner;
  command?: string;
  timeoutMs?: number;
  /** Seconds between sampled chat offsets for a Twitch VOD. */
  sampleStepSeconds?: number;
  maxSamples?: number;
}

const TWITCH_GQL = 'https://gql.twitch.tv/gql';
const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

export interface TwitchChatTarget {
  vodId?: string;
  channel?: string;
}

export interface ChatVelocityOptions {
  windowSeconds?: number;
  zThreshold?: number;
  minMessages?: number;
}

/** Extract absolute epoch-second timestamps from a YouTube live-chat JSONL replay. */
export function parseLiveChat(text: string): number[] {
  const times: number[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    const actions = (parsed as { replayChatItemAction?: { actions?: unknown[] } })?.replayChatItemAction?.actions;
    if (!Array.isArray(actions)) continue;
    for (const action of actions) {
      const item = (action as { addChatItemAction?: { item?: Record<string, unknown> } })?.addChatItemAction?.item;
      if (!item) continue;
      const renderer = (item.liveChatTextMessageRenderer ?? item.liveChatPaidMessageRenderer ?? item.liveChatMembershipItemRenderer) as { timestampUsec?: string | number } | undefined;
      const usec = renderer?.timestampUsec;
      if (usec === undefined || usec === null) continue;
      const value = Number(usec);
      if (Number.isFinite(value)) times.push(value / 1_000_000);
    }
  }
  return times.sort((a, b) => a - b);
}

/** Shift absolute timestamps so the first message is at 0. */
export function relativeChatTimes(times: number[]): number[] {
  if (!times.length) return [];
  const base = times[0];
  return times.map(time => time - base);
}

/** Rolling-window message-rate spikes, as absolute-relative time ranges. */
export function chatVelocity(times: number[], options: ChatVelocityOptions = {}): TimeRange[] {
  const windowSeconds = Math.max(1, options.windowSeconds ?? 5);
  const zThreshold = options.zThreshold ?? 2.5;
  const minMessages = options.minMessages ?? 8;
  if (times.length < minMessages) return [];
  const duration = Math.ceil(times[times.length - 1]);
  const perSecond = new Array<number>(duration + 1).fill(0);
  for (const time of times) {
    const second = Math.floor(time);
    if (second >= 0 && second <= duration) perSecond[second]++;
  }
  const windows: Array<{ start: number; count: number }> = [];
  for (let start = 0; start <= duration; start++) {
    let count = 0;
    for (let k = start; k < Math.min(start + windowSeconds, duration + 1); k++) count += perSecond[k];
    windows.push({ start, count });
  }
  const counts = windows.map(window => window.count);
  const mean = counts.reduce((sum, value) => sum + value, 0) / counts.length;
  const variance = counts.reduce((sum, value) => sum + (value - mean) ** 2, 0) / counts.length;
  const threshold = mean + zThreshold * Math.sqrt(variance);
  const flagged = windows.filter(window => window.count >= minMessages && window.count > threshold).map(window => window.start);
  const ranges: TimeRange[] = [];
  let current: TimeRange | null = null;
  for (const start of flagged) {
    if (current && start - current.end <= windowSeconds) current.end = start + windowSeconds;
    else {
      if (current) ranges.push(current);
      current = { start, end: start + windowSeconds };
    }
  }
  if (current) ranges.push(current);
  return ranges;
}

/** Extract message offsets (seconds) from a Twitch GQL video-comments response. */
export function parseTwitchComments(json: unknown): number[] {
  const edges = (json as { data?: { video?: { comments?: { edges?: unknown[] } } } })?.data?.video?.comments?.edges;
  if (!Array.isArray(edges)) return [];
  const offsets: number[] = [];
  for (const edge of edges) {
    const offset = (edge as { node?: { contentOffsetSeconds?: unknown } })?.node?.contentOffsetSeconds;
    const value = Number(offset);
    if (Number.isFinite(value)) offsets.push(value);
  }
  return offsets.sort((a, b) => a - b);
}

async function twitchGql(query: string, variables: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(TWITCH_GQL, {
      method: 'POST',
      headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const LATEST_VOD_QUERY = 'query($login:String!){ user(login:$login){ videos(first:1,type:ARCHIVE){ edges{ node{ id } } } } }';
const VOD_DURATION_QUERY = 'query($id:ID!){ video(id:$id){ lengthSeconds } }';
const COMMENTS_QUERY = 'query($id:ID!,$off:Int){ video(id:$id){ comments(first:100,contentOffsetSeconds:$off){ edges{ node{ contentOffsetSeconds } } } } }';

/**
 * Spike detection for sampled chat values (e.g. comments-per-second). A sample
 * is a spike when its value is both above an absolute floor and a z-outlier.
 */
export function chatSampleSpikes(samples: Array<{ t: number; value: number }>, options: { zThreshold?: number; minValue?: number; stepSeconds?: number } = {}): TimeRange[] {
  const zThreshold = options.zThreshold ?? 1.5;
  const minValue = options.minValue ?? 0.5;
  const step = options.stepSeconds ?? 120;
  if (samples.length < 4) return [];
  const values = samples.map(sample => sample.value);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const threshold = mean + zThreshold * Math.sqrt(variance);
  return samples
    .filter(sample => sample.value >= minValue && sample.value > threshold)
    .map(sample => ({ start: sample.t, end: sample.t + step }))
    .sort((a, b) => a.start - b.start);
}

/** Chat-velocity spikes from a Twitch VOD (by id or latest archive for a channel). */
export async function collectTwitchChat(target: TwitchChatTarget, deps: ChatDeps = {}): Promise<TimeRange[]> {
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const stepSeconds = deps.sampleStepSeconds ?? 120;
  const maxSamples = deps.maxSamples ?? 300;
  let vodId = target.vodId;
  if (!vodId && target.channel) {
    const latest = await twitchGql(LATEST_VOD_QUERY, { login: target.channel }, timeoutMs);
    vodId = (latest as { data?: { user?: { videos?: { edges?: Array<{ node?: { id?: string } }> } } } })?.data?.user?.videos?.edges?.[0]?.node?.id;
  }
  if (!vodId) return [];
  const durationJson = await twitchGql(VOD_DURATION_QUERY, { id: vodId }, timeoutMs);
  const duration = Number((durationJson as { data?: { video?: { lengthSeconds?: number } } })?.data?.video?.lengthSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const samples: Array<{ t: number; value: number }> = [];
  const total = Math.min(maxSamples, Math.floor(duration / stepSeconds) + 1);
  for (let index = 0; index < total; index++) {
    const offset = index * stepSeconds;
    const json = await twitchGql(COMMENTS_QUERY, { id: vodId, off: offset }, timeoutMs);
    const offsets = parseTwitchComments(json);
    const span = offsets.length >= 2 ? Math.max(1, offsets[offsets.length - 1] - offsets[0]) : stepSeconds;
    samples.push({ t: offset, value: offsets.length / span });
  }
  return chatSampleSpikes(samples, { stepSeconds });
}

/** Best-effort Kick chat: the public v2 API is undocumented and often blocked. */
export async function collectKickChat(channel: string, deps: ChatDeps = {}): Promise<TimeRange[]> {
  const timeoutMs = deps.timeoutMs ?? 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(channel)}`, { signal: controller.signal });
    if (!response.ok) return [];
    const json = await response.json() as { chatroom?: { id?: number } };
    const chatroomId = json?.chatroom?.id;
    if (!chatroomId) return [];
    const messages = await fetch(`https://kick.com/api/v2/messages/${chatroomId}`, { signal: controller.signal });
    if (!messages.ok) return [];
    const list = await messages.json() as Array<{ created_at?: string }>;
    const times = (Array.isArray(list) ? list : []).map(entry => Date.parse(String(entry.created_at ?? '')) / 1000).filter(Number.isFinite);
    return chatVelocity(relativeChatTimes(times));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function parseTwitchUrl(url: string): TwitchChatTarget | null {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes('twitch.tv')) return null;
    const vodMatch = parsed.pathname.match(/\/videos\/(\d+)/);
    if (vodMatch) return { vodId: vodMatch[1] };
    const channel = parsed.pathname.split('/').filter(Boolean)[0];
    return channel ? { channel } : null;
  } catch {
    return null;
  }
}

/**
 * Download the chat replay and return spike windows. Fail-open: no chat replay,
 * an unsupported platform, or a network error all return an empty list.
 */
export async function collectChatSignals(videoUrl: string, deps: ChatDeps = {}): Promise<TimeRange[]> {
  const host = (() => { try { return new URL(videoUrl).hostname; } catch { return ''; } })();
  if (host.includes('twitch.tv')) {
    const target = parseTwitchUrl(videoUrl);
    return target ? collectTwitchChat(target, deps) : [];
  }
  if (host.includes('kick.com')) {
    const channel = (() => { try { return new URL(videoUrl).pathname.split('/').filter(Boolean)[0] ?? ''; } catch { return ''; } })();
    return channel ? collectKickChat(channel, deps) : [];
  }
  return collectYouTubeChat(videoUrl, deps);
}

/** YouTube live-chat replay via yt-dlp. */
async function collectYouTubeChat(videoUrl: string, deps: ChatDeps = {}): Promise<TimeRange[]> {
  const runner = deps.runner ?? defaultProcessRunner;
  const command = deps.command ?? 'yt-dlp';
  const timeoutMs = deps.timeoutMs ?? 300_000;
  const dir = await mkdtemp(join(tmpdir(), 'whop-chat-'));
  try {
    const args = [
      '--skip-download', '--write-subs', '--sub-langs', 'live_chat', '--sub-format', 'json3',
      '--no-playlist', '--no-warnings', '--retries', '1',
      '-o', join(dir, '%(id)s'),
      videoUrl,
    ];
    const result = await runner(command, args, timeoutMs);
    if (result.code !== 0) return [];
    const files = await readdir(dir);
    const file = files.find(name => name.includes('live_chat') && name.endsWith('.json'));
    if (!file) return [];
    const text = await readFile(join(dir, file), 'utf8');
    return chatVelocity(relativeChatTimes(parseLiveChat(text)));
  } catch {
    return [];
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
