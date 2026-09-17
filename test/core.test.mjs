import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractCampaigns, extractDetail } from '../dist/parser.js';
import { normalize } from '../dist/normalize.js';
import { filterCampaigns, categoryCounts } from '../dist/filters.js';
import { Cache, CampaignSource, TTL_MS } from '../dist/source.js';

const html = await readFile(new URL('./fixtures/discover.html', import.meta.url), 'utf8');
const detail = await readFile(new URL('./fixtures/detail.html', import.meta.url), 'utf8');
const raw = extractCampaigns(html);
const campaigns = raw.map(c => normalize(c, Date.UTC(2026, 8, 17)));

test('real discover fixture yields 50 valid normalized campaigns', () => {
  assert.equal(raw.length, 50);
  const first = campaigns[0];
  assert.equal(first.id, '14f743b2-c5ca-4f3e-8c0d-3010c485005d');
  assert.equal(first.budgetTotal, 248000);
  assert.ok(Math.abs(first.budgetRemaining - 11428.07) < 0.001);
  assert.equal(first.cpmUsd, 1);
  assert.equal(first.ratePer1kLabel, '$1');
  assert.equal(first.budgetTotalLabel, '$248K');
  assert.equal(first.isNearlyExhausted, true);
  assert.ok(first.burnRatePerDay > 0);
  assert.ok(campaigns.some(c => c.category === 'Uncategorized'));
  assert.ok(campaigns.every(c => c.category === c.category.trim()));
});

test('normalization handles missing category, non-CPM rates and invalid age', () => {
  assert.equal(normalize({ ...raw[0], category: '  ' }).category, 'Uncategorized');
  assert.equal(normalize({ ...raw[0], category: 'Health ' }).category, 'Health');
  assert.equal(normalize({ ...raw[0], type: 'retainer' }).cpmUsd, null);
  assert.equal(normalize({ ...raw[0], payoutSortRaw: null, ratePer1kLabel: '$$1.50' }).cpmUsd, 1.5);
  assert.equal(normalize({ ...raw[0], createdAtMs: 0 }).burnRatePerDay, null);
  assert.equal(normalize({ ...raw[0], progressPercentage: 90 }).isNearlyExhausted, false);
});

test('parser errors are explicit and split flight chunks reassemble', () => {
  assert.throws(() => extractCampaigns('<html>empty</html>'), /0 valid campaigns/);
  const payload = `a:${JSON.stringify({ campaigns: [raw[0]] })}`;
  const chunks = [payload.slice(0, 150), payload.slice(150)].map(t => `<script>self.__next_f.push(${JSON.stringify([1, t])})</script>`).join('');
  assert.equal(extractCampaigns(chunks).length, 1);
});

test('public detail fixture exposes payout rules', () => {
  const card = extractDetail(detail, campaigns[0].id);
  assert.equal(card.id, campaigns[0].id);
  assert.equal(card.payouts[0].rateCents, 100);
  assert.throws(() => extractDetail('<html/>', campaigns[0].id), /Detail extraction failed/);
});

test('filters use numeric fields and normalize matching', () => {
  const result = filterCampaigns(campaigns, { categories: [' personal brand '], platforms: ['TIKTOK'], min_cpm: 1, min_budget_remaining: 500, requires_application: true, is_verified: true, sort_by: 'budget_remaining', limit: 3 });
  assert.ok(result.length > 0);
  assert.ok(result.length <= 3);
  assert.ok(result.every(c => c.category === 'Personal Brand' && c.platforms.includes('tiktok') && c.cpmUsd >= 1 && c.budgetRemaining >= 500 && c.requiresApplication && c.isVerified));
  assert.ok(result.every((c, i) => !i || result[i - 1].budgetRemaining >= c.budgetRemaining));
  assert.equal(categoryCounts(campaigns).reduce((sum, c) => sum + c.count, 0), 50);
  assert.equal(filterCampaigns(campaigns, { min_cpm: 1e9 }).length, 0);
  assert.throws(() => filterCampaigns(campaigns, { min_cpm: 2, max_cpm: 1 }), /min_cpm/);
});

test('cache coalesces concurrent loads, expires at five minutes, retries failure', async () => {
  let now = 0;
  let calls = 0;
  const cache = new Cache(async () => ++calls, () => now);
  assert.deepEqual(await Promise.all([cache.get(), cache.get()]), [1, 1]);
  now = TTL_MS - 1;
  assert.equal(await cache.get(), 1);
  now++;
  assert.equal(await cache.get(), 2);
  let attempts = 0;
  const retry = new Cache(async () => { if (++attempts === 1) throw new Error('failed'); return 2; });
  await assert.rejects(retry.get(), /failed/);
  assert.equal(await retry.get(), 2);
});

test('source caches list and detail and rejects HTTP failures', async () => {
  let requests = 0;
  const source = new CampaignSource(async url => { requests++; return new Response(url.endsWith(campaigns[0].id) ? detail : html); });
  await source.list();
  await source.list();
  const enriched = await source.detail(campaigns[0].id);
  await source.detail(campaigns[0].id);
  assert.equal(requests, 2);
  assert.equal(enriched.payoutRules[0].rateCents, 100);
  await assert.rejects(source.detail('../x'), /UUID/);
  const broken = new CampaignSource(async () => new Response('unavailable', { status: 503 }));
  await assert.rejects(broken.list(), /HTTP 503/);
});
