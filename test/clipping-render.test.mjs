import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAss, buildCaptionCards, buildLoudnormProbeArgs, buildRenderArgs, buildTightenArgs,
  formatAssTime, parseLoudnormOutput, renderClip, resolveCaptionOptions, renderOutputPaths,
} from '../dist/clipping/render.js';

const makeTranscript = (videoId = 'v', durationSeconds = 6, step = 0.5) => {
  const words = [];
  for (let start = 0; start < durationSeconds; start += step) {
    words.push({ start, end: Math.min(start + step, durationSeconds), word: `word${Math.round(start / step)}`, probability: 0.9 });
  }
  return { videoId, model: 'large-v3', device: 'cuda', computeType: 'int8_float16', language: 'en', durationSeconds, offsetSeconds: 0, segments: [{ start: 0, end: durationSeconds, text: 'x', words }] };
};

test('formatAssTime renders centisecond timestamps', () => {
  assert.equal(formatAssTime(0), '0:00:00.00');
  assert.equal(formatAssTime(61.5), '0:01:01.50');
  assert.equal(formatAssTime(3600), '1:00:00.00');
  assert.equal(formatAssTime(-4), '0:00:00.00');
});

test('resolveCaptionOptions clamps and applies safe-box defaults', () => {
  const opts = resolveCaptionOptions({ maxWordsPerCard: 99, fontSize: 5, keywordColor: '#ff8800' });
  assert.equal(opts.maxWordsPerCard, 6);
  assert.equal(opts.fontSize, 24);
  assert.deepEqual(opts.safeBox, { marginLeft: 130, marginRight: 190, marginBottom: 672 });
});

test('buildCaptionCards groups words and splits on long gaps', () => {
  const words = [
    { start: 0, end: 0.3, word: 'a', probability: null },
    { start: 0.3, end: 0.6, word: 'b', probability: null },
    { start: 0.6, end: 0.9, word: 'c', probability: null },
    { start: 5.0, end: 5.3, word: 'd', probability: null },
  ];
  const cards = buildCaptionCards(words, { maxWordsPerCard: 2, maxGapSeconds: 0.7 });
  assert.equal(cards.length, 3);
  assert.equal(cards[0].words.length, 2);
  assert.equal(cards[1].words.length, 1);
  assert.equal(cards[2].words[0].word, 'd');
});

test('buildAss emits karaoke captions inside the safe box', () => {
  const { ass, cards } = buildAss(makeTranscript(), 0, 6, { maxWordsPerCard: 2 });
  assert.ok(cards.length >= 3);
  assert.match(ass, /\[V4\+ Styles\]/);
  assert.match(ass, /Style: Caption,DejaVu Sans,72,/);
  assert.match(ass, /,2,130,190,672,1/);
  assert.match(ass, /Dialogue: 0,0:00:00\.00,/);
  assert.match(ass, /\{\\k\d+\}/);
  assert.match(ass, /&H0000E5FF/);
});

test('buildAss shifts times relative to the clip start and warns on fast captions', () => {
  const transcript = makeTranscript('v', 6, 0.5);
  const { cards, warnings } = buildAss(transcript, 3, 6, { maxWordsPerCard: 1 });
  assert.ok(cards[0].start < 0.5);
  assert.ok(warnings.every(w => typeof w === 'string'));
});

test('parseLoudnormOutput extracts the JSON block from stderr', () => {
  const stderr = 'noise\n{ "input_i" : "-18.5", "input_tp" : "-2.1", "input_lra" : "5.0", "input_thresh" : "-28.4", "target_offset" : "0.4" }\ntrailing';
  const parsed = parseLoudnormOutput(stderr);
  assert.deepEqual(parsed, { input_i: -18.5, input_tp: -2.1, input_lra: 5, input_thresh: -28.4, target_offset: 0.4 });
  assert.equal(parseLoudnormOutput('nothing here'), null);
});

test('buildLoudnormProbeArgs and buildRenderArgs carry the short-form target', () => {
  const loudness = { enabled: true, targetI: -14, targetTP: -1.5, targetLRA: 11, linear: true };
  assert.ok(buildLoudnormProbeArgs('/in.mp4', loudness).join(' ').includes('loudnorm=I=-14:TP=-1.5:LRA=11'));
  const withSubs = buildRenderArgs({ inputPath: '/in.mp4', outputPath: '/out.mp4', assPath: '/subs.ass', loudness, measured: { input_i: -18.5, input_tp: -2.1, input_lra: 5, input_thresh: -28.4, target_offset: 0.4 } });
  const joined = withSubs.join(' ');
  assert.ok(joined.includes("subtitles=filename='/subs.ass'"));
  assert.ok(joined.includes('measured_I=-18.5'));
  assert.ok(joined.includes('+faststart'));
});

test('buildTightenArgs targets auto-editor with a margin', () => {
  const args = buildTightenArgs('/in.mp4', '/out.mp4', { enabled: true, marginSeconds: 0.2, threshold: 0.04, command: 'auto-editor' });
  assert.equal(args[0], '/in.mp4');
  assert.ok(args.includes('--output'));
  assert.ok(args.join(' ').includes('--margin 0.2s'));
});

