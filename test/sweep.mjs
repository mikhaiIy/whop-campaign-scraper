import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { API_ENDPOINT, parseApiPage, normalizeApi } from '../dist/api.js';
import { BriefCrawler } from '../dist/clipping/crawl.js';
import { BbBrowserRunner } from '../dist/clipping/browser.js';

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const useBrowser = flag('browser');
const maxBrowser = Number(value('max-browser', '0')) || 0;
const idsFile = value('ids', null);
const limit = Number(value('limit', '0')) || 0;
const outPath = value('out', null);

const CLIPPING = /clip|clipper|clipping|ugc|content reward/i;

async function catalog() {
  const found = new Map();
  let cursor = null;
  for (let page = 1; page <= 5; page++) {
    const url = new URL(API_ENDPOINT);
    url.searchParams.set('limit', '50');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const payload = parseApiPage(await response.json());
    for (const record of Array.isArray(payload.data) ? payload.data : []) {
      try {
        const campaign = normalizeApi(record);
        found.set(campaign.id, { campaign, referenceMaterials: record.referenceMaterials ?? [] });
      } catch { continue; }
    }
    cursor = typeof payload.pagination?.nextCursor === 'string' ? payload.pagination.nextCursor : null;
    if (!cursor) break;
  }
  return [...found.values()];
}

let selected;
if (idsFile) {
  const ids = (await readFile(idsFile, 'utf8')).split(/\s+/).filter(Boolean);
  const all = await catalog();
  const byId = new Map(all.map(entry => [entry.campaign.id, entry]));
  selected = ids.map(id => byId.get(id)).filter(Boolean);
} else {
  const all = await catalog();
  selected = all.filter(({ campaign }) =>
    !campaign.requiresApplication && campaign.budgetRemaining > 0 && CLIPPING.test(`${campaign.title} ${campaign.description}`));
}
if (limit) selected = selected.slice(0, limit);

const browser = useBrowser ? new BbBrowserRunner() : null;
const crawler = new BriefCrawler({ browser, cacheDir: process.env.WHOP_CLIP_CACHE ?? '.cache/clipping/refs' });

const results = [];
let hardErrors = 0;
let browserEscalations = 0;
for (const [index, { campaign, referenceMaterials }] of selected.entries()) {
  try {
    let bundle = await crawler.crawl(campaign.id, referenceMaterials, { campaignUrl: campaign.url });
    if (useBrowser) {
      const needs = bundle.sources.some(source => source.status === 'needs_browser' || source.kind === 'footage_drive');
      if (needs && (!maxBrowser || browserEscalations < maxBrowser)) {
        browserEscalations++;
        bundle = await crawler.crawl(campaign.id, referenceMaterials, { campaignUrl: campaign.url, browser: true });
      }
    }
    results.push({ id: campaign.id, title: campaign.title, bundle });
  } catch (error) {
    hardErrors++;
    results.push({ id: campaign.id, title: campaign.title, error: error instanceof Error ? error.message : String(error) });
  }
  if ((index + 1) % 20 === 0) console.error(`… ${index + 1}/${selected.length}`);
}
if (browser) await browser.close();

const textChars = results.filter(r => (r.bundle?.coverage.briefSources ?? 0) > 0).map(r => r.bundle.coverage.textCharacters);
const withText = results.filter(r => (r.bundle?.coverage.briefSources ?? 0) > 0);
const zeroText = results.filter(r => !r.error && (r.bundle?.coverage.briefSources ?? 0) === 0);
const kinds = {};
for (const result of results) {
  for (const link of result.bundle?.links ?? []) kinds[link.kind] = (kinds[link.kind] ?? 0) + 1;
}
const sum = (fn) => results.reduce((total, result) => total + (result.bundle ? fn(result.bundle) : 0), 0);
const tableCampaigns = results.filter(r => (r.bundle?.coverage.tablesRendered ?? 0) > 0);
const sortedChars = [...textChars].sort((a, b) => a - b);
const median = sortedChars.length ? sortedChars[Math.floor((sortedChars.length - 1) / 2)] : 0;

const summary = {
  selected: selected.length,
  browserMode: useBrowser,
  browserEscalations,
  withBriefText: `${withText.length} (${selected.length ? Math.round(withText.length / selected.length * 100) : 0}%)`,
  zeroText: zeroText.length,
  hardErrors,
  failedFetches: sum(b => b.coverage.failed),
  skippedLinks: sum(b => b.coverage.skipped),
  needsBrowser: sum(b => b.coverage.needsBrowser),
  binarySkipped: sum(b => b.coverage.binarySkipped),
  tablesRendered: `${tableCampaigns.length} campaigns, ${sum(b => b.coverage.tablesRendered)} tables`,
  driveFiles: sum(b => b.coverage.driveFiles),
  briefChars: `min ${Math.min(...textChars)} / median ${median} / max ${Math.max(...textChars)}`,
  linkKinds: Object.fromEntries(Object.entries(kinds).sort()),
};

console.log('=== sweep ===');
console.log(JSON.stringify(summary, null, 2));
if (outPath) {
  await mkdir(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
  await writeFile(outPath, JSON.stringify(results.map(r => ({ id: r.id, title: r.title, error: r.error,
    coverage: r.bundle?.coverage, sources: r.bundle?.sources.map(s => ({ url: s.url, kind: s.kind, status: s.status, mediaType: s.mediaType, chars: s.text?.length ?? 0, driveFiles: s.driveFiles?.length ?? 0 })) })), null, 1));
  console.log(`wrote ${outPath}`);
}
