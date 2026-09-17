#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigStore } from './config.js';
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
const configStore = new ConfigStore();
const server = createServer(source, configStore, toolLog);

const port = parseServePort(process.argv.slice(2));
if (port !== null) {
  const web = await startWebServer({ source, configStore, toolLog, port });
  console.error(`[whop-content-rewards-mcp] web console listening on ${web.url}`);
}

await server.connect(new StdioServerTransport());
