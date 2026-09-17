import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { API_LIMITS } from './api.js';
import { filterSchema, type Filters } from './filters.js';

export const CONFIG_URI = 'whop://config/notes';

export const STARTER_CONFIG = `---
# default_preset names the preset that list_campaigns applies when the caller
# supplies no explicit arguments. Set it to a key under "presets" below.
default_preset: example

# Deeper fetching. The public discover page briefly shows about 50 campaigns.
# The MCP server asks the same public JSON API the site uses, following its
# cursor page by page, so agents can see the whole public catalog.
#   deep_fetch:     false keeps the older 50-campaign HTML path only.
#   max_pages:      how many API pages to request (default 5).
#   page_size:      records per page, 1-100 (default 50).
#   page_delay_ms:  pause between page requests, for politeness (default 500).
deep_fetch: true
max_pages: 5
page_size: 50
page_delay_ms: 500

# Each preset is a named bundle of filters. A caller picks one with the
# list_campaigns "preset" argument; explicit tool arguments override individual
# preset values. Every key is optional.
presets:
  example:
    # Match any listed category; case-insensitive and trimmed.
    categories: []
    # Match any listed platform (for example tiktok, youtube, instagram).
    platforms: []
    # Minimum and maximum CPM in US dollars, when the campaign pays per 1k views.
    min_cpm: 1.0
    # max_cpm: 10.0
    # Only keep campaigns with at least this much budget left, in USD.
    min_budget_remaining: 500
    # Brand names to drop, case-insensitive.
    exclude_brands: []
    # Sort order: newest | cpm | budget_remaining | creator_count.
    sort_by: newest
    # Maximum number of campaigns to return.
    limit: 50
---

# What I am looking for

Write your intent here in plain language. This prose is handed to the agent
alongside the numeric filters, so it is worth being specific: the kind of
content, the brands or categories you want, and anything you want to avoid.

This body is read as-is and is never treated as instructions by the machine;
it only tells the agent what you are trying to achieve.
`;

export const CONFIG_FILENAME = 'campaigns.config.md';
export const DEFAULT_CONFIG_PATH = resolve(homedir(), '.config/whop-mcp', CONFIG_FILENAME);

export interface FetchConfig {
  deep: boolean;
  maxPages: number;
  pageSize: number;
  pageDelayMs: number;
}

export const DEFAULT_FETCH: FetchConfig = {
  deep: true,
  maxPages: API_LIMITS.maxPages.default,
  pageSize: API_LIMITS.pageSize.default,
  pageDelayMs: API_LIMITS.pageDelayMs.default,
};

export interface ResolvedConfig {
  path: string | null;
  exists: boolean;
  defaultPreset: string | null;
  presets: Record<string, Filters>;
  prose: string;
  warnings: string[];
  mtimeMs: number | null;
  autoCreated: boolean;
  fetch: FetchConfig;
}

export interface ConfigPaths {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  home?: string;
}

export function resolveConfigPaths({ env = process.env, cwd = process.cwd(), home = homedir() }: ConfigPaths = {}): string[] {
  if (env.WHOP_MCP_CONFIG) return [resolve(cwd, env.WHOP_MCP_CONFIG)];
  return [resolve(cwd, CONFIG_FILENAME), resolve(home, '.config/whop-mcp', CONFIG_FILENAME)];
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface ConfigWrite {
  defaultPreset: string | null;
  presets: Record<string, Filters>;
  fetch: FetchConfig;
}

export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const match = FRONTMATTER.exec(text);
  if (!match) return { frontmatter: null, body: text };
  return { frontmatter: match[1], body: text.slice(match[0].length) };
}

export function buildConfigText(existing: string, input: ConfigWrite): string {
  const data: Record<string, unknown> = {
    default_preset: input.defaultPreset ?? null,
    deep_fetch: input.fetch.deep,
    max_pages: input.fetch.maxPages,
    page_size: input.fetch.pageSize,
    page_delay_ms: input.fetch.pageDelayMs,
    presets: input.presets,
  };
  const { body } = splitFrontmatter(existing);
  const frontmatter = `---\n${stringifyYaml(data).trimEnd()}\n---\n`;
  return body ? `${frontmatter}${body}` : frontmatter;
}

export async function writeConfigFile(path: string, input: ConfigWrite): Promise<ResolvedConfig> {
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buildConfigText(existing, input), 'utf8');
  const info = await stat(path);
  return { ...parseConfig(await readFile(path, 'utf8'), path), exists: true, mtimeMs: info.mtimeMs };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const boundedInt = (value: unknown, bounds: { min: number; max: number }, key: string, warnings: string[]): number | null => {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    warnings.push(`Config "${key}" must be an integer between ${bounds.min} and ${bounds.max}; it was ignored in favour of the default.`);
    return null;
  }
  return value;
};

