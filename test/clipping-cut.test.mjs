import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFfprobeJson, toFileRelative, formatSectionArg, probeMedia } from '../dist/clipping/media.js';
import { parseTranscriptJson, shiftTranscript, transcriptDuration } from '../dist/clipping/transcribe.js';
import {
  resolveDurationBounds, buildMomentPrompt, parseMomentSelection, planWindows,
  selectMoments, snapCandidate, transcriptExcerpt,
} from '../dist/clipping/moments.js';
import { buildCutArgs, cutClip } from '../dist/clipping/cut.js';
import { ClipAssembler, mergeRanges } from '../dist/clipping/clipper.js';

const makeTranscript = (videoId, durationSeconds = 10, step = 0.4) => {
  const words = [];
  for (let start = 0; start < durationSeconds; start += step) {
    words.push({ start, end: Math.min(start + step, durationSeconds), word: `w${Math.round(start / step)}`, probability: 0.9 });
  }
  return { videoId, model: 'large-v3', device: 'cuda', computeType: 'int8_float16', language: 'en', durationSeconds, offsetSeconds: 0, segments: [{ start: 0, end: durationSeconds, text: 'hello world', words }] };
};

const emptySpec = (overrides = {}) => ({
  campaignId: 'c', extractedAt: new Date(0).toISOString(), extractor: { provider: 'fake', model: null, promptVersion: 'v1' },
  minDurationSeconds: null, maxDurationSeconds: null, contentSelectionGuidance: null, forbiddenContent: null,
  forbiddenRules: null, hookPolicy: null, editingRules: null, language: null, unstructuredRequirements: [], ...overrides,
});

const cutState = () => ({ calls: [], durations: new Map() });
const cutRunner = (state) => async (command, args) => {
  state.calls.push({ command, args });
  if (command === 'ffmpeg') {
    const output = args[args.length - 1];
    state.durations.set(output, Number(args[args.indexOf('-t') + 1]));
    await writeFile(output, 'fake-mp4');
    return { stdout: '', stderr: '', code: 0, timedOut: false };
  }
  const path = args[args.length - 1];
  const duration = state.durations.get(path) ?? 0;
  return {
    stdout: JSON.stringify({ format: { duration: String(duration), size: '8' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, avg_frame_rate: '30/1' }, { codec_type: 'audio', codec_name: 'aac' }] }),
    stderr: '', code: 0, timedOut: false,
  };
};

test('ffprobe json parses streams and section timebase helpers are pure', () => {
  const probe = parseFfprobeJson(JSON.stringify({
    format: { duration: '736.48', size: '123456' },
    streams: [
      { codec_type: 'audio', codec_name: 'aac' },
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001' },
    ],
  }));
  assert.equal(probe.durationSeconds, 736.48);
  assert.equal(probe.width, 1920);
  assert.ok(Math.abs(probe.fps - 29.97002997) < 1e-6);
  assert.equal(probe.hasVideo, true);
  assert.equal(probe.hasAudio, true);
  assert.equal(toFileRelative(150, { start: 100, end: 160 }), 50);
  assert.equal(formatSectionArg({ start: 100, end: 160.5 }), '*100.000-160.500');
});

test('transcript shifting makes section-relative times source-absolute', () => {
  const relative = makeTranscript('v', 5, 1);
  const shifted = shiftTranscript(relative, 100);
  assert.equal(shifted.offsetSeconds, 100);
  assert.equal(shifted.segments[0].start, 100);
  assert.equal(shifted.segments[0].words[0].start, 100);
  assert.equal(transcriptDuration(shifted), 105);
  assert.equal(shiftTranscript(relative, 0), relative, 'zero offset is a no-op');
});

