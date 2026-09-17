import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CampaignSource } from '../dist/source.js';
import { CONFIG_URI, ConfigStore, parseConfig, STARTER_CONFIG, resolveConfigPaths } from '../dist/config.js';
import { createServer } from '../dist/server.js';

const html = await readFile(new URL('./fixtures/discover.html', import.meta.url), 'utf8');

async function connect(configPath) {
  const source = new CampaignSource(async () => new Response(html));
  const store = new ConfigStore({ env: { WHOP_MCP_CONFIG: configPath } });
  const server = createServer(source, store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'config-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
    return JSON.parse(result.content[0].text);
  };
  return { client, call, store };
}

async function withTemp(configText) {
  const dir = await mkdtemp(join(tmpdir(), 'whop-config-'));
  const path = join(dir, 'campaigns.config.md');
  if (configText !== undefined) await writeFile(path, configText);
  return { dir, path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const CONFIG = `---
default_preset: tech-lane
presets:
  tech-lane:
    categories: [Technology]
    platforms: [tiktok]
    min_cpm: 1.0
    min_budget_remaining: 500
    exclude_brands: [BloxClips]
  personal:
    categories: [Personal Brand]
---
# Intent

I want short-form tech clips on TikTok, and I do not work with BloxClips.
`;

test('parseConfig reads frontmatter, prose and warns on malformed input', () => {
  const parsed = parseConfig(CONFIG, '/tmp/x');
  assert.equal(parsed.defaultPreset, 'tech-lane');
  assert.deepEqual(Object.keys(parsed.presets).sort(), ['personal', 'tech-lane']);
  assert.equal(parsed.presets['tech-lane'].min_cpm, 1);
  assert.ok(parsed.prose.startsWith('# Intent'));
  assert.equal(parsed.warnings.length, 0);

  const invalidPreset = parseConfig('---\ndefault_preset: a\npresets:\n  a:\n    min_cpm: -5\n  b: 7\n---\nbody', '/tmp/x');
  assert.ok(invalidPreset.warnings.some(w => w.includes('preset "a"')));
  assert.ok(invalidPreset.warnings.some(w => w.includes('preset "b"')));
  assert.equal(invalidPreset.defaultPreset, 'a');

  const badDefault = parseConfig('---\ndefault_preset: missing\npresets: {}\n---\nbody', '/tmp/x');
  assert.ok(badDefault.warnings.some(w => w.includes('not defined')));

  const malformed = parseConfig('---\ndefault_preset: [unclosed\n---\nbody', '/tmp/x');
  assert.equal(malformed.defaultPreset, null);
  assert.deepEqual(malformed.presets, {});
  assert.ok(malformed.warnings.some(w => w.includes('not valid YAML')));
  assert.equal(malformed.prose, 'body');
});

test('resolveConfigPaths honours env, then cwd, then home', () => {
  assert.deepEqual(resolveConfigPaths({ env: { WHOP_MCP_CONFIG: '/etc/custom.md' }, cwd: '/work', home: '/home/me' }), ['/etc/custom.md']);
  assert.deepEqual(resolveConfigPaths({ env: {}, cwd: '/work', home: '/home/me' }), ['/work/campaigns.config.md', '/home/me/.config/whop-mcp/campaigns.config.md']);
});

test('missing config file is auto-created and the starter parses cleanly', async () => {
  const { path, cleanup } = await withTemp();
  try {
    const { call, client } = await connect(path);
    const listed = await call('list_campaigns');
    assert.equal(listed.configAutoCreated, true);
    assert.equal(listed.configExists, true);
    assert.equal(listed.appliedPreset, 'example');
    assert.deepEqual(listed.availablePresets, ['example']);
    const created = await readFile(path, 'utf8');
    assert.equal(created, STARTER_CONFIG);
    assert.ok(listed.returned > 0 && listed.returned < 50);
    assert.equal(listed.campaigns.every(c => c.cpmUsd >= 1 && c.budgetRemaining >= 500), true);
    const resource = await client.readResource({ uri: CONFIG_URI });
    assert.ok(resource.contents[0].text.includes('What I am looking for'));
    await client.close();
  } finally {
    await cleanup();
  }
});

test('default preset applies and explicit arguments override individual values', async () => {
  const { path, cleanup } = await withTemp(CONFIG);
  try {
    const { call, client } = await connect(path);

    const preset = await call('list_campaigns');
    assert.equal(preset.appliedPreset, 'tech-lane');
    assert.ok(preset.returned > 0);
    assert.equal(preset.configNotes.trim(), '# Intent\n\nI want short-form tech clips on TikTok, and I do not work with BloxClips.');
    assert.ok(preset.campaigns.every(c => c.category === 'Technology' && c.platforms.includes('tiktok') && c.cpmUsd >= 1 && c.budgetRemaining >= 500 && c.brand !== 'BloxClips'));
    assert.deepEqual(preset.configWarnings, []);

    const other = await call('list_campaigns', { preset: 'personal' });
    assert.equal(other.appliedPreset, 'personal');
    assert.ok(other.returned > 0);
    assert.ok(other.campaigns.every(c => c.category === 'Personal Brand'));

    const override = await call('list_campaigns', { categories: ['Personal Brand'] });
    assert.equal(override.appliedPreset, 'tech-lane');
    assert.ok(override.returned > 0);
    assert.ok(override.campaigns.every(c => c.category === 'Personal Brand' && c.platforms.includes('tiktok') && c.brand !== 'BloxClips'));
    assert.deepEqual(override.appliedFilters.categories, ['Personal Brand']);

    const unknown = await call('list_campaigns', { preset: 'nope' });
    assert.equal(unknown.appliedPreset, 'nope');
    assert.ok(unknown.configWarnings.some(w => w.includes('not defined')));
    assert.equal(unknown.returned, 50);

    await client.close();
  } finally {
    await cleanup();
  }
});

test('malformed config falls back to no filtering with a warning', async () => {
  const { path, cleanup } = await withTemp('---\ndefault_preset: [unclosed\npresets:\n  broken: {min_cpm: nope}\n---\nStill give me campaigns.\n');
  try {
    const { call, client } = await connect(path);
    const listed = await call('list_campaigns');
    assert.equal(listed.appliedPreset, null);
    assert.ok(listed.configWarnings.some(w => w.includes('not valid YAML')));
    assert.equal(listed.returned, 50);
    assert.equal(listed.configNotes, 'Still give me campaigns.');
    await client.close();
  } finally {
    await cleanup();
  }
});

test('hot reload picks up mtime changes and reload_config forces a re-read', async () => {
  const { path, cleanup } = await withTemp(CONFIG);
  try {
    const { call, client } = await connect(path);
    assert.equal((await call('list_campaigns')).appliedPreset, 'tech-lane');

    const before = await stat(path);
    const bumped = Math.round(before.mtimeMs) + 5000;
    await writeFile(path, CONFIG.replace('default_preset: tech-lane', 'default_preset: personal'));
    await utimes(path, before.atime, new Date(bumped));
    assert.equal((await call('list_campaigns')).appliedPreset, 'personal');

    await writeFile(path, CONFIG.replace('default_preset: tech-lane', 'default_preset: nope'));
    await utimes(path, before.atime, new Date(bumped));
    const withoutForce = await call('list_campaigns');
    assert.equal(withoutForce.appliedPreset, 'personal');
    assert.equal((await stat(path)).mtimeMs, bumped);

    const forced = await call('reload_config');
    assert.equal(forced.defaultPreset, 'nope');
    assert.ok(forced.configWarnings.some(w => w.includes('not defined')));
    assert.deepEqual(forced.presetNames, ['personal', 'tech-lane']);
    assert.ok(forced.prose.includes('I want short-form tech clips'));
    assert.equal((await call('list_campaigns')).appliedPreset, 'nope');

    await client.close();
  } finally {
    await cleanup();
  }
});