test('renderClip tightens, captions, normalizes, and writes a sidecar', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'render-'));
  await writeFile(join(dir, 'in.mp4'), 'fake');
  const state = { calls: [], durations: new Map() };
  const runner = async (command, args) => {
    state.calls.push({ command, args });
    if (command === 'auto-editor') {
      const output = args[args.indexOf('--output') + 1];
      await writeFile(output, 'tight');
      return { stdout: '', stderr: '', code: 0, timedOut: false };
    }
    if (command === 'ffmpeg' && args.includes('-f') && args[args.indexOf('-f') + 1] === 'null') {
      return { stdout: '', stderr: '{ "input_i" : "-20", "input_tp" : "-3", "input_lra" : "4", "input_thresh" : "-30", "target_offset" : "0.5" }', code: 0, timedOut: false };
    }
    if (command === 'ffmpeg') {
      const output = args[args.length - 1];
      state.durations.set(output, 5);
      await writeFile(output, 'rendered');
      return { stdout: '', stderr: '', code: 0, timedOut: false };
    }
    const path = args[args.length - 1];
    const duration = state.durations.get(path) ?? 5;
    return {
      stdout: JSON.stringify({ format: { duration: String(duration), size: '9' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, avg_frame_rate: '30/1' }, { codec_type: 'audio', codec_name: 'aac' }] }),
      stderr: '', code: 0, timedOut: false,
    };
  };
  const paths = renderOutputPaths(dir, '0.00-5.00');
  const result = await renderClip({
    campaignId: 'c', videoId: 'v', inputPath: join(dir, 'in.mp4'), ...paths,
    transcript: makeTranscript('v', 6, 0.5), clipStart: 0.5, clipEnd: 5.5,
    captions: { enabled: true }, loudness: { enabled: true }, tighten: { enabled: true, command: 'auto-editor' },
  }, { runner, now: () => 0 });
  assert.equal(result.fromCache, false);
  assert.equal(result.stages.tighten.ran, true);
  assert.equal(result.stages.captions.ran, true);
  assert.ok(result.stages.captions.cards > 0);
  assert.equal(result.stages.loudness.ran, true);
  const sidecar = JSON.parse(await readFile(paths.sidecarPath, 'utf8'));
  assert.equal(sidecar.render.reencode, true);
  assert.equal(sidecar.loudnessTarget.targetI, -14);
  assert.equal(sidecar.stages.loudness.measured.input_i, -20);
  const commands = state.calls.map(call => call.command);
  assert.ok(commands.includes('auto-editor'));
});

test('renderClip reframes a landscape cut to 9:16 and authors captions for it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reframe-'));
  await writeFile(join(dir, 'in.mp4'), 'fake');
  const state = { renderArgs: null };
  const runner = async (command, args) => {
    if (command === 'ffmpeg' && args.includes('-f') && args[args.indexOf('-f') + 1] === 'null') {
      return { stdout: '', stderr: '{ "input_i" : "-20", "input_tp" : "-3", "input_lra" : "4", "input_thresh" : "-30", "target_offset" : "0.5" }', code: 0, timedOut: false };
    }
    if (command === 'ffmpeg') {
      state.renderArgs = args;
      await writeFile(args[args.length - 1], 'rendered');
      return { stdout: '', stderr: '', code: 0, timedOut: false };
    }
    const path = args[args.length - 1];
    const landscape = path.endsWith('in.mp4');
    return {
      stdout: JSON.stringify({ format: { duration: '5', size: '9' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: landscape ? 1920 : 1080, height: landscape ? 1080 : 1920, avg_frame_rate: '30/1' }, { codec_type: 'audio', codec_name: 'aac' }] }),
      stderr: '', code: 0, timedOut: false,
    };
  };
  const paths = renderOutputPaths(dir, '0.00-5.00');
  const result = await renderClip({
    campaignId: 'c', videoId: 'v', inputPath: join(dir, 'in.mp4'), ...paths,
    transcript: makeTranscript('v', 6, 0.5), clipStart: 0.5, clipEnd: 5.5,
    captions: { enabled: true }, loudness: { enabled: true },
  }, { runner, now: () => 0 });
  assert.equal(result.stages.reframe.ran, true);
  assert.match(state.renderArgs.join(' '), /-vf scale=\d+:\d+,crop=1080:1920:\d+:\d+,subtitles=filename=/);
  const ass = await readFile(paths.assPath, 'utf8');
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
});

test('renderClip offsets the reframe crop to the detected face', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'focus-'));
  await writeFile(join(dir, 'in.mp4'), 'fake');
  const pythonPath = join(dir, 'python');
  const focusScript = join(dir, 'focus.py');
  await writeFile(pythonPath, '');
  await writeFile(focusScript, '');
  const state = { renderArgs: null };
  const runner = async (command, args) => {
    if (command === pythonPath) return { stdout: '{"focusX":0.8,"faces":6,"frames":6}', stderr: '', code: 0, timedOut: false };
    if (command === 'ffmpeg' && args.includes('-f') && args[args.indexOf('-f') + 1] === 'null') {
      return { stdout: '', stderr: '{ "input_i" : "-20", "input_tp" : "-3", "input_lra" : "4", "input_thresh" : "-30", "target_offset" : "0.5" }', code: 0, timedOut: false };
    }
    if (command === 'ffmpeg') {
      state.renderArgs = args;
      await writeFile(args[args.length - 1], 'rendered');
      return { stdout: '', stderr: '', code: 0, timedOut: false };
    }
    return {
      stdout: JSON.stringify({ format: { duration: '5', size: '9' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1' }, { codec_type: 'audio', codec_name: 'aac' }] }),
      stderr: '', code: 0, timedOut: false,
    };
  };
  const paths = renderOutputPaths(dir, '0.00-5.00');
  const result = await renderClip({
    campaignId: 'c', videoId: 'v', inputPath: join(dir, 'in.mp4'), ...paths,
    transcript: makeTranscript('v', 6, 0.5), clipStart: 0.5, clipEnd: 5.5,
    captions: { enabled: true }, loudness: { enabled: true },
  }, { runner, now: () => 0, pythonPath, focusScript });
  assert.equal(result.stages.reframe.focusSource, 'face');
  assert.equal(result.stages.reframe.focusX, 0.8);
  assert.match(state.renderArgs.join(' '), /crop=1080:1920:2192:0/);
});
