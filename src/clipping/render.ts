import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { probeMedia, type MediaProbe } from './media.js';
import { flattenWords, type Transcript, type WordTiming } from './transcribe.js';
import { defaultProcessRunner, type ProcessRunner } from './youtube.js';

/**
 * Render layer for the clipping pipeline.
 *
 * A cut clip is a plain, horizontal re-encode. This module turns it into a
 * postable short: optional dead-air tightening (auto-editor), then a single
 * final encode that burns word-synced ASS captions and normalizes loudness to
 * the short-form target. Every ffmpeg argument is produced by a pure builder so
 * the pipeline stays testable without touching a real media file.
 */

export const SHORT_FORM_LOUDNESS = { targetI: -14, targetTP: -1.5, targetLRA: 11 } as const;

/** Universal 1080x1920 text box (x130-890 / y288-1248), anchored to Meta's published ratio. */
export const DEFAULT_SAFE_BOX = { marginLeft: 130, marginRight: 190, marginBottom: 672 } as const;

export const DEFAULT_CANVAS = { width: 1080, height: 1920 } as const;

/** DEFAULT_SAFE_BOX expressed as fractions of the canvas, so caption geometry survives any aspect. */
export const SAFE_BOX_RATIO = {
  left: DEFAULT_SAFE_BOX.marginLeft / DEFAULT_CANVAS.width,
  right: DEFAULT_SAFE_BOX.marginRight / DEFAULT_CANVAS.width,
  bottom: DEFAULT_SAFE_BOX.marginBottom / DEFAULT_CANVAS.height,
} as const;

export interface CaptionOptions {
  enabled?: boolean;
  maxWordsPerCard?: number;
  maxGapSeconds?: number;
  /** Minimum on-screen time per card; short cards are merged or held. */
  minCardSeconds?: number;
  fontName?: string;
  fontSize?: number;
  keywordColor?: string;
  outline?: number;
  safeBox?: { marginLeft: number; marginRight: number; marginBottom: number };
  /** Output resolution the captions are authored for; drives PlayRes, font size and margins. */
  canvas?: { width: number; height: number };
}

export interface LoudnessOptions {
  enabled?: boolean;
  targetI?: number;
  targetTP?: number;
  targetLRA?: number;
  linear?: boolean;
}

export interface TightenOptions {
  enabled?: boolean;
  marginSeconds?: number;
  threshold?: number;
  command?: string;
}

export interface ColdOpenOptions {
  enabled?: boolean;
  /** Input-relative start of the teaser (usually the payoff instant). */
  startSeconds?: number;
  durationSeconds?: number;
}

export interface ResolvedColdOpenOptions {
  enabled: boolean;
  startSeconds: number;
  durationSeconds: number;
}

export interface RenderRequest {
  campaignId: string;
  videoId: string;
  inputPath: string;
  outputPath: string;
  sidecarPath: string;
  assPath: string;
  transcript: Transcript;
  clipStart: number;
  clipEnd: number;
  captions?: CaptionOptions;
  loudness?: LoudnessOptions;
  tighten?: TightenOptions;
  reframe?: ReframeOptions;
  coldOpen?: ColdOpenOptions;
  /** Insert beat-driven punch-ins so the frame changes every few seconds. */
  pacing?: PacingOptions;
}

export interface RenderDeps {
  runner?: ProcessRunner;
  ffmpegCommand?: string;
  autoEditorCommand?: string;
  probeCommand?: string;
  timeoutMs?: number;
  durationToleranceSeconds?: number;
  refresh?: boolean;
  now?: () => number;
  /** Local python used to run tools/focus.py; defaults to <cwd>/.venv/bin/python. */
  pythonPath?: string;
  /** Path to the face-focus sampler; defaults to <cwd>/tools/focus.py. */
  focusScript?: string;
  /** Set false to skip face detection and always center the reframe crop. */
  faceDetect?: boolean;
  focusSamples?: number;
  focusTimeoutMs?: number;
}

export interface LoudnormMeasurement {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
}

export interface RenderStageReport {
  tighten: { ran: boolean; command: string; args: string[]; output: string | null; warning: string | null };
  reframe: { ran: boolean; filter: string | null; focusX: number | null; focusSource: 'request' | 'face' | 'center' };
  coldOpen: { ran: boolean; startSeconds: number; durationSeconds: number };
  pacing: { ran: boolean; segments: number; cuts: number; plan: PacingSegmentPlan[] };
  captions: { ran: boolean; path: string | null; cards: number; warnings: string[] };
  loudness: { ran: boolean; measured: LoudnormMeasurement | null };
}

export interface RenderResult {
  outputPath: string;
  sidecarPath: string;
  assPath: string | null;
  probe: MediaProbe;
  stages: RenderStageReport;
  fromCache: boolean;
}

