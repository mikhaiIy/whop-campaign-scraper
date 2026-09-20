import { CampaignSource } from '../dist/source.js';
import { BriefCrawler } from '../dist/clipping/crawl.js';
import { BbBrowserRunner } from '../dist/clipping/browser.js';

const id = process.argv[2] ?? 'ecbd7fec-6f39-4081-aa18-1756f0ae73e9';
const source = new CampaignSource();
const detail = await source.detail(id);
console.log(`# ${detail.title} refs=${JSON.stringify(detail.referenceMaterials)}`);

const planner = new BriefCrawler({ cacheDir: process.env.WHOP_CLIP_CACHE ?? '.cache/clipping/refs' });
const before = await planner.crawl(id, detail.referenceMaterials, { campaignUrl: detail.url });
console.log('\n=== PLAIN FETCH ===');
console.log(JSON.stringify(before.coverage));
for (const s of before.sources) console.log(`- ${s.kind} ${s.status} chars=${s.text?.length ?? 0} ${s.error ?? ''}`);

const browser = new BbBrowserRunner();
const crawler = new BriefCrawler({ browser, cacheDir: process.env.WHOP_CLIP_CACHE ?? '.cache/clipping/refs' });
const after = await crawler.crawl(id, detail.referenceMaterials, { campaignUrl: detail.url, browser: true });
await browser.close();

console.log('\n=== WITH BROWSER ===');
console.log(JSON.stringify(after.coverage));
for (const s of after.sources) {
  console.log(`- ${s.kind} ${s.status} chars=${s.text?.length ?? 0}${s.fromCache ? ' (cache)' : ''}`);
  for (const file of (s.driveFiles ?? []).slice(0, 12)) console.log(`    drive: ${file.id} | ${file.name}`);
  if (s.driveFiles && s.driveFiles.length > 12) console.log(`    … ${s.driveFiles.length - 12} more files`);
}
console.log('\n--- brief text ---');
console.log((after.briefText ?? '(none)').slice(0, 1600));