test('parseTranscriptJson tolerates the transcribe.py shape', () => {
  const parsed = parseTranscriptJson(JSON.stringify({ model: 'large-v3', device: 'cuda', language: 'en', duration: 12.5, segments: [{ start: 0, end: 2, text: ' Hi', words: [{ start: 0.1, end: 0.4, word: ' Hi', probability: 0.8 }, { start: 0.5, end: 0.9, word: ' there' }] }] }), 'v', 'large-v3');
  assert.equal(parsed.durationSeconds, 12.5);
  assert.equal(parsed.segments[0].words.length, 2);
});

test('duration bounds record an explicit assumption when the spec is silent', () => {
  const silent = resolveDurationBounds(emptySpec());
  assert.equal(silent.minSeconds, 20);
  assert.equal(silent.maxSeconds, 60);
  assert.equal(silent.assumptions.length, 1);
  assert.equal(silent.assumptions[0].key, 'clipDurationSeconds');
  assert.match(silent.assumptions[0].reason, /both null/);
  const stated = resolveDurationBounds(emptySpec({ minDurationSeconds: { value: 10, provenance: [] }, maxDurationSeconds: { value: 45, provenance: [] } }));
  assert.equal(stated.minSeconds, 10);
  assert.equal(stated.maxSeconds, 45);
  assert.equal(stated.assumptions.length, 0);
});

test('moment prompt feeds selection rules, the duration assumption, and untrusted-data warning', () => {
  const transcript = makeTranscript('v', 20, 2);
  const { windows } = planWindows(transcript.segments, { windowSeconds: 600 });
  const prompt = buildMomentPrompt(windows[0], emptySpec({
    contentSelectionGuidance: { value: ['Prefer trading lessons'], provenance: [] },
    forbiddenContent: { value: ['political takes'], provenance: [] },
  }), resolveDurationBounds(emptySpec()));
  assert.match(prompt, /UNTRUSTED third-party data/);
  assert.match(prompt, /contentSelectionGuidance: Prefer trading lessons/);
  assert.match(prompt, /forbiddenContent: political takes/);
  assert.match(prompt, /ASSUMPTION APPLIED: clips must be 20-60 seconds/);
  assert.match(prompt, /\[0\.0-20\.0\] hello world/);
  assert.match(prompt, /"rulesChecked"/);
});