export interface RenderSidecar {
  campaignId: string;
  videoId: string;
  inputPath: string;
  outputPath: string;
  clip: { start: number; end: number; durationSeconds: number };
  stages: RenderStageReport;
  loudnessTarget: { targetI: number; targetTP: number; targetLRA: number };
  render: { reencode: true; ffmpegArgs: string[]; outputProbe: MediaProbe };
  createdAt: string;
}

const asNumber = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

export interface ResolvedCaptionOptions {
  enabled: boolean;
  maxWordsPerCard: number;
  maxGapSeconds: number;
  minCardSeconds: number;
  fontName: string;
  fontSize: number;
  keywordColor: string;
  outline: number;
  safeBox: { marginLeft: number; marginRight: number; marginBottom: number };
  canvas: { width: number; height: number };
}

export function resolveCaptionOptions(options: CaptionOptions = {}): ResolvedCaptionOptions {
  const canvas = {
    width: Math.max(1, Math.round(asNumber(options.canvas?.width, DEFAULT_CANVAS.width))),
    height: Math.max(1, Math.round(asNumber(options.canvas?.height, DEFAULT_CANVAS.height))),
  };
  const safeBox = options.safeBox
    ? {
        marginLeft: Math.max(0, Math.round(asNumber(options.safeBox.marginLeft, DEFAULT_SAFE_BOX.marginLeft))),
        marginRight: Math.max(0, Math.round(asNumber(options.safeBox.marginRight, DEFAULT_SAFE_BOX.marginRight))),
        marginBottom: Math.max(0, Math.round(asNumber(options.safeBox.marginBottom, DEFAULT_SAFE_BOX.marginBottom))),
      }
    : {
        marginLeft: Math.max(0, Math.round(SAFE_BOX_RATIO.left * canvas.width)),
        marginRight: Math.max(0, Math.round(SAFE_BOX_RATIO.right * canvas.width)),
        marginBottom: Math.max(0, Math.round(SAFE_BOX_RATIO.bottom * canvas.height)),
      };
  const fontAtCanvas = options.fontSize ?? Math.round((72 * canvas.height) / DEFAULT_CANVAS.height);
  return {
    enabled: options.enabled ?? true,
    maxWordsPerCard: Math.max(1, Math.min(6, Math.round(asNumber(options.maxWordsPerCard, 3)))),
    maxGapSeconds: asNumber(options.maxGapSeconds, 0.7),
    minCardSeconds: Math.max(0, asNumber(options.minCardSeconds, 0.8)),
    fontName: options.fontName ?? 'DejaVu Sans',
    fontSize: Math.max(24, Math.min(200, Math.round(asNumber(fontAtCanvas, 72)))),
    keywordColor: options.keywordColor ?? '#FFE500',
    outline: Math.max(0, Math.min(8, Math.round(asNumber(options.outline, 3)))),
    safeBox,
    canvas,
  };
}

export function resolveLoudnessOptions(options: LoudnessOptions = {}): Required<LoudnessOptions> {
  return {
    enabled: options.enabled ?? true,
    targetI: asNumber(options.targetI, SHORT_FORM_LOUDNESS.targetI),
    targetTP: asNumber(options.targetTP, SHORT_FORM_LOUDNESS.targetTP),
    targetLRA: asNumber(options.targetLRA, SHORT_FORM_LOUDNESS.targetLRA),
    linear: options.linear ?? true,
  };
}

export function resolveTightenOptions(options: TightenOptions = {}): Required<TightenOptions> {
  return {
    enabled: options.enabled ?? false,
    marginSeconds: Math.max(0, asNumber(options.marginSeconds, 0.2)),
    threshold: Math.max(0, Math.min(1, asNumber(options.threshold, 0.04))),
    command: options.command ?? process.env.AUTO_EDITOR ?? 'auto-editor',
  };
}

export interface ReframeOptions {
  enabled?: boolean;
  targetWidth?: number;
  targetHeight?: number;
  /** Horizontal focus in [0,1] (0 = left, 1 = right); null centers the crop. */
  focusX?: number | null;
  /** Punch-in factor; 1 keeps the full frame, 1.15 crops 15% tighter. */
  zoom?: number;
}

export interface ResolvedReframeOptions {
  enabled: boolean;
  targetWidth: number;
  targetHeight: number;
  focusX: number | null;
  zoom: number;
}

export function resolveReframeOptions(options: ReframeOptions = {}): ResolvedReframeOptions {
  const focus = options.focusX;
  return {
    enabled: options.enabled ?? true,
    targetWidth: Math.max(2, Math.round(asNumber(options.targetWidth, DEFAULT_CANVAS.width))),
    targetHeight: Math.max(2, Math.round(asNumber(options.targetHeight, DEFAULT_CANVAS.height))),
    focusX: typeof focus === 'number' && Number.isFinite(focus) ? Math.min(1, Math.max(0, focus)) : null,
    zoom: Math.min(2, Math.max(1, asNumber(options.zoom, 1))),
  };
}

