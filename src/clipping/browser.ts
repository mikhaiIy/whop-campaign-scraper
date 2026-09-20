import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultProcessRunner, type ProcessResult, type ProcessRunner } from './process.js';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string | null;
}

export interface RawDriveNode {
  id: string;
  label: string;
}

export interface RenderedText {
  url: string;
  text: string;
}

const DRIVE_ID = /^[A-Za-z0-9_-]{25,44}$/;

export const isDriveId = (id: string): boolean => typeof id === 'string' && DRIVE_ID.test(id);

export function filterDriveNodes(nodes: unknown): DriveFile[] {
  const seen = new Set<string>();
  const files: DriveFile[] = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const record = node && typeof node === 'object' ? node as Record<string, unknown> : {};
    const id = typeof record.id === 'string' ? record.id : '';
    if (!isDriveId(id) || seen.has(id)) continue;
    seen.add(id);
    const label = typeof record.label === 'string' ? record.label : '';
    const name = label.split('\n')[0].trim().slice(0, 200) || '(unnamed)';
    files.push({ id, name, mimeType: null });
  }
  return files;
}

export interface BrowserRunner {
  readonly id: string;
  renderText(url: string): Promise<RenderedText>;
  listDriveFolder(url: string): Promise<DriveFile[]>;
}

const renderTextScript = (url: string): string => `const page = await browser.newPage();
await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 4000));
const text = await page.evaluate(() => document.body.innerText);
return { text };`;

const listDriveScript = (url: string): string => `const page = await browser.newPage();
await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 5000));
const nodes = await page.evaluate(() => {
  const seen = new Set();
  const out = [];
  for (const el of document.querySelectorAll('[data-id]')) {
    const id = el.getAttribute('data-id') || '';
    if (!/^[A-Za-z0-9_-]{25,44}$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: (el.getAttribute('aria-label') || el.innerText || '').slice(0, 300) });
  }
  return out;
});
return { nodes };`;

export interface BbBrowserRunnerOptions {
  command?: string;
  host?: string;
  timeoutMs?: number;
  runTimeoutMs?: number;
  sessionTtlMs?: number;
  runner?: ProcessRunner;
}

export class BbBrowserRunner implements BrowserRunner {
  readonly id = 'bb-browser-automation';
  private session: { id: string; openedAt: number } | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private tempDir: string | null = null;
  private readonly command: string;
  private readonly host: string | undefined;
  private readonly timeoutMs: number;
  private readonly runTimeoutMs: number;
  private readonly sessionTtlMs: number;
  private readonly runner: ProcessRunner;

  constructor(options: BbBrowserRunnerOptions = {}) {
    this.command = options.command ?? 'bb';
    this.host = options.host;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.runTimeoutMs = options.runTimeoutMs ?? 110_000;
    this.sessionTtlMs = options.sessionTtlMs ?? 25 * 60_000;
    this.runner = options.runner ?? defaultProcessRunner;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async resolveHost(): Promise<string> {
    if (this.host) return this.host;
    if (process.env.WHOP_BROWSER_HOST) return process.env.WHOP_BROWSER_HOST;
    try {
      const id = (await readFile(join(homedir(), '.bb/host-id'), 'utf8')).trim();
      if (id) return id;
    } catch { /* fall through */ }
    throw new Error('No BB browser host configured. Set WHOP_BROWSER_HOST or run inside BB.');
  }

  private async exec(args: string[]): Promise<ProcessResult> {
    const result = await this.runner(this.command, ['browser-automation', ...args], this.timeoutMs);
    if (result.timedOut) throw new Error(`${this.command} browser-automation ${args[0]} timed out after ${this.timeoutMs}ms`);
    if (result.code !== 0 && !result.stdout.trim()) {
      throw new Error(`${this.command} browser-automation ${args[0]} failed (exit ${result.code}): ${result.stderr.trim().slice(0, 300) || 'no output'}`);
    }
    return result;
  }

  private async ensureSession(): Promise<string> {
    if (this.session && Date.now() - this.session.openedAt < this.sessionTtlMs) return this.session.id;
    if (this.session) { this.session = null; }
    const host = await this.resolveHost();
    const result = await this.exec(['open', '--backend', 'local', '--headless', '--machine', host, '--json']);
    const parsed: unknown = JSON.parse(result.stdout);
    const id = parsed && typeof parsed === 'object' ? (parsed as { id?: unknown }).id : null;
    if (typeof id !== 'string' || !id) throw new Error('BB browser session did not return an id.');
    this.session = { id, openedAt: Date.now() };
    return id;
  }

  private async runScript(script: string): Promise<unknown> {
    const host = await this.resolveHost();
    const attempt = async (): Promise<unknown> => {
      const session = await this.ensureSession();
      if (!this.tempDir) this.tempDir = await mkdtemp(join(tmpdir(), 'whop-browser-'));
      const file = join(this.tempDir, `script-${Date.now()}.js`);
      await writeFile(file, script, 'utf8');
      const result = await this.exec(['run', session, '--script-file', file, '--script-host', host, '--timeout-ms', String(this.runTimeoutMs), '--json']);
      const envelope: unknown = JSON.parse(result.stdout);
      const text = envelope && typeof envelope === 'object' ? (envelope as { text?: unknown }).text : null;
      if (typeof text !== 'string') throw new Error('BB browser run returned no text payload.');
      return JSON.parse(text);
    };
    try {
      return await attempt();
    } catch (error) {
      if (!this.session) throw error;
      // The session may have hit its idle/absolute expiry; reopen once and retry.
      this.session = null;
      return await attempt();
    }
  }

  renderText(url: string): Promise<RenderedText> {
    return this.enqueue(async () => {
      const value = await this.runScript(renderTextScript(url));
      const text = value && typeof value === 'object' ? (value as { text?: unknown }).text : null;
      if (typeof text !== 'string') throw new Error(`Browser render of ${url} returned no text.`);
      return { url, text };
    });
  }

  listDriveFolder(url: string): Promise<DriveFile[]> {
    return this.enqueue(async () => {
      const value = await this.runScript(listDriveScript(url));
      const nodes = value && typeof value === 'object' ? (value as { nodes?: unknown }).nodes : null;
      return filterDriveNodes(nodes);
    });
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session) {
      try { await this.exec(['close', session.id, '--json']); } catch { /* best-effort */ }
    }
    if (this.tempDir) {
      const dir = this.tempDir;
      this.tempDir = null;
      try { await rm(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}
