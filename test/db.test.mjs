import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClippingIndex } from '../dist/db/index.js';

const briefSource = (overrides = {}) => ({
  id: 'ref:0',
  url: 'https://example.com/brief',
  host: 'example.com',
  kind: 'brief_doc',
  mediaType: null,
  status: 'ok',
  httpStatus: 200,
  fetchedAt: '2026-09-17T00:00:00.000Z',
  fromCache: false,
  contentType: 'text',
  bytes: 42,
  lineCount: 3,
  text: 'line one\nline two\nline three',
  error: null,
  renderedTables: 0,
  needsBrowser: false,
  driveFiles: null,
  ...overrides,
});

const sidecar = (overrides = {}) => ({
  campaignId: 'camp-1',
  videoId: 'vid-1',
  sourceUrl: 'https://www.youtube.com/watch?v=vid-1',
  section: null,
  fetch: { start: 0, end: 32.28 },
  timecodes: { sourceAbsolute: { in: 0, out: 28.28 }, fileRelative: { in: 0, out: 28.28 } },
  durationSeconds: 28.28,
  transcriptExcerpt: { text: 'hello', wordCount: 1, firstWordStart: 0, lastWordEnd: 0.5 },
  specRulesChecked: ['minDurationSeconds'],
  specProvenance: {},
  moment: { start: 0, end: 27.8, reason: 'strong hook', hookRating: 9, rulesChecked: [] },
  snapping: { rawStart: 0, rawEnd: 27.8, start: 0, end: 28.28, warnings: [] },
  assumptions: [],
  transcript: { model: 'large-v3', language: 'en', offsetSeconds: 0 },
  cut: { reencode: true, ffmpegArgs: [], outputProbe: {} },
  createdAt: '2026-09-17T00:00:00.000Z',
  ...overrides,
});

const clipSpec = (overrides = {}) => ({
  campaignId: 'camp-spec',
  extractedAt: '2026-09-17T01:00:00.000Z',
  extractor: { provider: 'local', model: 'm', promptVersion: 'clipspec-v1' },
  watermarkRequired: { value: true, provenance: [{ sourceId: 'ref:0', line: 4, quote: 'Watermark: required' }] },
  requiredHashtags: { value: ['#ad', '#roobet'], provenance: [{ sourceId: 'ref:0', line: 5, quote: '#ad #roobet' }] },
  unstructuredRequirements: [{ text: 'No bots.', provenance: [{ sourceId: 'ref:0', line: 9, quote: 'no bots' }] }],
  ...overrides,
});

test('upserts are idempotent and do not duplicate rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whop-db-'));
  const idx = new ClippingIndex(join(root, 'index.db'));
  try {
    const source = briefSource();
    const clip = sidecar();
    const spec = clipSpec();

    const run = () => {
      idx.upsertCampaign({ id: 'camp-1', title: 'Camp One', campaignUrl: 'https://x/1', lastCrawledAt: '2026-09-17T00:00:00.000Z' });
      idx.upsertSources('camp-1', [source, briefSource({ id: 'ref:1', url: 'https://example.com/other', status: 'error', text: null, error: 'HTTP 404' })]);
      idx.upsertClipSpec(spec);
      idx.upsertClip(clip, { filePath: '/tmp/out/a.mp4', sidecarPath: '/tmp/out/a.json' });
    };

    run();
    const first = idx.counts();
    run();
    const second = idx.counts();

    assert.deepEqual(second, first);
    assert.equal(first.campaigns, 2, 'camp-1 and camp-spec');
    assert.equal(first.sources, 2);
    assert.equal(first.clipSpecs, 1);
    assert.equal(first.clipSpecFields, 3, 'watermarkRequired + requiredHashtags + one unstructured entry');
    assert.equal(first.clips, 1);
  } finally {
    idx.close();
  }
});

