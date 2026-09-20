import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { RULE_FIELDS, type ClipSpec, type Field, type Provenance } from '../clipping/extract.js';
import type { BriefBundle, BriefSource } from '../clipping/crawl.js';
import type { ClipSidecar } from '../clipping/cut.js';

export const DEFAULT_INDEX_PATH = join(process.cwd(), '.cache', 'clipping', 'index.db');
export const DEFAULT_REFS_DIR = join(process.cwd(), '.cache', 'clipping', 'refs');
export const DEFAULT_CLIPS_DIR = join(process.cwd(), 'out', 'clips');

export type FieldValue = string | number | boolean | string[] | null;

export interface CampaignInput {
  id: string;
  title?: string | null;
  campaignUrl?: string | null;
  lastCrawledAt?: string | null;
  lastExtractedAt?: string | null;
}

export interface CampaignRow {
  id: string;
  title: string | null;
  campaign_url: string | null;
  last_crawled_at: string | null;
  last_extracted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceRow {
  row_key: string;
  campaign_id: string | null;
  source_id: string | null;
  url: string;
  host: string | null;
  kind: string | null;
  status: string | null;
  http_status: number | null;
  content_type: string | null;
  bytes: number | null;
  line_count: number | null;
  media_type: string | null;
  needs_browser: number | null;
  rendered_tables: number | null;
  from_cache: number | null;
  has_text: number | null;
  fetched_at: string | null;
  error: string | null;
  cache_path: string | null;
  drive_files: number | null;
  indexed_at: string;
  updated_at: string;
}

export interface ClipSpecRow {
  campaign_id: string;
  extracted_at: string | null;
  extractor_provider: string | null;
  extractor_model: string | null;
  extractor_prompt_version: string | null;
  field_count: number;
  unstructured_count: number;
  updated_at: string;
}

export interface ClipSpecFieldRow {
  campaign_id: string;
  field_name: string;
  item_index: number;
  prov_index: number;
  value_json: string | null;
  value_type: string | null;
  source_id: string | null;
  line: number | null;
  quote: string | null;
}

export interface ClipRow {
  campaign_id: string;
  video_id: string;
  file_path: string;
  sidecar_path: string | null;
  source_url: string | null;
  duration_seconds: number | null;
  fetch_start: number | null;
  fetch_end: number | null;
  source_abs_in: number | null;
  source_abs_out: number | null;
  file_rel_in: number | null;
  file_rel_out: number | null;
  transcript_model: string | null;
  transcript_language: string | null;
  hook_rating: number | null;
  moment_reason: string | null;
  created_at: string | null;
  indexed_at: string;
  updated_at: string;
}

export interface IndexCounts {
  campaigns: number;
  sources: number;
  clipSpecs: number;
  clipSpecFields: number;
  clips: number;
}

export interface ReindexOptions {
  cacheDir?: string;
  clipsDir?: string;
}

export interface ReindexResult {
  cacheDir: string;
  clipsDir: string;
  counts: IndexCounts;
  refFiles: number;
  sidecarFiles: number;
  skippedFiles: number;
  warnings: string[];
}

interface SourceRecord {
  row_key: string;
  campaign_id: string | null;
  source_id: string | null;
  url: string;
  host: string | null;
  kind: string | null;
  status: string | null;
  http_status: number | null;
  content_type: string | null;
  bytes: number | null;
  line_count: number | null;
  media_type: string | null;
  needs_browser: number | null;
  rendered_tables: number | null;
  from_cache: number | null;
  has_text: number | null;
  fetched_at: string | null;
  error: string | null;
  cache_path: string | null;
  drive_files: number | null;
}

interface CachedReference {
  url: string;
  contentHash?: string;
  fetchedAt?: string;
  httpStatus?: number;
  contentType?: string;
  body?: string;
}

interface Statements {
  insertCampaign: StatementSync;
  ensureCampaign: StatementSync;
  insertSource: StatementSync;
  upsertSpec: StatementSync;
  deleteSpecFields: StatementSync;
  insertSpecField: StatementSync;
  insertClip: StatementSync;
  countCampaigns: StatementSync;
  countSources: StatementSync;
  countClipSpecs: StatementSync;
  countSpecFields: StatementSync;
  countClips: StatementSync;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

const SCHEMA_FALLBACK = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'schema.sql'), join(here, '..', '..', 'src', 'db', 'schema.sql')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }
  throw new Error('src/db/schema.sql was not found next to the compiled module or in the source tree.');
})();

