import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyLink, classifyReferences, referenceUrls, extractHttpLinks, unwrapRedirectUrl, isBinaryMediaType } from '../dist/clipping/links.js';
import { htmlToText, decodeEntities, googleDocExportUrl, withLineNumbers } from '../dist/clipping/html.js';
import { hasTable, hasMultiColumnTable, renderTable, htmlToTextWithTables, countTables } from '../dist/clipping/tables.js';
import { BriefCrawler, ReferenceCache, isNoiseLink, isBinaryContentType } from '../dist/clipping/crawl.js';
import { filterDriveNodes, isDriveId, BbBrowserRunner } from '../dist/clipping/browser.js';
import { buildExtractionPrompt, parseClipSpec, emptyClipSpec, specCompleteness, RULE_FIELDS } from '../dist/clipping/extract.js';
import { normalizeChannelUrl, parseYtDlpJson, YouTubeFootageResolver } from '../dist/clipping/youtube.js';
import { ClippingPipeline } from '../dist/clipping/pipeline.js';

const response = (body, { status = 200, type = 'text/html' } = {}) =>
  new Response(body, { status, headers: { 'content-type': type } });

const cacheDir = async () => mkdtemp(join(tmpdir(), 'whop-clip-'));

// Verbatim two-column table from ROOBET's Google Docs HTML export (campaign ee7a5010).
const LOGO_TABLE = '<table class="c23"><thead><tr class="c20"><td class="c32" colspan="1" rowspan="1"><p class="c28"><span class="c10 c11">&#10003; LOGO MUST</span></p></td><td class="c32" colspan="1" rowspan="1"><p class="c28"><span class="c10 c11">&#10007; LOGO CANNOT</span></p></td><tbody></tbody></tr><tr class="c20"><td class="c56" colspan="1" rowspan="1"><p class="c4"><span class="c0">Stay visible throughout the ENTIRE video</span></p></td><td class="c56" colspan="1" rowspan="1"><p class="c4"><span class="c0">Be cropped or obscured at any point</span></p></td></tr><tr class="c20"><td class="c6" colspan="1" rowspan="1"><p class="c4"><span class="c0">Stay BIG (not small or subtle)</span></p></td><td class="c6" colspan="1" rowspan="1"><p class="c4"><span class="c0">Be hidden by an Instagram caption</span></p></td></tr><tr class="c20"><td class="c56" colspan="1" rowspan="1"><p class="c4"><span class="c0">Stay centered (MIDDLE of the screen)</span></p></td><td class="c56" colspan="1" rowspan="1"><p class="c4"><span class="c0">Be moved off-center, to the edge, or cut off</span></p></td></tr><tr class="c20"><td class="c6" colspan="1" rowspan="1"><p class="c4"><span class="c0">Stay exactly as Roobet provided it</span></p></td><td class="c6" colspan="1" rowspan="1"><p class="c4"><span class="c0">Be modified, recolored, shrunk, or replaced</span></p></td></tr></thead></table>';

