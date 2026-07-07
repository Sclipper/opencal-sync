# opencal-sync

Self-hosted, open-source calendar sync — a free [OneCal](https://onecal.io) alternative you run yourself.

- **Sync calendars**: mirror events between Google Calendar and Outlook accounts as privacy-safe "Busy" blockers or full clones. One-way or two-way.
- **Share availability**: a public page (`/a/your-slug`) showing your merged free slots across all calendars.
- **Own your data**: one Docker container, SQLite inside, your own API keys. No third-party service sees your events except [Composio](https://composio.dev), which brokers the calendar APIs.

## How it works

opencal-sync polls your calendars every few minutes through Composio's Google Calendar and Outlook tools, then creates, updates, or deletes mirrored events. Google uses incremental sync (syncToken); Outlook has no delta/sync-token tool in Composio's toolkit, so each poll re-fetches the whole sync window and diffs it against the last-known mappings to infer deletions. A local mapping table prevents sync loops and makes every operation idempotent. Events marked "Free" never create blockers. Attendees are never copied, so nobody gets re-invited.

## Setup

You need: Docker, a free [Composio account](https://app.composio.dev), and (for Google) a free Google Cloud OAuth app.

### 1. Composio

1. Sign up at app.composio.dev and copy your API key.
2. **Outlook**: create an auth config for the `OUTLOOK` toolkit → choose *Composio managed auth* → copy the auth config ID (`ac_…`).
3. **Google Calendar**: Composio has no managed OAuth app for Google Calendar, so you need your own (5 minutes, free):
   1. In [Google Cloud Console](https://console.cloud.google.com), create a project → enable the **Google Calendar API**.
   2. Configure the OAuth consent screen (External, add yourself as a test user).
   3. Create an **OAuth client ID** (Web application). Add the redirect URI shown in Composio's auth config screen (`https://backend.composio.dev/api/v3/toolkits/auth/callback` — copy the exact value Composio shows).
   4. In Composio, create an auth config for `GOOGLECALENDAR` → *Custom OAuth* → paste the client ID/secret → request scope `https://www.googleapis.com/auth/calendar` → copy the auth config ID.

### 2. Run it

```bash
git clone https://github.com/sclipper/opencal-sync && cd opencal-sync
cp .env.example .env   # fill in COMPOSIO_API_KEY, ADMIN_PASSWORD, BASE_URL
docker compose up -d
```

Open `BASE_URL`, log in, paste the two auth config IDs in **Settings**, then **Connect Google / Connect Outlook** on the dashboard and create your first sync link.

> `BASE_URL` must be reachable by your browser (it's where OAuth redirects land). For a server deployment put it behind HTTPS (Caddy/Traefik/nginx).

### Composio free-tier math

The free tier includes 20,000 tool calls/month. Incremental polling costs ~1 call per source calendar per cycle:

| Poll interval | 1 source calendar | 2 source calendars | 3 source calendars |
|---|---|---|---|
| 5 min (default) | ~8,640/mo | ~17,280/mo | over budget |
| 10 min | ~4,320/mo | ~8,640/mo | ~12,960/mo |

Writes (creating/updating blockers) add calls proportional to how busy your calendars are. Tune the interval in Settings.

## Limitations (v1)

- Polling only (default 5 min) — not instant. Composio triggers/webhooks are a possible future upgrade.
- Google recurring events sync as individual instances inside the sync window (default 60 days ahead). The window re-anchors with a full refetch once a day, so long-running instances stay current.
- Outlook syncs the **default calendar only** — Composio's Outlook toolkit exposes no calendar-scoped event tools (list/create only ever operate on the caller's default calendar).
- Outlook has **no incremental sync** — Composio's toolkit has no calendar delta/sync-token tool, so every poll is a full window fetch; deletions are inferred by diffing the fetched snapshot against the last-known mappings rather than reported directly.
- Outlook recurring events currently sync as their series master only (no occurrence-expansion tool used), so recurring Outlook series are only partially mirrored — instance-level changes/cancellations on a recurring series may not propagate.
- Updated events are recreated (delete + create), so blocker event IDs change on edit.
- All-day events are mirrored as 24-hour timed blockers on both providers (Google's create tool has no confirmed all-day support; Outlook's has no `is_all_day` field at all).
- Blocker deletions never send cancellation emails/notifications to attendees.
- Removing a *connection* does not delete already-created blockers — delete its sync links first (that cleans up).
- Composio's tool schemas occasionally change; if a sync fails with a parameter error, check `scripts/dump-tool-schema.mts` (see CONTRIBUTING.md) and open an issue.

## Development

```bash
npm install
ADMIN_PASSWORD=dev COMPOSIO_API_KEY=... BASE_URL=http://localhost:3000 npm run dev
npx vitest run        # tests
```

MIT licensed.