const toEven = (value: number): number => (value % 2 === 0 ? value : value + 1);

/** Teaser flash of the payoff prepended before the setup; default off. */
export function resolveColdOpenOptions(options: ColdOpenOptions = {}, clipDuration = 0): ResolvedColdOpenOptions {
  const durationSeconds = Math.max(0, Math.min(2, asNumber(options.durationSeconds, 0.8)));
  const maxStart = Math.max(0, clipDuration - durationSeconds);
  const startSeconds = Math.min(Math.max(0, asNumber(options.startSeconds, 0)), maxStart);
  const enabled = (options.enabled ?? false) && durationSeconds > 0 && clipDuration > durationSeconds + 1;
  return { enabled, startSeconds, durationSeconds };
}

export interface PacingOptions {
  enabled?: boolean;
  /** Preferred maximum time a shot may hold before a visual change. */
  maxSecondsBetweenCuts?: number;
  /** Never place two visual changes closer than this. */
  minSecondsBetweenCuts?: number;
  /** Punch-in amount as a fraction (0.15 = 15% tighter). */
  zoomAmount?: number;
  /** Clips shorter than this are left as one continuous shot. */
  minClipSeconds?: number;
  /** A pause at least this long also marks a shot boundary. */
  sentencePauseSeconds?: number;
}

export interface ResolvedPacingOptions {
  enabled: boolean;
  maxSecondsBetweenCuts: number;
  minSecondsBetweenCuts: number;
  zoomAmount: number;
  minClipSeconds: number;
  sentencePauseSeconds: number;
}

export function resolvePacingOptions(options: PacingOptions = {}): ResolvedPacingOptions {
  const min = Math.min(8, Math.max(1, asNumber(options.minSecondsBetweenCuts, 2.5)));
  const max = Math.min(8, Math.max(min, asNumber(options.maxSecondsBetweenCuts, 5.5)));
  return {
    enabled: options.enabled ?? false,
    maxSecondsBetweenCuts: max,
    minSecondsBetweenCuts: min,
    zoomAmount: Math.min(0.5, Math.max(0, asNumber(options.zoomAmount, 0.15))),
    minClipSeconds: Math.max(0, asNumber(options.minClipSeconds, 3)),
    sentencePauseSeconds: Math.max(0.1, asNumber(options.sentencePauseSeconds, 0.45)),
  };
}

export interface PacingSegmentPlan {
  /** Clip-relative start in seconds. */
  start: number;
  duration: number;
  /** Punch-in factor for this shot; 1 is the full frame. */
  zoom: number;
}