export function parseFetch(data: Record<string, unknown>, warnings: string[]): FetchConfig {
  const fetch: FetchConfig = { ...DEFAULT_FETCH };
  if (data.deep_fetch !== undefined) {
    if (typeof data.deep_fetch === 'boolean') fetch.deep = data.deep_fetch;
    else warnings.push('Config "deep_fetch" must be true or false; it was ignored in favour of the default.');
  }
  fetch.maxPages = boundedInt(data.max_pages, API_LIMITS.maxPages, 'max_pages', warnings) ?? fetch.maxPages;
  fetch.pageSize = boundedInt(data.page_size, API_LIMITS.pageSize, 'page_size', warnings) ?? fetch.pageSize;
  fetch.pageDelayMs = boundedInt(data.page_delay_ms, API_LIMITS.pageDelayMs, 'page_delay_ms', warnings) ?? fetch.pageDelayMs;
  return fetch;
}

export function parseConfig(text: string, path: string | null = null): ResolvedConfig {
  const warnings: string[] = [];
  let prose = text.trim();
  let rawData: unknown = {};

  const match = FRONTMATTER.exec(text);
  if (match) {
    prose = text.slice(match[0].length).trim();
    try {
      rawData = parseYaml(match[1]) ?? {};
    } catch (error) {
      warnings.push(`Config frontmatter is not valid YAML (${error instanceof Error ? error.message : String(error)}); it was ignored and no preset filters are applied.`);
      rawData = {};
    }
  }

  if (!isPlainObject(rawData)) {
    warnings.push('Config frontmatter must be a YAML mapping; it was ignored and no preset filters are applied.');
  }
  const data: Record<string, unknown> = isPlainObject(rawData) ? rawData : {};

  const presets: Record<string, Filters> = {};
  if (data.presets !== undefined) {
    if (!isPlainObject(data.presets)) {
      warnings.push('Config "presets" must be a mapping of preset names to filter objects; it was ignored.');
    } else {
      for (const [name, value] of Object.entries(data.presets)) {
        const parsed = filterSchema.safeParse(value ?? {});
        if (!parsed.success) {
          const issues = parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
          warnings.push(`Config preset "${name}" is invalid and was skipped: ${issues}.`);
          continue;
        }
        presets[name] = parsed.data;
      }
    }
  }

  let defaultPreset: string | null = null;
  if (data.default_preset !== undefined && data.default_preset !== null) {
    if (typeof data.default_preset === 'string' && data.default_preset.trim()) {
      const name = data.default_preset.trim();
      defaultPreset = name;
      if (!(name in presets)) warnings.push(`Config default_preset "${name}" is not defined under "presets".`);
    } else {
      warnings.push('Config "default_preset" must be a non-empty string; it was ignored.');
    }
  }

  return { path, exists: true, defaultPreset, presets, prose, warnings, mtimeMs: null, autoCreated: false, fetch: parseFetch(data, warnings) };
}

export class ConfigStore {
  private cache: ResolvedConfig | null = null;
  private readonly paths: string[];

  constructor(options: ConfigPaths = {}) {
    this.paths = resolveConfigPaths(options);
  }

  private async locate(): Promise<ResolvedConfig> {
    for (const path of this.paths) {
      try {
        const info = await stat(path);
        return { ...parseConfig(await readFile(path, 'utf8'), path), exists: true, mtimeMs: info.mtimeMs };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return {
            path, exists: false, defaultPreset: null, presets: {}, prose: '', mtimeMs: null, autoCreated: false, fetch: { ...DEFAULT_FETCH },
            warnings: [`Config file at ${path} could not be read: ${error instanceof Error ? error.message : String(error)}. No preset filters are applied.`],
          };
        }
      }
    }
    const target = this.paths[this.paths.length - 1];
    const warnings: string[] = [];
    let autoCreated = false;
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, STARTER_CONFIG, { encoding: 'utf8', flag: 'wx' });
      autoCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        warnings.push(`Could not create a starter config at ${target}: ${error instanceof Error ? error.message : String(error)}. No preset filters are applied.`);
        return { path: target, exists: false, defaultPreset: null, presets: {}, prose: '', mtimeMs: null, autoCreated: false, fetch: { ...DEFAULT_FETCH }, warnings };
      }
    }
    try {
      const info = await stat(target);
      return { ...parseConfig(await readFile(target, 'utf8'), target), exists: true, mtimeMs: info.mtimeMs, autoCreated };
    } catch (error) {
      warnings.push(`Config file at ${target} could not be read after creation: ${error instanceof Error ? error.message : String(error)}. No preset filters are applied.`);
      return { path: target, exists: false, defaultPreset: null, presets: {}, prose: '', mtimeMs: null, autoCreated, fetch: { ...DEFAULT_FETCH }, warnings };
    }
  }

  async get(): Promise<ResolvedConfig> {
    for (const path of this.paths) {
      try {
        const info = await stat(path);
        if (this.cache && this.cache.path === path && this.cache.mtimeMs === info.mtimeMs) return this.cache;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') break;
      }
    }
    const fresh = await this.locate();
    this.cache = fresh;
    return fresh;
  }

  async reload(): Promise<ResolvedConfig> {
    this.cache = null;
    return this.get();
  }

  async write(input: ConfigWrite): Promise<ResolvedConfig> {
    const current = await this.get();
    const path = current.path ?? this.paths[this.paths.length - 1];
    this.cache = await writeConfigFile(path, input);
    return this.cache;
  }
}
