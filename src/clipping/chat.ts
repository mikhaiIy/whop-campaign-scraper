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

/**
 * Download the chat replay and return spike windows. Fail-open: no chat replay,
 * an unsupported platform, or a network error all return an empty list.
 */
export async function collectChatSignals(videoUrl: string, deps: ChatDeps = {}): Promise<TimeRange[]> {
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