const SENTENCE_END = /[.!?…]["')\]]*$/;

/**
 * Place visual changes across a clip so the frame never holds longer than
 * `maxSecondsBetweenCuts`. Boundaries prefer sentence starts and long pauses,
 * falling back to a forced cut at the ceiling. Shots alternate between the
 * full frame and a punch-in, which reads as a cut-equivalent attention reset
 * without breaking continuity. Returns [] when the clip is too short or has no
 * words to anchor a boundary.
 */
export function planPacing(words: WordTiming[], clipStart: number, clipEnd: number, options: PacingOptions = {}): PacingSegmentPlan[] {
  const resolved = resolvePacingOptions(options);
  const duration = Math.max(0, clipEnd - clipStart);
  if (!resolved.enabled || duration < resolved.minClipSeconds) return [];
  const inRange = words
    .filter(word => word.end > clipStart && word.start < clipEnd)
    .map(word => ({ start: Math.max(0, word.start - clipStart), end: Math.max(0, word.end - clipStart), word: word.word.trim() }))
    .filter(word => word.word.length > 0 && word.end > word.start)
    .sort((a, b) => a.start - b.start);
  if (inRange.length < 2) return [];

  const candidates: number[] = [];
  for (let index = 1; index < inRange.length; index++) {
    const previous = inRange[index - 1];
    const gap = inRange[index].start - previous.end;
    if (SENTENCE_END.test(previous.word) || gap > resolved.sentencePauseSeconds) candidates.push(inRange[index].start);
  }
  const unique = [...new Set(candidates)].filter(time => time > 0 && time < duration).sort((a, b) => a - b);

  const target = (resolved.minSecondsBetweenCuts + resolved.maxSecondsBetweenCuts) / 2;
  const segments: PacingSegmentPlan[] = [];
  let cursor = 0;
  let guard = 0;
  while (duration - cursor > resolved.minSecondsBetweenCuts && guard++ < 200) {
    const min = cursor + resolved.minSecondsBetweenCuts;
    const max = Math.min(cursor + resolved.maxSecondsBetweenCuts, duration);
    const window = unique.filter(time => time >= min && time <= max);
    const cut = window.length
      ? window.reduce((best, time) => (Math.abs(time - (cursor + target)) < Math.abs(best - (cursor + target)) ? time : best), window[0])
      : max;
    if (cut - cursor < resolved.minSecondsBetweenCuts) break;
    segments.push({ start: cursor, duration: cut - cursor, zoom: segments.length % 2 === 1 ? 1 + resolved.zoomAmount : 1 });
    cursor = cut;
  }
  if (cursor < duration - 1e-6) segments.push({ start: cursor, duration: duration - cursor, zoom: segments.length % 2 === 1 ? 1 + resolved.zoomAmount : 1 });
  return segments.length > 1 ? segments : [];
}

function loudnormFilter(loudness: Required<LoudnessOptions>, measured: LoudnormMeasurement | null | undefined): string {
  const measuredArgs = measured
    ? `:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}`
    : '';
  return `loudnorm=I=${loudness.targetI}:TP=${loudness.targetTP}:LRA=${loudness.targetLRA}${measuredArgs}:linear=${loudness.linear ? 'true' : 'false'}`;
}/**
 * Scale-to-cover, then crop to the target, centering horizontally on `focusX`.
 * Returns null when the input already matches the target size.
 */
export function buildReframeFilter(inputWidth: number, inputHeight: number, options: ResolvedReframeOptions): string | null {
  if (!(inputWidth > 0) || !(inputHeight > 0)) return null;
  const zoom = Math.min(2, Math.max(1, options.zoom ?? 1));
  if (zoom === 1 && inputWidth === options.targetWidth && inputHeight === options.targetHeight) return null;
  const factor = Math.max(options.targetWidth / inputWidth, options.targetHeight / inputHeight) * zoom;
  const scaledWidth = toEven(Math.ceil(inputWidth * factor));
  const scaledHeight = toEven(Math.ceil(inputHeight * factor));
  const centerX = (options.focusX ?? 0.5) * scaledWidth;
  const maxX = Math.max(0, scaledWidth - options.targetWidth);
  const x = toEven(Math.round(Math.min(Math.max(centerX - options.targetWidth / 2, 0), maxX)));
  const maxY = Math.max(0, scaledHeight - options.targetHeight);
  const y = toEven(Math.round(Math.min(Math.max((scaledHeight - options.targetHeight) / 2, 0), maxY)));
  return `scale=${scaledWidth}:${scaledHeight},crop=${options.targetWidth}:${options.targetHeight}:${x}:${y}`;
}

export interface FocusResult {
  focusX: number | null;
  faces: number;
  frames: number;
}

/** Parse the JSON emitted by tools/focus.py; returns null when it is absent or malformed. */
export function parseFocusOutput(stdout: string): FocusResult | null {
  const match = stdout.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const rawFocus = parsed.focusX;
    const focusX = typeof rawFocus === 'number' && Number.isFinite(rawFocus) ? Math.min(1, Math.max(0, rawFocus)) : null;
    const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
    return { focusX, faces: count(parsed.faces), frames: count(parsed.frames) };
  } catch {
    return null;
  }
}

/** Sample the input for a dominant face; null means "no confident focus, center the crop". */
async function detectFocus(inputPath: string, runner: ProcessRunner, deps: RenderDeps): Promise<FocusResult | null> {
  const python = deps.pythonPath ?? join(process.cwd(), '.venv/bin/python');
  const script = deps.focusScript ?? join(process.cwd(), 'tools/focus.py');
  if (!(await stat(python).catch(() => null)) || !(await stat(script).catch(() => null))) return null;
  const samples = Math.max(1, Math.round(deps.focusSamples ?? 12));
  try {
    const result = await runner(python, [script, inputPath, '--samples', String(samples)], deps.focusTimeoutMs ?? 120_000);
    if (result.code !== 0) return null;
    return parseFocusOutput(result.stdout);
  } catch {
    return null;
  }
}

const hexToAssColor = (hex: string): string => {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const value = match ? match[1] : 'FFFFFF';
  const r = value.slice(0, 2);
  const g = value.slice(2, 4);
  const b = value.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
};

export function formatAssTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const totalCs = Math.round(clamped * 100);
  const cs = totalCs % 100;
  const totalSeconds = (totalCs - cs) / 100;
  const s = totalSeconds % 60;
  const totalMinutes = (totalSeconds - s) / 60;
  const m = totalMinutes % 60;
  const h = (totalMinutes - m) / 60;
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

export function escapeAssText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/[{}]/g, '').replace(/\r?\n/g, ' ').trim();
}

export interface CaptionCard {
  start: number;
  end: number;
  words: WordTiming[];
}