const num = (value: boolean | number | null | undefined): number | null =>
  typeof value === 'boolean' ? (value ? 1 : 0) : typeof value === 'number' && Number.isFinite(value) ? value : null;
const str = (value: string | null | undefined): string | null => (typeof value === 'string' ? value : null);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function pointer(path: string): string {
  const rel = relative(process.cwd(), path);
  if (!rel) return path;
  return rel === '..' || rel.startsWith('..' + '/') || rel.startsWith('..' + '\\') ? path : rel;
}

function hostOf(url: string): string | null {
  try { return new URL(url).host || null; } catch { return null; }
}

function sourceRowKey(campaignId: string, sourceId: string): string {
  return `${campaignId}\u0000${sourceId}`;
}

function cacheRowKey(url: string): string {
  return `cache\u0000${url}`;
}

export class ClippingIndex {
  private readonly dbPath: string;
  private db!: DatabaseSync;
  private stmts!: Statements;
  private savepoint = 0;

  constructor(dbPath: string = DEFAULT_INDEX_PATH) {
    this.dbPath = dbPath;
    this.open();
  }

  open(): this {
    if (this.db?.isOpen) return this;
    if (this.dbPath !== ':memory:') mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(SCHEMA_FALLBACK);
    this.stmts = this.prepareStatements();
    return this;
  }

  close(): void {
    if (this.db?.isOpen) this.db.close();
  }

