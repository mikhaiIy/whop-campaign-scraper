-- Metadata-only index for the whop-mcp clipping pipeline.
--
-- Blobs stay on the filesystem. Every *_path column is a pointer, never a copy.
-- The filesystem is the source of truth; this database is a rebuildable index.
-- Nothing here may move, copy, or delete a file under .cache/ or out/.
--
-- Units: durations and timecodes are seconds (REAL); byte counts are bytes
-- (INTEGER); timestamps are ISO-8601 UTC strings (TEXT).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- One row per campaign. Rebuilt from clip sidecars (id only) or filled in by
-- the pipeline (title/url/coverage times).
CREATE TABLE IF NOT EXISTS campaigns (
  id                TEXT PRIMARY KEY,
  title             TEXT,
  campaign_url      TEXT,
  last_crawled_at   TEXT,
  last_extracted_at TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per BriefSource, plus one row per entry in the shared reference
-- cache. Reindexed cache entries have campaign_id NULL because the on-disk
-- cache is keyed only by URL and carries no campaign identity.
CREATE TABLE IF NOT EXISTS sources (
  row_key         TEXT PRIMARY KEY,          -- campaign-scoped or cache-scoped identity
  campaign_id     TEXT REFERENCES campaigns(id) ON DELETE CASCADE,
  source_id       TEXT,                      -- BriefSource.id (e.g. "ref:0"); NULL for cache rows
  url             TEXT NOT NULL,
  host            TEXT,
  kind            TEXT,
  status          TEXT,
  http_status     INTEGER,
  content_type    TEXT,
  bytes           INTEGER,
  line_count      INTEGER,
  media_type      TEXT,
  needs_browser   INTEGER,
  rendered_tables INTEGER,
  from_cache      INTEGER,
  has_text        INTEGER,
  fetched_at      TEXT,
  error           TEXT,
  cache_path      TEXT,                      -- pointer into .cache/clipping/refs
  drive_files     INTEGER,
  indexed_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sources_campaign ON sources(campaign_id);
CREATE INDEX IF NOT EXISTS idx_sources_status   ON sources(status);
CREATE INDEX IF NOT EXISTS idx_sources_kind     ON sources(kind);
CREATE INDEX IF NOT EXISTS idx_sources_url      ON sources(url);

-- One row per extracted campaign ClipSpec (extractor metadata only).
CREATE TABLE IF NOT EXISTS clip_specs (
  campaign_id              TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  extracted_at             TEXT,
  extractor_provider       TEXT,
  extractor_model          TEXT,
  extractor_prompt_version TEXT,
  field_count              INTEGER NOT NULL DEFAULT 0,
  unstructured_count       INTEGER NOT NULL DEFAULT 0,
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Long format: one row per (field, provenance) so cross-campaign queries are
-- plain SQL. A structured field with no provenance gets one row with NULL
-- provenance. item_index is 0 for structured fields and the array index for
-- unstructuredRequirements entries.
CREATE TABLE IF NOT EXISTS clip_spec_fields (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  field_name  TEXT NOT NULL,
  item_index  INTEGER NOT NULL DEFAULT 0,
  prov_index  INTEGER NOT NULL DEFAULT 0,
  value_json  TEXT,                          -- JSON-encoded value (array or scalar)
  value_type  TEXT,                          -- string | number | boolean | string[]
  source_id   TEXT,
  line        INTEGER,
  quote       TEXT,
  PRIMARY KEY (campaign_id, field_name, item_index, prov_index)
);

CREATE INDEX IF NOT EXISTS idx_spec_fields_name     ON clip_spec_fields(field_name);
CREATE INDEX IF NOT EXISTS idx_spec_fields_campaign ON clip_spec_fields(campaign_id);
CREATE INDEX IF NOT EXISTS idx_spec_fields_source   ON clip_spec_fields(source_id);

-- One row per cut clip, read from the JSON sidecar next to each .mp4.
CREATE TABLE IF NOT EXISTS clips (
  campaign_id         TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  video_id            TEXT NOT NULL,
  file_path           TEXT NOT NULL,         -- pointer to the .mp4
  sidecar_path        TEXT,                  -- pointer to the .json sidecar
  source_url          TEXT,
  duration_seconds    REAL,
  fetch_start         REAL,
  fetch_end           REAL,
  source_abs_in       REAL,
  source_abs_out      REAL,
  file_rel_in         REAL,
  file_rel_out        REAL,
  transcript_model    TEXT,
  transcript_language TEXT,
  hook_rating         INTEGER,
  moment_reason       TEXT,
  created_at          TEXT,
  indexed_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (campaign_id, video_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_clips_campaign ON clips(campaign_id);
CREATE INDEX IF NOT EXISTS idx_clips_video    ON clips(video_id);
