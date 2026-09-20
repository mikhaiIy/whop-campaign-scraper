import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReframeFilter, buildRenderArgs, planPacing, renderClip, renderOutputPaths, resolvePacingOptions,
} from '../dist/clipping/render.js';

const wordsWithStops = (count = 40, step = 0.5, every = 8) => {
  const words = [];
  for (let index = 0; index < count; index++) {
    const start = index * step;
    words.push({ start, end: start + step * 0.8, word: index % every === every - 1 ? `w${index}.` : `w${index}`, probability: 0.9 });
  }
  return { videoId: 'v', model: 'large-v3', device: 'cuda', computeType: 'int8_float16', language: 'en', durationSeconds: count * step, offsetSeconds: 0, segments: [{ start: 0, end: count * step, text: 'x', words }] };
};

const flatWords = (count = 20, step = 0.5) => {
  const words = [];
  for (let index = 0; index < count; index++) {
    const start = index * step;
    words.push({ start, end: start + step * 0.8, word: `w${index}`, probability: 0.9 });
  }
  return words;
};

test('resolvePacingOptions applies defaults and clamps', () => {
  const defaults = resolvePacingOptions({});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.maxSecondsBetweenCuts, 5.5);
  assert.equal(defaults.minSecondsBetweenCuts, 2.5);
  assert.equal(defaults.zoomAmount, 0.15);
  const clamped = resolvePacingOptions({ minSecondsBetweenCuts: 9, maxSecondsBetweenCuts: 1, zoomAmount: 9 });
  assert.equal(clamped.minSecondsBetweenCuts, 8);
  assert.equal(clamped.maxSecondsBetweenCuts, 8);
  assert.equal(clamped.zoomAmount, 0.5);
});

test('planPacing places cuts on sentence starts and covers the clip', () => {
  const plan = planPacing(wordsWithStops().segments[0].words, 0, 20, { enabled: true });
  assert.equal(plan.length, 5);
  assert.deepEqual(plan.map(segment => segment.zoom), [1, 1.15, 1, 1.15, 1]);
  assert.deepEqual(plan.map(segment => Number(segment.start.toFixed(2))), [0, 4, 8, 12, 16]);
  const total = plan.reduce((sum, segment) => sum + segment.duration, 0);
  assert.ok(Math.abs(total - 20) < 1e-9);
});

test('planPacing forces a cut at the ceiling when no boundary exists', () => {
  const plan = planPacing(flatWords(), 0, 10, { enabled: true });
  assert.equal(plan.length, 2);
  assert.equal(plan[0].duration, 5.5);
  assert.ok(Math.abs(plan[1].duration - 4.5) < 1e-9);
  assert.equal(plan[1].zoom, 1.15);
});

test('planPacing stays off for short clips and when disabled', () => {
  assert.deepEqual(planPacing(flatWords(), 0, 2, { enabled: true }), []);
  assert.deepEqual(planPacing(flatWords(), 0, 20, { enabled: false }), []);
});

test('buildReframeFilter punches in when zoom is above one', () => {
  const base = { enabled: true, targetWidth: 1080, targetHeight: 1920, focusX: null, zoom: 1 };
  assert.match(buildReframeFilter(1920, 1080, { ...base, zoom: 1.2 }), /^scale=4096:2304,crop=1080:1920:1508:192$/);
  assert.equal(buildReframeFilter(1920, 1080, base), 'scale=3414:1920,crop=1080:1920:1168:0');
});

test('buildRenderArgs concatenates paced segments and maps the audio', () => {
  const args = buildRenderArgs({
    inputPath: '/in.mp4', outputPath: '/out.mp4', assPath: '/subs.ass', reframeFilter: null,
    segments: [
      { start: 0, duration: 5, zoom: 1, filter: null },
      { start: 5, duration: 5, zoom: 1.15, filter: 'scale=4096:2304,crop=1080:1920:1508:192' },
    ],
    loudness: { enabled: true, targetI: -14, targetTP: -1.5, targetLRA: 11, linear: true },
  });
  const joined = args.join(' ');
  assert.ok(joined.includes('-filter_complex'));
  assert.ok(joined.includes('trim=start=0:duration=5'));
  assert.ok(joined.includes('trim=start=5:duration=5'));
  assert.ok(joined.includes('concat=n=2:v=1:a=0'));
  assert.ok(joined.includes('[vcat]subtitles=filename='));
  assert.ok(joined.includes('-map [vout]'));
  assert.ok(joined.includes('[0:a]asetpts=PTS-STARTPTS[acat]'));
  assert.ok(joined.includes('[acat]loudnorm=I=-14'));
});

test('renderClip paces the clip and reports the plan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pacing-'));
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
      stdout: JSON.stringify({ format: { duration: '13', size: '9' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: landscape ? 1920 : 1080, height: landscape ? 1080 : 1920, avg_frame_rate: '30/1' }, { codec_type: 'audio', codec_name: 'aac' }] }),
      stderr: '', code: 0, timedOut: false,
    };
  };
  const paths = renderOutputPaths(dir, '0.50-13.50');
  const result = await renderClip({
    campaignId: 'c', videoId: 'v', inputPath: join(dir, 'in.mp4'), ...paths,
    transcript: wordsWithStops(), clipStart: 0.5, clipEnd: 13.5,
    captions: { enabled: true }, loudness: { enabled: true }, pacing: { enabled: true },
  }, { runner, now: () => 0 });
  assert.equal(result.stages.pacing.ran, true);
  assert.equal(result.stages.pacing.segments, 4);
  assert.equal(result.stages.pacing.cuts, 3);
  assert.match(state.renderArgs.join(' '), /-filter_complex .*concat=n=4:v=1:a=0/);
});