  private prepareStatements(): Statements {
    const db = this.db;
    return {
      insertCampaign: db.prepare(`
        INSERT INTO campaigns (id, title, campaign_url, last_crawled_at, last_extracted_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = COALESCE(excluded.title, campaigns.title),
          campaign_url = COALESCE(excluded.campaign_url, campaigns.campaign_url),
          last_crawled_at = COALESCE(excluded.last_crawled_at, campaigns.last_crawled_at),
          last_extracted_at = COALESCE(excluded.last_extracted_at, campaigns.last_extracted_at),
          updated_at = ${NOW}
      `),
      ensureCampaign: db.prepare('INSERT INTO campaigns (id) VALUES (?) ON CONFLICT(id) DO NOTHING'),
      insertSource: db.prepare(`
        INSERT INTO sources (
          row_key, campaign_id, source_id, url, host, kind, status, http_status, content_type,
          bytes, line_count, media_type, needs_browser, rendered_tables, from_cache, has_text,
          fetched_at, error, cache_path, drive_files
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(row_key) DO UPDATE SET
          campaign_id = COALESCE(excluded.campaign_id, sources.campaign_id),
          source_id = COALESCE(excluded.source_id, sources.source_id),
          url = excluded.url,
          host = COALESCE(excluded.host, sources.host),
          kind = COALESCE(excluded.kind, sources.kind),
          status = COALESCE(excluded.status, sources.status),
          http_status = COALESCE(excluded.http_status, sources.http_status),
          content_type = COALESCE(excluded.content_type, sources.content_type),
          bytes = COALESCE(excluded.bytes, sources.bytes),
          line_count = COALESCE(excluded.line_count, sources.line_count),
          media_type = COALESCE(excluded.media_type, sources.media_type),
          needs_browser = COALESCE(excluded.needs_browser, sources.needs_browser),
          rendered_tables = COALESCE(excluded.rendered_tables, sources.rendered_tables),
          from_cache = COALESCE(excluded.from_cache, sources.from_cache),
          has_text = COALESCE(excluded.has_text, sources.has_text),
          fetched_at = COALESCE(excluded.fetched_at, sources.fetched_at),
          error = COALESCE(excluded.error, sources.error),
          cache_path = COALESCE(excluded.cache_path, sources.cache_path),
          drive_files = COALESCE(excluded.drive_files, sources.drive_files),
          updated_at = ${NOW}
      `),
      upsertSpec: db.prepare(`
        INSERT INTO clip_specs (
          campaign_id, extracted_at, extractor_provider, extractor_model, extractor_prompt_version,
          field_count, unstructured_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(campaign_id) DO UPDATE SET
          extracted_at = excluded.extracted_at,
          extractor_provider = excluded.extractor_provider,
          extractor_model = excluded.extractor_model,
          extractor_prompt_version = excluded.extractor_prompt_version,
          field_count = excluded.field_count,
          unstructured_count = excluded.unstructured_count,
          updated_at = ${NOW}
      `),
      deleteSpecFields: db.prepare('DELETE FROM clip_spec_fields WHERE campaign_id = ?'),
      insertSpecField: db.prepare(`
        INSERT INTO clip_spec_fields (
          campaign_id, field_name, item_index, prov_index, value_json, value_type, source_id, line, quote
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertClip: db.prepare(`
        INSERT INTO clips (
          campaign_id, video_id, file_path, sidecar_path, source_url, duration_seconds,
          fetch_start, fetch_end, source_abs_in, source_abs_out, file_rel_in, file_rel_out,
          transcript_model, transcript_language, hook_rating, moment_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(campaign_id, video_id, file_path) DO UPDATE SET
          sidecar_path = COALESCE(excluded.sidecar_path, clips.sidecar_path),
          source_url = COALESCE(excluded.source_url, clips.source_url),
          duration_seconds = COALESCE(excluded.duration_seconds, clips.duration_seconds),
          fetch_start = COALESCE(excluded.fetch_start, clips.fetch_start),
          fetch_end = COALESCE(excluded.fetch_end, clips.fetch_end),
          source_abs_in = COALESCE(excluded.source_abs_in, clips.source_abs_in),
          source_abs_out = COALESCE(excluded.source_abs_out, clips.source_abs_out),
          file_rel_in = COALESCE(excluded.file_rel_in, clips.file_rel_in),
          file_rel_out = COALESCE(excluded.file_rel_out, clips.file_rel_out),
          transcript_model = COALESCE(excluded.transcript_model, clips.transcript_model),
          transcript_language = COALESCE(excluded.transcript_language, clips.transcript_language),
          hook_rating = COALESCE(excluded.hook_rating, clips.hook_rating),
          moment_reason = COALESCE(excluded.moment_reason, clips.moment_reason),
          created_at = COALESCE(excluded.created_at, clips.created_at),
          updated_at = ${NOW}
      `),
      countCampaigns: db.prepare('SELECT COUNT(*) AS n FROM campaigns'),
      countSources: db.prepare('SELECT COUNT(*) AS n FROM sources'),
      countClipSpecs: db.prepare('SELECT COUNT(*) AS n FROM clip_specs'),
      countSpecFields: db.prepare('SELECT COUNT(*) AS n FROM clip_spec_fields'),
      countClips: db.prepare('SELECT COUNT(*) AS n FROM clips'),
    };
  }

  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) {
      const name = `sp${this.savepoint++}`;
      this.db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        this.db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO ${name}`);
        this.db.exec(`RELEASE ${name}`);
        throw error;
      }
    }
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  counts(): IndexCounts {
    const get = (stmt: StatementSync): number => Number((stmt.get() as { n: number | bigint }).n);
    return {
      campaigns: get(this.stmts.countCampaigns),
      sources: get(this.stmts.countSources),
      clipSpecs: get(this.stmts.countClipSpecs),
      clipSpecFields: get(this.stmts.countSpecFields),
      clips: get(this.stmts.countClips),
    };
  }

  upsertCampaign(campaign: CampaignInput): void {
    this.stmts.insertCampaign.run(
      campaign.id,
      str(campaign.title),
      str(campaign.campaignUrl),
      str(campaign.lastCrawledAt),
      str(campaign.lastExtractedAt),
    );
  }

  upsertSource(campaignId: string | null, source: BriefSource, cachePath: string | null = null): void {
    const record: SourceRecord = {
      row_key: campaignId === null ? cacheRowKey(source.url) : sourceRowKey(campaignId, source.id),
      campaign_id: campaignId,
      source_id: campaignId === null ? null : source.id,
      url: source.url,
      host: str(source.host),
      kind: str(source.kind),
      status: str(source.status),
      http_status: num(source.httpStatus),
      content_type: str(source.contentType),
      bytes: num(source.bytes),
      line_count: num(source.lineCount),
      media_type: str(source.mediaType),
      needs_browser: num(source.needsBrowser),
      rendered_tables: num(source.renderedTables),
      from_cache: num(source.fromCache),
      has_text: num(Boolean(source.text && source.text.length > 0)),
      fetched_at: str(source.fetchedAt),
      error: str(source.error),
      cache_path: str(cachePath),
      drive_files: num(source.driveFiles?.length ?? null),
    };
    this.writeSource(record);
  }

  upsertSources(campaignId: string | null, sources: BriefSource[], cachePathFor?: (source: BriefSource) => string | null): void {
    this.transaction(() => {
      for (const source of sources) {
        const cachePath = cachePathFor ? cachePathFor(source) : null;
        this.upsertSource(campaignId, source, cachePath);
      }
    });
  }

  upsertBriefBundle(bundle: BriefBundle): void {
    this.transaction(() => {
      this.upsertCampaign({ id: bundle.campaignId, campaignUrl: bundle.campaignUrl, lastCrawledAt: bundle.fetchedAt });
      this.upsertSources(bundle.campaignId, bundle.sources);
    });
  }

  upsertClipSpec(spec: ClipSpec): void {
    this.transaction(() => {
      this.stmts.ensureCampaign.run(spec.campaignId);
      const filled: [string, Field<unknown>][] = [];
      for (const field of Object.keys(RULE_FIELDS)) {
        const entry = (spec as unknown as Record<string, Field<unknown> | null>)[field];
        if (entry !== null && entry !== undefined) filled.push([field, entry]);
      }
      this.stmts.upsertSpec.run(
        spec.campaignId,
        str(spec.extractedAt),
        str(spec.extractor.provider),
        str(spec.extractor.model),
        str(spec.extractor.promptVersion),
        filled.length,
        spec.unstructuredRequirements.length,
      );
      this.stmts.deleteSpecFields.run(spec.campaignId);
      for (const [field, entry] of filled) {
        this.writeSpecField(spec.campaignId, field, 0, entry.value, RULE_FIELDS[field] ?? null, entry.provenance);
      }
      spec.unstructuredRequirements.forEach((item, index) => {
        this.writeSpecField(spec.campaignId, 'unstructuredRequirements', index, item.text, 'string', item.provenance);
      });
    });
  }

  upsertClip(sidecar: ClipSidecar, paths: { filePath: string; sidecarPath?: string | null }): void {
    this.transaction(() => {
      this.stmts.ensureCampaign.run(sidecar.campaignId);
      this.stmts.insertClip.run(
        sidecar.campaignId,
        sidecar.videoId,
        paths.filePath,
        str(paths.sidecarPath),
        str(sidecar.sourceUrl),
        num(sidecar.durationSeconds),
        num(sidecar.fetch?.start),
        num(sidecar.fetch?.end),
        num(sidecar.timecodes?.sourceAbsolute?.in),
        num(sidecar.timecodes?.sourceAbsolute?.out),
        num(sidecar.timecodes?.fileRelative?.in),
        num(sidecar.timecodes?.fileRelative?.out),
        str(sidecar.transcript?.model),
        str(sidecar.transcript?.language),
        num(sidecar.moment?.hookRating),
        str(sidecar.moment?.reason),
        str(sidecar.createdAt),
      );
    });
  }

  campaignsMissingBriefText(): CampaignRow[] {
    return this.db.prepare(`
      SELECT c.* FROM campaigns c
      WHERE NOT EXISTS (
        SELECT 1 FROM sources s
        WHERE s.campaign_id = c.id AND s.status = 'ok' AND s.has_text = 1
      )
      ORDER BY c.id
    `).all() as unknown as CampaignRow[];
  }

  sourcesByStatus(status: string): SourceRow[] {
    return this.db.prepare('SELECT * FROM sources WHERE status = ? ORDER BY row_key').all(status) as unknown as SourceRow[];
  }

  campaignsWhereField(fieldName: string): CampaignRow[] {
    return this.db.prepare(`
      SELECT DISTINCT c.* FROM campaigns c
      JOIN clip_spec_fields f ON f.campaign_id = c.id
      WHERE f.field_name = ?
      ORDER BY c.id
    `).all(fieldName) as unknown as CampaignRow[];
  }

  clipsForCampaign(campaignId: string): ClipRow[] {
    return this.db.prepare('SELECT * FROM clips WHERE campaign_id = ? ORDER BY video_id, file_path').all(campaignId) as unknown as ClipRow[];
  }

  reindex(options: ReindexOptions = {}): ReindexResult {
    const cacheDir = options.cacheDir ?? DEFAULT_REFS_DIR;
    const clipsDir = options.clipsDir ?? DEFAULT_CLIPS_DIR;
    const warnings: string[] = [];
    let skippedFiles = 0;

    const refFiles = this.walkFiles(cacheDir, '.json');
    const sidecarFiles = this.walkFiles(clipsDir, '.json');

    this.transaction(() => {
      for (const file of refFiles) {
        const parsed = this.parseJson(file, warnings);
        if (parsed === null) { skippedFiles++; continue; }
        const record = this.sourceFromCache(parsed, file, warnings);
        if (record === null) { skippedFiles++; continue; }
        this.writeSource(record);
      }
      for (const file of sidecarFiles) {
        const parsed = this.parseJson(file, warnings);
        if (parsed === null) { skippedFiles++; continue; }
        if (!isRecord(parsed) || typeof parsed.campaignId !== 'string' || typeof parsed.videoId !== 'string') {
          warnings.push(`${pointer(file)}: JSON is not a clip sidecar (missing campaignId/videoId); skipped.`);
          skippedFiles++;
          continue;
        }
        const mp4 = file.slice(0, -'.json'.length) + '.mp4';
        this.upsertClip(parsed as unknown as ClipSidecar, { filePath: mp4, sidecarPath: file });
        if (!existsSync(mp4)) warnings.push(`${pointer(file)}: sidecar present but its .mp4 is missing; file_path kept as a pointer.`);
      }
    });

    return {
      cacheDir,
      clipsDir,
      counts: this.counts(),
      refFiles: refFiles.length,
      sidecarFiles: sidecarFiles.length,
      skippedFiles,
      warnings,
    };
  }

  private writeSource(record: SourceRecord): void {
    this.stmts.insertSource.run(
      record.row_key,
      record.campaign_id,
      record.source_id,
      record.url,
      record.host,
      record.kind,
      record.status,
      record.http_status,
      record.content_type,
      record.bytes,
      record.line_count,
      record.media_type,
      record.needs_browser,
      record.rendered_tables,
      record.from_cache,
      record.has_text,
      record.fetched_at,
      record.error,
      record.cache_path,
      record.drive_files,
    );
  }

  private writeSpecField(
    campaignId: string,
    fieldName: string,
    itemIndex: number,
    value: unknown,
    valueType: string | null,
    provenance: Provenance[],
  ): void {
    const entries: (Provenance | null)[] = provenance.length ? provenance : [null];
    entries.forEach((entry, provIndex) => {
      this.stmts.insertSpecField.run(
        campaignId,
        fieldName,
        itemIndex,
        provIndex,
        JSON.stringify(value ?? null),
        valueType,
        entry ? str(entry.sourceId) : null,
        entry ? num(entry.line) : null,
        entry ? str(entry.quote) : null,
      );
    });
  }

  private sourceFromCache(parsed: unknown, file: string, warnings: string[]): SourceRecord | null {
    if (!isRecord(parsed) || typeof parsed.url !== 'string' || !parsed.url) {
      warnings.push(`${pointer(file)}: cache entry has no url; skipped.`);
      return null;
    }
    const entry = parsed as unknown as CachedReference;
    const key = entry.url;
    const isBrowser = key.startsWith('browser:');
    const isDrive = key.startsWith('browser:drive:');
    const url = isDrive ? key.slice('browser:drive:'.length) : key.startsWith('browser:text:') ? key.slice('browser:text:'.length) : key;
    const body = typeof entry.body === 'string' ? entry.body : null;
    let driveFiles: number | null = null;
    let status: string | null;
    if (isDrive && body !== null) {
      try {
        const list: unknown = JSON.parse(body);
        driveFiles = Array.isArray(list) ? list.length : null;
      } catch {
        driveFiles = null;
      }
      status = driveFiles && driveFiles > 0 ? 'ok' : 'skipped';
    } else if (entry.contentType === 'binary') {
      status = 'skipped';
    } else if (body !== null) {
      status = 'ok';
    } else {
      status = null;
    }
    return {
      row_key: cacheRowKey(key),
      campaign_id: null,
      source_id: `cache:${basename(file)}`,
      url,
      host: str(hostOf(url)),
      kind: isDrive ? 'footage_drive' : null,
      status,
      http_status: num(entry.httpStatus),
      content_type: str(entry.contentType),
      bytes: num(body?.length ?? null),
      line_count: num(body === null ? null : body.split('\n').length),
      media_type: null,
      needs_browser: isBrowser ? 1 : 0,
      rendered_tables: null,
      from_cache: null,
      has_text: num(body !== null && body.trim().length > 0),
      fetched_at: str(entry.fetchedAt),
      error: null,
      cache_path: pointer(file),
      drive_files: driveFiles,
    };
  }

  private parseJson(file: string, warnings: string[]): unknown | null {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      warnings.push(`${pointer(file)}: unreadable JSON (${error instanceof Error ? error.message : String(error)}); skipped.`);
      return null;
    }
  }

  private walkFiles(dir: string, extension: string): string[] {
    const out: string[] = [];
    if (!existsSync(dir)) return out;
    const visit = (current: string): void => {
      let entries;
      try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) visit(full);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) out.push(full);
      }
    };
    visit(dir);
    return out.sort();
  }
}

export default ClippingIndex;
