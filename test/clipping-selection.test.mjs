import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyHookGate, buildRerankPrompt, dedupeCandidates, mmrSelect, parseRerank,
  rerankCandidates, textCosine, timeIoU,
} from '../dist/clipping/moments.js';
import { buildReframeFilter, buildRenderArgs, resolveCaptionOptions, buildAss } from '../dist/clipping/render.js';

const candidate = (start, end, hookRating, reason = 'r') => ({ start, end, hookRating, reason, rulesChecked: [] });

const transcriptWith = (words) => ({
  videoId: 'v', model: 'test', device: 'cpu', computeType: 'int8', language: 'en',
  durationSeconds: words.at(-1)?.end ?? 10, offsetSeconds: 0,
  segments: [{ start: 0, end: words.at(-1)?.end ?? 10, text: words.map(w => w.word).join(' '), words }],
});

test('textCosine scores identical text at 1 and disjoint text at 0', () => {
  assert.equal(textCosine('the quick brown fox', 'the quick brown fox'), 1);
  assert.equal(textCosine('alpha beta', 'gamma delta'), 0);
  const partial = textCosine('the quick brown fox', 'the quick red fox');
  assert.ok(partial > 0 && partial < 1);
});

test('timeIoU measures overlap over union', () => {
  assert.equal(timeIoU({ start: 0, end: 10 }, { start: 0, end: 10 }), 1);
  assert.equal(timeIoU({ start: 0, end: 10 }, { start: 10, end: 20 }), 0);
  assert.equal(timeIoU({ start: 0, end: 10 }, { start: 5, end: 15 }), 5 / 15);
});

test('dedupeCandidates removes overlaps and near-duplicate transcripts', () => {
  const text = new Map();
  const candidates = [
    candidate(0, 10, 9),
    candidate(1, 11, 8),   // overlaps the first (IoU 9/11 > 0.5)
    candidate(40, 50, 7),
    candidate(60, 70, 6),
  ];
  text.set(candidates[0], 'the quick brown fox jumps over the lazy dog again and again');
  text.set(candidates[1], 'the quick brown fox jumps over the lazy dog again and again');
  text.set(candidates[2], 'a completely different topic about cooking pasta');
  text.set(candidates[3], 'the quick brown fox jumps over the lazy dog again and again');
  const kept = dedupeCandidates(candidates, c => text.get(c));
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map(c => c.start), [0, 40]);
});

test('mmrSelect trades relevance for diversity', () => {
  const text = new Map();
  const candidates = [candidate(0, 10, 10), candidate(0, 10, 9), candidate(0, 10, 8)];
  text.set(candidates[0], 'one topic about cars and engines and speed');
  text.set(candidates[1], 'one topic about cars and engines and speed');
  text.set(candidates[2], 'an unrelated topic about baking sourdough bread at home');
  const similarity = (a, b) => textCosine(text.get(a), text.get(b));

  const relevantOnly = mmrSelect(candidates, { limit: 1, lambda: 1, similarity });
  assert.equal(relevantOnly[0].hookRating, 10);

  const diverse = mmrSelect(candidates, { limit: 2, lambda: 0.7, similarity });
  assert.equal(diverse[0].hookRating, 10);
  assert.equal(diverse[1].hookRating, 8, 'the diverse candidate beats the near-duplicate one');
});

test('applyHookGate drops weak ratings and silent openings', () => {
  const transcript = transcriptWith([
    { start: 0.0, end: 1.0, word: 'hook', probability: null },
    { start: 1.0, end: 2.0, word: 'line', probability: null },
    { start: 2.0, end: 3.0, word: 'now', probability: null },
    { start: 20.0, end: 21.0, word: 'quiet', probability: null },
  ]);
  const strong = candidate(0, 4, 8);
  const weakRating = candidate(0, 4, 2);
  const silent = candidate(19, 22, 8);
  const result = applyHookGate([strong, weakRating, silent], transcript);
  assert.deepEqual(result.candidates.map(c => c.start), [0]);
  assert.equal(result.dropped.length, 2);
  assert.ok(result.warnings.length >= 2);
});

