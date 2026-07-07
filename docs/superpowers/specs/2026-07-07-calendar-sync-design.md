# opencal-sync — Design

**Date:** 2026-07-07
**Status:** Approved

## What it is

A self-hosted, open-source calendar sync tool (OneCal alternative). A single Next.js app run in Docker that:

1. Syncs events between Google Calendar and Outlook calendars — busy-blockers or full clones, one-way or two-way.
2. Serves a public availability page showing merged free slots.

Anyone self-hosts it with their own Composio API key. MIT licensed, public GitHub repo `opencal-sync`. Single-user per instance (no user accounts).

## Stack

- **Next.js** (App Router, TypeScript), **Tailwind CSS** for UI.
- **SQLite** via `better-sqlite3`, plain SQL (no ORM). Schema applied idempotently at startup (`CREATE TABLE IF NOT EXISTS`).
- **`@composio/core`** for all calendar access (OAuth + tool execution). No direct Google/Microsoft SDKs.
- **Auth:** `ADMIN_PASSWORD` env var; constant-time compare; HMAC-signed session cookie (Node `crypto`, no auth library).
- **Scheduler:** in-process interval loop started from `instrumentation.ts` (runs once per server start). No queue, no worker process.
- **Deployment:** one Docker container (multi-stage build, Next standalone output), one volume for the SQLite file. `docker-compose.yml` provided.

Required env vars: `COMPOSIO_API_KEY`, `ADMIN_PASSWORD`, `BASE_URL`. Everything else is configured in the UI and stored in SQLite.

## Connecting calendars (Composio)

