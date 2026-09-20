import { CampaignSource } from '../dist/source.js';
import { ClippingPipeline } from '../dist/clipping/pipeline.js';
import { OpenCodeCliLlm, DEFAULT_LOCAL_MODEL } from '../dist/clipping/llm.js';
import { BriefCrawler } from '../dist/clipping/crawl.js';
import { YouTubeFootageResolver } from '../dist/clipping/youtube.js';

const TJR = '0d921575-0f7b-4082-a7a9-79a9dcc72dba';
const campaignId = process.argv[2] ?? TJR;
const limit = Number(process.argv[3] ?? 8);
const model = process.env.WHOP_LLM_MODEL ?? DEFAULT_LOCAL_MODEL;

const source = new CampaignSource();
const pipeline = new ClippingPipeline({
  crawler: new BriefCrawler({ cacheDir: process.env.WHOP_CLIP_CACHE ?? '.cache/clipping/refs' }),
  llm: new OpenCodeCliLlm({ model }),
  resolver: new YouTubeFootageResolver(),
});

const started = Date.now();
const detail = await source.detail(campaignId);
console.log(`# ${detail.title} (${campaignId})`);
console.log(`cpm=$${detail.campaign?.cpmUsd ?? '?'} remaining=$${detail.campaign?.budgetRemaining ?? '?'} refs=${detail.referenceMaterials?.length ?? 0}`);

const bundle = await pipeline.brief(detail);
console.log(`\n## Brief\nlinks=${bundle.links.map(l => l.kind).join(',')} fetched=${bundle.coverage.fetched} failed=${bundle.coverage.failed} skipped=${bundle.coverage.skipped} chars=${bundle.coverage.textCharacters}`);
for (const warning of bundle.warnings) console.log(`warning: ${warning}`);

const { clipSpec, warnings } = await pipeline.extract(bundle, detail);
const META = new Set(['campaignId', 'extractedAt', 'extractor']);
const filled = Object.entries(clipSpec).filter(([field, value]) => !META.has(field) && value !== null && !Array.isArray(value));
console.log(`\n## ClipSpec (${filled.length} rule fields via ${clipSpec.extractor.provider})`);
for (const [field, entry] of filled) console.log(`- ${field}: ${JSON.stringify(entry.value)}`);
for (const item of clipSpec.unstructuredRequirements) console.log(`- (unstructured) ${item.text}`);
for (const warning of warnings) console.log(`warning: ${warning}`);

const footage = await pipeline.footage(bundle, { videoLimit: limit });
console.log(`\n## Source videos (${footage.videos.length})`);
for (const channel of footage.channels) {
  console.log(`\n### ${channel.channel ?? channel.channelUrl} — ${channel.videos.length} video(s)`);
  for (const video of channel.videos) console.log(`- ${video.id} | ${video.durationSeconds ?? '?'}s | ${video.uploadDate ?? '?'} | ${video.title}`);
}
for (const note of footage.deferred) console.log(`deferred: ${note}`);
console.log(`\ncompleted in ${((Date.now() - started) / 1000).toFixed(1)}s`);