test('table renderer preserves column association so a prohibition never reads as a requirement', () => {
  assert.equal(hasTable(LOGO_TABLE), true);
  assert.equal(hasTable('<p>no tables here</p>'), false);
  assert.equal(hasMultiColumnTable(LOGO_TABLE), true);
  assert.equal(countTables(LOGO_TABLE), 1);
  assert.equal(countTables('<p>no tables</p>'), 0);
  assert.equal(hasMultiColumnTable('<table><tr><td>only one cell</td></tr></table>'), false, 'layout tables do not trigger the HTML path');
  const text = htmlToTextWithTables(`<p>before</p>${LOGO_TABLE}<p>after</p>`);
  assert.ok(text.startsWith('before'));
  assert.ok(text.endsWith('after'));
  assert.ok(text.includes('TABLE HEADERS: ✓ LOGO MUST | ✗ LOGO CANNOT'));
  const pairs = [
    ['Stay visible throughout the ENTIRE video', 'Be cropped or obscured at any point'],
    ['Stay BIG (not small or subtle)', 'Be hidden by an Instagram caption'],
    ['Stay centered (MIDDLE of the screen)', 'Be moved off-center, to the edge, or cut off'],
    ['Stay exactly as Roobet provided it', 'Be modified, recolored, shrunk, or replaced'],
  ];
  for (const [must, cannot] of pairs) {
    assert.ok(text.includes(`✓ LOGO MUST: ${must} | ✗ LOGO CANNOT: ${cannot}`), `pair kept together: ${must}`);
  }
  assert.doesNotMatch(text, /✓ LOGO MUST: Be /, 'a prohibition must never be labelled as a requirement');
  assert.doesNotMatch(text, /✗ LOGO CANNOT: Stay /, 'a requirement must never be labelled as a prohibition');
  assert.equal(renderTable('<table><tr><td><p>one column only</p></td></tr></table>'), 'one column only');
});

test('html link extraction unwraps google redirects', () => {
  const href = 'https://www.google.com/url?q=https%3A%2F%2Fdrive.google.com%2Fdrive%2Ffolders%2F1abc%3Fusp%3Dsharing&sa=D&source=editors';
  assert.equal(unwrapRedirectUrl(href), 'https://drive.google.com/drive/folders/1abc?usp=sharing');
  const [link] = extractHttpLinks(`<a href="${href}">folder</a>`, 'https://docs.google.com/document/d/1X/edit');
  assert.equal(link, 'https://drive.google.com/drive/folders/1abc?usp=sharing');
});

test('link classifier maps hosts to kinds', () => {
  const cases = [
    ['https://docs.google.com/document/d/abc123/edit?usp=sharing', 'brief_doc'],
    ['https://mediamaxxing.notion.site/lovable-clipping', 'brief_doc'],
    ['https://drive.google.com/drive/folders/1abc?usp=sharing', 'footage_drive'],
    ['https://app.mediasilo.com/review/6a88', 'footage_drive'],
    ['https://f.io/nzx3cW3p', 'footage_drive'],
    ['https://fileshare.terrahq.com/fl/RkVpFC6XD9h9', 'footage_drive'],
    ['https://www.youtube.com/@TJRTrades', 'footage_channel'],
    ['https://kick.com/tjr', 'footage_channel'],
    ['https://next.frame.io/share/4da67ff0', 'footage_drive'],
    ['https://t.me/nikitatyuka1oclippers', 'community'],
    ['https://discord.gg/9Uf3dWzAym\'', 'community'],
    ['https://forms.gle/MGy8PCrmUu6N4mAc7', 'form'],
    ['https://www.instagram.com/pbblake/', 'brand_site'],
    ['https://reachclipping.com/TJR', 'brand_site'],
    ['clippbblake.com/', 'brand_site'],
    ['mailto:someone@example.com', 'unknown'],
    ['javascript:alert(1)', 'unknown'],
    ['not a url at all', 'unknown'],
  ];
  for (const [url, kind] of cases) assert.equal(classifyLink(url).kind, kind, `${url} should be ${kind}`);
  assert.equal(classifyLink('https://www.youtube.com/@TJRTrades').host, 'youtube.com');
  assert.equal(classifyReferences([{ url: 'https://www.youtube.com/@a' }, { url: 'https://www.youtube.com/@a' }]).length, 1);
  assert.deepEqual(referenceUrls([{ url: 'https://a.com' }, 'https://b.com', { nope: 1 }, null]), ['https://a.com', 'https://b.com']);
  assert.equal(extractHttpLinks('<a href="/x">a</a><a href="https://y.com/z">b</a>', 'https://base.com/dir/').length, 2);
});

