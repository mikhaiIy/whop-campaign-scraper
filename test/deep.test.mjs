import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_ENDPOINT, assetUrl, moneyLabel, normalizeApi } from '../dist/api.js';
import { CampaignSource } from '../dist/source.js';
import { parseConfig, DEFAULT_FETCH } from '../dist/config.js';
import { createServer } from '../dist/server.js';
import { ConfigStore } from '../dist/config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const apiFixture = JSON.parse(await readFile(new URL('./fixtures/discover-api.json', import.meta.url), 'utf8'));
const html = await readFile(new URL('./fixtures/discover.html', import.meta.url), 'utf8');
const NOW = Date.UTC(2026, 8, 17);

test('normalizeApi maps the public JSON API shape onto Campaign', () => {
  const campaign = normalizeApi(apiFixture.data[0], NOW);
  assert.equal(campaign.id, '14f743b2-c5ca-4f3e-8c0d-3010c485005d');
  assert.equal(campaign.title, 'FR Yomi Denzel Campagne Principale');
  assert.equal(campaign.brand, 'Yomi Denzel Clipping');
  assert.equal(campaign.category, 'Personal Brand');
  assert.equal(campaign.budgetTotal, 248000);
  assert.ok(Math.abs(campaign.budgetSpent - 236597.88) < 0.01);
  assert.ok(Math.abs(campaign.budgetRemaining - 11402.12) < 0.01);
  assert.equal(campaign.cpmUsd, 1);
  assert.equal(campaign.ratePer1kLabel, '$1');
  assert.equal(campaign.budgetTotalLabel, '$248K');
  assert.equal(campaign.isNearlyExhausted, true);
  assert.equal(campaign.creatorCount, 280);
  assert.equal(campaign.submissionCount, 43297);
  assert.equal(campaign.requiresApplication, true);
  assert.equal(campaign.isVerified, true);
  assert.equal(campaign.createdAtMs, Date.parse('2026-08-15T10:40:47.000Z'));
  assert.ok(campaign.thumbnail.startsWith('https://content-rewards-production-publicassetsbucket-'));
  assert.equal(campaign.url, `https://contentrewards.com/discover/${campaign.id}`);

  const uncategorized = normalizeApi(apiFixture.data.find(c => !c.categories?.length), NOW);
  assert.equal(uncategorized.category, 'Uncategorized');
  assert.equal(uncategorized.cpmUsd, 1.75);
  assert.equal(uncategorized.budgetTotalLabel, '$105K');
  assert.ok(uncategorized.burnRatePerDay > 0);
});

test('api helpers format assets and money defensively', () => {
  assert.equal(assetUrl(null), null);
  assert.equal(assetUrl('https://x.test/a.png'), 'https://x.test/a.png');
  assert.ok(assetUrl('key/a.png').endsWith('/key/a.png'));
  assert.equal(moneyLabel(null), '$0');
  assert.equal(moneyLabel(500), '$5');
  assert.equal(moneyLabel(1249900), '$12.5K');
  assert.equal(moneyLabel(24800000), '$248K');
  assert.equal(moneyLabel(150000000), '$1.5M');
});

function record(id, overrides = {}) {
  return {
    id, name: `Campaign ${id}`, organizationName: 'Brand', description: 'd', payoutType: 'cpm',
    primaryPayoutCents: 200, platforms: ['tiktok'], requiresApplication: false, organizationVerified: true,
    budgetCents: 1000000, createdAt: '2026-09-01T00:00:00.000Z', banner: `${id}.png`,
    categories: [{ id: 'tech', name: 'Technology' }],
    metrics: { budgetSpentCents: 100000, budgetProgressBps: 1000, creatorCount: 5, approvedSubmissionCount: 9 },
    ...overrides,
  };
}

function apiResponse(records, nextCursor) {
  return new Response(JSON.stringify({ data: records, pagination: { count: records.length, limit: 2, nextCursor }, success: true }), { headers: { 'Content-Type': 'application/json' } });
}

test('deep fetch follows the cursor, dedupes, and respects max_pages', async () => {
  const pages = [
    [record('11111111-1111-1111-1111-111111111111'), record('22222222-2222-2222-2222-222222222222')],
    [record('22222222-2222-2222-2222-222222222222'), record('33333333-3333-3333-3333-333333333333')],
    [record('44444444-4444-4444-4444-444444444444')],
  ];
  const requestedCursors = [];
  const source = new CampaignSource(async (url, init) => {
    assert.equal(init.headers['User-Agent'].includes('Mozilla'), true);
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, API_ENDPOINT);
    requestedCursors.push(parsed.searchParams.get('cursor'));
    const index = Number(parsed.searchParams.get('cursor') ?? '0');
    return apiResponse(pages[index] ?? [], String(index + 1));
  }, { maxPages: 3, pageSize: 2, pageDelayMs: 0 });

  const campaigns = await source.list();
  assert.deepEqual(campaigns.map(c => c.id), [
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
    '33333333-3333-3333-3333-333333333333',
    '44444444-4444-4444-4444-444444444444',
  ]);
  assert.deepEqual(requestedCursors, [null, '1', '2']);
  assert.equal(source.fetchMode, 'api');
  assert.equal(source.pagesFetched, 3);
  assert.equal(source.catalogComplete, false);
  assert.equal(source.deepFetchError, null);
});

