import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const temp = await mkdtemp(join(tmpdir(), 'whop-mcp-live-'));
const config = join(temp, 'campaigns.config.md');
await writeFile(config, '---\ndefault_preset: live-lane\npresets:\n  live-lane:\n    min_budget_remaining: 1\n    sort_by: cpm\n---\n# Live smoke test\nInitial intent.\n');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('dist/index.js')],
  env: { ...process.env, WHOP_MCP_CONFIG: config },
  stderr: 'inherit',
});
const client = new Client({ name: 'whop-live-smoke', version: '1.0.0' });
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return JSON.parse(result.content[0].text);
}
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(t => t.name).sort(), ['get_campaign', 'list_campaigns', 'list_categories', 'reload_config', 'search_campaigns']);
  const resources = await client.listResources();
  assert.ok(resources.resources.some(r => r.uri === 'whop://config/notes'));

  const listed = await call('list_campaigns');
  assert.equal(listed.appliedPreset, 'live-lane');
  assert.ok(listed.campaigns.length > 0);
  assert.ok(listed.campaigns.every(c => c.budgetRemaining >= 1));
  assert.ok(listed.configNotes.includes('Initial intent'));
  assert.deepEqual(listed.configWarnings, []);
  const first = listed.campaigns[0];

  const filtered = await call('list_campaigns', { categories: [first.category.toUpperCase()], min_budget_remaining: 0, sort_by: 'cpm', limit: 3 });
  assert.equal(filtered.appliedPreset, 'live-lane');
  assert.ok(filtered.campaigns.length <= 3);
  assert.equal(filtered.fetchedAt, listed.fetchedAt);

  const notes = await client.readResource({ uri: 'whop://config/notes' });
  assert.ok(notes.contents[0].text.includes('Initial intent'));

  const categories = await call('list_categories');
  assert.equal(categories.categories.reduce((sum, c) => sum + c.count, 0), listed.totalFetched);
  const searched = await call('search_campaigns', { query: first.title });
  assert.ok(searched.campaigns.some(c => c.id === first.id));
  const detail = await call('get_campaign', { id: first.id });
  assert.equal(detail.id, first.id);
  assert.ok(Array.isArray(detail.payoutRules));

  await writeFile(config, '# Live smoke test\nChanged intent.\n');
  const changed = await call('reload_config');
  assert.equal(changed.defaultPreset, null);
  assert.ok(changed.prose.includes('Changed intent'));
  const unfiltered = await call('list_campaigns');
  assert.equal(unfiltered.appliedPreset, null);
  assert.equal(unfiltered.returned, unfiltered.totalFetched);

  await writeFile(config, '---\ndefault_preset: [unclosed\n---\nBroken frontmatter.\n');
  const broken = await call('list_campaigns');
  assert.equal(broken.appliedPreset, null);
  assert.ok(broken.configWarnings.some(w => w.includes('not valid YAML')));
  assert.ok(broken.campaigns.length > 0);

  const invalid = await client.callTool({ name: 'get_campaign', arguments: { id: '../invalid' } });
  assert.equal(invalid.isError, true);
  console.log(JSON.stringify({ tools: tools.tools.map(t => t.name), resources: resources.resources.map(r => r.uri), campaigns: listed.totalFetched, presetApplied: true, explicitOverride: true, notesResource: true, hotReload: true, malformedFallback: true, detailId: detail.id, payoutRules: detail.payoutRules.length }, null, 2));
} finally {
  await client.close();
  await rm(temp, { recursive: true, force: true });
}