test('html helpers strip markup and build export urls', () => {
  const html = '<html><head><style>.x{}</style><script>bad()</script></head><body><h1>Hello&nbsp;World</h1><p>Min&nbsp;10&nbsp;seconds</p><ul><li>#tag</li></ul></body></html>';
  const text = htmlToText(html);
  assert.match(text, /Hello World/);
  assert.match(text, /Min 10 seconds/);
  assert.match(text, /• #tag/);
  assert.doesNotMatch(text, /bad\(\)/);
  assert.equal(decodeEntities('a &amp; b &#65; &#x42;'), 'a & b A B');
  assert.equal(googleDocExportUrl('https://docs.google.com/document/d/1ABC_def/edit?usp=sharing'), 'https://docs.google.com/document/d/1ABC_def/export?format=txt');
  assert.equal(googleDocExportUrl('https://docs.google.com/document/d/1ABC_def/edit', 'html'), 'https://docs.google.com/document/d/1ABC_def/export?format=html');
  assert.equal(googleDocExportUrl('https://drive.google.com/drive/folders/1abc'), null);
  assert.equal(withLineNumbers('a\nb'), '1: a\n2: b');
});

test('crawler classifies, extracts text, caches, and degrades per source', async () => {
  const dir = await cacheDir();
  let calls = 0;
  const docsTxt = 'https://docs.google.com/document/d/1AAA/export?format=txt';
  const docsHtml = 'https://docs.google.com/document/d/1AAA/export?format=html';
  const request = async url => {
    calls++;
    if (url === docsTxt) return response('Clip brief\nMinimum duration 10 seconds\n#GoliWalmart', { type: 'text/plain' });
    if (url === docsHtml) return response('<p>folder <a href="https://www.youtube.com/@Chan">here</a> <a href="https://fonts.googleapis.com/css?family=Inter">f</a></p>');
    if (url.includes('notion.site')) return response('nope', { status: 403, type: 'text/html' });
    if (url.includes('drive.google.com')) return response('<html><body>JavaScript must be enabled</body></html>');
    return response('<html><body>Rules hub</body></html>');
  };
  const crawler = new BriefCrawler({ request, cacheDir: dir });
  const materials = [
    { url: 'https://docs.google.com/document/d/1AAA/edit' },
    { url: 'https://mediamaxxing.notion.site/lovable-clipping' },
    { url: 'https://drive.google.com/drive/folders/1abc' },
    { url: 'https://www.youtube.com/@TJRTrades' },
  ];
  const bundle = await crawler.crawl('camp-1', materials);
  assert.equal(bundle.links.length, 4);
  assert.equal(bundle.coverage.fetched, 1);
  assert.equal(bundle.coverage.failed, 1);
  assert.equal(bundle.coverage.skipped, 2);
  assert.match(bundle.briefText, /Minimum duration 10 seconds/);
  assert.ok(bundle.discoveredLinks.some(link => link.url.includes('youtube.com/@Chan')));
  assert.ok(!bundle.discoveredLinks.some(link => link.url.includes('fonts.googleapis.com')), 'asset/CDN links are noise');
  assert.equal(isNoiseLink(classifyLink('https://fonts.googleapis.com/css2?family=Inter')), true);
  assert.equal(isNoiseLink(classifyLink('https://www.youtube.com/@Chan')), false);
  assert.ok(bundle.warnings.some(w => w.includes('notion.site')));
  const fetchesAfterFirst = calls;
  const second = await crawler.crawl('camp-1', materials);
  assert.equal(calls, fetchesAfterFirst + 1, 'only the failed fetch is retried; successes come from cache');
  assert.equal(second.coverage.fetched, 1);

  const failing = new BriefCrawler({ request: async () => response('', { status: 500 }), cacheDir: await cacheDir() });
  const empty = await failing.crawl('camp-2', [{ url: 'https://example.com/brief' }]);
  assert.equal(empty.coverage.fetched, 0);
  assert.equal(empty.briefText, null);
  assert.ok(empty.warnings.some(w => w.includes('No readable brief text')));
});

test('crawler uses the HTML export for tables and leaves table-free docs byte-identical', async () => {
  const dir = await cacheDir();
  const tableTxt = 'https://docs.google.com/document/d/1TBL/export?format=txt';
  const tableHtml = 'https://docs.google.com/document/d/1TBL/export?format=html';
  const plainTxt = 'https://docs.google.com/document/d/1PLN/export?format=txt';
  const plainHtml = 'https://docs.google.com/document/d/1PLN/export?format=html';
  const layoutTxt = 'https://docs.google.com/document/d/1LAY/export?format=txt';
  const layoutHtml = 'https://docs.google.com/document/d/1LAY/export?format=html';
  const request = async url => {
    if (url === tableTxt) return response('flattened must row\nflattened cannot row', { type: 'text/plain' });
    if (url === tableHtml) return response(LOGO_TABLE);
    if (url === plainTxt) return response('keep me\nbyte identical', { type: 'text/plain' });
    if (url === plainHtml) return response('<p>a completely different html rendering</p>');
    if (url === layoutTxt) return response('layout txt wins', { type: 'text/plain' });
    if (url === layoutHtml) return response('<table><tr><td>one cell layout table</td></tr></table>');
    return response('x');
  };
  const crawler = new BriefCrawler({ request, cacheDir: dir });
  const bundle = await crawler.crawl('c', [
    { url: 'https://docs.google.com/document/d/1TBL/edit' },
    { url: 'https://docs.google.com/document/d/1PLN/edit' },
    { url: 'https://docs.google.com/document/d/1LAY/edit' },
  ]);
  const [table, plain, layout] = bundle.sources;
  assert.match(table.text, /✓ LOGO MUST: Stay visible throughout the ENTIRE video \| ✗ LOGO CANNOT: Be cropped or obscured at any point/);
  assert.doesNotMatch(table.text, /flattened must row\nflattened cannot row/);
  assert.equal(plain.text, 'keep me\nbyte identical', 'table-free docs stay on the txt export');
  assert.equal(layout.text, 'layout txt wins', 'single-column layout tables stay on the txt export');
});

test('forbiddenRules is a nullable field kept separate from requirement arrays', () => {
  const ctx = { campaignId: 'c1', extractor: { provider: 'fake', model: null, promptVersion: 'v1' }, sourceIds: ['ref:0'] };
  const raw = JSON.stringify({
    watermarkRules: { value: ['Stay visible throughout the video'], provenance: [{ sourceId: 'ref:0', line: 1, quote: 'Stay visible throughout the video' }] },
    forbiddenRules: { value: ['Be cropped or obscured', 'Be modified'], provenance: [{ sourceId: 'ref:0', line: 2, quote: 'Be cropped or obscured' }] },
  });
  const { spec } = parseClipSpec(raw, ctx);
  assert.deepEqual(spec.watermarkRules.value, ['Stay visible throughout the video']);
  assert.deepEqual(spec.forbiddenRules.value, ['Be cropped or obscured', 'Be modified']);
  assert.ok(!spec.watermarkRules.value.some(item => /cropped|modified/i.test(item)));
  assert.equal(emptyClipSpec(ctx).forbiddenRules, null, 'absent prohibitions stay null, never default-filled');
  assert.equal(RULE_FIELDS.forbiddenRules, 'string[]');
});

test('reference cache honours ttl and ignores corrupt entries', async () => {
  let now = 0;
  const dir = await cacheDir();
  const cache = new ReferenceCache(dir, 1000, () => now);
  await cache.put({ url: 'u', contentHash: 'h', fetchedAt: new Date(0).toISOString(), httpStatus: 200, contentType: 'text', body: 'body' });
  assert.equal((await cache.get('u')).body, 'body');
  now = 1001;
  assert.equal(await cache.get('u'), null);
});

test('clip spec parser keeps nulls, validates provenance, coerces, and drops junk', () => {
  const ctx = { campaignId: 'c1', extractor: { provider: 'fake', model: 'm', promptVersion: 'v1' }, sourceIds: ['ref:0'] };
  const raw = [
    '```json',
    JSON.stringify({
      minDurationSeconds: { value: 10, provenance: [{ sourceId: 'ref:0', line: 3, quote: 'Minimum duration 10 seconds' }] },
      allowedPlatforms: { value: ['TikTok', 'tiktok', 'Instagram'], provenance: [{ sourceId: 'ref:0', line: 1, quote: 'Post on TikTok, Instagram' }] },
      watermarkRequired: { value: false, provenance: [{ sourceId: 'ref:0', line: 9, quote: 'no watermark needed' }] },
      minAudienceAge: { value: '18', provenance: [{ sourceId: 'ref:0', line: 4, quote: '18+' }] },
      maxDurationSeconds: null,
      language: { value: 'English', provenance: [{ sourceId: 'nope', line: 1, quote: 'x' }] },
      ghost: { value: 1, provenance: [] },
      unstructuredRequirements: [{ text: 'Warm up the account 24-48h', provenance: [{ sourceId: 'ref:0', line: 8, quote: 'Wait 24-48 hours' }] }],
    }),
    '```',
  ].join('\n');
  const { spec, warnings } = parseClipSpec(raw, ctx);
  assert.equal(spec.minDurationSeconds.value, 10);
  assert.equal(spec.minDurationSeconds.provenance[0].line, 3);
  assert.deepEqual(spec.allowedPlatforms.value, ['TikTok', 'tiktok', 'Instagram']);
  assert.equal(spec.watermarkRequired.value, false);
  assert.equal(spec.minAudienceAge.value, 18);
  assert.equal(spec.maxDurationSeconds, null);
  assert.equal(spec.language, null, 'unknown source provenance must drop the field');
  assert.equal(spec.unstructuredRequirements.length, 1);
  assert.ok(warnings.some(w => w.includes('unknown key "ghost"')));
  assert.ok(warnings.some(w => w.includes('unknown source "nope"')));
  assert.equal(specCompleteness(spec).filled, 4);
});

test('parser returns an all-null spec for non-object output', () => {
  const ctx = { campaignId: 'c1', extractor: { provider: 'fake', model: null, promptVersion: 'v1' }, sourceIds: [] };
  const { spec, warnings } = parseClipSpec('not json', ctx);
  assert.equal(spec.minDurationSeconds, null);
  assert.equal(Object.keys(RULE_FIELDS).every(field => spec[field] === null), true);
  assert.ok(warnings.length > 0);
  assert.equal(emptyClipSpec(ctx).unstructuredRequirements.length, 0);
});

test('extraction prompt numbers lines and names every field', () => {
  const bundle = {
    campaignId: 'c1',
    sources: [{ id: 'ref:0', status: 'ok', kind: 'brief_doc', url: 'https://d', text: 'line one\nline two' }],
  };
  const prompt = buildExtractionPrompt(bundle, { title: 'T', cpmUsd: 1, platforms: ['youtube'] });
  assert.match(prompt, /1: line one/);
  assert.match(prompt, /2: line two/);
  for (const field of Object.keys(RULE_FIELDS)) assert.match(prompt, new RegExp(`\\b${field}\\b`));
});

test('youtube resolver normalises urls and parses flat playlists', () => {
  assert.deepEqual(normalizeChannelUrl('https://www.youtube.com/@TJRTrades'), { isChannel: true, url: 'https://www.youtube.com/@TJRTrades/videos' });
  assert.deepEqual(normalizeChannelUrl('https://www.youtube.com/@TJRTrades/videos'), { isChannel: true, url: 'https://www.youtube.com/@TJRTrades/videos' });
  assert.equal(normalizeChannelUrl('https://www.youtube.com/watch?v=abc').isChannel, false);
  assert.equal(normalizeChannelUrl('https://example.com/@x').isChannel, false);
  const playlist = JSON.stringify({
    _type: 'playlist', channel: 'TJR', channel_id: 'UC1',
    entries: [
      { id: 'v1', title: 'A', duration: 100, timestamp: 1789516800, url: 'https://www.youtube.com/watch?v=v1', view_count: 5 },
      { entries: [{ id: 'v2', title: 'B', duration: 30, upload_date: '20260916', webpage_url: 'https://www.youtube.com/watch?v=v2' }] },
    ],
  });
  const parsed = parseYtDlpJson(playlist);
  assert.equal(parsed.channel, 'TJR');
  assert.deepEqual(parsed.videos.map(v => v.id), ['v1', 'v2']);
  assert.equal(parsed.videos[0].uploadDate, '2026-09-16');
  assert.equal(parsed.videos[1].uploadDate, '2026-09-16');
  assert.equal(parsed.videos[1].durationSeconds, 30);
});

test('youtube resolver runs yt-dlp and reports failures without throwing in resolveAll', async () => {
  const payload = JSON.stringify({ _type: 'playlist', channel: 'C', entries: [{ id: 'x', title: 'T', duration: 12 }] });
  const resolver = new YouTubeFootageResolver({ runner: async (_cmd, args) => {
    const bad = args.some(arg => arg.includes('@bad'));
    return { stdout: bad ? '' : payload, stderr: bad ? 'ERROR: nope' : '', code: bad ? 1 : 0, timedOut: false };
  } });
  const listing = await resolver.resolve('https://www.youtube.com/@Good', { limit: 10 });
  assert.equal(listing.videos.length, 1);
  assert.equal(listing.videos[0].id, 'x');
  const all = await resolver.resolveAll(['https://www.youtube.com/@Good', 'https://www.youtube.com/@bad'], {});
  assert.equal(all.length, 2);
  assert.equal(all[1].videos.length, 0);
  const notChannel = await resolver.resolve('https://example.com/watch');
  assert.equal(notChannel.videos.length, 0);
  assert.ok(notChannel.warnings.length > 0);
});

test('pipeline plans brief + spec + footage end to end offline', async () => {
  const dir = await cacheDir();
  const docsTxt = 'https://docs.google.com/document/d/1AAA/export?format=txt';
  const request = async url => {
    if (url === docsTxt) return response('TJR clipping\nMinimum 10 seconds\nPost to YouTube', { type: 'text/plain' });
    return response('<html><body>link <a href="https://www.youtube.com/@TRichesTrades">t</a></body></html>');
  };
  const canned = JSON.stringify({
    minDurationSeconds: { value: 10, provenance: [{ sourceId: 'ref:0', line: 2, quote: 'Minimum 10 seconds' }] },
    allowedPlatforms: { value: ['youtube'], provenance: [{ sourceId: 'ref:0', line: 3, quote: 'Post to YouTube' }] },
  });
  const llm = { id: 'fake', model: 'fake', complete: async () => canned };
  const ytPayload = JSON.stringify({ _type: 'playlist', channel: 'TRiches', entries: [{ id: 'vid1', title: 'Trade', duration: 600, timestamp: 1789516800 }] });
  const resolver = new YouTubeFootageResolver({ runner: async () => ({ stdout: ytPayload, stderr: '', code: 0, timedOut: false }) });
  const crawler = new BriefCrawler({ request, cacheDir: dir });
  const pipeline = new ClippingPipeline({ crawler, llm, resolver });
  const detail = {
    id: '0d921575-0f7b-4082-a7a9-79a9dcc72dba',
    title: 'TJR',
    referenceMaterials: [{ url: 'https://docs.google.com/document/d/1AAA/edit' }, { url: 'https://www.youtube.com/@TJRTrades' }, { url: 'https://kick.com/tjr' }],
    campaign: { cpmUsd: 1, platforms: ['youtube'] },
  };
  const plan = await pipeline.plan(detail);
  assert.equal(plan.clipSpec.minDurationSeconds.value, 10);
  assert.deepEqual(plan.clipSpec.allowedPlatforms.value, ['youtube']);
  assert.ok(plan.footage.videos.some(v => v.id === 'vid1'));
  assert.ok(plan.links.some(link => link.kind === 'footage_channel'));
  assert.ok(plan.discoveredLinks.some(link => link.url.includes('@TRichesTrades')));
  assert.equal(plan.footage.channels.length, 2, 'both YouTube channels are resolved');
  assert.equal(plan.footage.videos.length, 1, 'duplicate video ids are merged');
  assert.ok(plan.footage.deferred.some(note => note.includes('kick.com')), 'non-YouTube channels are reported as deferred');
  assert.equal(plan.contentTrust.includes('untrusted'), true);
});

test('binary media types are skipped, never decoded as HTML text', async () => {
  const pdf = '%PDF-1.4 binary junk';
  const byMediaType = async () => response(pdf, { type: 'application/pdf' });
  const a = await new BriefCrawler({ request: byMediaType, cacheDir: await cacheDir() }).crawl('c', [{ url: 'https://files.example.com/brief.pdf', mediaType: 'pdf' }]);
  assert.equal(a.sources[0].status, 'skipped');
  assert.match(a.sources[0].error, /pdf not supported/);
  assert.equal(a.coverage.binarySkipped, 1);
  assert.ok(a.warnings.some(w => w.includes('pdf not supported')));
  assert.equal(a.briefText, null);
  assert.equal(isBinaryMediaType('pdf'), true);
  assert.equal(isBinaryMediaType('external'), false);

  const b = await new BriefCrawler({ request: byMediaType, cacheDir: await cacheDir() }).crawl('c2', [{ url: 'https://files.example.com/doc.pdf', mediaType: 'external' }]);
  assert.equal(b.sources[0].contentType, 'binary');
  assert.equal(b.coverage.binarySkipped, 1);
  assert.ok(b.warnings.some(w => w.includes('binary content not supported')));
  assert.equal(isBinaryContentType('application/pdf'), true);
  assert.equal(isBinaryContentType('text/html; charset=utf-8'), false);
});

test('client-rendered pages are classified needs_browser, not counted as fetched', async () => {
  const request = async () => response('<html><head><script>x()</script></head><body>Notion JavaScript must be enabled in order to use Notion.</body></html>');
  const bundle = await new BriefCrawler({ request, cacheDir: await cacheDir() }).crawl('c', [{ url: 'https://mediamaxxing.notion.site/lovable-clipping' }]);
  assert.equal(bundle.sources[0].kind, 'brief_doc');
  assert.equal(bundle.sources[0].status, 'needs_browser');
  assert.equal(bundle.sources[0].needsBrowser, true);
  assert.equal(bundle.coverage.needsBrowser, 1);
  assert.equal(bundle.coverage.fetched, 0);
  assert.equal(bundle.briefText, null);
  assert.ok(bundle.warnings.some(w => w.includes('needs a browser')));
});

test('drive node filtering drops junk, dedupes, and parses names', () => {
  const files = filterDriveNodes([
    { id: '_gd', label: 'window.WIZ_global_data' },
    { id: '1dV1eUWqrzBdd-2LPxrygY0rL5gaUCX-u', label: 'Forge Logo\nOwner hidden\n26 Aug\n—' },
    { id: '1dV1eUWqrzBdd-2LPxrygY0rL5gaUCX-u', label: 'Forge Logo duplicate' },
    { id: 'short', label: 'nope' },
    { id: '1zU9qjaepJG4A8SsL4Gnpm6LDfiOwL3n8', label: '\n' },
  ]);
  assert.equal(files.length, 2);
  assert.equal(files[0].name, 'Forge Logo');
  assert.equal(files[0].id, '1dV1eUWqrzBdd-2LPxrygY0rL5gaUCX-u');
  assert.equal(files[1].name, '(unnamed)');
  assert.equal(isDriveId('_gd'), false);
  assert.equal(isDriveId('1dV1eUWqrzBdd-2LPxrygY0rL5gaUCX-u'), true);
});

test('BbBrowserRunner parses the bb envelope through an injected runner', async () => {
  const calls = [];
  let runs = 0;
  const runner = async (command, args) => {
    calls.push([command, ...args].join(' '));
    if (args[1] === 'open') return { stdout: JSON.stringify({ id: 'sess-1', state: 'ready' }), stderr: '', code: 0, timedOut: false };
    if (args[1] === 'run') {
      runs++;
      const payload = runs === 1 ? { text: 'rendered body text' } : { nodes: [{ id: '1dV1eUWqrzBdd-2LPxrygY0rL5gaUCX-u', label: 'Forge Logo\nowner' }, { id: '_gd', label: 'junk' }] };
      return { stdout: JSON.stringify({ text: JSON.stringify(payload), exitCode: 0 }), stderr: '', code: 0, timedOut: false };
    }
    return { stdout: JSON.stringify({ state: 'closed' }), stderr: '', code: 0, timedOut: false };
  };
  const browser = new BbBrowserRunner({ host: 'host_test', runner });
  assert.equal((await browser.renderText('https://example.com')).text, 'rendered body text');
  const files = await browser.listDriveFolder('https://drive.google.com/drive/folders/1abc');
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'Forge Logo');
  await browser.close();
  assert.ok(calls.some(c => c.includes('open --backend local --headless')));
  assert.ok(calls.some(c => c.includes('close sess-1')));
});

