import { extractCampaigns, extractDetail } from './parser.js';
import { normalize, type Campaign } from './normalize.js';

export const SOURCE = 'https://contentrewards.com/discover';
export const TTL_MS = 300_000;
export const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
}

export class CampaignSource {
  private queue: Promise<unknown> = Promise.resolve();
  private details = new Map<string, Cache<ReturnType<typeof extractDetail>>>();
  private readonly campaigns: Cache<Campaign[]>;
  fetchedAt: string | null = null;
  lastError: string | null = null;
  requestCount = 0;

  constructor(private readonly request: typeof fetch = fetch) {
    this.campaigns = new Cache(async () => {
      try {
        const result = extractCampaigns(await this.getHtml(SOURCE)).map(raw => normalize(raw));
        this.fetchedAt = new Date().toISOString();
        this.lastError = null;
        return result;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    });
  }

  private getHtml(url: string): Promise<string> {
    const task = this.queue.then(async () => {
      this.requestCount++;
      const response = await this.request(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
        signal: AbortSignal.timeout(30_000), redirect: 'error',
      });
      if (!response.ok) throw new Error(`Public source returned HTTP ${response.status} for ${url}`);
      const html = await response.text();
      if (html.length > 10_000_000) throw new Error(`Public source response exceeds 10 MB for ${url}`);
      return html;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  list(): Promise<Campaign[]> { return this.campaigns.get(); }

  async detail(id: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Campaign id must be a UUID');
    const campaign = (await this.list()).find(c => c.id === id) ?? null;
    let cache = this.details.get(id);
    if (!cache) {
      cache = new Cache(async () => extractDetail(await this.getHtml(`${SOURCE}/${id}`), id));
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
