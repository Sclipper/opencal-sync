# Private Copies + Title Prefix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-link "mark copies as private" flag (both modes) and a clone-mode title prefix joining the existing suffix, with mode-aware greyed-out form fields.

**Architecture:** Two new `sync_links` columns flow through the existing pipeline: schema/db retrofit → `SyncLinkConfig`/`WriteEvent` in sync core → provider create calls (Google: native `visibility` param; Outlook: post-create Graph proxy patch) → engine SQL threading → server-action parsing + form fields. Content hashes append new markers only when set, so pre-feature mappings never mass-recreate.

**Tech Stack:** Next.js 15 server components/actions, better-sqlite3, Composio tools + proxy, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-09-private-copies-title-prefix-design.md`.
- Local Mac (Node 26) cannot build better-sqlite3 — run tests on the NAS in a persistent node:22-alpine container (Task 7 sets it up; matches CI).
- Composio tool slugs/payloads stay inside `src/lib/providers/` only.
- Hash back-compat is a hard requirement: links without the new options must produce byte-identical `contentHash` inputs to today.
- Commit after every task on branch `feat/private-copies-title-prefix`; commit messages end with the Claude Code trailer.

---

### Task 1: Schema + DB retrofit

**Files:**
- Modify: `src/lib/schema.sql` (sync_links block)
- Modify: `src/lib/db.ts:14-21` (guarded ALTER list)
- Test: `src/lib/db.test.ts` (retrofit test)

**Interfaces:**
- Produces: columns `sync_links.title_prefix TEXT NOT NULL DEFAULT ''` and `sync_links.private_copy INTEGER NOT NULL DEFAULT 0` — Tasks 5 and 6 read/write them by these exact names.

- [ ] **Step 1: Extend the retrofit test** — in `db.test.ts`, inside the legacy-db fixture SQL add a pre-feature `sync_links` table, and assert the new columns exist after `createDb(path)`:

```ts
// add to the legacy.exec(...) SQL block:
      CREATE TABLE sync_links (
        id INTEGER PRIMARY KEY,
        source_calendar_id INTEGER NOT NULL,
        target_calendar_id INTEGER NOT NULL,
        mode TEXT NOT NULL DEFAULT 'busy',
        busy_title TEXT NOT NULL DEFAULT 'Busy',
        pair_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        last_error TEXT
      );
// add to the assertions (both legacy and fresh db):
    expect(() => db.prepare('SELECT title_prefix, private_copy FROM sync_links')).not.toThrow()
    expect(() => fresh.prepare('SELECT title_prefix, private_copy FROM sync_links')).not.toThrow()
```

- [ ] **Step 2: Run test, expect FAIL** (`no such column: title_prefix`).

- [ ] **Step 3: Implement** — `schema.sql` sync_links gains (after `title_suffix`):

```sql
  title_prefix TEXT NOT NULL DEFAULT '',
```

and (after `event_color`):

```sql
  private_copy INTEGER NOT NULL DEFAULT 0, -- mark created copies private at the provider
```

`db.ts` ALTER list gains:

```ts
    "ALTER TABLE sync_links ADD COLUMN title_prefix TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE sync_links ADD COLUMN private_copy INTEGER NOT NULL DEFAULT 0',