test('crawler escalates needs_browser and drive sources only when browser is enabled', async () => {
  const dir = await cacheDir();
  const request = async url => url.includes('notion')
    ? response('<html><body>JavaScript must be enabled</body></html>')
    : response('<html><body>ok</body></html>');
  const materials = [
    { url: 'https://mediamaxxing.notion.site/lovable-clipping' },
    { url: 'https://drive.google.com/drive/folders/1abc' },
  ];
  const browser = {
    id: 'fake',
    renderText: async url => ({ url, text: 'Rendered rules: must use #Tag. Submit within 10 minutes.' }),
    listDriveFolder: async () => [{ id: '1dV1eUWqrzBdd-2LPxrygY0rL5gaUCX-u', name: 'clip.mp4', mimeType: null }],
  };
  const off = await new BriefCrawler({ request, cacheDir: dir }).crawl('c', materials);
  assert.equal(off.coverage.needsBrowser, 1);
  assert.equal(off.coverage.fetched, 0);
  assert.equal(off.coverage.driveFiles, 0);

  const on = await new BriefCrawler({ request, cacheDir: dir, browser }).crawl('c', materials, { browser: true });
  assert.equal(on.coverage.needsBrowser, 0);
  assert.equal(on.coverage.fetched, 1);
  assert.equal(on.coverage.driveFiles, 1);
  assert.match(on.briefText, /Rendered rules/);
  assert.ok(on.sources.find(s => s.kind === 'footage_drive').driveFiles.length === 1);

  const failing = { id: 'bad', renderText: async () => { throw new Error('no browser'); }, listDriveFolder: async () => { throw new Error('no drive'); } };
  const graceful = await new BriefCrawler({ request, cacheDir: await cacheDir(), browser: failing }).crawl('c', materials, { browser: true });
  assert.equal(graceful.coverage.needsBrowser, 1);
  assert.ok(graceful.warnings.some(w => w.includes('Browser render failed')));
  assert.ok(graceful.warnings.some(w => w.includes('Drive enumeration failed')));
});