test('deep fetch stops early when the catalog is exhausted', async () => {
  const source = new CampaignSource(async url => {
    const cursor = new URL(url).searchParams.get('cursor');
    return apiResponse([record('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')], cursor ? null : 'c1');
  }, { maxPages: 10, pageSize: 1, pageDelayMs: 0 });
  const campaigns = await source.list();
  assert.equal(campaigns.length, 1);
  assert.equal(source.pagesFetched, 2);
  assert.equal(source.catalogComplete, true);
});

test('deep fetch failure falls back silently to the HTML batch and reports why', async () => {
  const seen = [];
  const source = new CampaignSource(async url => {
    seen.push(url);
    if (url.includes('/api/campaign/campaigns/discover')) return new Response('<html>not json</html>');
    return new Response(html);
  }, { maxPages: 5, pageDelayMs: 0 });
  const campaigns = await source.list();
  assert.equal(campaigns.length, 50);
  assert.equal(source.fetchMode, 'html');
  assert.ok(source.deepFetchError.includes('JSON'));
  assert.equal(seen[0].includes('/api/campaign/campaigns/discover'), true);
  assert.ok(seen.some(u => u === 'https://contentrewards.com/discover'));
});

test('HTTP API errors fall back to the HTML batch too', async () => {
  const source = new CampaignSource(async url => url.includes('/api/') ? new Response('nope', { status: 429 }) : new Response(html), { pageDelayMs: 0 });
  const campaigns = await source.list();
  assert.equal(campaigns.length, 50);
  assert.equal(source.fetchMode, 'html');
  assert.ok(source.deepFetchError.includes('HTTP 429'));
});

test('configure enables and disables deep fetch without disturbing the HTML path', async () => {
  let apiCalls = 0;
  const source = new CampaignSource(async url => {
    if (url.includes('/api/')) { apiCalls++; return apiResponse([record('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')], null); }
    return new Response(html);
  }, { deep: false, pageDelayMs: 0 });
  assert.equal((await source.list()).length, 50);
  assert.equal(source.fetchMode, 'html');
  assert.equal(apiCalls, 0);
  source.configure({ deep: true });
  assert.equal((await source.list()).length, 1);
  assert.equal(source.fetchMode, 'api');
  assert.equal(apiCalls, 1);
});

test('parseConfig reads deep fetch settings and warns on bad values', () => {
  const parsed = parseConfig('---\ndeep_fetch: false\nmax_pages: 12\npage_size: 100\npage_delay_ms: 0\n---\nbody');
  assert.deepEqual(parsed.fetch, { deep: false, maxPages: 12, pageSize: 100, pageDelayMs: 0 });
  assert.deepEqual(parseConfig('---\n---\nbody').fetch, DEFAULT_FETCH);
  const bad = parseConfig('---\ndeep_fetch: yes\nmax_pages: 999\npage_size: 0\npage_delay_ms: -1\n---\nbody');
  assert.deepEqual(bad.fetch, DEFAULT_FETCH);
  assert.equal(bad.warnings.filter(w => w.includes('must be')).length, 4);
});

test('list_campaigns metadata reflects API coverage and config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whop-deep-'));
  const configPath = join(dir, 'campaigns.config.md');
  await writeFile(configPath, '---\nmax_pages: 4\npage_size: 8\npage_delay_ms: 0\n---\nbody\n');
  const source = new CampaignSource(async url => {
    if (url.includes('/api/')) return apiResponse([record('cccccccc-cccc-cccc-cccc-cccccccccccc')], null);
    return new Response(html);
  });
  const server = createServer(source, new ConfigStore({ env: { WHOP_MCP_CONFIG: configPath } }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'deep-test', version: '1.0.0' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: 'list_campaigns', arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.fetchMode, 'api');
    assert.equal(payload.catalogComplete, true);
    assert.equal(payload.fetchConfig.maxPages, 4);
    assert.equal(payload.fetchConfig.pageSize, 8);
    assert.ok(payload.coverage.includes('end of the public catalog'));
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
