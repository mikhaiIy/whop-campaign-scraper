import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEbur128, parseSceneChanges, loudnessPeaks, cutDensity, summarize,
  energyAt, peakTimeWithin, sourcePotential, topEnergyWindows, EMPTY_SIGNALS,
} from '../dist/clipping/signals.js';
import {
  scoreCandidate, annotateSignals, applyPayoffGate, refineHookStart, buildMomentPrompt, planWindows,
} from '../dist/clipping/moments.js';
import { clippabilityScore, rankFootage } from '../dist/clipping/youtube.js';
import { buildCaptionCards } from '../dist/clipping/render.js';

const signalLine = (t, m) => `[Parsed_ebur128_0 @ 0x1] t: ${t} TARGET:-23 LUFS    M:${m} S:${m}     I: -70.0 LUFS       LRA:   0.0 LU`;

const signalsFrom = (samples) => {
  const loudness = samples.map(([t, m]) => ({ t, m }));
  const { medianLoudness, dynamicRangeDb } = summarize(loudness);
  return { durationSeconds: samples.at(-1)?.[0] ?? 0, loudness, loudPeaks: loudnessPeaks(loudness), sceneCuts: [], cutDense: [], medianLoudness, dynamicRangeDb };
};

test('parseEbur128 and parseSceneChanges read ffmpeg output', () => {
  const loud = parseEbur128(`${signalLine(0.1, -120.7)}\n${signalLine(0.4, -16.2)}\n`);
  assert.deepEqual(loud, [{ t: 0.1, m: -120.7 }, { t: 0.4, m: -16.2 }]);
  const cuts = parseSceneChanges('[Parsed_showinfo_1] n:0 pts_time:1.25 ...\n[Parsed_showinfo_1] n:1 pts_time:3.5 ...\n[Parsed_showinfo_1] n:2 pts_time:1.25 ...');
  assert.deepEqual(cuts, [1.25, 3.5]);
});

test('loudnessPeaks finds sustained bursts above the median', () => {
  const samples = [];
  for (let t = 0; t < 60; t += 0.1) samples.push({ t, m: t > 20 && t < 24 ? -12 : -22 });
  const peaks = loudnessPeaks(samples);
  assert.equal(peaks.length, 1);
  assert.ok(peaks[0].start >= 20 && peaks[0].start <= 20.5);
  assert.ok(peaks[0].end >= 23.5 && peaks[0].end <= 24);
});

test('cutDensity marks windows with clustered scene changes', () => {
  const dense = cutDensity([10, 10.5, 11, 11.5, 12, 12.5, 40, 80]);
  assert.equal(dense.length, 1);
  assert.ok(dense[0].start <= 10.5 && dense[0].end >= 12.5);
});

test('sourcePotential grades a flat mix as low and a dynamic one as high', () => {
  const flat = signalsFrom(Array.from({ length: 200 }, (_, i) => [i * 0.1, -18 + (i % 3)]));
  assert.equal(sourcePotential(flat).level, 'low');
  const dynamic = signalsFrom(Array.from({ length: 400 }, (_, i) => [i * 0.1, i > 20 && i < 80 ? -8 : -22]));
  assert.ok(['medium', 'high'].includes(sourcePotential(dynamic).level));
  assert.equal(sourcePotential(EMPTY_SIGNALS).level, 'low');
});

test('energyAt and peakTimeWithin read a range', () => {
  const signals = signalsFrom([[0, -20], [1, -20], [2, -10], [3, -20], [4, -20]]);
  assert.ok(Math.abs(energyAt(signals, 1.9, 2.1) - -10) < 1e-9);
  assert.equal(peakTimeWithin(signals, 0, 4), 2);
  assert.equal(energyAt(signals, 50, 60), null);
});

test('scoreCandidate blends the rubric with audio energy', () => {
  const candidate = { start: 0, end: 10, reason: 'r', hookRating: 8, rulesChecked: [], emotion: 5, stakes: 5, curiosity: 5, payoff: 5 };
  const withoutSignals = scoreCandidate(candidate);
  assert.ok(withoutSignals > 0.7 && withoutSignals <= 1);
  const quiet = signalsFrom(Array.from({ length: 120 }, (_, i) => [i * 0.1, -22]));
  const loud = signalsFrom(Array.from({ length: 120 }, (_, i) => [i * 0.1, -22]).map(([t, m], i) => [t, i > 20 && i < 40 ? -8 : m]));
  assert.ok(scoreCandidate(candidate, loud) > scoreCandidate(candidate, quiet));
});

