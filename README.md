# Spotonix -> HubSpot Sync (GitHub Actions)

Runs the Spotonix HubSpot sync (HeyReach LinkedIn + Instantly email -> HubSpot contacts/notes) **every 15 minutes** in the cloud, free, via GitHub Actions scheduled workflow.

## How it works

- `.github/workflows/sync.yml` runs on a cron schedule (`*/15 * * * *`) on `ubuntu-latest`.
- `hubspot-sync/sync-to-hubspot.mjs` pulls all campaigns/leads/conversations from HeyReach and Instantly via their MCP JSON-RPC endpoints, upserts HubSpot contacts, and writes every message/reply as a timeline note.
- Dedup state is persisted through GitHub Actions cache (`spotonix-hs-state-*`), so repeated runs don't duplicate notes/contacts.
- `SYNC_FAST=1` shortens API safety sleeps so a run completes in ~5 min (well under the 15-min cadence). Local runs without the flag keep the original slower, gentler pacing.

## Secrets

Set these in **Settings -> Secrets and variables -> Actions**:

| Secret | Value |
|---|---|
| `HUBSPOT_TOKEN` | HubSpot private app access token |
| `HEYREACH_MCP_KEY` | HeyReach MCP API key |
| `INSTANTLY_KEY` | Instantly API key |

No secrets live in the repo.

## Manual trigger

Actions tab -> "Spotonix HubSpot Sync" -> Run workflow, or:

```sh
gh workflow run sync.yml
```

## Local fallback

The script is backwards-compatible: without the env vars / `SPOTONIX_HS_SYNC_DIR`, it reads `~/.spotonix-hs-sync/config.json` and writes `state.json` there (the original local setup). Run with `node hubspot-sync/sync-to-hubspot.mjs`.