- Uses Composio **auth configs** (per-toolkit OAuth blueprint) + **connected accounts** (a user's authenticated link).
- Flow: app calls `composio.connectedAccounts.link(userId, authConfigId, { callbackUrl })` → user clicks the returned `redirectUrl` → completes provider consent → returns to callback → app confirms via `waitForConnection` / status check.
- **Google Calendar (`GOOGLECALENDAR` toolkit): Composio-managed OAuth is NOT available.** Self-hosters must create their own free Google Cloud OAuth client and paste its credentials into a Composio auth config. README documents this step-by-step.
- **Outlook (`OUTLOOK` toolkit): Composio-managed OAuth available** — zero provider setup.
- The two auth-config IDs are entered once on the app's Settings page (stored in DB).
- A fixed internal `userId` (e.g. `"default"`) is used for all Composio calls since instances are single-user.

## Data model (SQLite)

- `connections` — id, provider (`google`|`outlook`), composio_connected_account_id, account_label (email), status, created_at.
- `calendars` — id, connection_id FK, provider_calendar_id, name, cached calendar list per connection (refreshable).
- `sync_links` — id, source_calendar_id FK, target_calendar_id FK, mode (`busy`|`clone`), busy_title (default "Busy"), pair_id (nullable), enabled, last_run_at, last_error. **All links are one-way**; the UI's "two-way" toggle creates two links (paired via `pair_id` so the UI can display/delete them together).
- `event_mappings` — id, sync_link_id FK, source_event_id, target_event_id, content_hash, updated_at. Unique on (sync_link_id, source_event_id).
- `sync_state` — calendar_id PK, sync_cursor (Google syncToken / Outlook deltaLink), last_synced_at.
- `settings` — key/value: poll interval (default 5 min), sync window days (default 60), auth config IDs.
- `availability_pages` — id, slug, calendar_ids (JSON), working_hours (JSON per weekday), timezone, days_ahead (default 14), enabled.

## Sync engine

Runs every poll cycle, sequentially per source calendar:

1. **Fetch changes** for each calendar that is a source of ≥1 enabled link, within a rolling window (now-1 day → now+window):
   - Google: `GOOGLECALENDAR_EVENTS_LIST` with `syncToken` (incremental after first run).
   - Outlook: `OUTLOOK_LIST_CALENDAR_VIEW_DELTA` with stored deltaLink.
   - First run / no cursor: full fetch of the window.
2. **Loop prevention:** skip any changed event whose ID appears as a `target_event_id` in `event_mappings` (we created it). No reliance on event tags/extended properties.
3. **Propagate** per sync link:
   - New source event → create target event, insert mapping.
   - Changed → compare content hash (start, end, and for clone mode title/description/location); skip if unchanged, else update target.
   - Deleted/cancelled → delete target event, remove mapping.
   - Busy mode writes: configurable title, start/end only, no attendees/description. Clone mode: also title, description, location. Never attendees (avoids re-inviting people).
4. **Recurring events** sync as individual expanded instances within the window (no recurrence-rule cloning in v1).
5. **All-day events** sync as all-day.
6. **Free/transparent events** (marked "Free" in Google, "Free" show-as in Outlook) are ignored — no blocker created; same rule applies to the availability page's busy computation.

**Error handling:**
- Per-link `last_error` stored and surfaced in dashboard; next cycle retries automatically; "Sync now" button forces an immediate cycle.
- HTTP 410 / expired cursor → clear cursor, full re-sync of window (mappings make this idempotent).
- 429 / rate limit → exponential backoff, sequential writes with small delay (per Google's guidance, ≤5 concurrent — we use 1).
- A `sync_runs` log (last ~50 runs: started_at, duration, events processed, errors) shown on the dashboard.

**Free-tier budget:** Composio free plan = 20K tool calls/month. Incremental polling ≈ 1 call per source calendar per cycle; at 5-min default, 2 source calendars ≈ 17K/month plus writes. README documents the math and how to tune the interval.

## Availability sharing

- Public route `/a/<slug>` (no login).
- On request: fetch events for each selected calendar in the page's window (Google `GOOGLECALENDAR_EVENTS_LIST` with timeMin/timeMax; Outlook `OUTLOOK_LIST_USER_CALENDAR_VIEW`), merge busy intervals, subtract from configured working hours, render free slots.
- Output: simple week grid + copyable plain-text summary ("Mon Jul 13: 10:00–12:30, 14:00–17:00 …") in the page's timezone.
- Responses cached in-memory for 5 minutes per slug to bound tool calls.

## UI (3 screens + public page)

1. **Dashboard `/`** — connections list + "Connect Google / Outlook" buttons (Composio link flow), sync links list + create form (source calendar, target calendar, mode, one-way/two-way toggle), per-link status/error, last runs, "Sync now".
2. **Settings `/settings`** — Composio auth config IDs, poll interval, sync window, busy title default.
3. **Availability `/availability`** — create/edit availability pages: slug, included calendars, working hours per weekday, timezone, days ahead.
4. **Public `/a/<slug>`** — the free-slots page.
5. `/login` — password form.

Empty states guide first-run setup (no connections → "connect a calendar first", etc.).

## Repo layout & OSS hygiene

- `Dockerfile`, `docker-compose.yml`, `.env.example`, `LICENSE` (MIT), `README.md` (features, screenshots placeholder, full self-host guide incl. Google OAuth app creation + Composio auth config setup, free-tier math), `CONTRIBUTING.md` (brief).
- GitHub Actions CI: lint + typecheck + tests on PR/push.
- **Tests:** vitest unit tests for the sync engine core — diffing, loop prevention, mapping lifecycle, hash comparison, cursor expiry — against a mocked Composio client. Provider modules (`lib/providers/google.ts`, `lib/providers/outlook.ts`) isolate all Composio tool slugs/payloads so schema corrections stay local.

## Out of scope (v1)

Booking/scheduling links · webhook/trigger-based instant sync (polling only; Composio triggers are a documented future option) · multi-user instances · recurrence-rule fidelity in clone mode · notifications/emails.

## Known risks

- Composio publishes only natural-language tool descriptions publicly; exact parameter schemas are verified against the Composio dashboard/SDK types during implementation. Isolated in the two provider modules.
- Composio deprecations noted during research: use `connectedAccounts.link()` (not `initiate()`), `GOOGLECALENDAR_EVENTS_LIST` (not `SYNC_EVENTS`), `OUTLOOK_CALENDAR_CREATE_EVENT` (the docs' suggested replacement slug for a deprecated variant does not exist).
- Google Calendar create via Composio uses `start_datetime` + duration fields and may auto-add Meet links — implementation must verify and disable conference auto-add for blockers if the schema allows.