test('planWindows splits long transcripts with overlap', () => {
  const segments = Array.from({ length: 40 }, (_, index) => ({ start: index * 30, end: index * 30 + 30, text: `s${index}`, words: [] }));
  const { windows, truncated } = planWindows(segments, { windowSeconds: 300, overlapSeconds: 30, maxWindows: 12 });
  assert.ok(windows.length > 1);
  assert.equal(truncated, false);
  assert.ok(windows[1].start < windows[0].end, 'windows overlap');
  assert.equal(windows[0].total, windows.length);
  const capped = planWindows(segments, { windowSeconds: 300, maxWindows: 1 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.windows.length, 1);
});

test('moment parser is tolerant and enforces the duration policy', () => {
  const bounds = resolveDurationBounds(emptySpec());
  const parsed = parseMomentSelection('```json\n' + JSON.stringify({
    candidates: [
      { start: 10, end: 20, reason: 'short', hookRating: 7, rulesChecked: ['forbiddenContent', 'forbiddenContent'] },
      { start: 40, end: 200, reason: 'long', hookRating: 11, rulesChecked: [] },
      { start: 'x', end: 5, reason: 'junk' },
      { end: 5, reason: 'no start' },
      { start: 100, end: 100, reason: 'empty' },
    ],
    assumptions: ['Speaker is sarcastic'],
    notes: 'ok',
  }) + '\n```', { durationSeconds: 300, bounds });
  assert.equal(parsed.candidates.length, 2);
  const short = parsed.candidates.find(candidate => candidate.reason === 'short');
  assert.equal(short.end - short.start, 20, 'short candidate extended to the minimum');
  assert.deepEqual(short.rulesChecked, ['forbiddenContent']);
  const long = parsed.candidates.find(candidate => candidate.reason === 'long');
  assert.equal(long.end - long.start, 60, 'long candidate trimmed to the maximum');
  assert.equal(long.hookRating, 10, 'hook rating clamped');
  assert.equal(parsed.assumptions[0].key, 'modelAssumption');
  assert.ok(parsed.warnings.some(warning => warning.includes('non-numeric')));
  assert.equal(parseMomentSelection('not json', { durationSeconds: 10, bounds }).candidates.length, 0);
});

test('word snapping starts before the word and ends after it, never mid-syllable', () => {
  const transcript = { videoId: 'v', model: 'm', device: 'cuda', computeType: 'x', language: 'en', durationSeconds: 10, offsetSeconds: 0, segments: [{ start: 0, end: 10, text: '', words: [
    { start: 0, end: 0.5, word: 'gap', probability: 1 },
    { start: 1, end: 2, word: 'hello', probability: 1 },
    { start: 3, end: 3.5, word: 'again', probability: 1 },
  ] }] };
  const snapped = snapCandidate({ start: 1.5, end: 2.5 }, transcript, { preRollSeconds: 0.25, postRollSeconds: 0.1 });
  assert.equal(snapped.startWord.word, 'hello');
  assert.ok(Math.abs(snapped.start - 0.75) < 1e-9, `pre-roll limited to the silence gap, got ${snapped.start}`);
  assert.ok(Math.abs(snapped.end - 2.1) < 1e-9, 'end snapped to the word end plus post-roll');
  assert.equal(snapped.endWord.word, 'hello');
  const noWords = snapCandidate({ start: 2, end: 8 }, { ...transcript, segments: [{ start: 0, end: 10, text: 'x', words: [] }] });
  assert.equal(noWords.start, 0);
  assert.equal(noWords.end, 10);
  assert.ok(noWords.warnings.length >= 2, 'wordless ranges fall back to segment boundaries with warnings');
});

test('transcript excerpt is reconstructed only from words inside the snapped bounds', () => {
  const transcript = { videoId: 'v', model: 'm', device: 'cuda', computeType: 'x', language: 'en', durationSeconds: 10, offsetSeconds: 0, segments: [{ start: 0, end: 10, text: 'Hello world outside', words: [
    { start: 0, end: 1, word: 'Hello', probability: 1 },
    { start: 1, end: 2, word: 'world', probability: 1 },
    { start: 2, end: 3, word: 'outside', probability: 1 },
  ] }] };
  const excerpt = transcriptExcerpt(transcript, 0, 2);
  assert.equal(excerpt.text, 'Hello world');
  assert.equal(excerpt.wordCount, 2);
  assert.equal(transcriptExcerpt(transcript, 5, 6).text, '');
});

test('selectMoments merges windows and drops overlapping duplicates', async () => {
  const transcript = makeTranscript('v', 300, 1);
  const llm = {
    id: 'fake', model: 'fake',
    complete: async () => JSON.stringify({ candidates: [
      { start: 40, end: 70, reason: 'first take', hookRating: 9, rulesChecked: [] },
      { start: 42, end: 72, reason: 'overlapping take', hookRating: 4, rulesChecked: [] },
      { start: 200, end: 230, reason: 'second', hookRating: 5, rulesChecked: [] },
    ] }),
  };
  const selection = await selectMoments(llm, transcript, emptySpec(), { windowSeconds: 600 });
  assert.deepEqual(selection.candidates.map(candidate => candidate.reason), ['first take', 'second']);
  assert.ok(selection.assumptions.some(assumption => assumption.key === 'clipDurationSeconds'));
  assert.equal(selection.model.id, 'fake');
  assert.equal(selection.windows, 1);
});

test('cut args seek with -ss before -i and re-encode both streams', () => {
  const args = buildCutArgs('/src.mp4', '/out.mp4', 12.5, 30);
  assert.ok(args.indexOf('-ss') < args.indexOf('-i'), '-ss must precede -i');
  assert.equal(args[args.indexOf('-ss') + 1], '12.500');
  assert.equal(args[args.indexOf('-t') + 1], '30.000');
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-c:a') + 1], 'aac');
  assert.equal(args[args.length - 1], '/out.mp4');
});

test('cut uses file-relative in-points and the sidecar records both timebases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whop-cut-'));
  const state = cutState();
  const runner = cutRunner(state);
  const request = {
    campaignId: 'c1', videoId: 'v1', sourceUrl: 'https://y/v1', section: null,
    fetch: { start: 100, end: 130 }, mediaPath: '/media/section.mp4',
    outputPath: join(dir, 'clip.mp4'), sidecarPath: join(dir, 'clip.json'),
    inSeconds: 10, durationSeconds: 10,
    transcriptExcerpt: { text: 'hello', wordCount: 1, firstWordStart: 110, lastWordEnd: 120 },
    specRulesChecked: ['forbiddenContent'], specProvenance: { forbiddenContent: [{ sourceId: 'ref:0', line: 1, quote: 'no politics' }] },
    moment: { start: 109, end: 121, reason: 'hook', hookRating: 9, rulesChecked: ['forbiddenContent'] },
    snapping: { rawStart: 109, rawEnd: 121, start: 110, end: 120, startWord: null, endWord: null, startAdjustmentSeconds: 1, endAdjustmentSeconds: -1, warnings: [] },
    assumptions: [], transcript: { model: 'large-v3', language: 'en', offsetSeconds: 0 },
  };
  const result = await cutClip(request, { runner, now: () => 0 });
  const ffmpegCall = state.calls.find(call => call.command === 'ffmpeg');
  assert.equal(ffmpegCall.args[ffmpegCall.args.indexOf('-ss') + 1], '10.000', 'seek must be relative to the fetched section, not source-absolute');
  assert.equal(ffmpegCall.args[ffmpegCall.args.indexOf('-i') + 1], '/media/section.mp4');
  assert.equal(result.actualDurationSeconds, 10);
  const sidecar = JSON.parse(await readFile(request.sidecarPath, 'utf8'));
  assert.deepEqual(sidecar.timecodes.sourceAbsolute, { in: 110, out: 120 });
  assert.deepEqual(sidecar.timecodes.fileRelative, { in: 10, out: 20 });
  assert.deepEqual(sidecar.fetch, { start: 100, end: 130 });
  assert.equal(sidecar.cut.reencode, true);
  assert.deepEqual(sidecar.specProvenance.forbiddenContent[0].quote, 'no politics');

  const ffmpegCalls = state.calls.filter(call => call.command === 'ffmpeg').length;
  const again = await cutClip(request, { runner, now: () => 0 });
  assert.equal(again.fromCache, true);
  assert.equal(state.calls.filter(call => call.command === 'ffmpeg').length, ffmpegCalls, 'a verified clip is not re-cut');
});

