import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CampaignSource } from '../dist/source.js';
import { ConfigStore, buildConfigText, parseConfig, splitFrontmatter } from '../dist/config.js';
import { ToolLog } from '../dist/toolLog.js';
import { startWebServer, toWebCampaign } from '../dist/web.js';
import { normalizeApi } from '../dist/api.js';
import { createServer } from '../dist/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const apiFixture = JSON.parse(await readFile(new URL('./fixtures/api-with-chartpoints.json', import.meta.url), 'utf8'));
const html = await readFile(new URL('./fixtures/discover.html', import.meta.url), 'utf8');

const CONFIG = `---
default_preset: tech-lane
max_pages: 1
page_delay_ms: 0
presets:
  tech-lane:
    categories: [Technology]
    platforms: [tiktok]
    min_cpm: 1.0
    min_budget_remaining: 500
---
# Intent

I want short-form tech clips on TikTok.
This second line must survive byte for byte.
`;

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'whop-web-'));
  const configPath = join(dir, 'campaigns.config.md');
  await writeFile(configPath, CONFIG);
  const source = new CampaignSource(async url => {
    if (url.includes('/api/campaign/campaigns/discover')) {
      return new Response(JSON.stringify(apiFixture), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(html);
  }, { pageDelayMs: 0, maxPages: 1 });
  const configStore = new ConfigStore({ env: { WHOP_MCP_CONFIG: configPath } });
  const toolLog = new ToolLog();
  const web = await startWebServer({ source, configStore, toolLog, port: 0 });
  return {
    web, source, toolLog, configPath, dir,
    url: path => `${web.url}${path}`,
    cleanup: async () => { await web.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('serves the single-page app and JSON endpoints with real handler shapes', async () => {
  const h = await harness();
  try {
    const page = await fetch(h.url('/'));
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const body = await page.text();
    assert.ok(body.includes('Campaign Console'));
    assert.ok(body.includes('id="campaigns"'));

    const camps = await fetch(h.url('/api/campaigns'));
    assert.equal(camps.status, 200);
    const payload = await camps.json();
    assert.equal(payload.total, 1);
    assert.equal(payload.campaigns.length, 1);
    assert.ok(payload.categories.some(c => c.category === 'Personal Brand'));
    assert.ok(payload.platforms.some(p => p.value === 'tiktok'));
    assert.ok(Array.isArray(payload.campaigns[0].series.values));
    assert.ok(payload.campaigns[0].series.values.length > 10);
    assert.equal(payload.campaigns[0].series.metric, 'spend');

    const status = await fetch(h.url('/api/status'));
    assert.equal(status.status, 200);
    const meta = await status.json();
    assert.equal(meta.fetchMode, 'api');
    assert.equal(meta.pagesFetched, 1);
    assert.ok(meta.source.includes('contentrewards.com'));
    assert.equal(meta.defaultPreset, 'tech-lane');
    assert.ok(Array.isArray(meta.toolCalls));

    const missing = await fetch(h.url('/api/nope'));
    assert.equal(missing.status, 404);
  } finally {
    await h.cleanup();
  }
});

test('config POST round-trips presets and preserves the prose body exactly', async () => {
  const h = await harness();
  try {
    const before = await (await fetch(h.url('/api/config'))).json();
    assert.equal(before.defaultPreset, 'tech-lane');
    assert.deepEqual(before.presets['tech-lane'].categories, ['Technology']);

    const response = await fetch(h.url('/api/config'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultPreset: 'gaming',
        presets: {
          'tech-lane': { categories: ['Technology'], platforms: ['tiktok'], min_cpm: 1.5 },
          gaming: { categories: ['Gaming'], platforms: ['youtube'], min_budget_remaining: 1000, limit: 25 },
        },
        fetch: { deep: true, maxPages: 7, pageSize: 40, pageDelayMs: 250 },
      }),
    });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.config.defaultPreset, 'gaming');
    assert.deepEqual(saved.config.presets.gaming.categories, ['Gaming']);
    assert.equal(saved.config.presets.gaming.limit, 25);
    assert.equal(saved.config.fetch.maxPages, 7);

    const onDisk = await readFile(h.configPath, 'utf8');
    const { body } = splitFrontmatter(onDisk);
    assert.equal(body, '# Intent\n\nI want short-form tech clips on TikTok.\nThis second line must survive byte for byte.\n');
    assert.equal(body, splitFrontmatter(CONFIG).body);

    const reparsed = parseConfig(onDisk, h.configPath);
    assert.equal(reparsed.prose, '# Intent\n\nI want short-form tech clips on TikTok.\nThis second line must survive byte for byte.');
    assert.equal(reparsed.defaultPreset, 'gaming');
    assert.deepEqual(Object.keys(reparsed.presets).sort(), ['gaming', 'tech-lane']);
    assert.deepEqual(reparsed.warnings, []);

    const after = await (await fetch(h.url('/api/config'))).json();
    assert.equal(after.defaultPreset, 'gaming');
  } finally {
    await h.cleanup();
  }
});

test('config POST rejects malformed payloads without touching the file', async () => {
  const h = await harness();
  try {
    const response = await fetch(h.url('/api/config'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultPreset: 'x', presets: { bad: { min_cpm: -3 } }, fetch: { deep: true, maxPages: 5, pageSize: 50, pageDelayMs: 0 } }),
    });
    assert.equal(response.status, 400);
    assert.equal(await readFile(h.configPath, 'utf8'), CONFIG);
  } finally {
    await h.cleanup();
  }
});

