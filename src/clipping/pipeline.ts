import { BriefCrawler, type BriefBundle, type BriefCoverage, type BriefSource } from './crawl.js';
import { buildExtractionPrompt, emptyClipSpec, parseClipSpec, EXTRACTION_PROMPT_VERSION, type ClipSpec } from './extract.js';
import type { BrowserRunner, DriveFile } from './browser.js';
import type { TextLlm } from './llm.js';
import { classifyReferences, type ClassifiedLink } from './links.js';
import { YouTubeFootageResolver, clippabilityScore, normalizeChannelUrl, rankFootage, type ChannelListing, type SourceVideo } from './youtube.js';

export interface CampaignDetailLike {
  id: string;
  title?: string | null;
  description?: string | null;
  campaignUrl?: string | null;
  referenceMaterials?: unknown;
  campaign?: { cpmUsd?: number | null; platforms?: string[]; url?: string; title?: string } | null;
}

export interface FootageResult {
  channels: ChannelListing[];
  videos: SourceVideo[];
  driveFiles: DriveFile[];
  deferred: string[];
  warnings: string[];
}

export interface ClippingPlan {
  campaignId: string;
  title: string | null;
  campaignUrl: string;
  links: ClassifiedLink[];
  discoveredLinks: ClassifiedLink[];
  brief: {
    sources: BriefSource[];
    coverage: BriefCoverage;
    briefText: string | null;
    warnings: string[];
  };
  clipSpec: ClipSpec | null;
  clipSpecWarnings: string[];
  footage: FootageResult;
  warnings: string[];
  contentTrust: string;
}

export interface PlanOptions {
  refresh?: boolean;
  extract?: boolean;
  resolveVideos?: boolean;
  videoLimit?: number;
  browser?: boolean;
}

export interface ClippingPipelineDeps {
  crawler?: BriefCrawler;
  llm?: TextLlm | null;
  resolver?: YouTubeFootageResolver;
  browser?: BrowserRunner | null;
  now?: () => number;
}

export class ClippingPipeline {
  private readonly crawler: BriefCrawler;
  private readonly llm: TextLlm | null;
  private readonly resolver: YouTubeFootageResolver;

  constructor(deps: ClippingPipelineDeps = {}) {
    this.crawler = deps.crawler ?? new BriefCrawler({ browser: deps.browser ?? null });
    this.llm = deps.llm === undefined ? null : deps.llm;
    this.resolver = deps.resolver ?? new YouTubeFootageResolver();
  }

  async brief(detail: CampaignDetailLike, options: { refresh?: boolean; browser?: boolean } = {}): Promise<BriefBundle> {
    return this.crawler.crawl(detail.id, detail.referenceMaterials, {
      campaignUrl: detail.campaignUrl ?? detail.campaign?.url,
      refresh: options.refresh ?? false,
      browser: options.browser ?? false,
    });
  }

  async extract(bundle: BriefBundle, detail: CampaignDetailLike): Promise<{ clipSpec: ClipSpec; warnings: string[] }> {
    if (!this.llm) {
      const spec = emptyClipSpec({ campaignId: bundle.campaignId, extractor: { provider: 'none', model: null, promptVersion: EXTRACTION_PROMPT_VERSION }, sourceIds: [] });
      return { clipSpec: spec, warnings: ['No LLM is configured; the ClipSpec is empty.'] };
    }
    const prompt = buildExtractionPrompt(bundle, {
      title: detail.title ?? detail.campaign?.title ?? null,
      description: detail.description ?? null,
      cpmUsd: detail.campaign?.cpmUsd ?? null,
      platforms: detail.campaign?.platforms,
    });
    const raw = await this.llm.complete(prompt, { system: 'You output strict JSON only.' });
    const { spec, warnings } = parseClipSpec(raw, {
      campaignId: bundle.campaignId,
      extractor: { provider: this.llm.id, model: this.llm.model, promptVersion: EXTRACTION_PROMPT_VERSION },
      sourceIds: bundle.sources.map(source => source.id),
      now: Date.now,
    });
    return { clipSpec: spec, warnings };
  }

