# Private copies + title prefix — Design

**Date:** 2026-07-09
**Status:** Approved

## What it is

Two additions to sync links:

1. **Private copies** — a per-link "Mark copies as private" checkbox (both modes, default off). Events the link creates are marked private at the provider, so people the target calendar is shared with see them as private/busy slots without details.
2. **Title prefix** — a per-link prefix for clone-mode titles, joining the existing suffix: `prefix + base + suffix`, space-separated, either side optional. Busy mode ignores both (its title is the fixed `busy_title`).

## Data model

Two new `sync_links` columns via schema.sql + guarded `ALTER TABLE` retrofits in `db.ts` (existing pattern):

- `title_prefix TEXT NOT NULL DEFAULT ''`
- `private_copy INTEGER NOT NULL DEFAULT 0`

## Core (`src/lib/sync/core.ts`)

- `SyncLinkConfig` gains `titlePrefix?: string` and `privateCopy?: boolean`.
- `WriteEvent` gains `private?: boolean` — set only when the link opts in.
- `buildWriteEvent`:
  - clone title: `[titlePrefix, base, titleSuffix].filter(Boolean).join(' ')` where `base = src.title || '(No title)'`.
  - busy mode: unchanged (fixed title, no prefix/suffix).
  - both modes: `...(link.privateCopy && { private: true })`.
- `contentHash`: append a `private` marker **only when set** (same approach as `colorId`) so pre-feature mappings keep their hashes — no mass recreate on upgrade. Toggling the checkbox changes hashes, which correctly rewrites that link's events on the next full cycle.

## Providers

- **Google** (`providers/google.ts`): pass `visibility: 'private'` in `GOOGLECALENDAR_CREATE_EVENT` when `event.private`. Verified against the live Composio tool schema (enum includes `private`). No extra API call.
- **Outlook** (`providers/outlook.ts`): `OUTLOOK_OUTLOOK_CALENDAR_CREATE_EVENT` has no sensitivity field (verified), so when `event.private`, after create, best-effort `proxyRequest PATCH https://graph.microsoft.com/v1.0/me/events/{id}` with `{ sensitivity: 'private' }` — mirroring the Google colorId patch pattern: failure is logged, never fails the sync (the event exists; failing here would loop recreates).

## Engine (`src/lib/sync/engine.ts`)

Thread `title_prefix` and `private_copy` through `LINKS_SQL` → `LinkRow` → the link config passed to `planActions`/`buildWriteEvent`. The orphan janitor needs no change: its shape key uses the built title, which includes the prefix on both sides of the comparison.

## UI (`src/app/page.tsx`, `src/app/actions.ts`, `globals.css`)

- **Create form + Edit panel**: a "Title prefix" input beside the suffix field, and a "Mark copies as private" checkbox.
- **Defaults (create form)**: prefix empty; suffix pre-filled with `(copy)` via `defaultValue` — visible to the user and deletable (clearing it means "no suffix"; the action stores whatever was submitted, trimmed). Edit panels show the stored values.
- **Mode-aware greying (no client JS)**: a CSS `:has()` rule keyed on the mode select —
  `form:has(select[name=mode] option[value=busy]:checked)` greys out and disables pointer events on `.clone-only` field wrappers (prefix, suffix), and the inverse greys `.busy-only` (blocker title) in clone mode. Values still submit; the mode simply ignores them (as today).
- **Link rows**: a dim `private` stamp when the flag is on.
- **Actions**: `createSyncLink`/`updateSyncLink` parse `title_prefix` (trimmed) and `private_copy` (checkbox). Editing already clears `sync_state` to force a full rewrite next cycle.

## Error handling

Only the Outlook sensitivity patch introduces a new failure path; it is cosmetic-tier: log and continue (never fail the link). Google visibility rides inside the create call — a failure there is an ordinary create failure, handled by existing per-link error capture.

## Testing

- `core.test.ts`: prefix/suffix join combinations (each side optional, empty-title fallback), `private` present in writes for both modes when set, absent otherwise; hash unchanged for links without the flag (back-compat), changed when flag toggles.
- `google.test.ts`: `visibility: 'private'` passed when set, omitted otherwise.
- `outlook.test.ts`: sensitivity proxy patch fired when set / skipped when not / patch failure still returns the event id.
- `engine.test.ts`: new columns flow into the write (one seeded link with prefix+private).

## Out of scope

Retroactively privatizing/prefixing a link's existing events without saving the link (the rewrite-on-edit mechanism covers it) · per-event overrides · Outlook sensitivity retry queue.
