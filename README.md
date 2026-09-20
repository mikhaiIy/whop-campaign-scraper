# whop-content-rewards-mcp

An MCP server that lets coding agents discover and filter public Whop
**Content Rewards** clipping campaigns from
[contentrewards.com/discover](https://contentrewards.com/discover).

**No Whop account, no login, no cookies, and no API key are required.** The data
source is the public JSON API that the contentrewards.com website itself calls:

```
GET https://contentrewards.com/api/campaign/campaigns/discover?limit=50&cursor=<opaque>
```

The server follows its cursor page by page (currently ~660 campaigns), caches
the result in memory for 5 minutes, and never sends a login or session. All it
needs is ordinary outbound HTTPS access to `contentrewards.com`.

---

## Quick start

```bash
# 1. Install dependencies
cd /home/mikhaily/Work/whop-mcp
npm install

# 2. Build the server (produces dist/index.js)
npm run build
```

The built entry point is `/home/mikhaily/Work/whop-mcp/dist/index.js`. All three
harnesses below point at that same artifact; only the config wrapper differs.

**3. Wire it into opencode** — add the `mcp` block shown in
[opencode (primary)](#opencode-primary) to your config, then restart opencode and
ask it `list the whop content rewards campaigns`.

**4. Optional: run the web console**

```bash
npm run serve            # http://127.0.0.1:4317
npm run serve -- 8080    # a different port
```

Stdio MCP keeps working with `--serve` absent or present.

---

## What the 5 tools do

| Tool | Purpose |
| --- | --- |
| `list_campaigns` | Filter the cached public catalog. Applies a config preset, then explicit arguments override individual values. |
| `get_campaign` | Fetch a public campaign detail page by UUID (description, payouts, reference materials). |
| `search_campaigns` | Case-insensitive substring search over title, brand and description. |
| `list_categories` | Categories and counts derived from live data, so the agent can discover valid filter values. |
| `reload_config` | Force an immediate re-read of the config file without a restart. |

`list_campaigns` follows the same public JSON API the site uses, page by page,
so it sees the whole public catalog (currently ~660 campaigns) instead of just
the first rendered batch. See [Deep fetching](#deep-fetching-pagination).

---

## Clipping pipeline

The server also turns a campaign's footage into vertical, captioned clips — still
fully local, with no account or API key. One-time setup:

```bash
bash tools/setup-whisper.sh     # .venv: faster-whisper (transcription) + auto-editor (tighten)
```

This needs system `ffmpeg`/`ffprobe` built with `libass` and `loudnorm`.

| Tool | Purpose |
| --- | --- |
| `get_campaign_brief` | Crawl the brief into a BriefBundle. |
| `extract_clip_spec` | Extract a typed ClipSpec (durations, hook policy, forbidden rules). |
| `resolve_campaign_footage` | Resolve YouTube channels / Drive folders to source videos. |
| `plan_campaign_clips` | Crawl + spec + footage — the front half, no cutting. |
| `select_campaign_moments` | Transcribe and pick clip-worthy moments; cuts nothing. |
| `produce_campaign_clips` | Cut real clips. Set `enhance: true` for the rendered vertical short. |

**Moment selection** ranks candidates by a hook score, drops overlapping or
near-duplicate picks (IoU > 0.5, bag-of-words cosine > 0.85), gates out weak
openings, re-scores the shortlist in a second model pass, then applies MMR
diversity (λ = 0.7) so one batch is not five versions of the same moment.

**The render stage** (`enhance: true`) tightens dead air with auto-editor,
reframes to 1080×1920 (scale-to-cover, then crop), burns word-synced ASS captions
authored for the output canvas, and normalizes audio to −14 LUFS / −1.5 dBTP /
LRA 11 in a single ffmpeg pass. Reframing samples the clip for a dominant face
(`tools/focus.py`, OpenCV Haar cascade) and centers the crop on it, falling back
to a centered crop when no face is found. Each render writes a sidecar
(`<clip>.vertical.json`) with the measured loudness, the exact ffmpeg args and
the output probe. The console exposes the same path as a **Vertical + captions**
toggle.

---

## Harness wiring

All three harnesses launch the same stdio server:

```
node /home/mikhaily/Work/whop-mcp/dist/index.js
```

### The Node path problem (read this first)

On this machine `node` is a **mise** install, not a system Node:

```
node --version  ->  v26.7.0
which node      ->  /home/mikhaily/.local/share/mise/installs/node/26.7.0/bin/node
```

`node` is on `PATH` only through mise shims. An MCP client launched from a
desktop app or a non-login shell may not have those shims on `PATH`, so a bare
`"node"` can fail with `ENOENT` and the tools simply won't appear. If that
happens, replace `"node"` with the absolute path:

```
/home/mikhaily/.local/share/mise/installs/node/26.7.0/bin/node
```

The examples below show the simple bare-`node` form; swap in the absolute path
whenever the server fails to start.

### opencode (primary)

Schema source: <https://opencode.ai/docs/mcp-servers/>. A local server uses
`"type": "local"`, a `"command"` array, `"enabled": true`, and an
`"environment"` object for `WHOP_MCP_CONFIG`.

**Project-level** — `opencode.json` (or `opencode.jsonc`) in the repo root. This
adds the server only when you open this project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "whop-content-rewards": {
      "type": "local",
      "command": ["node", "/home/mikhaily/Work/whop-mcp/dist/index.js"],
      "enabled": true,
      "environment": {
        "WHOP_MCP_CONFIG": "/home/mikhaily/Work/whop-mcp/campaigns.config.md"
      }
    }
  }
}
```

**Global** — `~/.config/opencode/opencode.json`. The file already exists and has
other keys (`autoupdate`, `permission`). Do **not** replace it; add the `mcp`
block alongside the keys that are already there:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,
  "permission": { "bash": "allow", "edit": "allow" },
  "mcp": {
    "whop-content-rewards": {
      "type": "local",
      "command": ["node", "/home/mikhaily/Work/whop-mcp/dist/index.js"],
      "enabled": true,
      "environment": {
        "WHOP_MCP_CONFIG": "/home/mikhaily/Work/whop-mcp/campaigns.config.md"
      }
    }
  }
}
```

If the tools do not appear, use the absolute Node path:

```json
"command": [
  "/home/mikhaily/.local/share/mise/installs/node/26.7.0/bin/node",
  "/home/mikhaily/Work/whop-mcp/dist/index.js"
]
```

After editing the config, restart opencode. Then ask it to `use the
whop-content-rewards tools to list campaigns`.

### codex

Append to `~/.codex/config.toml`. That file already exists with top-level scalar
keys (`service_tier`, `approvals_reviewer`, `model`, `model_reasoning_effort`)
and other tables (`[marketplaces.*]`, `[plugins.*]`). Because TOML is
table-based, put the new table **after** the existing top-level scalar keys —
not in the middle of them — so those keys stay attached to the root table:

```toml
[mcp_servers.whop-content-rewards]
command = "node"
args = ["/home/mikhaily/Work/whop-mcp/dist/index.js"]

[mcp_servers.whop-content-rewards.env]
WHOP_MCP_CONFIG = "/home/mikhaily/Work/whop-mcp/campaigns.config.md"
```

Use the absolute Node path if `node` is not found:

```toml
[mcp_servers.whop-content-rewards]
command = "/home/mikhaily/.local/share/mise/installs/node/26.7.0/bin/node"
args = ["/home/mikhaily/Work/whop-mcp/dist/index.js"]

[mcp_servers.whop-content-rewards.env]
WHOP_MCP_CONFIG = "/home/mikhaily/Work/whop-mcp/campaigns.config.md"
```

### Claude Code

`claude` is installed, so `claude mcp add` works. Pass the server command after
`--`, and set the config path with repeated `--env` flags:

```bash
claude mcp add whop-content-rewards \
  --env WHOP_MCP_CONFIG=/home/mikhaily/Work/whop-mcp/campaigns.config.md \
  -- node /home/mikhaily/Work/whop-mcp/dist/index.js
```

With the absolute Node path:

```bash
claude mcp add whop-content-rewards \
  --env WHOP_MCP_CONFIG=/home/mikhaily/Work/whop-mcp/campaigns.config.md \
  -- /home/mikhaily/.local/share/mise/installs/node/26.7.0/bin/node /home/mikhaily/Work/whop-mcp/dist/index.js
```

Verify with `claude mcp list`.

---

## Local web console (`--serve`)

```bash
npm run serve            # http://127.0.0.1:4317
npm run serve -- 8080    # a different port
```

`npm run serve` is equivalent to `node dist/index.js --serve`. The server binds
to **localhost only** and adds a single-page console next to the stdio MCP
server. It reuses the same source, cache, and config layer as the MCP tools, so
the config's `deep_fetch`/`max_pages`/`page_size` settings apply here too. Three
panels:

- **Campaign table** — live catalog, sortable by CPM, budget remaining, burn rate,
  creator count and more; filterable by category, platform, type and free text.
  Shows thumbnails, platform badges, a spend meter, a nearly-exhausted flag, and a
  sparkline of estimated daily spend per campaign.
- **Config editor** — build a preset by clicking categories/platforms and setting
  numeric filters, then write it back to the resolved config file. Only the YAML
  frontmatter is rewritten; the prose body is preserved byte for byte.
- **Monitor** — active preset, cache age, fetch mode (JSON API vs HTML fallback),
  pages fetched, last fetch status and any `deepFetchError`, plus a log of the MCP
  tool calls agents made against this server instance.

Endpoints: `GET /` (SPA), `GET /api/campaigns`, `GET /api/config`,
`POST /api/config`, `GET /api/status`, `POST /api/refresh`.

---

## Configuration file

The server reads a Markdown file with YAML frontmatter: machine filters in the
frontmatter, human intent in the prose body.

### Worked example

A complete `campaigns.config.md` you can copy as a starting point:

```markdown
---
default_preset: tech-clipping
deep_fetch: true
max_pages: 5
page_size: 50
page_delay_ms: 500
presets:
  tech-clipping:
    categories: [Technology, SaaS, Gaming]
    platforms: [tiktok, youtube]
    min_cpm: 1.0
    max_cpm: 10.0
    min_budget_remaining: 500
    exclude_brands: [SomeBrand]
    type: cpm
    requires_application: true
    is_verified: true
    sort_by: budget_remaining
    limit: 25
  all-at-once:
    platforms: [instagram, tiktok, youtube]
    min_budget_remaining: 1000
    sort_by: cpm
    limit: 50
---

# What I am looking for

I clip talking-head tech and SaaS content. I want active campaigns with at
least $500 of budget left and a CPM of at least $1, on TikTok or YouTube.
Skip anything that looks abandoned — I would rather have fewer, healthier
campaigns than a long list of exhausted ones.
```

The prose body is a feature: the agent reads it alongside the numeric filters,
so it understands intent, not just thresholds.

### Resolution order

1. `WHOP_MCP_CONFIG` environment variable, if set.
2. `./campaigns.config.md` in the current working directory.
3. `~/.config/whop-mcp/campaigns.config.md`.

If `WHOP_MCP_CONFIG` is set, that path is the only target. Otherwise, if neither
location exists, the server creates a commented starter file at
`~/.config/whop-mcp/campaigns.config.md` on first run. An unreadable or missing
file never crashes the server; it falls back to no filtering and reports a
warning in the tool response.

### Frontmatter keys

| Key | Type | Meaning |
| --- | --- | --- |
| `default_preset` | string | Preset applied by `list_campaigns` when no arguments are given. |
| `presets` | mapping | Named bundles of filters. Any key below can appear in a preset. |
| `deep_fetch` | boolean | Enable cursor pagination over the public JSON API. Default `true`. |
| `max_pages` | integer 1-100 | Maximum API pages to request. Default `5`. |
| `page_size` | integer 1-100 | Records per API page. Default `50`. |
| `page_delay_ms` | integer 0-10000 | Pause between page requests, for politeness. Default `500`. |

Preset filter keys: `categories`, `platforms`, `exclude_brands`, `type`,
`min_cpm`, `max_cpm`, `min_budget_remaining`, `requires_application`,
`is_verified`, `sort_by`, `limit`. They are the same fields the
`list_campaigns` tool accepts, so a preset value can be overridden by passing
that argument explicitly.

### Behavior

- `list_campaigns` with no arguments applies `default_preset`.
- `list_campaigns` with `preset: <name>` applies that preset instead.
- Explicit arguments override individual preset values key by key; unspecified
  preset values remain in effect.
- The prose body is exposed as the MCP resource `whop://config/notes` and is
  also returned as `configNotes` in `list_campaigns` output.
- The file is hot-reloaded when its modification time changes; no restart is
  needed. `reload_config` bypasses the mtime check and always re-reads.
- Invalid YAML, an invalid preset, or a `default_preset` that is not defined is
  skipped and reported in `configWarnings`. The server keeps serving campaigns.

---

## Deep fetching (pagination)

The discover HTML page server-renders only its first ~50 campaigns.
`?page=2`, `?category=`, `?platform=` and `?sort=` all return that same 50, so
the web app loads more client-side.

It does this through a public JSON API that needs no authentication and no
cookies:

```
GET https://contentrewards.com/api/campaign/campaigns/discover?limit=50&cursor=<opaque>
```

The response carries `data[]` and `pagination.nextCursor`; passing the cursor
back walks the catalog forward. As of this writing the whole catalog is ~660
campaigns and the cursor runs out after ~7 pages of 100.

- This JSON endpoint was found by reading the Next.js client bundles: the
  discover feed calls an oRPC style client
  `campaignClient.listDiscover({ limit, cursor })` against
  `/api/campaign/campaigns/discover`. The raw API is used directly, so no
  server action replay or headless browser is needed.
- The JSON records are normalized onto the same internal `Campaign` type as the
  HTML path (`budgetCents` → dollars, `primaryPayoutCents`/`cpmMinRateCents` →
  `cpmUsd`, `metrics.budgetProgressBps` → progress, `organizationName` → brand,
  and so on).
- `max_pages` caps how deep the server goes (default 5 × 50 = 250 campaigns)
  and `page_delay_ms` keeps the origin politely paced.

### Graceful degradation

Deeper fetching is strictly additive. If the API request fails for any reason
(non-200, non-JSON body, timeout), the server silently falls back to the
original server-rendered HTML path that yields ~50 campaigns. The failure is
never fatal and is reported in the tool response metadata:

- `fetchMode`: `"api"` or `"html"`.
- `pagesFetched`: how many API pages were read.
- `catalogComplete`: `true` when the cursor ran out, `false` when `max_pages`
  capped the walk.
- `deepFetchError`: the reason the API path was abandoned, or `null`.
- `coverage`: a human-readable summary of the above.

Set `deep_fetch: false` to disable the API path entirely and keep the
50-campaign HTML behavior.

---

## Development

```bash
npm run typecheck   # TypeScript check
npm run lint        # ESLint
npm test            # offline unit tests against captured fixtures
npm run test:live   # end-to-end smoke test against the live public source
```

Requirements: Node.js >= 26 (`node --version` should print `v26.x`).
