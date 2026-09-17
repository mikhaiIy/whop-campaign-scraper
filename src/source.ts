import { extractCampaigns, extractDetail } from './parser.js';
import { normalize, type Campaign } from './normalize.js';
import { API_ENDPOINT, API_LIMITS, normalizeApi, parseApiPage } from './api.js';

export const SOURCE = 'https://contentrewards.com/discover';
export const TTL_MS = 300_000;
export const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface DeepOptions {
  deep?: boolean;
  maxPages?: number;
  pageSize?: number;
  pageDelayMs?: number;
}

export interface DeepConfig {
  deep: boolean;
  maxPages: number;
  pageSize: number;
  pageDelayMs: number;
}

export const DEFAULT_DEEP: DeepConfig = {
  deep: true,
  maxPages: API_LIMITS.maxPages.default,
  pageSize: API_LIMITS.pageSize.default,
  pageDelayMs: API_LIMITS.pageDelayMs.default,
};

const clamp = (value: number, { min, max }: { min: number; max: number }) => Math.min(max, Math.max(min, Math.trunc(value)));

const mergeDeep = (options: DeepOptions, base: DeepConfig): DeepConfig => ({
  deep: options.deep ?? base.deep,
  maxPages: options.maxPages === undefined ? base.maxPages : clamp(options.maxPages, API_LIMITS.maxPages),
  pageSize: options.pageSize === undefined ? base.pageSize : clamp(options.pageSize, API_LIMITS.pageSize),
  pageDelayMs: options.pageDelayMs === undefined ? base.pageDelayMs : clamp(options.pageDelayMs, API_LIMITS.pageDelayMs),
});

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class Cache<T> {
  private value?: T;
  private expires = 0;
  private pending?: Promise<T>;
  constructor(private readonly load: () => Promise<T>, private readonly now = Date.now) {}
  get(): Promise<T> {
    if (this.value !== undefined && this.now() < this.expires) return Promise.resolve(this.value);
    if (this.pending) return this.pending;
    this.pending = this.load().then(value => {
      this.value = value;
      this.expires = this.now() + TTL_MS;
      return value;
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  invalidate(): void { this.value = undefined; this.expires = 0; }
}

export class CampaignSource {
  private queue: Promise<unknown> = Promise.resolve();
  private details = new Map<string, Cache<ReturnType<typeof extractDetail>>>();
  private readonly campaigns: Cache<Campaign[]>;
  private options: DeepConfig = { ...DEFAULT_DEEP };
  fetchedAt: string | null = null;
  lastError: string | null = null;
  requestCount = 0;
  pagesFetched = 0;
  fetchMode: 'api' | 'html' | null = null;
  deepFetchError: string | null = null;
  catalogComplete = false;

  constructor(private readonly request: typeof fetch = fetch, options: DeepOptions = {}) {
    this.options = mergeDeep(options, DEFAULT_DEEP);
    this.campaigns = new Cache(async () => {
      this.pagesFetched = 0;
      this.deepFetchError = null;
      this.catalogComplete = false;
      if (this.options.deep) {
        try {
          const campaigns = await this.fetchDeep();
          this.fetchMode = 'api';
          this.fetchedAt = new Date().toISOString();
          this.lastError = null;
          return campaigns;
        } catch (error) {
          this.deepFetchError = error instanceof Error ? error.message : String(error);
        }
      }
      try {
        const result = extractCampaigns(await this.getText(SOURCE)).map(raw => normalize(raw));
        this.fetchMode = 'html';
        this.fetchedAt = new Date().toISOString();
        this.lastError = null;
        return result;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    });
  }

  configure(options: DeepOptions): void {
    const next = mergeDeep(options, this.options);
    if (next.deep !== this.options.deep || next.maxPages !== this.options.maxPages || next.pageSize !== this.options.pageSize || next.pageDelayMs !== this.options.pageDelayMs) {
      this.options = next;
      this.campaigns.invalidate();
    }
  }

  private requestText(url: string, accept: string): Promise<string> {
    const task = this.queue.then(async () => {
      this.requestCount++;
      const response = await this.request(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: accept },
        signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
      if (!response.ok) throw new Error(`Public source returned HTTP ${response.status} for ${url}`);
      const body = await response.text();
      if (body.length > 10_000_000) throw new Error(`Public source response exceeds 10 MB for ${url}`);
      return body;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  private getText(url: string): Promise<string> { return this.requestText(url, 'text/html'); }

  private async fetchDeep(): Promise<Campaign[]> {
    const found = new Map<string, Campaign>();
    let cursor: string | null = null;
    for (let page = 1; page <= this.options.maxPages; page++) {
      if (page > 1) await sleep(this.options.pageDelayMs);
      const url = new URL(API_ENDPOINT);
      url.searchParams.set('limit', String(this.options.pageSize));
      if (cursor) url.searchParams.set('cursor', cursor);
      const payload = parseApiPage(JSON.parse(await this.requestText(url.toString(), 'application/json')));
      const records = Array.isArray(payload.data) ? payload.data : [];
      const valid = records.filter((record): record is Record<string, unknown> => typeof record === 'object' && record !== null && !Array.isArray(record));
      if (!valid.length) {
        if (page === 1) throw new Error('Discover API returned no campaign records');
        break;
      }
      for (const record of valid) {
        try {
          const campaign = normalizeApi(record);
          if (!found.has(campaign.id)) found.set(campaign.id, campaign);
        } catch { continue; }
      }
      this.pagesFetched = page;
      cursor = typeof payload.pagination?.nextCursor === 'string' ? payload.pagination.nextCursor : null;
      if (!cursor) { this.catalogComplete = true; break; }
    }
    if (!found.size) throw new Error('Discover API returned no normalizable campaigns');
    return [...found.values()];
  }

  list(): Promise<Campaign[]> { return this.campaigns.get(); }

  get config(): DeepConfig { return { ...this.options }; }

  async detail(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Campaign id must be a UUID');
    const campaign = (await this.list()).find(c => c.id === id) ?? null;
    let cache = this.details.get(id);
    if (!cache) {
      cache = new Cache(async () => extractDetail(await this.getText(`${SOURCE}/${id}`), id));
      if (this.details.size >= 100) this.details.delete(this.details.keys().next().value!);
      this.details.set(id, cache);
    }
    const card = await cache.get();
    return {
      campaign,
      id,
      url: `${SOURCE}/${id}`,
      title: card.name ?? campaign?.title ?? null,
      description: card.description ?? campaign?.description ?? null,
      requirements: card.requirements ?? null,
      requirementsNote: card.requirements == null ? 'No separate requirements field is exposed. Read the description and reference materials; do not infer absent rules.' : null,
      payoutRules: card.payouts ?? null,
      payoutUnits: 'Fields ending in Cents are USD cents; CPM rateCents is per 1,000 views.',
      referenceMaterials: card.referenceMaterials ?? [],
      status: card.status ?? null,
      updatedAt: card.updatedAt ?? null,
    };
  }
}
