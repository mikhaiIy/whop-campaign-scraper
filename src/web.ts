import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { ClippingApi, isInsideClipRoot, runBodySchema } from './clippingApi.js';
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
  /** Omit to run the console without the clipping stages. */
  clipping?: ClippingApi;
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
  const clipping = options.clipping ?? null;

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
    if (path.startsWith('/api/clipping/') || path.startsWith('/clips/')) {
      if (!clipping) { sendJson(response, 503, { error: 'The clipping stages are not enabled on this server.' }); return; }
      if (await handleClipping(clipping, path, method, url, request, response)) return;
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

const STAGE_STARTERS = {
  brief: (api: ClippingApi, body: ReturnType<typeof runBodySchema.parse>) => api.crawlBrief(body),
  extract: (api: ClippingApi, body: ReturnType<typeof runBodySchema.parse>) => api.extractSpec(body),
  footage: (api: ClippingApi, body: ReturnType<typeof runBodySchema.parse>) => api.resolveFootage(body),
  moments: (api: ClippingApi, body: ReturnType<typeof runBodySchema.parse>) => api.selectMoments(body),
  clips: (api: ClippingApi, body: ReturnType<typeof runBodySchema.parse>) => api.produceClips(body),
} as const;

async function handleClipping(
  api: ClippingApi,
  path: string,
  method: string,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  if (path === '/api/clipping/view' && method === 'GET') {
    const campaignId = url.searchParams.get('campaignId');
    if (!campaignId) { sendJson(response, 400, { error: 'Pass a campaignId.' }); return true; }
    sendJson(response, 200, api.view(campaignId));
    return true;
  }

  if (path === '/api/clipping/job' && method === 'GET') {
    const id = url.searchParams.get('id');
    if (!id) { sendJson(response, 400, { error: 'Pass a job id.' }); return true; }
    const job = api.job(id);
    if (!job) { sendJson(response, 404, { error: 'No job has that id.' }); return true; }
    sendJson(response, 200, job);
    return true;
  }

  if (path === '/api/clipping/cancel' && method === 'POST') {
    const body = JSON.parse(await readBody(request)) as { id?: string };
    if (!body.id) { sendJson(response, 400, { error: 'Pass a job id.' }); return true; }
    sendJson(response, 200, { cancelled: api.cancel(body.id) });
    return true;
  }

  const runMatch = /^\/api\/clipping\/run\/(brief|extract|footage|moments|clips)$/.exec(path);
  if (runMatch && method === 'POST') {
    const parsed = runBodySchema.safeParse(JSON.parse(await readBody(request)));
    if (!parsed.success) {
      sendJson(response, 400, { error: 'Invalid request.', issues: parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`) });
      return true;
    }
    const stage = runMatch[1] as keyof typeof STAGE_STARTERS;
    try {
      const job = STAGE_STARTERS[stage](api, parsed.data);
      sendJson(response, 202, { job });
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (path === '/api/clipping/sidecar' && method === 'GET') {
    const target = url.searchParams.get('path');
    if (!target) { sendJson(response, 400, { error: 'Pass a path.' }); return true; }
    try {
      sendJson(response, 200, await api.sidecar(target));
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (path === '/clips/media' && method === 'GET') {
    const target = url.searchParams.get('path');
    if (!target || !isInsideClipRoot(target)) { sendJson(response, 400, { error: 'That path is outside out/clips.' }); return true; }
    let size: number;
    try { size = (await stat(target)).size; } catch { sendJson(response, 404, { error: 'No file is at that path.' }); return true; }
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : size - 1;
      if (start >= size || end >= size || start > end) {
        response.writeHead(416, { 'Content-Range': `bytes */${size}` });
        response.end();
        return true;
      }
      response.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
      });
      createReadStream(target, { start, end }).pipe(response);
      return true;
    }
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    createReadStream(target).pipe(response);
    return true;
  }

  return false;
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