test('parseRerank rejects out-of-range and non-numeric entries', () => {
  const { ratings, warnings } = parseRerank('{"ratings":[{"index":0,"hookRating":9},{"index":5,"hookRating":3},{"index":1,"hookRating":"x"}]}', 2);
  assert.equal(ratings.get(0), 9);
  assert.equal(ratings.has(5), false);
  assert.equal(ratings.has(1), false);
  assert.equal(warnings.length, 2);
});

test('rerankCandidates updates ratings and keeps the first-pass score', async () => {
  const transcript = transcriptWith([
    { start: 0, end: 1, word: 'a', probability: null },
    { start: 1, end: 2, word: 'b', probability: null },
  ]);
  const llm = { id: 'fake', model: 'fake', complete: async () => '{"ratings":[{"index":0,"hookRating":10},{"index":1,"hookRating":3}]}' };
  const spec = {};
  const result = await rerankCandidates(llm, [candidate(0, 2, 5), candidate(3, 5, 6)], transcript, spec);
  assert.equal(result.applied, true);
  assert.equal(result.candidates[0].hookRating, 10);
  assert.equal(result.candidates[0].initialHookRating, 5);
  assert.equal(result.candidates[1].hookRating, 3);
});

test('rerankCandidates keeps the original ratings when the model fails', async () => {
  const transcript = transcriptWith([{ start: 0, end: 1, word: 'a', probability: null }]);
  const llm = { id: 'fake', model: 'fake', complete: async () => { throw new Error('offline'); } };
  const result = await rerankCandidates(llm, [candidate(0, 2, 5), candidate(3, 5, 6)], transcript, {});
  assert.equal(result.applied, false);
  assert.deepEqual(result.candidates.map(c => c.hookRating), [5, 6]);
  assert.match(result.warnings[0], /Rerank pass failed/);
});

test('buildRerankPrompt lists candidates with their current ratings', () => {
  const transcript = transcriptWith([{ start: 0, end: 1, word: 'hello', probability: null }]);
  const prompt = buildRerankPrompt([candidate(0, 2, 7)], transcript, {});
  assert.match(prompt, /current hookRating 7/);
  assert.match(prompt, /ratings/);
});

test('buildReframeFilter scale-covers a landscape input into 9:16', () => {
  const options = { enabled: true, targetWidth: 1080, targetHeight: 1920, focusX: null };
  assert.equal(buildReframeFilter(1920, 1080, options), 'scale=3414:1920,crop=1080:1920:1168:0');
  assert.equal(buildReframeFilter(1080, 1920, options), null);
  assert.equal(buildReframeFilter(1920, 1080, { ...options, focusX: 0 }), 'scale=3414:1920,crop=1080:1920:0:0');
  assert.equal(buildReframeFilter(0, 0, options), null);
});

test('buildRenderArgs chains the reframe filter before the subtitles filter', () => {
  const args = buildRenderArgs({
    inputPath: '/in.mp4', outputPath: '/out.mp4', assPath: '/subs.ass',
    reframeFilter: 'scale=3414:1920,crop=1080:1920:1168:0',
    loudness: { enabled: true, targetI: -14, targetTP: -1.5, targetLRA: 11, linear: true },
  });
  assert.ok(args.join(' ').includes('-vf scale=3414:1920,crop=1080:1920:1168:0,subtitles=filename=\'/subs.ass\''));
});

test('resolveCaptionOptions scales captions to a non-vertical canvas', () => {
  const opts = resolveCaptionOptions({ canvas: { width: 1920, height: 1080 } });
  assert.equal(opts.fontSize, 41);
  assert.deepEqual(opts.safeBox, { marginLeft: 231, marginRight: 338, marginBottom: 378 });
  const ass = buildAss(transcriptWith([{ start: 0, end: 1, word: 'x', probability: null }]), 0, 1, { canvas: { width: 1920, height: 1080 } }).ass;
  assert.match(ass, /PlayResX: 1920/);
  assert.match(ass, /PlayResY: 1080/);
});