/** Group clip-relative words into caption cards of at most `maxWordsPerCard`, splitting on long pauses. */
export function buildCaptionCards(words: WordTiming[], options: { maxWordsPerCard?: number; maxGapSeconds?: number; minDurationSeconds?: number } = {}): CaptionCard[] {
  const maxWords = Math.max(1, options.maxWordsPerCard ?? 3);
  const maxGap = options.maxGapSeconds ?? 0.7;
  const minDuration = Math.max(0, options.minDurationSeconds ?? 0);
  const cards: CaptionCard[] = [];
  let current: WordTiming[] = [];
  const flush = (): void => {
    if (!current.length) return;
    cards.push({ start: current[0].start, end: current[current.length - 1].end, words: current });
    current = [];
  };
  for (const word of words) {
    if (!word.word.trim()) continue;
    if (current.length) {
      const gap = word.start - current[current.length - 1].end;
      if (gap > maxGap || current.length >= maxWords) flush();
    }
    current.push(word);
  }
  flush();
  if (minDuration <= 0) return cards;

  const merged: CaptionCard[] = [];
  for (const card of cards) {
    const last = merged[merged.length - 1];
    if (last && last.end - last.start < minDuration && last.words.length + card.words.length <= maxWords) {
      last.end = card.end;
      last.words = [...last.words, ...card.words];
    } else {
      merged.push({ start: card.start, end: card.end, words: [...card.words] });
    }
  }
  for (let index = 0; index < merged.length; index++) {
    const card = merged[index];
    if (card.end - card.start >= minDuration) continue;
    const limit = merged[index + 1] ? merged[index + 1].start : Number.POSITIVE_INFINITY;
    card.end = Math.min(Math.max(card.end, card.start + minDuration), limit);
  }
  return merged;
}

export interface AssBuildResult {
  ass: string;
  cards: CaptionCard[];
  warnings: string[];
}

function pickKeyword(card: CaptionCard): number {
  let best = -1;
  let bestLength = 3;
  card.words.forEach((word, index) => {
    const length = word.word.replace(/[^\p{L}\p{N}]/gu, '').length;
    if (length > bestLength) { best = index; bestLength = length; }
  });
  return best;
}

/**
 * Build an ASS subtitle document for the words inside [clipStart, clipEnd].
 * Times are clip-relative: the first clip frame is 0.
 */
export function buildAss(transcript: Transcript, clipStart: number, clipEnd: number, options: CaptionOptions = {}, timeOffsetSeconds = 0): AssBuildResult {
  const resolved = resolveCaptionOptions(options);
  const inRange = flattenWords(transcript)
    .filter(word => word.end > clipStart && word.start < clipEnd)
    .map(word => ({ ...word, start: Math.max(0, word.start - clipStart), end: Math.max(0, word.end - clipStart), word: word.word.trim() }))
    .filter(word => word.word.length > 0 && word.end > word.start);
  const cards = buildCaptionCards(inRange, { maxWordsPerCard: resolved.maxWordsPerCard, maxGapSeconds: resolved.maxGapSeconds, minDurationSeconds: resolved.minCardSeconds });
  const warnings: string[] = [];
  const keyword = hexToAssColor(resolved.keywordColor);
  const white = hexToAssColor('#FFFFFF');

  const events = cards.map(card => {
    let cursor = card.start;
    const keywordIndex = pickKeyword(card);
    const text = card.words.map((word, index) => {
      const gap = Math.max(0, word.start - cursor);
      const duration = Math.max(0, word.end - word.start);
      const lead = gap > 0.05 ? `{\\k${Math.round(gap * 100)}}` : '';
      const syllable = `{\\k${Math.max(1, Math.round(duration * 100))}}`;
      const highlighted = index === keywordIndex ? `{\\c${keyword}}${escapeAssText(word.word)}{\\c${white}}` : escapeAssText(word.word);
      cursor = word.end;
      return `${lead}${syllable}${highlighted}`;
    }).join(' ');
    const cps = card.end > card.start ? (card.words.map(word => word.word).join(' ').length / (card.end - card.start)) : 0;
    if (cps > 20) warnings.push(`caption card at ${card.start.toFixed(2)}s reads at ${cps.toFixed(1)} CPS (>20).`);
    return `Dialogue: 0,${formatAssTime(card.start + timeOffsetSeconds)},${formatAssTime(card.end + timeOffsetSeconds)},Caption,,0,0,0,,${text}`;
  });

  const ass = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${resolved.canvas.width}`,
    `PlayResY: ${resolved.canvas.height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${resolved.fontName},${resolved.fontSize},${white},&H00B4B4B4,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,${resolved.outline},2,2,${resolved.safeBox.marginLeft},${resolved.safeBox.marginRight},${resolved.safeBox.marginBottom},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    '',
  ].join('\n');
  return { ass, cards, warnings };
}