  async footage(bundle: BriefBundle, options: { resolveVideos?: boolean; channelOverride?: string; videoLimit?: number; timeoutMs?: number } = {}): Promise<FootageResult> {
    const all = [...bundle.links, ...bundle.discoveredLinks];
    const deferred: string[] = [];
    const warnings: string[] = [];
    const driveFiles: DriveFile[] = [];
    const driveSeen = new Set<string>();
    for (const source of bundle.sources) {
      for (const file of source.driveFiles ?? []) {
        if (driveSeen.has(file.id)) continue;
        driveSeen.add(file.id);
        driveFiles.push(file);
      }
    }
    const channelUrls = [...new Set(all.filter(link => link.kind === 'footage_channel').map(link => link.url))];
    if (options.channelOverride) channelUrls.unshift(options.channelOverride);
    for (const link of all.filter(link => link.kind === 'footage_drive')) {
      const source = bundle.sources.find(candidate => candidate.url === link.url);
      if (!source?.driveFiles?.length) deferred.push(`${link.url} (${link.host}): folder/listings not enumerated; enable the browser option or a provider API.`);
    }
    const youtubeUrls = channelUrls.filter(url => normalizeChannelUrl(url).isChannel);
    for (const url of channelUrls.filter(url => !normalizeChannelUrl(url).isChannel)) {
      deferred.push(`${url}: only YouTube channels are enumerated right now; this channel needs another extractor.`);
    }
    if (options.resolveVideos === false || !youtubeUrls.length) {
      return { channels: [], videos: [], driveFiles, deferred, warnings };
    }
    const channels = await this.resolver.resolveAll(youtubeUrls, { limit: options.videoLimit, timeoutMs: options.timeoutMs });
    for (const listing of channels) warnings.push(...listing.warnings.map(warning => `${listing.channelUrl}: ${warning}`));
    const seen = new Set<string>();
    const videos: SourceVideo[] = [];
    for (const listing of channels) {
      for (const video of listing.videos) {
        if (seen.has(video.id)) continue;
        seen.add(video.id);
        videos.push(video);
      }
    }
    const ranked = rankFootage(videos);
    if (ranked.length) {
      const best = clippabilityScore(ranked[0]);
      warnings.push(`Footage ranked by clippability; best candidate is "${ranked[0].title}" (score ${best.score}).`);
    }
    return { channels, videos: ranked, driveFiles, deferred, warnings };
  }

  async plan(detail: CampaignDetailLike, options: PlanOptions = {}): Promise<ClippingPlan> {
    const bundle = await this.brief(detail, { refresh: options.refresh, browser: options.browser });
    const warnings = [...bundle.warnings];
    let clipSpec: ClipSpec | null = null;
    let clipSpecWarnings: string[] = [];
    if (options.extract !== false) {
      try {
        const extracted = await this.extract(bundle, detail);
        clipSpec = extracted.clipSpec;
        clipSpecWarnings = extracted.warnings;
      } catch (error) {
        clipSpecWarnings = [`ClipSpec extraction failed: ${error instanceof Error ? error.message : String(error)}`];
      }
    }
    warnings.push(...clipSpecWarnings);
    const footage = await this.footage(bundle, { resolveVideos: options.resolveVideos, videoLimit: options.videoLimit });
    warnings.push(...footage.warnings);
    return {
      campaignId: detail.id,
      title: detail.title ?? detail.campaign?.title ?? null,
      campaignUrl: bundle.campaignUrl,
      links: bundle.links,
      discoveredLinks: bundle.discoveredLinks,
      brief: { sources: bundle.sources, coverage: bundle.coverage, briefText: bundle.briefText, warnings: bundle.warnings },
      clipSpec,
      clipSpecWarnings,
      footage,
      warnings,
      contentTrust: bundle.contentTrust,
    };
  }
}

export function summarizePlan(plan: ClippingPlan): Record<string, unknown> {
  const videoCount = plan.footage.videos.length;
  return {
    campaignId: plan.campaignId,
    title: plan.title,
    campaignUrl: plan.campaignUrl,
    briefSources: plan.brief.coverage.briefSources,
    failedSources: plan.brief.coverage.failed,
    needsBrowser: plan.brief.coverage.needsBrowser,
    binarySkipped: plan.brief.coverage.binarySkipped,
    tablesRendered: plan.brief.coverage.tablesRendered,
    briefCharacters: plan.brief.coverage.textCharacters,
    clipSpecExtracted: plan.clipSpec !== null,
    clipSpecFilled: plan.clipSpec ? Object.values(plan.clipSpec).filter(value => value !== null && !Array.isArray(value)).length : 0,
    footageChannels: plan.footage.channels.length,
    footageVideos: videoCount,
    footageDriveFiles: plan.footage.driveFiles.length,
    deferredFootage: plan.footage.deferred.length,
    warnings: plan.warnings,
  };
}

export function referenceMaterialsFrom(detail: unknown): unknown {
  if (!detail || typeof detail !== 'object') return [];
  const value = (detail as { referenceMaterials?: unknown }).referenceMaterials;
  return Array.isArray(value) ? value : [];
}

export function classifyDetailReferences(detail: CampaignDetailLike): ClassifiedLink[] {
  return classifyReferences(referenceMaterialsFrom(detail));
}
