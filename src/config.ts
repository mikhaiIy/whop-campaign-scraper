import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { filterSchema, type Filters } from './filters.js';

export const CONFIG_URI = 'whop://config/notes';

export const STARTER_CONFIG = `---
# default_preset names the preset that list_campaigns applies when the caller
# supplies no explicit arguments. Set it to a key under "presets" below.
default_preset: example

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

export interface ResolvedConfig {
  path: string | null;
  exists: boolean;
  defaultPreset: string | null;
  presets: Record<string, Filters>;
  prose: string;
  warnings: string[];
  mtimeMs: number | null;
  autoCreated: boolean;
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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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

  return { path, exists: true, defaultPreset, presets, prose, warnings, mtimeMs: null, autoCreated: false };
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
            path, exists: false, defaultPreset: null, presets: {}, prose: '', mtimeMs: null, autoCreated: false,
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
        return { path: target, exists: false, defaultPreset: null, presets: {}, prose: '', mtimeMs: null, autoCreated: false, warnings };
      }
    }
    try {
      const info = await stat(target);
      return { ...parseConfig(await readFile(target, 'utf8'), target), exists: true, mtimeMs: info.mtimeMs, autoCreated };
    } catch (error) {
      warnings.push(`Config file at ${target} could not be read after creation: ${error instanceof Error ? error.message : String(error)}. No preset filters are applied.`);
      return { path: target, exists: false, defaultPreset: null, presets: {}, prose: '', mtimeMs: null, autoCreated, warnings };
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
}