```

- [ ] **Step 4: Run tests, expect PASS.**
- [ ] **Step 5: Commit** `feat: sync_links columns for title prefix and private copies`

---

### Task 2: Sync core — WriteEvent.private, prefix join, hash markers

**Files:**
- Modify: `src/lib/providers/types.ts` (WriteEvent)
- Modify: `src/lib/sync/core.ts` (SyncLinkConfig, buildWriteEvent, contentHash)
- Test: `src/lib/sync/core.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SyncLinkConfig = { mode; busyTitle; titlePrefix?: string; titleSuffix?: string; eventColor?: string; privateCopy?: boolean }`; `WriteEvent.private?: boolean`. Tasks 3–5 rely on these names.

- [ ] **Step 1: Write failing tests** in `core.test.ts`:

```ts
  it('clone mode prepends the title prefix with a space', () => {
    const link = { ...cloneLink, titlePrefix: '[Work]' }
    expect(buildWriteEvent(event(), link).title).toBe('[Work] Meeting')
    expect(buildWriteEvent(event(), { ...link, titleSuffix: '(copy)' }).title).toBe('[Work] Meeting (copy)')
    expect(buildWriteEvent(event({ title: '' }), link).title).toBe('[Work] (No title)')
  })

  it('busy mode ignores the title prefix', () => {
    expect(buildWriteEvent(event(), { ...busyLink, titlePrefix: '[Work]' }).title).toBe('Busy')
  })

  it('sets private in both modes when the link opts in, omits it otherwise', () => {
    expect(buildWriteEvent(event(), { ...busyLink, privateCopy: true }).private).toBe(true)
    expect(buildWriteEvent(event(), { ...cloneLink, privateCopy: true }).private).toBe(true)
    expect('private' in buildWriteEvent(event(), busyLink)).toBe(false)
    expect('private' in buildWriteEvent(event(), { ...cloneLink, privateCopy: false })).toBe(false)
  })

  it('private changes the hash, but non-private events hash as before the feature existed', () => {
    const plain = buildWriteEvent(event(), busyLink)
    expect(contentHash({ ...plain, private: true })).not.toBe(contentHash(plain))
    expect(contentHash({ ...plain, private: undefined })).toBe(contentHash(plain))
  })
```

- [ ] **Step 2: Run, expect FAIL** (title/private mismatches).

- [ ] **Step 3: Implement** — `types.ts` WriteEvent gains:

```ts
  private?: boolean // mark the copy private at the provider; shared-calendar viewers see no details
```

`core.ts`:

```ts
export type SyncLinkConfig = { mode: 'busy' | 'clone'; busyTitle: string; titlePrefix?: string; titleSuffix?: string; eventColor?: string; privateCopy?: boolean }

export function buildWriteEvent(src: NormalizedEvent, link: SyncLinkConfig): WriteEvent {
  const colorId = link.eventColor || undefined
  const flags = { ...(colorId && { colorId }), ...(link.privateCopy && { private: true }) }
  if (link.mode === 'busy') {
    return { title: link.busyTitle, start: src.start, end: src.end, allDay: src.allDay, ...flags }
  }
  const base = src.title || '(No title)'
  return {
    title: [link.titlePrefix, base, link.titleSuffix].filter(Boolean).join(' '),
    description: src.description || undefined,
    location: src.location || undefined,
    start: src.start,
    end: src.end,
    allDay: src.allDay,
    ...flags,
  }
}

export function contentHash(w: WriteEvent): string {
  // colorId / private appended only when set so pre-feature mappings keep their hashes (no mass recreate on upgrade)
  return createHash('sha256')
    .update(JSON.stringify([w.title, w.description ?? '', w.location ?? '', w.start, w.end, w.allDay, ...(w.colorId ? [w.colorId] : []), ...(w.private ? ['private'] : [])]))
    .digest('hex')
}
```

- [ ] **Step 4: Run tests, expect PASS** (including all pre-existing suffix/color tests unchanged).
- [ ] **Step 5: Commit** `feat: private flag and title prefix in sync core`

---

### Task 3: Google provider — native visibility

**Files:**
- Modify: `src/lib/providers/google.ts` (createEvent args)
- Test: `src/lib/providers/google.test.ts`

**Interfaces:**
- Consumes: `WriteEvent.private` from Task 2.
- Produces: `GOOGLECALENDAR_CREATE_EVENT` gains `visibility: 'private'` when set (schema-verified enum value).

- [ ] **Step 1: Write failing test**:

```ts
  it('passes visibility private when the write is private, omits it otherwise', async () => {
    executeTool.mockResolvedValueOnce({ id: 'ev-p' })
    await googleProvider.createEvent('acc1', 'cal1', {
      title: 'Busy', start: '2026-07-08T10:00:00Z', end: '2026-07-08T11:00:00Z', allDay: false, private: true,
    })
    expect(executeTool).toHaveBeenCalledWith('GOOGLECALENDAR_CREATE_EVENT', 'acc1', expect.objectContaining({ visibility: 'private' }))
  })
```

(Existing createEvent tests assert exact args objects without `visibility` — the conditional spread keeps them green.)

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** — in `createEvent`'s executeTool args add:

```ts
        ...(event.private && { visibility: 'private' }),