test('annotateSignals attaches energy, peak and a virality score', () => {
  const signals = signalsFrom([[0, -20], [5, -8], [10, -20]]);
  const [annotated] = annotateSignals([{ start: 0, end: 10, reason: 'r', hookRating: 7, rulesChecked: [] }], signals);
  assert.equal(annotated.signalPeakSeconds, 5);
  assert.ok(typeof annotated.viralityScore === 'number' && annotated.viralityScore > 0);
});

test('applyPayoffGate drops context-dependent and payoff-less candidates', () => {
  const keep = { start: 0, end: 10, reason: 'r', hookRating: 7, rulesChecked: [], selfContained: true, payoffLine: 'and that is why' };
  const context = { start: 20, end: 30, reason: 'r', hookRating: 7, rulesChecked: [], selfContained: false };
  const noPayoff = { start: 40, end: 50, reason: 'r', hookRating: 7, rulesChecked: [], payoffLine: '', payoff: 1 };
  const legacy = { start: 60, end: 70, reason: 'r', hookRating: 7, rulesChecked: [] };
  const result = applyPayoffGate([keep, context, noPayoff, legacy]);
  assert.deepEqual(result.candidates.map(c => c.start), [0, 60]);
  assert.equal(result.dropped.length, 2);
});

test('refineHookStart moves the start to the loudest instant, then the hook line', () => {
  const signals = signalsFrom([[0, -22], [1, -22], [4, -8], [6, -22]]);
  const candidate = { start: 0, end: 10, reason: 'r', hookRating: 8, rulesChecked: [] };
  const moved = refineHookStart(candidate, { videoId: 'v', model: 'm', device: 'c', computeType: 'x', language: 'en', durationSeconds: 10, offsetSeconds: 0, segments: [] }, signals);
  assert.equal(moved.moved, true);
  assert.ok(Math.abs(moved.start - 3.6) < 1e-9, `expected 3.6, got ${moved.start}`);
  const noSignals = refineHookStart(candidate, { videoId: 'v', model: 'm', device: 'c', computeType: 'x', language: 'en', durationSeconds: 10, offsetSeconds: 0, segments: [] }, undefined);
  assert.equal(noSignals.moved, false);
});

test('buildMomentPrompt adds the energy section and the payoff schema when signals exist', () => {
  const transcript = { videoId: 'v', model: 'm', device: 'c', computeType: 'x', language: 'en', durationSeconds: 20, offsetSeconds: 0, segments: [{ start: 0, end: 20, text: 'hello world', words: [] }] };
  const { windows } = planWindows(transcript.segments, { windowSeconds: 600 });
  const signals = signalsFrom(Array.from({ length: 200 }, (_, i) => [i * 0.1, i > 50 && i < 70 ? -8 : -22]));
  const prompt = buildMomentPrompt(windows[0], {}, { minSeconds: 20, maxSeconds: 60, assumptions: [] }, signals);
  assert.match(prompt, /## Audio energy/);
  assert.match(prompt, /payoffLine/);
  assert.match(prompt, /momentType/);
  assert.match(prompt, /"rulesChecked"/);
  assert.ok(topEnergyWindows(signals).length >= 1);
});

test('clippabilityScore prefers reactions and penalises tutorials', () => {
  const base = { id: 'x', uploadDate: null, url: '', channel: null, viewCount: 0 };
  const reaction = clippabilityScore({ ...base, title: 'TJR Reacts to Drake', durationSeconds: 1200 });
  const tutorial = clippabilityScore({ ...base, title: '5 Tips That Made Me Rich (How To Guide)', durationSeconds: 3000 });
  assert.ok(reaction.score > tutorial.score);
  const ranked = rankFootage([
    { ...base, id: 'a', title: 'A Guide For Beginners', durationSeconds: 3000, viewCount: 100 },
    { ...base, id: 'b', title: 'Live Stream Highlights', durationSeconds: 200, viewCount: 5 },
  ]);
  assert.equal(ranked[0].id, 'b');
});

test('buildCaptionCards merges cards that would flash by too fast', () => {
  const words = [
    { start: 0.0, end: 0.15, word: 'a', probability: null },
    { start: 0.15, end: 0.3, word: 'b', probability: null },
    { start: 0.3, end: 0.45, word: 'c', probability: null },
    { start: 5.0, end: 5.15, word: 'd', probability: null },
  ];
  const plain = buildCaptionCards(words, { maxWordsPerCard: 2, maxGapSeconds: 0.7 });
  assert.equal(plain.length, 3);
  const paced = buildCaptionCards(words, { maxWordsPerCard: 3, maxGapSeconds: 0.7, minDurationSeconds: 0.4 });
  assert.ok(paced.every(card => card.end - card.start >= 0.4 || card.words.length >= 3));
  assert.ok(paced.length <= plain.length);
});