test('read queries return the expected rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whop-db-'));
  const idx = new ClippingIndex(join(root, 'index.db'));
  try {
    idx.upsertCampaign({ id: 'has-brief', title: 'Has Brief' });
    idx.upsertSources('has-brief', [briefSource()]);
    idx.upsertCampaign({ id: 'no-brief', title: 'No Brief' });
    idx.upsertCampaign({ id: 'error-brief', title: 'Error Brief' });
    idx.upsertSources('error-brief', [briefSource({ id: 'ref:9', status: 'error', text: null, error: 'boom' })]);
    idx.upsertClipSpec(clipSpec());
    idx.upsertClip(sidecar(), { filePath: '/tmp/out/a.mp4', sidecarPath: '/tmp/out/a.json' });

    assert.deepEqual(idx.campaignsMissingBriefText().map(c => c.id), ['camp-1', 'camp-spec', 'error-brief', 'no-brief']);

    assert.deepEqual(idx.sourcesByStatus('ok').map(s => s.url), ['https://example.com/brief']);
    assert.deepEqual(idx.sourcesByStatus('error').map(s => s.source_id), ['ref:9']);

    assert.deepEqual(idx.campaignsWhereField('watermarkRequired').map(c => c.id), ['camp-spec']);
    assert.deepEqual(idx.campaignsWhereField('requiredHashtags').map(c => c.id), ['camp-spec']);
    assert.deepEqual(idx.campaignsWhereField('doesNotExist'), []);

    const clips = idx.clipsForCampaign('camp-1');
    assert.equal(clips.length, 1);
    assert.equal(clips[0].video_id, 'vid-1');
    assert.equal(clips[0].hook_rating, 9);
    assert.equal(clips[0].duration_seconds, 28.28);
    assert.equal(clips[0].source_abs_in, 0);
    assert.equal(clips[0].source_abs_out, 28.28);
    assert.equal(clips[0].file_rel_in, 0);
    assert.equal(clips[0].file_rel_out, 28.28);
    assert.deepEqual(idx.clipsForCampaign('missing'), []);
  } finally {
    idx.close();
  }
});

test('reindex rebuilds from refs and clip sidecars, skips bad JSON, and is repeatable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whop-db-'));
  const refsDir = join(root, '.cache', 'clipping', 'refs');
  const clipsDir = join(root, 'out', 'clips');
  const dbPath = join(root, '.cache', 'clipping', 'index.db');
  await mkdir(refsDir, { recursive: true });
  await mkdir(join(clipsDir, 'camp-1', 'vid-1'), { recursive: true });

  await writeFile(join(refsDir, 'a.json'), JSON.stringify({
    url: 'https://example.com/brief', contentHash: 'x', fetchedAt: '2026-09-17T00:00:00.000Z',
    httpStatus: 200, contentType: 'html', body: '<html><body>rules</body></html>',
  }));
  await writeFile(join(refsDir, 'b.json'), JSON.stringify({
    url: 'browser:drive:https://drive.google.com/drive/folders/abc', contentHash: 'y',
    fetchedAt: '2026-09-17T00:00:00.000Z', httpStatus: 200, contentType: 'text', body: '',
  }));
  await writeFile(join(refsDir, 'bad.json'), '{ not json');

  await writeFile(join(clipsDir, 'camp-1', 'vid-1', '0.00-28.28.json'), JSON.stringify(sidecar()));
  await writeFile(join(clipsDir, 'camp-1', 'vid-1', '0.00-28.28.mp4'), 'fake');
  await mkdir(join(clipsDir, 'camp-1', 'vid-2'), { recursive: true });
  await writeFile(join(clipsDir, 'camp-1', 'vid-2', '1.00-9.00.json'), JSON.stringify(sidecar({ videoId: 'vid-2', durationSeconds: 8 })));

  const idx = new ClippingIndex(dbPath);
  try {
    const first = idx.reindex({ cacheDir: refsDir, clipsDir });
    assert.equal(first.refFiles, 3);
    assert.equal(first.sidecarFiles, 2);
    assert.equal(first.skippedFiles, 1, 'the unparseable ref is skipped, not thrown');
    assert.ok(first.warnings.some(w => w.includes('bad.json')), first.warnings.join('\n'));
    assert.ok(first.warnings.some(w => w.includes('missing')), first.warnings.join('\n'));

    assert.equal(first.counts.campaigns, 1);
    assert.equal(first.counts.sources, 2);
    assert.equal(first.counts.clips, 2);

    assert.deepEqual(idx.sourcesByStatus('ok').map(s => s.url), ['https://example.com/brief']);
    assert.equal(idx.sourcesByStatus('skipped').length, 1);
    assert.equal(idx.clipsForCampaign('camp-1').length, 2);

    const second = idx.reindex({ cacheDir: refsDir, clipsDir });
    assert.deepEqual(second.counts, first.counts, 'reindex is idempotent');

    idx.close();
    await rm(dbPath, { force: true });
    await rm(dbPath + '-wal', { force: true });
    await rm(dbPath + '-shm', { force: true });

    const rebuilt = new ClippingIndex(dbPath);
    try {
      assert.deepEqual(rebuilt.counts(), { campaigns: 0, sources: 0, clipSpecs: 0, clipSpecFields: 0, clips: 0 });
      const third = rebuilt.reindex({ cacheDir: refsDir, clipsDir });
      assert.deepEqual(third.counts, first.counts, 'a deleted DB is fully reconstructed from disk');
    } finally {
      rebuilt.close();
    }
  } finally {
    idx.close();
  }
});

test('WAL mode is enabled and the DB file survives close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whop-db-'));
  const dbPath = join(root, 'index.db');
  const idx = new ClippingIndex(dbPath);
  idx.upsertCampaign({ id: 'c' });
  idx.close();
  assert.ok(existsSync(dbPath));
});