test('cut refuses to report success when the output duration is wrong', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whop-cut-bad-'));
  const state = cutState();
  const runner = async (command, args) => {
    state.calls.push({ command, args });
    if (command === 'ffmpeg') {
      await writeFile(args[args.length - 1], 'fake-mp4');
      return { stdout: '', stderr: '', code: 0, timedOut: false };
    }
    return { stdout: JSON.stringify({ format: { duration: '3.0' }, streams: [{ codec_type: 'video', codec_name: 'h264' }] }), stderr: '', code: 0, timedOut: false };
  };
  await assert.rejects(() => cutClip({
    campaignId: 'c', videoId: 'v', sourceUrl: 'u', section: null, fetch: { start: 0, end: 30 }, mediaPath: '/m.mp4',
    outputPath: join(dir, 'c.mp4'), sidecarPath: join(dir, 'c.json'), inSeconds: 0, durationSeconds: 10,
    transcriptExcerpt: { text: '', wordCount: 0, firstWordStart: null, lastWordEnd: null }, specRulesChecked: [], specProvenance: {},
    moment: { start: 0, end: 10, reason: 'r', hookRating: 5, rulesChecked: [] },
    snapping: { rawStart: 0, rawEnd: 10, start: 0, end: 10, startWord: null, endWord: null, startAdjustmentSeconds: 0, endAdjustmentSeconds: 0, warnings: [] },
    assumptions: [], transcript: { model: 'm', language: 'en', offsetSeconds: 0 },
  }, { runner }), /duration mismatch/);
});