export function buildLoudnormProbeArgs(inputPath: string, loudness: Required<LoudnessOptions>): string[] {
  return [
    '-hide_banner', '-nostdin', '-i', inputPath,
    '-af', `loudnorm=I=${loudness.targetI}:TP=${loudness.targetTP}:LRA=${loudness.targetLRA}:print_format=json`,
    '-f', 'null', '-',
  ];
}

export function parseLoudnormOutput(stderr: string): LoudnormMeasurement | null {
  const match = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const numeric = (key: string): number | null => {
      const value = parsed[key];
      const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
      return Number.isFinite(number) ? number : null;
    };
    const input_i = numeric('input_i');
    const input_tp = numeric('input_tp');
    const input_lra = numeric('input_lra');
    const input_thresh = numeric('input_thresh');
    const target_offset = numeric('target_offset');
    if (input_i === null || input_tp === null || input_lra === null || input_thresh === null || target_offset === null) return null;
    return { input_i, input_tp, input_lra, input_thresh, target_offset };
  } catch {
    return null;
  }
}

const escapeFilterPath = (path: string): string => path.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");

export function ffmpegSubtitlesFilter(assPath: string): string {
  return `subtitles=filename='${escapeFilterPath(assPath)}'`;
}

export interface PacingRenderSegment {
  /** Input-relative start in seconds. */
  start: number;
  duration: number;
  zoom: number;
  /** Reframe/zoom filter for this shot; null means the input is already the target size. */
  filter: string | null;
}

export interface RenderArgsRequest {
  inputPath: string;
  outputPath: string;
  assPath?: string | null;
  reframeFilter?: string | null;
  /** Beat-driven shots; more than one switches the video graph to a concat. */
  segments?: PacingRenderSegment[] | null;
  coldOpen?: { startSeconds: number; durationSeconds: number } | null;
  loudness?: Required<LoudnessOptions>;
  measured?: LoudnormMeasurement | null;
}

export function buildRenderArgs(request: RenderArgsRequest): string[] {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', request.inputPath];
  const cold = request.coldOpen && request.coldOpen.durationSeconds > 0 ? request.coldOpen : null;
  const segments = request.segments && request.segments.length > 1 ? request.segments : null;
  const loud = request.loudness?.enabled ? loudnormFilter(request.loudness, request.measured) : null;

  if (!cold && !segments) {
    const filters: string[] = [];
    if (request.reframeFilter) filters.push(request.reframeFilter);
    if (request.assPath) filters.push(ffmpegSubtitlesFilter(request.assPath));
    if (filters.length) args.push('-vf', filters.join(','));
    if (loud) args.push('-af', loud);
  } else {
    const graph: string[] = [];
    const videoLabels: string[] = [];
    const pushShot = (label: string, filter: string | null, trim?: { start: number; duration: number }): void => {
      const head = trim ? `trim=start=${trim.start}:duration=${trim.duration},setpts=PTS-STARTPTS,` : 'setpts=PTS-STARTPTS,';
      graph.push(`[0:v]${head}${filter ? `${filter},` : ''}format=yuv420p,setsar=1[${label}]`);
      videoLabels.push(label);
    };
    let index = 0;
    if (cold) pushShot(`v${index++}`, request.reframeFilter ?? null, { start: cold.startSeconds, duration: cold.durationSeconds });
    if (segments) {
      for (const segment of segments) pushShot(`v${index++}`, segment.filter, { start: segment.start, duration: segment.duration });
    } else {
      pushShot(`v${index}`, request.reframeFilter ?? null);
    }
    graph.push(`[${videoLabels.join('][')}]concat=n=${videoLabels.length}:v=1:a=0[vcat]`);
    const videoOut = request.assPath ? 'vout' : 'vcat';
    if (request.assPath) graph.push(`[vcat]${ffmpegSubtitlesFilter(request.assPath)}[vout]`);

    if (cold) {
      graph.push(`[0:a]atrim=start=${cold.startSeconds}:duration=${cold.durationSeconds},asetpts=PTS-STARTPTS[a0]`);
      graph.push('[0:a]asetpts=PTS-STARTPTS[a1]');
      graph.push('[a0][a1]concat=n=2:v=0:a=1[acat]');
    } else {
      graph.push('[0:a]asetpts=PTS-STARTPTS[acat]');
    }
    const audioOut = loud ? 'aout' : 'acat';
    if (loud) graph.push(`[acat]${loud}[aout]`);
    args.push('-filter_complex', graph.join(';'), '-map', `[${videoOut}]`, '-map', `[${audioOut}]`);
  }
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-movflags', '+faststart', '-y', request.outputPath,
  );
  return args;
}

