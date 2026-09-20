#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BbBrowserRunner } from './clipping/browser.js';
import { createLlm } from './clipping/llm.js';
import { ClippingPipeline, type CampaignDetailLike } from './clipping/pipeline.js';
import { ClippingApi } from './clippingApi.js';
import { ClippingIndex } from './db/index.js';
import { ConfigStore } from './config.js';
import { JobRunner } from './jobs.js';
import { createServer } from './server.js';
import { CampaignSource } from './source.js';
import { ToolLog } from './toolLog.js';
import { DEFAULT_WEB_PORT, startWebServer } from './web.js';

function parseServePort(args: string[]): number | null {
  const index = args.findIndex(arg => arg === '--serve' || arg.startsWith('--serve='));
  if (index < 0) return null;
  const inline = args[index].includes('=') ? args[index].slice(args[index].indexOf('=') + 1) : undefined;
  const candidate = inline ?? args[index + 1];
  if (candidate === undefined || candidate.startsWith('-')) return DEFAULT_WEB_PORT;
  const port = Number(candidate);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid --serve port: ${candidate}`);
  return port;
}

const toolLog = new ToolLog();
const source = new CampaignSource();

// The clipping render layer shells out to auto-editor, which lives in the
// project venv. Put it on PATH so the tighten stage works without a global install.
const venvBin = join(process.cwd(), '.venv/bin');
if (existsSync(join(venvBin, 'auto-editor'))) {
  process.env.PATH = `${venvBin}${delimiter}${process.env.PATH ?? ''}`;
}

const configStore = new ConfigStore();
const server = createServer(source, configStore, toolLog);

const port = parseServePort(process.argv.slice(2));
if (port !== null) {
  const llm = createLlm();
  const loadDetail = async (id: string): Promise<CampaignDetailLike> => {
    const detail = await source.detail(id);
    return {
      ...detail,
      title: typeof detail.title === 'string' ? detail.title : null,
      description: typeof detail.description === 'string' ? detail.description : null,
      campaignUrl: detail.url,
    };
  };
  let index: ClippingIndex | null;
  try {
    index = new ClippingIndex().open();
    const rebuilt = index.reindex();
    console.error(`[whop-content-rewards-mcp] clip index: ${rebuilt.counts.clips} clips, ${rebuilt.counts.sources} sources`);
  } catch (error) {
    console.error(`[whop-content-rewards-mcp] clip index unavailable: ${error instanceof Error ? error.message : String(error)}`);
    index = null;
  }
  const clipping = new ClippingApi({
    pipeline: new ClippingPipeline({ llm, browser: new BbBrowserRunner() }),
    jobs: new JobRunner({ concurrency: 3 }),
    llm,
    loadDetail,
    index,
  });
  const web = await startWebServer({ source, configStore, toolLog, port, clipping });
  console.error(`[whop-content-rewards-mcp] web console listening on ${web.url}`);
}

await server.connect(new StdioServerTransport());