test('monitor log records agent tool calls through the shared ToolLog', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whop-weblog-'));
  const configPath = join(dir, 'campaigns.config.md');
  await writeFile(configPath, CONFIG);
  const source = new CampaignSource(async url => url.includes('/api/campaign/campaigns/discover')
    ? new Response(JSON.stringify(apiFixture), { headers: { 'Content-Type': 'application/json' } })
    : new Response(html), { pageDelayMs: 0, maxPages: 1 });
  const configStore = new ConfigStore({ env: { WHOP_MCP_CONFIG: configPath } });
  const toolLog = new ToolLog();
  const web = await startWebServer({ source, configStore, toolLog, port: 0 });
  const server = createServer(source, configStore, toolLog);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'web-log-test', version: '1.0.0' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.callTool({ name: 'list_campaigns', arguments: { limit: 5 } });
    await client.callTool({ name: 'list_categories', arguments: {} });

    const status = await (await fetch(`${web.url}/api/status`)).json();
    assert.equal(status.toolCalls.length, 2);
    assert.deepEqual(status.toolCalls.map(c => c.tool).sort(), ['list_campaigns', 'list_categories']);
    const listed = status.toolCalls.find(c => c.tool === 'list_campaigns');
    assert.equal(listed.ok, true);
    assert.equal(listed.args.limit, 5);
    assert.ok(listed.durationMs >= 0);
    await client.close();
  } finally {
    await web.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildConfigText adds frontmatter without disturbing a bare prose file', () => {
  const bare = '# Just prose\n\nNo frontmatter here.\n';
  const text = buildConfigText(bare, { defaultPreset: null, presets: { a: { min_cpm: 2 } }, fetch: { deep: true, maxPages: 5, pageSize: 50, pageDelayMs: 0 } });
  assert.equal(splitFrontmatter(text).body, bare);
  const parsed = parseConfig(text);
  assert.equal(parsed.prose, '# Just prose\n\nNo frontmatter here.');
  assert.deepEqual(parsed.presets.a, { min_cpm: 2 });
});

test('toWebCampaign emits a compact series and drops the description', () => {
  const campaign = normalizeApi(apiFixture.data[0], Date.UTC(2026, 8, 17));
  const web = toWebCampaign(campaign);
  assert.equal(web.description, undefined);
  assert.equal(web.chartPoints, undefined);
  assert.equal(web.series.values.length, campaign.chartPoints.length);
  assert.ok(web.series.values.every(v => typeof v === 'number' && v >= 0));
});
