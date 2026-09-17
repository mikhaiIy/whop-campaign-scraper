# whop-content-rewards-mcp

An MCP server that lets coding agents discover and filter public Whop
**Content Rewards** clipping campaigns from
[contentrewards.com/discover](https://contentrewards.com/discover). No
authentication, no cookies, no API key.

## Requirements and setup

- Node.js >= 26
- `npm install`
- `npm run build`
- `npm start` starts the server on **stdio**.

Verify it works:

- `npm run typecheck` — TypeScript check.
- `npm test` — offline unit tests against captured fixtures.
- `npm run test:live` — end-to-end smoke test against the live public source.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_campaigns` | Filter the cached discover batch. Applies a config preset, then explicit arguments override individual values. |
| `get_campaign` | Fetch a public campaign detail page by UUID (description, payouts, reference materials). |
| `search_campaigns` | Case-insensitive substring search over title, brand and description. |
| `list_categories` | Categories and counts derived from live data. |
| `reload_config` | Force an immediate re-read of the config file. |

The campaign batch is cached in memory for 5 minutes. `list_campaigns`
coverage note: the public source exposes only its initial discover batch
(normally 50 campaigns), not the complete catalog.

## Configuration file

The server reads a Markdown file with YAML frontmatter: machine filters in the
frontmatter, human intent in the prose body.

### Resolution order

1. `WHOP_MCP_CONFIG` environment variable, if set.
2. `./campaigns.config.md` in the current working directory.
3. `~/.config/whop-mcp/campaigns.config.md`.

If `WHOP_MCP_CONFIG` is set, that path is the only target. Otherwise, if neither
location exists, the server creates a commented starter file at
`~/.config/whop-mcp/campaigns.config.md` on first run. An unreadable or missing
file never crashes the server; it falls back to no filtering and reports a
warning in the tool response.

### Format

```markdown
---
default_preset: my-lane
presets:
  my-lane:
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
---

# What I am looking for

Free text explaining what I want and why. The agent reads this alongside the
numeric filters, so it is worth being specific.
```

### Frontmatter keys

| Key | Type | Meaning |
| --- | --- | --- |
| `default_preset` | string | Preset applied by `list_campaigns` when no arguments are given. |
| `presets` | mapping | Named bundles of filters. Any key below can appear in a preset. |

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