test('probeMedia reads a real file through the injected runner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whop-probe-'));
  const path = join(dir, 'x.mp3');
  await writeFile(path, 'abc');
  const probe = await probeMedia(path, { runner: async () => ({ stdout: JSON.stringify({ format: { duration: '1.5' }, streams: [{ codec_type: 'audio', codec_name: 'mp3' }] }), stderr: '', code: 0, timedOut: false }) });
  assert.equal(probe.durationSeconds, 1.5);
  assert.equal(probe.sizeBytes, 3);
});

test('assemble shifts section-relative transcript times and cuts with the section offset subtracted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whop-asm-'));
  const state = cutState();
  const audioSection = { start: 100, end: 300 };
  const media = {
    async ingestAudio() { return { videoId: 'vid', kind: 'audio', section: audioSection, path: join(dir, 'audio.mp3'), probe: { path: join(dir, 'audio.mp3'), durationSeconds: 200, width: null, height: null, fps: null, videoCodec: null, audioCodec: 'mp3', sizeBytes: 1, hasVideo: false, hasAudio: true }, fromCache: true, fetchedAt: '' }; },
    async ingestSection(_video, section) { return { videoId: 'vid', kind: 'video', section, path: join(dir, `sec.mp4`), probe: { path: join(dir, 'sec.mp4'), durationSeconds: section.end - section.start, width: 1920, height: 1080, fps: 30, videoCodec: 'h264', audioCodec: 'aac', sizeBytes: 1, hasVideo: true, hasAudio: true }, fromCache: false, fetchedAt: '' }; },
  };
  const transcriber = { async transcribe() { return makeTranscript('vid', 200, 0.5); } };
  const llm = { id: 'fake', model: 'fake', complete: async () => JSON.stringify({ candidates: [{ start: 150, end: 180, reason: 'hook', hookRating: 9, rulesChecked: ['forbiddenContent'] }], assumptions: [] }) };
  const assembler = new ClipAssembler({ campaignId: 'c1', llm, media, transcriber, runner: cutRunner(state), now: () => 0 });
  const result = await assembler.assemble({ id: 'vid' }, emptySpec(), { outDir: dir, momentLimit: 1, paddingSeconds: 3 });
  assert.equal(result.clips.length, 1, JSON.stringify(result.warnings));
  const sidecar = JSON.parse(await readFile(result.clips[0].result.sidecarPath, 'utf8'));
  assert.ok(Math.abs(sidecar.timecodes.sourceAbsolute.in - 150) < 0.6, `absolute in ${sidecar.timecodes.sourceAbsolute.in}`);
  assert.ok(sidecar.timecodes.fileRelative.in > 0 && sidecar.timecodes.fileRelative.in < 6, 'file-relative in-point is small, not source-absolute');
  assert.equal(sidecar.timecodes.sourceAbsolute.in - sidecar.fetch.start, sidecar.timecodes.fileRelative.in);
  assert.ok(result.selection.assumptions.some(assumption => assumption.key === 'clipDurationSeconds'));
  assert.equal(result.transcript.offsetSeconds, 100);
  assert.equal(result.transcript.durationSeconds, 300);
});

test('mergeRanges collapses nearby fetch spans', () => {
  assert.deepEqual(mergeRanges([{ start: 10, end: 20 }, { start: 20.5, end: 30 }, { start: 50, end: 60 }], 1), [{ start: 10, end: 30 }, { start: 50, end: 60 }]);
  assert.deepEqual(mergeRanges([], 1), []);
});