```

- [ ] **Step 4: Run tests, expect PASS.**
- [ ] **Step 5: Commit** `feat: google private visibility on created copies`

---

### Task 4: Outlook provider — sensitivity proxy patch

**Files:**
- Modify: `src/lib/providers/outlook.ts` (import proxyRequest; createEvent)
- Test: `src/lib/providers/outlook.test.ts` (mock factory + tests)

**Interfaces:**
- Consumes: `proxyRequest` from `../composio` (existing), `WriteEvent.private`.
- Produces: post-create `PATCH https://graph.microsoft.com/v1.0/me/events/{id}` with `{ sensitivity: 'private' }`, best-effort.

- [ ] **Step 1: Extend the mock factory** (outlook.ts will import proxyRequest, so the vi.mock must provide it) and write failing tests:

```ts
const proxyRequest = vi.fn()
vi.mock('../composio', () => ({
  executeTool: (...args: unknown[]) => executeTool(...args),
  proxyRequest: (...args: unknown[]) => proxyRequest(...args),
}))
// beforeEach adds: proxyRequest.mockReset()

  it('patches sensitivity through the proxy for private writes', async () => {
    executeTool.mockResolvedValueOnce({ id: 'new-p' })
    proxyRequest.mockResolvedValueOnce({})
    const id = await outlookProvider.createEvent('acc1', 'cal1', {
      title: 'Busy', start: '2026-07-08T10:00:00Z', end: '2026-07-08T11:00:00Z', allDay: false, private: true,
    })
    expect(id).toBe('new-p')
    expect(proxyRequest).toHaveBeenCalledWith('acc1', 'PATCH', 'https://graph.microsoft.com/v1.0/me/events/new-p', { sensitivity: 'private' })
  })

  it('skips the proxy entirely for non-private writes', async () => {
    executeTool.mockResolvedValueOnce({ id: 'new-np' })
    await outlookProvider.createEvent('acc1', 'cal1', { title: 'Busy', start: '2026-07-08T10:00:00Z', end: '2026-07-08T11:00:00Z', allDay: false })
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('still returns the event id when the sensitivity patch fails', async () => {
    executeTool.mockResolvedValueOnce({ id: 'new-f' })
    proxyRequest.mockRejectedValueOnce(new Error('proxy down'))
    await expect(
      outlookProvider.createEvent('acc1', 'cal1', { title: 'Busy', start: '2026-07-08T10:00:00Z', end: '2026-07-08T11:00:00Z', allDay: false, private: true }),
    ).resolves.toBe('new-f')
  })
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** — `outlook.ts` imports `{ executeTool, proxyRequest }`; in `createEvent` after the id guard:

```ts
    if (event.private) {
      // The create tool has no sensitivity field, so patch it via the raw Graph proxy after create.
      // ponytail: privacy patch failure is cosmetic-tier — never fail the sync (the event exists; failing here would loop recreates)
      try {
        await proxyRequest(accountId, 'PATCH', `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(String(id))}`, { sensitivity: 'private' })
      } catch (e) {
        console.error('event sensitivity patch failed:', e instanceof Error ? e.message : e)
      }
    }
```

- [ ] **Step 4: Run tests, expect PASS.**
- [ ] **Step 5: Commit** `feat: outlook private sensitivity via graph proxy`

---

### Task 5: Engine threading

**Files:**
- Modify: `src/lib/sync/engine.ts` (LinkRow, LINKS_SQL, cfg)
- Test: `src/lib/sync/engine.test.ts`

**Interfaces:**
- Consumes: columns from Task 1, `SyncLinkConfig` fields from Task 2.
- Produces: engine builds cfg `{ mode, busyTitle, titlePrefix, titleSuffix, eventColor, privateCopy }` from link rows.

- [ ] **Step 1: Write failing test**:

```ts
  it('threads title prefix and private flag from the link row into writes', async () => {
    db.prepare("UPDATE sync_links SET mode = 'clone', title_prefix = '[W]', title_suffix = '(copy)', private_copy = 1 WHERE id = 1").run()
    const g = makeFakeProvider({ changes: () => ({ events: [ev('e1')], nextCursor: 'c' }) })
    const o = makeFakeProvider({})

    await runSyncCycle(deps(g.provider, o.provider))

    const write = o.calls[0].args[0] as { title: string; private?: boolean }
    expect(write.title).toBe('[W] Meeting (copy)')
    expect(write.private).toBe(true)
  })
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** — `LinkRow` gains `title_prefix: string` and `private_copy: number`; `LINKS_SQL` SELECT gains `l.title_prefix, l.private_copy`; cfg becomes:

```ts
        const cfg = { mode: link.mode, busyTitle: link.busy_title, titlePrefix: link.title_prefix || undefined, titleSuffix: link.title_suffix || undefined, eventColor: link.event_color || undefined, privateCopy: Boolean(link.private_copy) }
```

- [ ] **Step 4: Run tests, expect PASS.**
- [ ] **Step 5: Commit** `feat: engine threads prefix and private flag`

---

### Task 6: UI + actions + mode-aware greying

**Files:**
- Modify: `src/app/actions.ts` (createSyncLink, updateSyncLink)
- Modify: `src/app/page.tsx` (LinkRow type, queries, create form, edit panel, row stamp)
- Modify: `src/app/globals.css` (mode-aware rule)

**Interfaces:**
- Consumes: columns from Task 1.
- Produces: form fields `title_prefix` (text), `private_copy` (checkbox); create-form suffix `defaultValue="(copy)"`.

- [ ] **Step 1: actions.ts** — both `createSyncLink` and `updateSyncLink` parse and persist:

```ts
  const titlePrefix = String(formData.get('title_prefix') ?? '').trim()
  const privateCopy = formData.get('private_copy') === 'on' ? 1 : 0
```

INSERT: `'INSERT INTO sync_links (source_calendar_id, target_calendar_id, mode, busy_title, title_prefix, title_suffix, event_color, private_copy, pair_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'` with matching run args (both the one-way and paired insert).
UPDATE: `'UPDATE sync_links SET mode = ?, busy_title = ?, title_prefix = ?, title_suffix = ?, event_color = ?, private_copy = ? WHERE id = ?'`.

- [ ] **Step 2: page.tsx** — `LinkRow` gains `title_prefix: string; private_copy: number`; both link queries select them. Create form: wrap the blocker-title label in `<div className="busy-only">`, add prefix + suffix labels inside `<div className="clone-only">` wrappers, suffix input gets `defaultValue="(copy)"` (placeholder removed), add below the color block:

```tsx
<label className="flex items-center gap-2 text-sm">
  <input type="checkbox" name="private_copy" className="check" /> Mark copies as private — viewers of shared calendars see no details
</label>
```

Edit panel: same wrappers/fields with `defaultValue={l.title_prefix}` / `defaultValue={l.title_suffix}` / `defaultChecked={l.private_copy === 1}`. Row display: prefix shown before target name alongside existing suffix; add `{l.private_copy === 1 && <span className="stamp stamp-dim">private</span>}` next to the mode stamp.

- [ ] **Step 3: globals.css** — after the form section:

```css
/* mode-dependent fields grey out live via :has() on the mode select — keeps forms zero-JS */
form:has(select[name='mode'] option[value='busy']:checked) .clone-only,
form:has(select[name='mode'] option[value='clone']:checked) .busy-only {
  opacity: 0.35;
  pointer-events: none;
  transition: opacity 0.15s;
}
```

- [ ] **Step 4: Typecheck** (`npx tsc --noEmit` in the NAS test container) — expect clean.
- [ ] **Step 5: Commit** `feat: link form fields for prefix and private copies with mode-aware greying`

---

### Task 7: Full verification + NAS deploy

**Files:** none new (operational).

- [ ] **Step 1: Persistent test container on NAS** (once):

```bash
ssh nas 'sudo -n /usr/local/bin/docker run -d --name opencal-test -v /volume1/docker/opencal-sync:/w -w /w node:22-alpine sleep infinity && sudo -n /usr/local/bin/docker exec opencal-test npm ci --silent'
```

- [ ] **Step 2: Sync changed files to NAS** (`scp -O` the modified src/app/docs files into `/volume1/docker/opencal-sync/...`).
- [ ] **Step 3: Run suite**: `docker exec opencal-test npx vitest run` and `docker exec opencal-test npx tsc --noEmit` — expect all green. Fix and repeat if not.
- [ ] **Step 4: Rebuild + restart app**: `cd /volume1/docker/opencal-sync && sudo -n /usr/local/bin/docker compose up -d --build`; verify `docker ps` Up, logs show Ready, `curl http://192.168.1.30:3000/login` → 200.
- [ ] **Step 5: Cleanup**: `docker rm -f opencal-test`. Final commit of any stragglers; report to user for UI verification.
