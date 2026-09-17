import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { API_LIMITS } from './api.js';
import { type ConfigStore, type ResolvedConfig } from './config.js';
import { categoryCounts, filterSchema } from './filters.js';
import type { Campaign } from './normalize.js';
import { SOURCE, TTL_MS, type CampaignSource } from './source.js';
import type { ToolLog } from './toolLog.js';
import { PAGE_HTML } from './ui.js';

export const DEFAULT_WEB_PORT = 4317;
const LOOPBACK = '127.0.0.1';
const MAX_BODY_BYTES = 512 * 1024;

const HOST_HEADER = /^(127\.0\.0\.1|localhost)(:\d+)?$/i;

export interface WebServerOptions {
  source: CampaignSource;
  configStore: ConfigStore;
  toolLog: ToolLog;
  port?: number;
}

export interface WebServerHandle {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

const configJson = (config: ResolvedConfig) => ({
  path: config.path,
  exists: config.exists,
  defaultPreset: config.defaultPreset,
  presets: config.presets,
  prose: config.prose,
  warnings: config.warnings,
  autoCreated: config.autoCreated,
  mtimeMs: config.mtimeMs,
  fetch: config.fetch,
});

export interface WebCampaign extends Omit<Campaign, 'chartPoints' | 'description'> {
  series: { metric: 'spend' | 'views'; start: string | null; values: number[] };
}

export function toWebCampaign(campaign: Campaign): WebCampaign {
  const { chartPoints, ...rest } = campaign;
  delete (rest as Partial<Campaign>).description;
  const metric = chartPoints.some(point => point.spend > 0) ? 'spend' : 'views';
  return {
    ...rest,
    series: {
      metric,
      start: chartPoints[0]?.bucket ?? null,
      values: chartPoints.map(point => metric === 'spend' ? point.spend : point.views),
    },
  };
}

const countValues = (campaigns: Campaign[], pick: (campaign: Campaign) => string[]) => {
  const counts = new Map<string, number>();
  for (const campaign of campaigns) for (const value of pick(campaign)) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
};

const writeBodySchema = z.object({
  defaultPreset: z.string().trim().min(1).max(60).nullable(),
  presets: z.record(z.string().trim().min(1).max(60), filterSchema),
  fetch: z.object({
    deep: z.boolean(),
    maxPages: z.number().int().min(API_LIMITS.maxPages.min).max(API_LIMITS.maxPages.max),
    pageSize: z.number().int().min(API_LIMITS.pageSize.min).max(API_LIMITS.pageSize.max),
    pageDelayMs: z.number().int().min(API_LIMITS.pageDelayMs.min).max(API_LIMITS.pageDelayMs.max),
  }),
});

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', chunk => {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) { reject(new Error('Request body too large')); request.destroy(); return; }
      chunks.push(chunk as Buffer);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
};

export function createWebServer(options: WebServerOptions): Server {
  const { source, configStore, toolLog } = options;

  const applyFetchConfig = async () => {
    const config = await configStore.get();
    source.configure(config.fetch);
    return config;
  };

  const status = async () => {
    try { await applyFetchConfig(); await source.list(); } catch { /* the metadata below reports the failure */ }
    const config = await configStore.get();
    const age = source.fetchedAt ? Date.now() - Date.parse(source.fetchedAt) : null;
    return {
      source: SOURCE,
      fetchMode: source.fetchMode,
      pagesFetched: source.pagesFetched,
      catalogComplete: source.catalogComplete,
      fetchedAt: source.fetchedAt,
      cacheAgeMs: age,
      cacheTtlMs: TTL_MS,
      cacheStale: age === null || age > TTL_MS,
      requestCount: source.requestCount,
      lastError: source.lastError,
      deepFetchError: source.deepFetchError,
      defaultPreset: config.defaultPreset,
      configPath: config.path,
      configExists: config.exists,
      configWarnings: config.warnings,
      toolCalls: toolLog.list(),
      now: new Date().toISOString(),
    };
  };

  const campaigns = async () => {
    await applyFetchConfig();
    const all = await source.list();
    return {
      total: all.length,
      categories: categoryCounts(all),
      platforms: countValues(all, campaign => campaign.platforms),
      types: countValues(all, campaign => [campaign.type]),
      campaigns: all.map(toWebCampaign),
    };
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? LOOPBACK}`);
    const path = url.pathname;

    if (path === '/' || path === '/index.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(PAGE_HTML);
      return;
    }
    if (path === '/api/status' && method === 'GET') { sendJson(response, 200, await status()); return; }
    if (path === '/api/campaigns' && method === 'GET') { sendJson(response, 200, await campaigns()); return; }
    if (path === '/api/config' && method === 'GET') { sendJson(response, 200, configJson(await configStore.get())); return; }
    if (path === '/api/config' && method === 'POST') {
      const parsed = writeBodySchema.safeParse(JSON.parse(await readBody(request)));
      if (!parsed.success) {
        sendJson(response, 400, { error: 'Invalid config payload', issues: parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`) });
        return;
      }
      const saved = await configStore.write({ defaultPreset: parsed.data.defaultPreset, presets: parsed.data.presets, fetch: parsed.data.fetch });
      sendJson(response, 200, { saved: true, config: configJson(saved) });
      return;
    }
    if (path === '/api/refresh' && method === 'POST') {
      source.refresh();
      const data = await campaigns();
      sendJson(response, 200, { refreshed: true, ...data, status: await status() });
      return;
    }
    sendJson(response, 404, { error: `No route for ${method} ${path}` });
  };

  return createServer((request, response) => {
    if (!HOST_HEADER.test(request.headers.host ?? '')) {
      sendJson(response, 403, { error: 'This server only answers requests addressed to localhost.' });
      return;
    }
    handle(request, response).catch(error => {
      if (!response.headersSent) sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      else response.end();
    });
  });
}

export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
  const server = createWebServer(options);
  const port = options.port ?? DEFAULT_WEB_PORT;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    port: bound,
    url: `http://${LOOPBACK}:${bound}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