export function buildTightenArgs(inputPath: string, outputPath: string, options: Required<TightenOptions>): string[] {
  return [
    inputPath, '--output', outputPath,
    '--edit', `audio:threshold=${options.threshold}`,
    '--margin', `${options.marginSeconds}s`,
  ];
}

function buildSidecar(request: RenderRequest, outputProbe: MediaProbe, stages: RenderStageReport, loudness: Required<LoudnessOptions>, ffmpegArgs: string[], now: () => number): RenderSidecar {
  return {
    campaignId: request.campaignId,
    videoId: request.videoId,
    inputPath: request.inputPath,
    outputPath: request.outputPath,
    clip: { start: request.clipStart, end: request.clipEnd, durationSeconds: Math.max(0, request.clipEnd - request.clipStart) },
    stages,
    loudnessTarget: { targetI: loudness.targetI, targetTP: loudness.targetTP, targetLRA: loudness.targetLRA },
    render: { reencode: true, ffmpegArgs, outputProbe },
    createdAt: new Date(now()).toISOString(),
  };
}

export async function renderClip(request: RenderRequest, deps: RenderDeps = {}): Promise<RenderResult> {
  const runner = deps.runner ?? defaultProcessRunner;
  const ffmpeg = deps.ffmpegCommand ?? 'ffmpeg';
  const probeCommand = deps.probeCommand ?? 'ffprobe';
  const timeoutMs = deps.timeoutMs ?? 600_000;
  const tolerance = deps.durationToleranceSeconds ?? 0.5;
  const now = deps.now ?? Date.now;
  const captions = resolveCaptionOptions(request.captions);
  const loudness = resolveLoudnessOptions(request.loudness);
  const tighten = resolveTightenOptions(request.tighten);
  const reframe = resolveReframeOptions(request.reframe);
  const coldOpen = resolveColdOpenOptions(request.coldOpen, Math.max(0, request.clipEnd - request.clipStart));
  const pacing = resolvePacingOptions(request.pacing);
  const expectedDuration = Math.max(0, request.clipEnd - request.clipStart) + (coldOpen.enabled ? coldOpen.durationSeconds : 0);
  await mkdir(dirname(request.outputPath), { recursive: true });

  if (!deps.refresh && (await stat(request.outputPath).catch(() => null))) {
    try {
      const probe = await probeMedia(request.outputPath, { command: probeCommand, runner, timeoutMs: 60_000 });
      if (probe.durationSeconds > 0 && Math.abs(probe.durationSeconds - expectedDuration) <= tolerance) {
        return {
          outputPath: request.outputPath, sidecarPath: request.sidecarPath, assPath: null, probe, fromCache: true,
          stages: { tighten: { ran: false, command: tighten.command, args: [], output: null, warning: null }, reframe: { ran: false, filter: null, focusX: reframe.focusX, focusSource: reframe.focusX === null ? 'center' : 'request' }, coldOpen: { ran: false, startSeconds: coldOpen.startSeconds, durationSeconds: coldOpen.durationSeconds }, pacing: { ran: false, segments: 0, cuts: 0, plan: [] }, captions: { ran: false, path: null, cards: 0, warnings: [] }, loudness: { ran: false, measured: null } },
        };
      }
    } catch { /* unreadable; re-render */ }
  }

  const stageReport: RenderStageReport = {
    tighten: { ran: false, command: tighten.command, args: [], output: null, warning: null },
    reframe: { ran: false, filter: null, focusX: reframe.focusX, focusSource: reframe.focusX === null ? 'center' : 'request' },
    coldOpen: { ran: coldOpen.enabled, startSeconds: coldOpen.startSeconds, durationSeconds: coldOpen.durationSeconds },
    pacing: { ran: false, segments: 0, cuts: 0, plan: [] },
    captions: { ran: false, path: null, cards: 0, warnings: [] },
    loudness: { ran: false, measured: null },
  };

  let workingInput = request.inputPath;
  if (tighten.enabled) {
    const tightened = `${request.outputPath}.tightened.mp4`;
    const args = buildTightenArgs(request.inputPath, tightened, tighten);
    stageReport.tighten.args = args;
    try {
      const result = await runner(tighten.command, args, timeoutMs);
      if (result.code === 0 && (await stat(tightened).catch(() => null))) {
        workingInput = tightened;
        stageReport.tighten.ran = true;
        stageReport.tighten.output = tightened;
      } else {
        stageReport.tighten.warning = `${tighten.command} exited ${result.code}; keeping the untightened cut.`;
      }
    } catch (error) {
      stageReport.tighten.warning = `${tighten.command} unavailable (${error instanceof Error ? error.message : String(error)}); keeping the untightened cut.`;
    }
  }

  let assPath: string | null = null;
  let pacingSegments: PacingRenderSegment[] | null = null;
  const canvas = { width: 0, height: 0 };
  if (reframe.enabled) {
    const inputProbe = await probeMedia(workingInput, { command: probeCommand, runner, timeoutMs: 60_000 }).catch(() => null);
    const inputWidth = inputProbe?.width ?? 0;
    const inputHeight = inputProbe?.height ?? 0;
    let focusX = reframe.focusX;
    let focusSource: 'request' | 'face' | 'center' = focusX === null ? 'center' : 'request';
    if (focusX === null && deps.faceDetect !== false) {
      const detected = await detectFocus(workingInput, runner, deps);
      if (detected && detected.focusX !== null) { focusX = detected.focusX; focusSource = 'face'; }
    }
    const filter = buildReframeFilter(inputWidth, inputHeight, { ...reframe, focusX });
    stageReport.reframe = { ran: Boolean(filter), filter, focusX, focusSource };
    if (pacing.enabled) {
      const plan = planPacing(flattenWords(request.transcript), request.clipStart, request.clipEnd, request.pacing);
      if (plan.length > 1) {
        pacingSegments = plan.map(segment => {
          const zoom = Math.min(2, segment.zoom * reframe.zoom);
          return { start: segment.start, duration: segment.duration, zoom, filter: buildReframeFilter(inputWidth, inputHeight, { ...reframe, focusX, zoom }) };
        });
      }
      stageReport.pacing = { ran: pacingSegments !== null, segments: pacingSegments?.length ?? 0, cuts: Math.max(0, (pacingSegments?.length ?? 1) - 1), plan };
    }
    canvas.width = filter ? reframe.targetWidth : inputWidth || DEFAULT_CANVAS.width;
    canvas.height = filter ? reframe.targetHeight : inputHeight || DEFAULT_CANVAS.height;
  } else {
    canvas.width = DEFAULT_CANVAS.width;
    canvas.height = DEFAULT_CANVAS.height;
  }
  if (captions.enabled) {
    const built = buildAss(request.transcript, request.clipStart, request.clipEnd, { ...request.captions, canvas }, coldOpen.enabled ? coldOpen.durationSeconds : 0);
    stageReport.captions.cards = built.cards.length;
    stageReport.captions.warnings = built.warnings;
    if (built.cards.length) {
      await mkdir(dirname(request.assPath), { recursive: true });
      await writeFile(request.assPath, built.ass, 'utf8');
      assPath = request.assPath;
      stageReport.captions.ran = true;
      stageReport.captions.path = request.assPath;
    }
  }

  if (loudness.enabled) {
    const probeArgs = buildLoudnormProbeArgs(workingInput, loudness);
    const measuredRun = await runner(ffmpeg, probeArgs, timeoutMs);
    if (measuredRun.code === 0) {
      const measured = parseLoudnormOutput(measuredRun.stderr);
      if (measured) { stageReport.loudness.ran = true; stageReport.loudness.measured = measured; }
    }
  }

  const args = buildRenderArgs({ inputPath: workingInput, outputPath: request.outputPath, assPath, reframeFilter: stageReport.reframe.filter, segments: pacingSegments, coldOpen: coldOpen.enabled ? { startSeconds: coldOpen.startSeconds, durationSeconds: coldOpen.durationSeconds } : null, loudness, measured: stageReport.loudness.measured });
  const result = await runner(ffmpeg, args, timeoutMs);
  if (result.code !== 0) {
    throw new Error(`render ffmpeg failed (exit ${result.code}): ${result.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500) || 'no stderr'}`);
  }
  const probe = await probeMedia(request.outputPath, { command: probeCommand, runner, timeoutMs: 60_000 });
  if (!(probe.durationSeconds > 0)) {
    throw new Error(`render produced a zero-length clip at ${request.outputPath} (ffprobe duration ${probe.durationSeconds}).`);
  }
  const delta = Math.abs(probe.durationSeconds - expectedDuration);
  if (delta > tolerance) {
    throw new Error(`Render duration mismatch: expected ${expectedDuration.toFixed(3)}s, ffprobe reports ${probe.durationSeconds.toFixed(3)}s (delta ${delta.toFixed(3)}s > ${tolerance}s).`);
  }
  await writeFile(request.sidecarPath, JSON.stringify(buildSidecar(request, probe, stageReport, loudness, args, now), null, 2), 'utf8');
  return { outputPath: request.outputPath, sidecarPath: request.sidecarPath, assPath, probe, stages: stageReport, fromCache: false };
}

export function renderOutputPaths(outDir: string, base: string): { outputPath: string; sidecarPath: string; assPath: string } {
  return {
    outputPath: join(outDir, `${base}.vertical.mp4`),
    sidecarPath: join(outDir, `${base}.vertical.json`),
    assPath: join(outDir, `${base}.vertical.ass`),
  };
}
