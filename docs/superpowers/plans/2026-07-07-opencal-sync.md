# opencal-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Self-hosted open-source calendar sync app (OneCal alternative): syncs events between Google/Outlook calendars via Composio, plus a public availability page. Single Next.js app, SQLite, one Docker container.

**Architecture:** Next.js App Router serves UI + server actions; an in-process scheduler (started via `instrumentation.ts`) polls calendars every N minutes using Composio tool execution with incremental cursors (Google syncToken / Outlook delta). SQLite `event_mappings` table provides loop prevention and idempotency. All Composio tool slugs/payloads are isolated in two provider modules.

**Tech Stack:** Next.js 15 (TypeScript, App Router), Tailwind CSS v4, better-sqlite3 (plain SQL), `@composio/core`, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-07-calendar-sync-design.md`. Read it before starting any task.
- Required env vars exactly: `COMPOSIO_API_KEY`, `ADMIN_PASSWORD`, `BASE_URL`. Optional: `DATA_DIR` (default `./data`).
- Single-user instance: all Composio calls use `userId = 'default'`.
- **All imports are relative** (no `@/` path alias) so vitest needs no path plugin.
- No ORM, no auth library, no date library — plain SQL, Node `crypto`, native `Intl`.
- Updates to synced events are implemented as **delete + recreate** (no provider update method) — this avoids unverified PATCH tool schemas.
- Never copy attendees to synced events (avoids re-inviting people).
- Composio tool payloads are best-known from docs research (2026-07-07); exact field names are verifiable at runtime with `scripts/dump-tool-schema.ts` (Task 4). Keep every slug/payload inside `src/lib/providers/{google,outlook}.ts` only.
- Commit after every task. Run `npx vitest run` and `npx tsc --noEmit` before every commit.
- License: MIT. Repo will be public — never commit real keys; only `.env.example`.

---

### Task 1: Scaffold Next.js app

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `vitest.config.ts`, `.gitignore`, `.env.example`, `src/app/layout.tsx`, `src/app/globals.css`, `src/app/page.tsx`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a building Next.js skeleton; `npm run build`, `npx vitest run`, `npx tsc --noEmit` all pass. Later tasks replace `src/app/page.tsx`.

- [ ] **Step 1: Write config files**

`package.json`:
```json
{
  "name": "opencal-sync",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@composio/core": "^0.13.1",
    "better-sqlite3": "^11.10.0",
    "next": "^15.3.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.1.0",
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.15.0",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "tailwindcss": "^4.1.0",
    "tsx": "^4.19.0",
    "typescript": "^5.8.0",
    "vitest": "^3.1.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`next.config.ts`:
```ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['better-sqlite3'],
}

export default nextConfig
```

`postcss.config.mjs`:
```js
export default { plugins: { '@tailwindcss/postcss': {} } }
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
})
```

`.gitignore`:
```
node_modules/
.next/
data/
*.db
*.db-*
.env
.env.local
tsconfig.tsbuildinfo
next-env.d.ts
```

`.env.example`:
```
# Composio API key — https://app.composio.dev (free tier: 20k tool calls/month)
COMPOSIO_API_KEY=

# Password for the web UI (single user)
ADMIN_PASSWORD=

# Public base URL of this instance (used for OAuth callback redirects)
BASE_URL=http://localhost:3000

# Where the SQLite database lives (default: ./data)
# DATA_DIR=./data
```

- [ ] **Step 2: Write app shell**

`src/app/globals.css`:
```css
@import 'tailwindcss';
```

`src/app/layout.tsx`:
```tsx
import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'opencal-sync',
  description: 'Self-hosted calendar sync',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-50 text-zinc-900">{children}</body>
    </html>
  )
}
```

`src/app/page.tsx` (placeholder, replaced in Task 11):
```tsx
export default function Home() {
  return <main className="p-8">opencal-sync</main>
}
```

- [ ] **Step 3: Install and verify**

Run: `npm install`
Run: `npm run build` — Expected: build succeeds.
Run: `npx vitest run` — Expected: "No test files found" pass (passWithNoTests).
Run: `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: scaffold Next.js app"
```

---

### Task 2: Database layer

**Files:**
- Create: `src/lib/schema.sql`, `src/lib/db.ts`, `src/lib/settings.ts`
- Test: `src/lib/db.test.ts`

**Interfaces:**
- Produces:
  - `createDb(path?: string): DB` — opens SQLite (default `:memory:`), applies schema idempotently. `DB` = `Database.Database` from better-sqlite3.
  - `getDb(): DB` — process-wide singleton at `${DATA_DIR|./data}/opencal.db`.
  - `getSetting(db: DB, key: string, fallback: string): string`
  - `setSetting(db: DB, key: string, value: string): void`
  - Settings keys used app-wide: `poll_interval_minutes` (default `'5'`), `sync_window_days` (`'60'`), `default_busy_title` (`'Busy'`), `google_auth_config_id` (`''`), `outlook_auth_config_id` (`''`).

- [ ] **Step 1: Write the failing test**

`src/lib/db.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { createDb } from './db'
import { getSetting, setSetting } from './settings'

describe('db', () => {
  it('applies schema and round-trips a connection row', () => {
    const db = createDb()
    db.prepare("INSERT INTO connections (provider, status) VALUES ('google', 'active')").run()
    const row = db.prepare('SELECT provider, status FROM connections').get() as { provider: string; status: string }
    expect(row).toEqual({ provider: 'google', status: 'active' })
  })

  it('is idempotent — schema can be applied twice', () => {
    const db = createDb()
    expect(() => createDb()).not.toThrow()
    db.close()
  })

  it('cascades calendar + mapping deletes from connections', () => {
    const db = createDb()
    db.prepare("INSERT INTO connections (provider, status) VALUES ('google', 'active')").run()
    db.prepare("INSERT INTO calendars (connection_id, provider_calendar_id, name) VALUES (1, 'cal1', 'Work')").run()
    db.prepare('DELETE FROM connections WHERE id = 1').run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM calendars').get()).toEqual({ n: 0 })
  })
})

describe('settings', () => {
  it('returns fallback when unset, then persisted value', () => {
    const db = createDb()
    expect(getSetting(db, 'poll_interval_minutes', '5')).toBe('5')
    setSetting(db, 'poll_interval_minutes', '10')
    expect(getSetting(db, 'poll_interval_minutes', '5')).toBe('10')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/db.test.ts`
Expected: FAIL — cannot find module './db'.

- [ ] **Step 3: Write schema and implementation**

`src/lib/schema.sql`:
```sql
CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'outlook')),
  composio_request_id TEXT,
  composio_connected_account_id TEXT,
  account_label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | active | error
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calendars (
  id INTEGER PRIMARY KEY,
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  provider_calendar_id TEXT NOT NULL,
  name TEXT NOT NULL,
  UNIQUE (connection_id, provider_calendar_id)
);

CREATE TABLE IF NOT EXISTS sync_links (
  id INTEGER PRIMARY KEY,
  source_calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  target_calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'busy' CHECK (mode IN ('busy', 'clone')),
  busy_title TEXT NOT NULL DEFAULT 'Busy',
  pair_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS event_mappings (
  id INTEGER PRIMARY KEY,
  sync_link_id INTEGER NOT NULL REFERENCES sync_links(id) ON DELETE CASCADE,
  source_event_id TEXT NOT NULL,
  target_event_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (sync_link_id, source_event_id)
);

CREATE TABLE IF NOT EXISTS sync_state (
  calendar_id INTEGER PRIMARY KEY REFERENCES calendars(id) ON DELETE CASCADE,
  sync_cursor TEXT,
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS availability_pages (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  calendar_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array of calendars.id
  working_hours TEXT NOT NULL DEFAULT '{}',  -- JSON: {"days":["mon",...],"start":"09:00","end":"17:00"}
  timezone TEXT NOT NULL DEFAULT 'UTC',
  days_ahead INTEGER NOT NULL DEFAULT 14,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  events_processed INTEGER NOT NULL DEFAULT 0,
  errors TEXT
);
```

`src/lib/db.ts`:
```ts
import Database from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type DB = Database.Database

export function createDb(path = ':memory:'): DB {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(readFileSync(join(process.cwd(), 'src/lib/schema.sql'), 'utf8'))
  return db
}

declare global {
  // eslint-disable-next-line no-var
  var __opencalDb: DB | undefined
}

export function getDb(): DB {
  if (!globalThis.__opencalDb) {
    const dir = process.env.DATA_DIR ?? join(process.cwd(), 'data')
    mkdirSync(dir, { recursive: true })
    globalThis.__opencalDb = createDb(join(dir, 'opencal.db'))
  }
  return globalThis.__opencalDb
}
```

`src/lib/settings.ts`:
```ts
import type { DB } from './db'

export function getSetting(db: DB, key: string, fallback: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? fallback
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/db.test.ts` — Expected: PASS (4 tests).
Run: `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schema.sql src/lib/db.ts src/lib/settings.ts src/lib/db.test.ts
git commit -m "feat: sqlite schema and db layer"
```

---

### Task 3: Auth (password login, signed session cookie)

**Files:**
- Create: `src/lib/session.ts`, `src/lib/auth.ts`, `src/app/login/page.tsx`
- Test: `src/lib/session.test.ts`

**Interfaces:**
- Produces:
  - `createToken(ttlMs?: number, now?: number): string` — `"<expiryMs>.<hmacHex>"`.
  - `verifyToken(token: string, now?: number): boolean`
  - `checkPassword(input: string): boolean` — constant-time compare vs `ADMIN_PASSWORD`.
  - `requireAuth(): Promise<void>` (in `src/lib/auth.ts`) — reads `session` cookie, redirects to `/login` if invalid. **Every protected page and server action calls this first.**
  - `SESSION_COOKIE = 'session'`.

- [ ] **Step 1: Write the failing test**

`src/lib/session.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { checkPassword, createToken, verifyToken } from './session'

describe('session', () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = 'hunter2'
  })

  it('round-trips a valid token', () => {
    expect(verifyToken(createToken())).toBe(true)
  })

  it('rejects expired tokens', () => {
    const token = createToken(1000, Date.now() - 5000)
    expect(verifyToken(token)).toBe(false)
  })

  it('rejects tampered tokens', () => {
    const [exp] = createToken().split('.')
    expect(verifyToken(`${exp}.deadbeef`)).toBe(false)
    expect(verifyToken('garbage')).toBe(false)
  })

  it('tokens become invalid when password changes', () => {
    const token = createToken()
    process.env.ADMIN_PASSWORD = 'other'
    expect(verifyToken(token)).toBe(false)
  })

  it('checks password in constant time', () => {
    expect(checkPassword('hunter2')).toBe(true)
    expect(checkPassword('wrong')).toBe(false)
    expect(checkPassword('')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/session.test.ts`
Expected: FAIL — cannot find module './session'.

- [ ] **Step 3: Write implementation**

`src/lib/session.ts`:
```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'session'

function secret(): Buffer {
  return createHmac('sha256', 'opencal-sync-session-v1').update(process.env.ADMIN_PASSWORD ?? '').digest()
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('hex')
}

export function createToken(ttlMs = 30 * 86_400_000, now = Date.now()): string {
  const exp = String(now + ttlMs)
  return `${exp}.${sign(exp)}`
}

export function verifyToken(token: string, now = Date.now()): boolean {
  const [exp, sig] = token.split('.')
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < now) return false
  const expected = sign(exp)
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
}

export function checkPassword(input: string): boolean {
  if (!process.env.ADMIN_PASSWORD) return false
  const a = createHmac('sha256', 'opencal-pw').update(input).digest()
  const b = createHmac('sha256', 'opencal-pw').update(process.env.ADMIN_PASSWORD).digest()
  return timingSafeEqual(a, b)
}
```

`src/lib/auth.ts`:
```ts
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { SESSION_COOKIE, verifyToken } from './session'

export async function requireAuth(): Promise<void> {
  const store = await cookies()
  const token = store.get(SESSION_COOKIE)?.value
  if (!token || !verifyToken(token)) redirect('/login')
}
```

`src/app/login/page.tsx`:
```tsx
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { checkPassword, createToken, SESSION_COOKIE } from '../../lib/session'

async function login(formData: FormData) {
  'use server'
  const password = String(formData.get('password') ?? '')
  if (!checkPassword(password)) redirect('/login?error=1')
  const store = await cookies()
  store.set(SESSION_COOKIE, createToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: (process.env.BASE_URL ?? '').startsWith('https'),
    maxAge: 30 * 86_400,
    path: '/',
  })
  redirect('/')
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams
  return (
    <main className="mx-auto mt-24 max-w-sm rounded-lg border border-zinc-200 bg-white p-8">
      <h1 className="mb-4 text-xl font-semibold">opencal-sync</h1>
      {error && <p className="mb-3 text-sm text-red-600">Wrong password.</p>}
      <form action={login} className="space-y-3">
        <input
          type="password"
          name="password"
          placeholder="Admin password"
          required
          className="w-full rounded border border-zinc-300 px-3 py-2"
        />
        <button className="w-full rounded bg-zinc-900 px-3 py-2 text-white">Log in</button>
      </form>
    </main>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/session.test.ts` — Expected: PASS (5 tests).
Run: `npx tsc --noEmit` and `npm run build` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/session.ts src/lib/session.test.ts src/lib/auth.ts src/app/login/page.tsx
git commit -m "feat: password auth with signed session cookie"
```

---

### Task 4: Composio wrapper + provider types + schema dump script

**Files:**
- Create: `src/lib/composio.ts`, `src/lib/providers/types.ts`, `scripts/dump-tool-schema.ts`
- Test: `src/lib/composio.test.ts`

**Interfaces:**
- Produces:
  - `USER_ID = 'default'`
  - `getComposio(): Composio` — lazy singleton from `COMPOSIO_API_KEY`.
  - `executeTool(slug: string, connectedAccountId: string, args: Record<string, unknown>): Promise<unknown>` — throws classified errors.
  - Error classes: `RateLimitError`, `CursorExpiredError`, `NotFoundError` (all extend `Error`); `classifyError(message: string): Error`.
  - Types (in `providers/types.ts`): `NormalizedEvent`, `WriteEvent`, `Changes`, `CalendarProvider` — exact shapes below; Tasks 5–8, 14 depend on them verbatim.

- [ ] **Step 1: Write the failing test**

`src/lib/composio.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { classifyError, CursorExpiredError, NotFoundError, RateLimitError } from './composio'

describe('classifyError', () => {
  it('classifies rate limits', () => {
    expect(classifyError('Rate limit exceeded')).toBeInstanceOf(RateLimitError)
    expect(classifyError('HTTP 429 Too Many Requests')).toBeInstanceOf(RateLimitError)
    expect(classifyError('userRateLimitExceeded')).toBeInstanceOf(RateLimitError)
  })

  it('classifies expired sync cursors', () => {
    expect(classifyError('Sync token is no longer valid, a full sync is required')).toBeInstanceOf(CursorExpiredError)
    expect(classifyError('HTTP 410 Gone')).toBeInstanceOf(CursorExpiredError)
    expect(classifyError('The delta token has expired')).toBeInstanceOf(CursorExpiredError)
  })

  it('classifies not-found', () => {
    expect(classifyError('Event not found')).toBeInstanceOf(NotFoundError)
    expect(classifyError('HTTP 404')).toBeInstanceOf(NotFoundError)
  })

  it('falls back to plain Error', () => {
    const err = classifyError('something else')
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(RateLimitError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/composio.test.ts`
Expected: FAIL — cannot find module './composio'.

- [ ] **Step 3: Write implementation**

`src/lib/composio.ts`:
```ts
import { Composio } from '@composio/core'

export const USER_ID = 'default'

let client: Composio | undefined
export function getComposio(): Composio {
  if (!client) {
    const apiKey = process.env.COMPOSIO_API_KEY
    if (!apiKey) throw new Error('COMPOSIO_API_KEY is not set')
    client = new Composio({ apiKey })
  }
  return client
}

export class RateLimitError extends Error {}
export class CursorExpiredError extends Error {}
export class NotFoundError extends Error {}

export function classifyError(message: string): Error {
  if (/rate ?limit|too many requests|\b429\b/i.test(message)) return new RateLimitError(message)
  if (/\b410\b|\bgone\b|sync ?token|delta ?token|full ?sync/i.test(message)) return new CursorExpiredError(message)
  if (/\b404\b|not ?found/i.test(message)) return new NotFoundError(message)
  return new Error(message)
}

export async function executeTool(
  slug: string,
  connectedAccountId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await getComposio().tools.execute(slug, {
    userId: USER_ID,
    connectedAccountId,
    arguments: args,
  })
  if (!res.successful) throw classifyError(String(res.error ?? `Tool ${slug} failed`))
  return res.data
}
```

`src/lib/providers/types.ts`:
```ts
export type NormalizedEvent = {
  id: string
  status: 'active' | 'cancelled'
  title: string
  description: string
  location: string
  start: string // ISO datetime with offset, or YYYY-MM-DD when allDay
  end: string
  allDay: boolean
  transparent: boolean // marked "Free" — never creates blockers
}

export type WriteEvent = {
  title: string
  description?: string
  location?: string
  start: string
  end: string
  allDay: boolean
}

export type Changes = { events: NormalizedEvent[]; nextCursor: string | null }

export interface CalendarProvider {
  listCalendars(accountId: string): Promise<{ id: string; name: string }[]>
  listChanges(
    accountId: string,
    calendarId: string,
    cursor: string | null,
    windowStart: string,
    windowEnd: string,
  ): Promise<Changes>
  listEvents(accountId: string, calendarId: string, timeMin: string, timeMax: string): Promise<NormalizedEvent[]>
  createEvent(accountId: string, calendarId: string, event: WriteEvent): Promise<string>
  deleteEvent(accountId: string, calendarId: string, eventId: string): Promise<void>
}
```

`scripts/dump-tool-schema.ts` (self-hosters/devs run this with a real key to verify Composio field names against the code):
```ts
// Usage: COMPOSIO_API_KEY=... npx tsx scripts/dump-tool-schema.ts GOOGLECALENDAR_CREATE_EVENT
const slug = process.argv[2]
if (!slug || !process.env.COMPOSIO_API_KEY) {
  console.error('Usage: COMPOSIO_API_KEY=... npx tsx scripts/dump-tool-schema.ts <TOOL_SLUG>')
  process.exit(1)
}

const res = await fetch(`https://backend.composio.dev/api/v3/tools/${slug}`, {
  headers: { 'x-api-key': process.env.COMPOSIO_API_KEY },
})
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${await res.text()}`)
  process.exit(1)
}
const tool = await res.json()
console.log(JSON.stringify(tool.input_parameters ?? tool, null, 2))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/composio.test.ts` — Expected: PASS (4 tests).
Run: `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/composio.ts src/lib/composio.test.ts src/lib/providers/types.ts scripts/dump-tool-schema.ts
git commit -m "feat: composio wrapper, provider types, schema dump script"
```

---

### Task 5: Google Calendar provider

**Files:**
- Create: `src/lib/providers/google.ts`
- Test: `src/lib/providers/google.test.ts`

**Interfaces:**
- Consumes: `executeTool` from `../composio`, types from `./types`.
- Produces: `googleProvider: CalendarProvider` (a plain object export).
- Composio slugs used (keep ONLY in this file): `GOOGLECALENDAR_LIST_CALENDARS`, `GOOGLECALENDAR_EVENTS_LIST`, `GOOGLECALENDAR_CREATE_EVENT`, `GOOGLECALENDAR_DELETE_EVENT`.

- [ ] **Step 1: Write the failing test**

`src/lib/providers/google.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const executeTool = vi.fn()
vi.mock('../composio', () => ({
  executeTool: (...args: unknown[]) => executeTool(...args),
}))

const { googleProvider } = await import('./google')

beforeEach(() => executeTool.mockReset())

describe('googleProvider.listChanges', () => {
  it('does a full windowed fetch when cursor is null and maps events', async () => {
    executeTool.mockResolvedValueOnce({
      items: [
        {
          id: 'ev1',
          status: 'confirmed',
          summary: 'Standup',
          description: 'daily',
          location: 'Zoom',
          start: { dateTime: '2026-07-08T10:00:00+03:00' },
          end: { dateTime: '2026-07-08T10:30:00+03:00' },
        },
        { id: 'ev2', status: 'cancelled' },
        {
          id: 'ev3',
          status: 'confirmed',
          summary: 'OOO',
          transparency: 'transparent',
          start: { date: '2026-07-09' },
          end: { date: '2026-07-10' },
        },
      ],
      nextSyncToken: 'tok-1',
    })

    const res = await googleProvider.listChanges('acc1', 'cal1', null, '2026-07-07T00:00:00Z', '2026-09-05T00:00:00Z')

    expect(executeTool).toHaveBeenCalledWith('GOOGLECALENDAR_EVENTS_LIST', 'acc1', {
      calendarId: 'cal1',
      timeMin: '2026-07-07T00:00:00Z',
      timeMax: '2026-09-05T00:00:00Z',
      singleEvents: true,
      showDeleted: true,
      maxResults: 250,
      pageToken: undefined,
    })
    expect(res.nextCursor).toBe('tok-1')
    expect(res.events).toEqual([
      {
        id: 'ev1', status: 'active', title: 'Standup', description: 'daily', location: 'Zoom',
        start: '2026-07-08T10:00:00+03:00', end: '2026-07-08T10:30:00+03:00', allDay: false, transparent: false,
      },
      { id: 'ev2', status: 'cancelled', title: '', description: '', location: '', start: '', end: '', allDay: false, transparent: false },
      {
        id: 'ev3', status: 'active', title: 'OOO', description: '', location: '',
        start: '2026-07-09', end: '2026-07-10', allDay: true, transparent: true,
      },
    ])
  })

  it('uses syncToken when cursor exists and follows pagination', async () => {
    executeTool
      .mockResolvedValueOnce({ items: [{ id: 'a', status: 'confirmed', start: { dateTime: 'x' }, end: { dateTime: 'y' } }], nextPageToken: 'p2' })
      .mockResolvedValueOnce({ items: [], nextSyncToken: 'tok-2' })

    const res = await googleProvider.listChanges('acc1', 'cal1', 'tok-1', 'ws', 'we')

    expect(executeTool).toHaveBeenNthCalledWith(1, 'GOOGLECALENDAR_EVENTS_LIST', 'acc1', {
      calendarId: 'cal1', syncToken: 'tok-1', pageToken: undefined,
    })
    expect(executeTool).toHaveBeenNthCalledWith(2, 'GOOGLECALENDAR_EVENTS_LIST', 'acc1', {
      calendarId: 'cal1', syncToken: 'tok-1', pageToken: 'p2',
    })
    expect(res.events).toHaveLength(1)
    expect(res.nextCursor).toBe('tok-2')
  })

  it('unwraps response_data envelopes', async () => {
    executeTool.mockResolvedValueOnce({ response_data: { items: [], nextSyncToken: 't' } })
    const res = await googleProvider.listChanges('acc1', 'cal1', null, 'ws', 'we')
    expect(res).toEqual({ events: [], nextCursor: 't' })
  })
})

describe('googleProvider.createEvent', () => {
  it('creates a timed event with computed duration and returns its id', async () => {
    executeTool.mockResolvedValueOnce({ response_data: { id: 'new-ev' } })
    const id = await googleProvider.createEvent('acc1', 'cal1', {
      title: 'Busy', start: '2026-07-08T10:00:00+03:00', end: '2026-07-08T11:30:00+03:00', allDay: false,
    })
    expect(id).toBe('new-ev')
    expect(executeTool).toHaveBeenCalledWith('GOOGLECALENDAR_CREATE_EVENT', 'acc1', {
      calendar_id: 'cal1',
      summary: 'Busy',
      description: undefined,
      location: undefined,
      start_datetime: '2026-07-08T07:00:00.000Z',
      event_duration_hour: 1,
      event_duration_minutes: 30,
      timezone: 'UTC',
    })
  })

  it('creates all-day blockers as 24h timed events', async () => {
    // ponytail: Composio create tool has no confirmed all-day support; 24h timed blocker is equivalent for busy purposes
    executeTool.mockResolvedValueOnce({ id: 'new-ev2' })
    await googleProvider.createEvent('acc1', 'cal1', { title: 'Busy', start: '2026-07-09', end: '2026-07-10', allDay: true })
    expect(executeTool).toHaveBeenCalledWith('GOOGLECALENDAR_CREATE_EVENT', 'acc1', {
      calendar_id: 'cal1',
      summary: 'Busy',
      description: undefined,
      location: undefined,
      start_datetime: '2026-07-09T00:00:00.000Z',
      event_duration_hour: 24,
      event_duration_minutes: 0,
      timezone: 'UTC',
    })
  })
})

describe('googleProvider.deleteEvent / listCalendars / listEvents', () => {
  it('deletes by calendar and event id', async () => {
    executeTool.mockResolvedValueOnce({})
    await googleProvider.deleteEvent('acc1', 'cal1', 'ev9')
    expect(executeTool).toHaveBeenCalledWith('GOOGLECALENDAR_DELETE_EVENT', 'acc1', { calendar_id: 'cal1', event_id: 'ev9' })
  })

  it('lists calendars', async () => {
    executeTool.mockResolvedValueOnce({ items: [{ id: 'c1', summary: 'Work' }] })
    expect(await googleProvider.listCalendars('acc1')).toEqual([{ id: 'c1', name: 'Work' }])
    expect(executeTool).toHaveBeenCalledWith('GOOGLECALENDAR_LIST_CALENDARS', 'acc1', {})
  })

  it('lists events for a time range', async () => {
    executeTool.mockResolvedValueOnce({ items: [] })
    await googleProvider.listEvents('acc1', 'cal1', 't1', 't2')
    expect(executeTool).toHaveBeenCalledWith('GOOGLECALENDAR_EVENTS_LIST', 'acc1', {
      calendarId: 'cal1', timeMin: 't1', timeMax: 't2', singleEvents: true, showDeleted: false, maxResults: 250, pageToken: undefined,
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/providers/google.test.ts`
Expected: FAIL — cannot find module './google'.

- [ ] **Step 3: Write implementation**

`src/lib/providers/google.ts`:
```ts
import { executeTool } from '../composio'
import type { CalendarProvider, Changes, NormalizedEvent, WriteEvent } from './types'

// Composio wraps some tool outputs in { response_data: ... }; tolerate both.
function unwrap(data: unknown): Record<string, any> {
  const d = data as Record<string, any>
  return (d?.response_data ?? d ?? {}) as Record<string, any>
}

function mapEvent(raw: Record<string, any>): NormalizedEvent {
  return {
    id: String(raw.id),
    status: raw.status === 'cancelled' ? 'cancelled' : 'active',
    title: raw.summary ?? '',
    description: raw.description ?? '',
    location: raw.location ?? '',
    start: raw.start?.dateTime ?? raw.start?.date ?? '',
    end: raw.end?.dateTime ?? raw.end?.date ?? '',
    allDay: Boolean(raw.start?.date),
    transparent: raw.transparency === 'transparent',
  }
}

// For all-day WriteEvents (YYYY-MM-DD), treat the date as UTC midnight.
// ponytail: all-day blockers are written as 24h timed events; Composio's create tool has no confirmed all-day support.
function toUtcIso(value: string): string {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value).toISOString()
}

async function listRange(
  accountId: string,
  calendarId: string,
  cursor: string | null,
  timeMin: string,
  timeMax: string,
  showDeleted: boolean,
): Promise<Changes> {
  const events: NormalizedEvent[] = []
  let pageToken: string | undefined
  let nextCursor: string | null = cursor
  do {
    const args: Record<string, unknown> = cursor
      ? { calendarId, syncToken: cursor, pageToken }
      : { calendarId, timeMin, timeMax, singleEvents: true, showDeleted, maxResults: 250, pageToken }
    const payload = unwrap(await executeTool('GOOGLECALENDAR_EVENTS_LIST', accountId, args))
    for (const item of payload.items ?? []) events.push(mapEvent(item))
    pageToken = payload.nextPageToken ?? undefined
    if (payload.nextSyncToken) nextCursor = payload.nextSyncToken
  } while (pageToken)
  return { events, nextCursor }
}

export const googleProvider: CalendarProvider = {
  async listCalendars(accountId) {
    const payload = unwrap(await executeTool('GOOGLECALENDAR_LIST_CALENDARS', accountId, {}))
    return (payload.items ?? []).map((c: Record<string, any>) => ({ id: String(c.id), name: c.summary ?? String(c.id) }))
  },

  listChanges(accountId, calendarId, cursor, windowStart, windowEnd) {
    return listRange(accountId, calendarId, cursor, windowStart, windowEnd, true)
  },

  async listEvents(accountId, calendarId, timeMin, timeMax) {
    const { events } = await listRange(accountId, calendarId, null, timeMin, timeMax, false)
    return events
  },

  async createEvent(accountId, calendarId, event: WriteEvent) {
    const startIso = toUtcIso(event.start)
    const minutes = Math.max(1, Math.round((Date.parse(toUtcIso(event.end)) - Date.parse(startIso)) / 60_000))
    const payload = unwrap(
      await executeTool('GOOGLECALENDAR_CREATE_EVENT', accountId, {
        calendar_id: calendarId,
        summary: event.title,
        description: event.description,
        location: event.location,
        start_datetime: startIso,
        event_duration_hour: Math.floor(minutes / 60),
        event_duration_minutes: minutes % 60,
        timezone: 'UTC',
      }),
    )
    return String(payload.id)
  },

  async deleteEvent(accountId, calendarId, eventId) {
    await executeTool('GOOGLECALENDAR_DELETE_EVENT', accountId, { calendar_id: calendarId, event_id: eventId })
  },
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/providers/google.test.ts` — Expected: PASS (8 tests).
Run: `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/providers/google.ts src/lib/providers/google.test.ts
git commit -m "feat: google calendar provider via composio"
```

---

### Task 6: Outlook provider

**Files:**
- Create: `src/lib/providers/outlook.ts`
- Test: `src/lib/providers/outlook.test.ts`

**Interfaces:**
- Consumes: `executeTool` from `../composio`, types from `./types`.
- Produces: `outlookProvider: CalendarProvider`.
- Composio slugs used (keep ONLY in this file): `OUTLOOK_LIST_CALENDARS`, `OUTLOOK_LIST_CALENDAR_VIEW_DELTA`, `OUTLOOK_LIST_USER_CALENDAR_VIEW`, `OUTLOOK_CREATE_CALENDAR_EVENT_IN_CALENDAR`, `OUTLOOK_DELETE_CALENDAR_EVENT`.

- [ ] **Step 1: Write the failing test**

`src/lib/providers/outlook.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const executeTool = vi.fn()
vi.mock('../composio', () => ({
  executeTool: (...args: unknown[]) => executeTool(...args),
}))

const { outlookProvider } = await import('./outlook')

beforeEach(() => executeTool.mockReset())

describe('outlookProvider.listChanges', () => {
  it('maps Graph events, @removed entries, and delta link', async () => {
    executeTool.mockResolvedValueOnce({
      value: [
        {
          id: 'ev1',
          subject: 'Standup',
          bodyPreview: 'daily',
          location: { displayName: 'Teams' },
          start: { dateTime: '2026-07-08T07:00:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-07-08T07:30:00.0000000', timeZone: 'UTC' },
          isAllDay: false,
          showAs: 'busy',
          isCancelled: false,
        },
        { '@removed': { reason: 'deleted' }, id: 'ev2' },
        {
          id: 'ev3',
          subject: 'OOO',
          start: { dateTime: '2026-07-09T00:00:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-07-10T00:00:00.0000000', timeZone: 'UTC' },
          isAllDay: true,
          showAs: 'free',
        },
      ],
      '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=abc',
    })

    const res = await outlookProvider.listChanges('acc1', 'cal1', null, '2026-07-07T00:00:00Z', '2026-09-05T00:00:00Z')

    expect(executeTool).toHaveBeenCalledWith('OUTLOOK_LIST_CALENDAR_VIEW_DELTA', 'acc1', {
      calendar_id: 'cal1',
      start_datetime: '2026-07-07T00:00:00Z',
      end_datetime: '2026-09-05T00:00:00Z',
    })
    expect(res.nextCursor).toBe('https://graph.microsoft.com/delta?token=abc')
    expect(res.events).toEqual([
      {
        id: 'ev1', status: 'active', title: 'Standup', description: 'daily', location: 'Teams',
        start: '2026-07-08T07:00:00.0000000Z', end: '2026-07-08T07:30:00.0000000Z', allDay: false, transparent: false,
      },
      { id: 'ev2', status: 'cancelled', title: '', description: '', location: '', start: '', end: '', allDay: false, transparent: false },
      {
        id: 'ev3', status: 'active', title: 'OOO', description: '', location: '',
        start: '2026-07-09T00:00:00.0000000Z', end: '2026-07-10T00:00:00.0000000Z', allDay: true, transparent: true,
      },
    ])
  })

  it('passes the stored delta cursor and follows nextLink pages', async () => {
    executeTool
      .mockResolvedValueOnce({ value: [], '@odata.nextLink': 'https://graph/next?x=1' })
      .mockResolvedValueOnce({ value: [], '@odata.deltaLink': 'https://graph/delta?y=2' })

    const res = await outlookProvider.listChanges('acc1', 'cal1', 'https://graph/delta?old=1', 'ws', 'we')

    expect(executeTool).toHaveBeenNthCalledWith(1, 'OUTLOOK_LIST_CALENDAR_VIEW_DELTA', 'acc1', {
      calendar_id: 'cal1', start_datetime: 'ws', end_datetime: 'we', delta_token: 'https://graph/delta?old=1',
    })
    expect(executeTool).toHaveBeenNthCalledWith(2, 'OUTLOOK_LIST_CALENDAR_VIEW_DELTA', 'acc1', {
      calendar_id: 'cal1', start_datetime: 'ws', end_datetime: 'we', delta_token: 'https://graph/next?x=1',
    })
    expect(res.nextCursor).toBe('https://graph/delta?y=2')
  })
})

describe('outlookProvider writes', () => {
  it('creates events in a specific calendar', async () => {
    executeTool.mockResolvedValueOnce({ response_data: { id: 'new1' } })
    const id = await outlookProvider.createEvent('acc1', 'cal1', {
      title: 'Busy', description: 'x', start: '2026-07-08T10:00:00+03:00', end: '2026-07-08T11:00:00+03:00', allDay: false,
    })
    expect(id).toBe('new1')
    expect(executeTool).toHaveBeenCalledWith('OUTLOOK_CREATE_CALENDAR_EVENT_IN_CALENDAR', 'acc1', {
      calendar_id: 'cal1',
      subject: 'Busy',
      body: 'x',
      location: undefined,
      is_all_day: false,
      start_datetime: '2026-07-08T07:00:00.000Z',
      end_datetime: '2026-07-08T08:00:00.000Z',
      time_zone: 'UTC',
      show_as: 'busy',
    })
  })

  it('creates all-day events with date bounds preserved', async () => {
    executeTool.mockResolvedValueOnce({ id: 'new2' })
    await outlookProvider.createEvent('acc1', 'cal1', { title: 'Busy', start: '2026-07-09', end: '2026-07-10', allDay: true })
    expect(executeTool).toHaveBeenCalledWith('OUTLOOK_CREATE_CALENDAR_EVENT_IN_CALENDAR', 'acc1', {
      calendar_id: 'cal1',
      subject: 'Busy',
      body: undefined,
      location: undefined,
      is_all_day: true,
      start_datetime: '2026-07-09T00:00:00.000Z',
      end_datetime: '2026-07-10T00:00:00.000Z',
      time_zone: 'UTC',
      show_as: 'busy',
    })
  })

  it('deletes events', async () => {
    executeTool.mockResolvedValueOnce({})
    await outlookProvider.deleteEvent('acc1', 'cal1', 'ev9')
    expect(executeTool).toHaveBeenCalledWith('OUTLOOK_DELETE_CALENDAR_EVENT', 'acc1', { event_id: 'ev9' })
  })
})

describe('outlookProvider reads', () => {
  it('lists calendars', async () => {
    executeTool.mockResolvedValueOnce({ value: [{ id: 'c1', name: 'Calendar' }] })
    expect(await outlookProvider.listCalendars('acc1')).toEqual([{ id: 'c1', name: 'Calendar' }])
    expect(executeTool).toHaveBeenCalledWith('OUTLOOK_LIST_CALENDARS', 'acc1', {})
  })

  it('lists events in a range via calendar view', async () => {
    executeTool.mockResolvedValueOnce({ value: [] })
    await outlookProvider.listEvents('acc1', 'cal1', 't1', 't2')
    expect(executeTool).toHaveBeenCalledWith('OUTLOOK_LIST_USER_CALENDAR_VIEW', 'acc1', {
      calendar_id: 'cal1', start_datetime: 't1', end_datetime: 't2',
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/providers/outlook.test.ts`
Expected: FAIL — cannot find module './outlook'.

- [ ] **Step 3: Write implementation**

`src/lib/providers/outlook.ts`:
```ts
import { executeTool } from '../composio'
import type { CalendarProvider, Changes, NormalizedEvent, WriteEvent } from './types'

function unwrap(data: unknown): Record<string, any> {
  const d = data as Record<string, any>
  return (d?.response_data ?? d ?? {}) as Record<string, any>
}

// Graph returns naive local datetimes plus a timeZone field; delta/calendarView default to UTC.
// ponytail: assume UTC unless proven otherwise — blockers only need instants, not wall-clock fidelity.
function graphDate(dt: { dateTime?: string; timeZone?: string } | undefined): string {
  if (!dt?.dateTime) return ''
  return /Z|[+-]\d{2}:\d{2}$/.test(dt.dateTime) ? dt.dateTime : `${dt.dateTime}Z`
}

function mapEvent(raw: Record<string, any>): NormalizedEvent {
  if (raw['@removed']) {
    return { id: String(raw.id), status: 'cancelled', title: '', description: '', location: '', start: '', end: '', allDay: false, transparent: false }
  }
  return {
    id: String(raw.id),
    status: raw.isCancelled ? 'cancelled' : 'active',
    title: raw.subject ?? '',
    description: raw.bodyPreview ?? '',
    location: raw.location?.displayName ?? '',
    start: graphDate(raw.start),
    end: graphDate(raw.end),
    allDay: Boolean(raw.isAllDay),
    transparent: raw.showAs === 'free',
  }
}

function toUtcIso(value: string): string {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value).toISOString()
}

export const outlookProvider: CalendarProvider = {
  async listCalendars(accountId) {
    const payload = unwrap(await executeTool('OUTLOOK_LIST_CALENDARS', accountId, {}))
    return (payload.value ?? []).map((c: Record<string, any>) => ({ id: String(c.id), name: c.name ?? String(c.id) }))
  },

  async listChanges(accountId, calendarId, cursor, windowStart, windowEnd): Promise<Changes> {
    const events: NormalizedEvent[] = []
    let token: string | null = cursor
    let nextCursor: string | null = cursor
    for (;;) {
      const args: Record<string, unknown> = { calendar_id: calendarId, start_datetime: windowStart, end_datetime: windowEnd }
      if (token) args.delta_token = token
      const payload = unwrap(await executeTool('OUTLOOK_LIST_CALENDAR_VIEW_DELTA', accountId, args))
      for (const item of payload.value ?? []) events.push(mapEvent(item))
      if (payload['@odata.nextLink']) {
        token = String(payload['@odata.nextLink'])
        continue
      }
      if (payload['@odata.deltaLink']) nextCursor = String(payload['@odata.deltaLink'])
      return { events, nextCursor }
    }
  },

  async listEvents(accountId, calendarId, timeMin, timeMax) {
    const payload = unwrap(
      await executeTool('OUTLOOK_LIST_USER_CALENDAR_VIEW', accountId, {
        calendar_id: calendarId,
        start_datetime: timeMin,
        end_datetime: timeMax,
      }),
    )
    return (payload.value ?? []).map(mapEvent)
  },

  async createEvent(accountId, calendarId, event: WriteEvent) {
    const payload = unwrap(
      await executeTool('OUTLOOK_CREATE_CALENDAR_EVENT_IN_CALENDAR', accountId, {
        calendar_id: calendarId,
        subject: event.title,
        body: event.description,
        location: event.location,
        is_all_day: event.allDay,
        start_datetime: toUtcIso(event.start),
        end_datetime: toUtcIso(event.end),
        time_zone: 'UTC',
        show_as: 'busy',
      }),
    )
    return String(payload.id)
  },

  async deleteEvent(accountId, _calendarId, eventId) {
    await executeTool('OUTLOOK_DELETE_CALENDAR_EVENT', accountId, { event_id: eventId })
  },
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/providers/outlook.test.ts` — Expected: PASS (7 tests).
Run: `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/providers/outlook.ts src/lib/providers/outlook.test.ts
git commit -m "feat: outlook provider via composio"
```

---

### Task 7: Sync core (pure diff logic)

**Files:**
- Create: `src/lib/sync/core.ts`
- Test: `src/lib/sync/core.test.ts`

**Interfaces:**
- Consumes: `NormalizedEvent`, `WriteEvent` from `../providers/types`.
- Produces (Task 8 depends on these exact signatures):
  - `type SyncLinkConfig = { mode: 'busy' | 'clone'; busyTitle: string }`
  - `buildWriteEvent(src: NormalizedEvent, link: SyncLinkConfig): WriteEvent`
  - `contentHash(w: WriteEvent): string` — sha256 hex.
  - `type Mapping = { targetEventId: string; contentHash: string }`
  - `type Action = { type: 'create'; sourceEventId: string; write: WriteEvent; hash: string } | { type: 'recreate'; sourceEventId: string; targetEventId: string; write: WriteEvent; hash: string } | { type: 'delete'; sourceEventId: string; targetEventId: string }`
  - `planActions(opts: { events: NormalizedEvent[]; link: SyncLinkConfig; mappings: Map<string, Mapping>; isOwnEvent: (eventId: string) => boolean }): Action[]`

- [ ] **Step 1: Write the failing test**

`src/lib/sync/core.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../providers/types'
import { buildWriteEvent, contentHash, planActions } from './core'

function event(over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: 'src1', status: 'active', title: 'Meeting', description: 'notes', location: 'HQ',
    start: '2026-07-08T10:00:00Z', end: '2026-07-08T11:00:00Z', allDay: false, transparent: false,
    ...over,
  }
}

const busyLink = { mode: 'busy' as const, busyTitle: 'Busy' }
const cloneLink = { mode: 'clone' as const, busyTitle: 'Busy' }

describe('buildWriteEvent', () => {
  it('busy mode strips all details', () => {
    expect(buildWriteEvent(event(), busyLink)).toEqual({
      title: 'Busy', start: '2026-07-08T10:00:00Z', end: '2026-07-08T11:00:00Z', allDay: false,
    })
  })

  it('clone mode copies title/description/location but never attendees', () => {
    expect(buildWriteEvent(event(), cloneLink)).toEqual({
      title: 'Meeting', description: 'notes', location: 'HQ',
      start: '2026-07-08T10:00:00Z', end: '2026-07-08T11:00:00Z', allDay: false,
    })
  })

  it('clone mode falls back for empty titles', () => {
    expect(buildWriteEvent(event({ title: '' }), cloneLink).title).toBe('(No title)')
  })
})

describe('contentHash', () => {
  it('is stable and changes when content changes', () => {
    const a = contentHash(buildWriteEvent(event(), busyLink))
    expect(a).toBe(contentHash(buildWriteEvent(event(), busyLink)))
    expect(a).not.toBe(contentHash(buildWriteEvent(event({ end: '2026-07-08T12:00:00Z' }), busyLink)))
  })

  it('busy-mode hash ignores title/description changes on the source', () => {
    const a = contentHash(buildWriteEvent(event(), busyLink))
    expect(a).toBe(contentHash(buildWriteEvent(event({ title: 'Renamed', description: 'x' }), busyLink)))
  })
})

describe('planActions', () => {
  const hash = (ev: NormalizedEvent) => contentHash(buildWriteEvent(ev, busyLink))

  it('creates unmapped active events', () => {
    const actions = planActions({ events: [event()], link: busyLink, mappings: new Map(), isOwnEvent: () => false })
    expect(actions).toEqual([{ type: 'create', sourceEventId: 'src1', write: buildWriteEvent(event(), busyLink), hash: hash(event()) }])
  })

  it('skips events we created ourselves (loop prevention)', () => {
    const actions = planActions({ events: [event()], link: busyLink, mappings: new Map(), isOwnEvent: () => true })
    expect(actions).toEqual([])
  })

  it('skips unchanged mapped events', () => {
    const mappings = new Map([['src1', { targetEventId: 'tgt1', contentHash: hash(event()) }]])
    expect(planActions({ events: [event()], link: busyLink, mappings, isOwnEvent: () => false })).toEqual([])
  })

  it('recreates changed mapped events', () => {
    const mappings = new Map([['src1', { targetEventId: 'tgt1', contentHash: 'old-hash' }]])
    const actions = planActions({ events: [event()], link: busyLink, mappings, isOwnEvent: () => false })
    expect(actions).toEqual([
      { type: 'recreate', sourceEventId: 'src1', targetEventId: 'tgt1', write: buildWriteEvent(event(), busyLink), hash: hash(event()) },
    ])
  })

  it('deletes mapped events that were cancelled', () => {
    const mappings = new Map([['src1', { targetEventId: 'tgt1', contentHash: 'h' }]])
    const actions = planActions({ events: [event({ status: 'cancelled' })], link: busyLink, mappings, isOwnEvent: () => false })
    expect(actions).toEqual([{ type: 'delete', sourceEventId: 'src1', targetEventId: 'tgt1' }])
  })

  it('ignores cancelled events with no mapping', () => {
    expect(planActions({ events: [event({ status: 'cancelled' })], link: busyLink, mappings: new Map(), isOwnEvent: () => false })).toEqual([])
  })

  it('treats transparent (Free) events as gone', () => {
    const mappings = new Map([['src1', { targetEventId: 'tgt1', contentHash: 'h' }]])
    expect(planActions({ events: [event({ transparent: true })], link: busyLink, mappings, isOwnEvent: () => false })).toEqual([
      { type: 'delete', sourceEventId: 'src1', targetEventId: 'tgt1' },
    ])
    expect(planActions({ events: [event({ transparent: true })], link: busyLink, mappings: new Map(), isOwnEvent: () => false })).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sync/core.test.ts`
Expected: FAIL — cannot find module './core'.

- [ ] **Step 3: Write implementation**

`src/lib/sync/core.ts`:
```ts
import { createHash } from 'node:crypto'
import type { NormalizedEvent, WriteEvent } from '../providers/types'

export type SyncLinkConfig = { mode: 'busy' | 'clone'; busyTitle: string }

export function buildWriteEvent(src: NormalizedEvent, link: SyncLinkConfig): WriteEvent {
  if (link.mode === 'busy') {
    return { title: link.busyTitle, start: src.start, end: src.end, allDay: src.allDay }
  }
  return {
    title: src.title || '(No title)',
    description: src.description || undefined,
    location: src.location || undefined,
    start: src.start,
    end: src.end,
    allDay: src.allDay,
  }
}

export function contentHash(w: WriteEvent): string {
  return createHash('sha256')
    .update(JSON.stringify([w.title, w.description ?? '', w.location ?? '', w.start, w.end, w.allDay]))
    .digest('hex')
}

export type Mapping = { targetEventId: string; contentHash: string }

export type Action =
  | { type: 'create'; sourceEventId: string; write: WriteEvent; hash: string }
  | { type: 'recreate'; sourceEventId: string; targetEventId: string; write: WriteEvent; hash: string }
  | { type: 'delete'; sourceEventId: string; targetEventId: string }

export function planActions(opts: {
  events: NormalizedEvent[]
  link: SyncLinkConfig
  mappings: Map<string, Mapping>
  isOwnEvent: (eventId: string) => boolean
}): Action[] {
  const actions: Action[] = []
  for (const ev of opts.events) {
    if (opts.isOwnEvent(ev.id)) continue
    const mapping = opts.mappings.get(ev.id)
    if (ev.status === 'cancelled' || ev.transparent) {
      if (mapping) actions.push({ type: 'delete', sourceEventId: ev.id, targetEventId: mapping.targetEventId })
      continue
    }
    const write = buildWriteEvent(ev, opts.link)
    const hash = contentHash(write)
    if (!mapping) actions.push({ type: 'create', sourceEventId: ev.id, write, hash })
    else if (mapping.contentHash !== hash) {
      actions.push({ type: 'recreate', sourceEventId: ev.id, targetEventId: mapping.targetEventId, write, hash })
    }
  }
  return actions
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/sync/core.test.ts` — Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/core.ts src/lib/sync/core.test.ts
git commit -m "feat: pure sync diff logic with loop prevention"
```

---

### Task 8: Sync engine (runSyncCycle)

**Files:**
- Create: `src/lib/sync/engine.ts`
- Test: `src/lib/sync/engine.test.ts`

**Interfaces:**
- Consumes: `createDb`/`DB`, `getSetting`, core functions from `./core`, error classes from `../composio`, `CalendarProvider` from `../providers/types`.
- Produces (Tasks 9, 11 depend on):
  - `type EngineDeps = { db: DB; providerFor: (provider: 'google' | 'outlook') => CalendarProvider; now?: () => Date }`
  - `runSyncCycle(deps: EngineDeps): Promise<{ processed: number; errors: string[] }>` — throws `RateLimitError` (caller backs off); all other errors are captured per-link.

**Behavior contract (implement exactly):**
1. Load enabled links whose source AND target connections are `active`, joined to calendar/connection columns.
2. Group links by source calendar; fetch changes once per source calendar using its provider and stored cursor from `sync_state`.
3. On `CursorExpiredError`: clear cursor, retry once with `null` (full window re-fetch; mappings make this idempotent).
4. Loop prevention: an event is "ours" if `event_mappings.target_event_id` matches for any link targeting this calendar.
5. Apply actions sequentially. For `delete`/`recreate`: delete target event (ignore `NotFoundError`), then delete the mapping row, THEN (for `recreate`) create + upsert mapping — this order survives crashes mid-action.
6. Advance the source calendar's cursor in `sync_state` only if every link for that calendar succeeded.
7. Per-link success clears `last_error`; per-link failure records message in `last_error`. Both update `last_run_at`.
8. `RateLimitError` anywhere aborts the whole cycle (re-thrown after recording a sync_runs row).
9. Always insert a `sync_runs` row (started_at ISO, duration_ms, events_processed = number of executed actions, errors JSON or NULL).

- [ ] **Step 1: Write the failing test**

`src/lib/sync/engine.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { createDb, type DB } from '../db'
import { NotFoundError, RateLimitError, CursorExpiredError } from '../composio'
import type { CalendarProvider, NormalizedEvent } from '../providers/types'
import { runSyncCycle } from './engine'

function ev(id: string, over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id, status: 'active', title: 'Meeting', description: '', location: '',
    start: '2026-07-08T10:00:00Z', end: '2026-07-08T11:00:00Z', allDay: false, transparent: false,
    ...over,
  }
}

type FakeCall = { method: string; args: unknown[] }

function makeFakeProvider(script: {
  changes?: (cursor: string | null) => { events: NormalizedEvent[]; nextCursor: string | null }
  createId?: () => string
  failCreateWith?: Error
  failChangesWith?: Error
  failDeleteWith?: Error
}) {
  const calls: FakeCall[] = []
  let n = 0
  const provider: CalendarProvider = {
    async listCalendars() { return [] },
    async listChanges(_a, _c, cursor) {
      calls.push({ method: 'listChanges', args: [cursor] })
      if (script.failChangesWith) { const e = script.failChangesWith; script.failChangesWith = undefined; throw e }
      return script.changes ? script.changes(cursor) : { events: [], nextCursor: null }
    },
    async listEvents() { return [] },
    async createEvent(_a, _c, w) {
      calls.push({ method: 'createEvent', args: [w] })
      if (script.failCreateWith) throw script.failCreateWith
      return script.createId ? script.createId() : `tgt-${++n}`
    },
    async deleteEvent(_a, _c, id) {
      calls.push({ method: 'deleteEvent', args: [id] })
      if (script.failDeleteWith) throw script.failDeleteWith
    },
  }
  return { provider, calls }
}

// seed: two active connections (google src, outlook tgt), one calendar each, one busy link
function seed(db: DB) {
  db.prepare("INSERT INTO connections (provider, composio_connected_account_id, status) VALUES ('google', 'acc-g', 'active')").run()
  db.prepare("INSERT INTO connections (provider, composio_connected_account_id, status) VALUES ('outlook', 'acc-o', 'active')").run()
  db.prepare("INSERT INTO calendars (connection_id, provider_calendar_id, name) VALUES (1, 'gcal', 'Work')").run()
  db.prepare("INSERT INTO calendars (connection_id, provider_calendar_id, name) VALUES (2, 'ocal', 'Personal')").run()
  db.prepare("INSERT INTO sync_links (source_calendar_id, target_calendar_id, mode, busy_title) VALUES (1, 2, 'busy', 'Busy')").run()
}

describe('runSyncCycle', () => {
  let db: DB
  beforeEach(() => { db = createDb(); seed(db) })

  function deps(google: CalendarProvider, outlook: CalendarProvider) {
    return { db, providerFor: (p: 'google' | 'outlook') => (p === 'google' ? google : outlook) }
  }

  it('creates blockers for new events, stores mappings and cursor', async () => {
    const g = makeFakeProvider({ changes: () => ({ events: [ev('e1')], nextCursor: 'cur-1' }) })
    const o = makeFakeProvider({})

    const res = await runSyncCycle(deps(g.provider, o.provider))

    expect(res).toEqual({ processed: 1, errors: [] })
    expect(o.calls).toEqual([{ method: 'createEvent', args: [{ title: 'Busy', start: '2026-07-08T10:00:00Z', end: '2026-07-08T11:00:00Z', allDay: false }] }])
    const mapping = db.prepare('SELECT source_event_id, target_event_id FROM event_mappings').get()
    expect(mapping).toEqual({ source_event_id: 'e1', target_event_id: 'tgt-1' })
    expect(db.prepare('SELECT sync_cursor FROM sync_state WHERE calendar_id = 1').get()).toEqual({ sync_cursor: 'cur-1' })
    expect(db.prepare('SELECT last_error FROM sync_links WHERE id = 1').get()).toEqual({ last_error: null })
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_runs').get()).toEqual({ n: 1 })
  })

  it('is idempotent — second run with same events does nothing', async () => {
    const g = makeFakeProvider({ changes: () => ({ events: [ev('e1')], nextCursor: 'c' }) })
    const o = makeFakeProvider({})
    await runSyncCycle(deps(g.provider, o.provider))
    o.calls.length = 0

    const res = await runSyncCycle(deps(g.provider, o.provider))
    expect(res.processed).toBe(0)
    expect(o.calls).toEqual([])
  })

  it('recreates changed events (delete then create) and deletes cancelled ones', async () => {
    let phase = 0
    const g = makeFakeProvider({
      changes: () => (phase === 0
        ? { events: [ev('e1'), ev('e2')], nextCursor: 'c1' }
        : { events: [ev('e1', { end: '2026-07-08T12:00:00Z' }), ev('e2', { status: 'cancelled' })], nextCursor: 'c2' }),
    })
    const o = makeFakeProvider({})
    await runSyncCycle(deps(g.provider, o.provider))
    phase = 1
    o.calls.length = 0

    const res = await runSyncCycle(deps(g.provider, o.provider))

    expect(res.processed).toBe(2)
    expect(o.calls.map((c) => c.method)).toEqual(['deleteEvent', 'createEvent', 'deleteEvent'])
    expect(db.prepare('SELECT COUNT(*) AS n FROM event_mappings').get()).toEqual({ n: 1 })
  })

  it('skips events created by a reverse link (loop prevention)', async () => {
    // reverse link: outlook cal 2 -> google cal 1; mapping says event "blk1" in cal 1 is ours
    db.prepare("INSERT INTO sync_links (source_calendar_id, target_calendar_id, mode, busy_title) VALUES (2, 1, 'busy', 'Busy')").run()
    db.prepare("INSERT INTO event_mappings (sync_link_id, source_event_id, target_event_id, content_hash) VALUES (2, 'oev', 'blk1', 'h')").run()
    const g = makeFakeProvider({ changes: () => ({ events: [ev('blk1')], nextCursor: null }) })
    const o = makeFakeProvider({ changes: () => ({ events: [], nextCursor: null }) })

    const res = await runSyncCycle(deps(g.provider, o.provider))
    expect(res.processed).toBe(0)
    expect(o.calls.filter((c) => c.method === 'createEvent')).toEqual([])
  })

  it('retries a full fetch when the cursor expired', async () => {
    db.prepare("INSERT INTO sync_state (calendar_id, sync_cursor) VALUES (1, 'stale')").run()
    const g = makeFakeProvider({
      failChangesWith: new CursorExpiredError('gone'),
      changes: (cursor) => ({ events: cursor === null ? [ev('e1')] : [], nextCursor: 'fresh' }),
    })
    const o = makeFakeProvider({})

    const res = await runSyncCycle(deps(g.provider, o.provider))

    expect(g.calls.map((c) => c.args[0])).toEqual(['stale', null])
    expect(res.processed).toBe(1)
    expect(db.prepare('SELECT sync_cursor FROM sync_state WHERE calendar_id = 1').get()).toEqual({ sync_cursor: 'fresh' })
  })

  it('records per-link errors without advancing the cursor', async () => {
    const g = makeFakeProvider({ changes: () => ({ events: [ev('e1')], nextCursor: 'c1' }) })
    const o = makeFakeProvider({ failCreateWith: new Error('boom') })

    const res = await runSyncCycle(deps(g.provider, o.provider))

    expect(res.errors).toHaveLength(1)
    expect(db.prepare('SELECT last_error FROM sync_links WHERE id = 1').get()).toEqual({ last_error: 'boom' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_state').get()).toEqual({ n: 0 })
  })

  it('ignores NotFoundError when deleting already-gone targets', async () => {
    let phase = 0
    const g = makeFakeProvider({
      changes: () => (phase === 0 ? { events: [ev('e1')], nextCursor: 'c1' } : { events: [ev('e1', { status: 'cancelled' })], nextCursor: 'c2' }),
    })
    const o = makeFakeProvider({})
    await runSyncCycle(deps(g.provider, o.provider))
    phase = 1
    o.provider.deleteEvent = async () => { throw new NotFoundError('404') }

    const res = await runSyncCycle(deps(g.provider, o.provider))
    expect(res.errors).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM event_mappings').get()).toEqual({ n: 0 })
  })

  it('rethrows RateLimitError after logging a run', async () => {
    const g = makeFakeProvider({ failChangesWith: new RateLimitError('429') })
    const o = makeFakeProvider({})
    await expect(runSyncCycle(deps(g.provider, o.provider))).rejects.toBeInstanceOf(RateLimitError)
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_runs').get()).toEqual({ n: 1 })
  })

  it('ignores links with inactive connections', async () => {
    db.prepare("UPDATE connections SET status = 'pending' WHERE id = 1").run()
    const g = makeFakeProvider({})
    const o = makeFakeProvider({})
    const res = await runSyncCycle(deps(g.provider, o.provider))
    expect(res.processed).toBe(0)
    expect(g.calls).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sync/engine.test.ts`
Expected: FAIL — cannot find module './engine'.

- [ ] **Step 3: Write implementation**

`src/lib/sync/engine.ts`:
```ts
import { CursorExpiredError, NotFoundError, RateLimitError } from '../composio'
import type { DB } from '../db'
import type { CalendarProvider, Changes } from '../providers/types'
import { getSetting } from '../settings'
import { planActions, type Mapping } from './core'

export type EngineDeps = {
  db: DB
  providerFor: (provider: 'google' | 'outlook') => CalendarProvider
  now?: () => Date
}

type LinkRow = {
  id: number
  mode: 'busy' | 'clone'
  busy_title: string
  source_calendar_id: number
  target_calendar_id: number
  src_provider: 'google' | 'outlook'
  src_account: string
  src_cal: string
  tgt_provider: 'google' | 'outlook'
  tgt_account: string
  tgt_cal: string
}

const LINKS_SQL = `
  SELECT l.id, l.mode, l.busy_title, l.source_calendar_id, l.target_calendar_id,
         sc.provider_calendar_id AS src_cal, scon.provider AS src_provider, scon.composio_connected_account_id AS src_account,
         tc.provider_calendar_id AS tgt_cal, tcon.provider AS tgt_provider, tcon.composio_connected_account_id AS tgt_account
  FROM sync_links l
  JOIN calendars sc ON sc.id = l.source_calendar_id
  JOIN connections scon ON scon.id = sc.connection_id
  JOIN calendars tc ON tc.id = l.target_calendar_id
  JOIN connections tcon ON tcon.id = tc.connection_id
  WHERE l.enabled = 1 AND scon.status = 'active' AND tcon.status = 'active'
`

export async function runSyncCycle(deps: EngineDeps): Promise<{ processed: number; errors: string[] }> {
  const { db } = deps
  const now = (deps.now ?? (() => new Date()))()
  const startedAt = now.toISOString()
  const t0 = Date.now()
  let processed = 0
  const errors: string[] = []

  const finishRun = () => {
    db.prepare('INSERT INTO sync_runs (started_at, duration_ms, events_processed, errors) VALUES (?, ?, ?, ?)')
      .run(startedAt, Date.now() - t0, processed, errors.length ? JSON.stringify(errors) : null)
  }

  try {
    const windowDays = Number(getSetting(db, 'sync_window_days', '60'))
    const windowStart = new Date(now.getTime() - 86_400_000).toISOString()
    const windowEnd = new Date(now.getTime() + windowDays * 86_400_000).toISOString()

    const links = db.prepare(LINKS_SQL).all() as LinkRow[]
    const bySource = new Map<number, LinkRow[]>()
    for (const link of links) {
      const group = bySource.get(link.source_calendar_id) ?? []
      group.push(link)
      bySource.set(link.source_calendar_id, group)
    }

    const isOwnStmt = db.prepare(
      'SELECT 1 FROM event_mappings m JOIN sync_links l ON l.id = m.sync_link_id WHERE l.target_calendar_id = ? AND m.target_event_id = ?',
    )
    const markLink = db.prepare("UPDATE sync_links SET last_run_at = datetime('now'), last_error = ? WHERE id = ?")

    for (const [calendarId, calLinks] of bySource) {
      const src = calLinks[0]
      const provider = deps.providerFor(src.src_provider)
      const cursorRow = db.prepare('SELECT sync_cursor FROM sync_state WHERE calendar_id = ?').get(calendarId) as { sync_cursor: string | null } | undefined

      let changes: Changes
      try {
        try {
          changes = await provider.listChanges(src.src_account, src.src_cal, cursorRow?.sync_cursor ?? null, windowStart, windowEnd)
        } catch (e) {
          if (!(e instanceof CursorExpiredError)) throw e
          db.prepare('DELETE FROM sync_state WHERE calendar_id = ?').run(calendarId)
          changes = await provider.listChanges(src.src_account, src.src_cal, null, windowStart, windowEnd)
        }
      } catch (e) {
        if (e instanceof RateLimitError) throw e
        const msg = e instanceof Error ? e.message : String(e)
        for (const link of calLinks) markLink.run(msg, link.id)
        errors.push(`calendar ${calendarId}: ${msg}`)
        continue
      }

      let calendarOk = true
      for (const link of calLinks) {
        const rows = db.prepare('SELECT source_event_id, target_event_id, content_hash FROM event_mappings WHERE sync_link_id = ?').all(link.id) as {
          source_event_id: string
          target_event_id: string
          content_hash: string
        }[]
        const mappings = new Map<string, Mapping>(rows.map((r) => [r.source_event_id, { targetEventId: r.target_event_id, contentHash: r.content_hash }]))
        const actions = planActions({
          events: changes.events,
          link: { mode: link.mode, busyTitle: link.busy_title },
          mappings,
          isOwnEvent: (id) => Boolean(isOwnStmt.get(calendarId, id)),
        })

        const target = deps.providerFor(link.tgt_provider)
        try {
          for (const action of actions) {
            if (action.type === 'delete' || action.type === 'recreate') {
              try {
                await target.deleteEvent(link.tgt_account, link.tgt_cal, action.targetEventId)
              } catch (e) {
                if (!(e instanceof NotFoundError)) throw e
              }
              db.prepare('DELETE FROM event_mappings WHERE sync_link_id = ? AND source_event_id = ?').run(link.id, action.sourceEventId)
            }
            if (action.type === 'create' || action.type === 'recreate') {
              const targetId = await target.createEvent(link.tgt_account, link.tgt_cal, action.write)
              db.prepare(
                `INSERT INTO event_mappings (sync_link_id, source_event_id, target_event_id, content_hash, updated_at)
                 VALUES (?, ?, ?, ?, datetime('now'))
                 ON CONFLICT(sync_link_id, source_event_id)
                 DO UPDATE SET target_event_id = excluded.target_event_id, content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
              ).run(link.id, action.sourceEventId, targetId, action.hash)
            }
            processed++
          }
          markLink.run(null, link.id)
        } catch (e) {
          if (e instanceof RateLimitError) throw e
          calendarOk = false
          const msg = e instanceof Error ? e.message : String(e)
          errors.push(`link ${link.id}: ${msg}`)
          markLink.run(msg, link.id)
        }
      }

      if (calendarOk) {
        db.prepare(
          `INSERT INTO sync_state (calendar_id, sync_cursor, last_synced_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(calendar_id) DO UPDATE SET sync_cursor = excluded.sync_cursor, last_synced_at = excluded.last_synced_at`,
        ).run(calendarId, changes.nextCursor)
      }
    }

    finishRun()
    return { processed, errors }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e))
    finishRun()
    throw e
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/sync/engine.test.ts` — Expected: PASS (9 tests).
Run: `npx vitest run` — Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/engine.ts src/lib/sync/engine.test.ts
git commit -m "feat: sync engine with cursor handling and error isolation"
```

---

### Task 9: Scheduler + instrumentation

**Files:**
- Create: `src/lib/scheduler.ts`, `src/instrumentation.ts`

**Interfaces:**
- Consumes: `getDb`, `getSetting`, `runSyncCycle`, `googleProvider`, `outlookProvider`, `RateLimitError`.
- Produces (Task 11 depends on): `runOnce(): Promise<{ processed: number; errors: string[] }>` — used by the "Sync now" button; `startScheduler(): void`.

- [ ] **Step 1: Write implementation** (thin wiring — the engine underneath is fully tested; a unit test here would only re-test `setTimeout`)

`src/lib/scheduler.ts`:
```ts
import { RateLimitError } from './composio'
import { getDb } from './db'
import { googleProvider } from './providers/google'
import { outlookProvider } from './providers/outlook'
import { getSetting } from './settings'
import { runSyncCycle } from './sync/engine'

const providerFor = (p: 'google' | 'outlook') => (p === 'google' ? googleProvider : outlookProvider)

declare global {
  // eslint-disable-next-line no-var
  var __opencalTimer: ReturnType<typeof setTimeout> | undefined
}

let running = false
// ponytail: in-memory backoff, resets on restart; persist it if rate limits ever become chronic
let backoffMs = 0

export async function runOnce(): Promise<{ processed: number; errors: string[] }> {
  if (running) return { processed: 0, errors: ['sync already running'] }
  running = true
  try {
    const result = await runSyncCycle({ db: getDb(), providerFor })
    backoffMs = 0
    return result
  } catch (e) {
    if (e instanceof RateLimitError) {
      backoffMs = Math.min(backoffMs ? backoffMs * 2 : 60_000, 30 * 60_000)
      return { processed: 0, errors: [`rate limited — backing off ${backoffMs / 1000}s`] }
    }
    return { processed: 0, errors: [e instanceof Error ? e.message : String(e)] }
  } finally {
    running = false
  }
}

export function startScheduler(): void {
  if (globalThis.__opencalTimer) return
  const tick = async () => {
    await runOnce()
    const interval = Number(getSetting(getDb(), 'poll_interval_minutes', '5')) * 60_000
    globalThis.__opencalTimer = setTimeout(tick, Math.max(interval, backoffMs))
  }
  globalThis.__opencalTimer = setTimeout(tick, 5_000)
}
```

`src/instrumentation.ts`:
```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('./lib/scheduler')
    startScheduler()
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit && npm run build` — Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/scheduler.ts src/instrumentation.ts
git commit -m "feat: in-process sync scheduler via instrumentation hook"
```

---

### Task 10: Connection flow (Composio OAuth link + callback)

**Files:**
- Create: `src/lib/connections.ts`, `src/app/api/connect/callback/route.ts`
- Test: `src/lib/connections.test.ts`

**Interfaces:**
- Consumes: `getDb`/`DB`, `getComposio`, `USER_ID`, `getSetting`, providers.
- Produces (Task 11 depends on):
  - `startConnectionFlow(db: DB, provider: 'google' | 'outlook', baseUrl: string, deps?: { composio?: ComposioLike }): Promise<string>` — creates a pending connection row, returns Composio `redirectUrl` to send the user to. Throws `Error('missing-auth-config')` if the provider's auth config id setting is empty.
  - `completeConnectionFlow(db: DB, deps?: { composio?: ComposioLike; providerFor?: ProviderFor }): Promise<void>` — resolves the newest pending connection: waits for ACTIVE, stores `composio_connected_account_id` + label, sets status `active`, fetches and stores its calendars. On failure marks the row status `error`.
  - `ComposioLike = { connectedAccounts: { link: Function; waitForConnection: Function } }` (structural type so tests can fake it), `ProviderFor = (p: 'google' | 'outlook') => CalendarProvider`.

- [ ] **Step 1: Write the failing test**

`src/lib/connections.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { createDb } from './db'
import { setSetting } from './settings'
import { completeConnectionFlow, startConnectionFlow } from './connections'
import type { CalendarProvider } from './providers/types'

const fakeProvider: CalendarProvider = {
  listCalendars: vi.fn(async () => [{ id: 'cal-1', name: 'Work' }]),
  listChanges: vi.fn(),
  listEvents: vi.fn(),
  createEvent: vi.fn(),
  deleteEvent: vi.fn(),
} as unknown as CalendarProvider

describe('startConnectionFlow', () => {
  it('throws when the auth config id is not set', async () => {
    const db = createDb()
    await expect(startConnectionFlow(db, 'google', 'http://x', {
      composio: { connectedAccounts: { link: vi.fn(), waitForConnection: vi.fn() } },
    })).rejects.toThrow('missing-auth-config')
  })

  it('creates a pending row and returns the redirect url', async () => {
    const db = createDb()
    setSetting(db, 'google_auth_config_id', 'ac_123')
    const link = vi.fn(async () => ({ id: 'req-1', redirectUrl: 'https://composio/redirect' }))

    const url = await startConnectionFlow(db, 'google', 'http://localhost:3000', {
      composio: { connectedAccounts: { link, waitForConnection: vi.fn() } },
    })

    expect(url).toBe('https://composio/redirect')
    expect(link).toHaveBeenCalledWith('default', 'ac_123', { callbackUrl: 'http://localhost:3000/api/connect/callback' })
    expect(db.prepare('SELECT provider, composio_request_id, status FROM connections').get()).toEqual({
      provider: 'google', composio_request_id: 'req-1', status: 'pending',
    })
  })
})

describe('completeConnectionFlow', () => {
  it('activates the pending connection and stores its calendars', async () => {
    const db = createDb()
    setSetting(db, 'google_auth_config_id', 'ac_123')
    const composio = {
      connectedAccounts: {
        link: vi.fn(async () => ({ id: 'req-1', redirectUrl: 'u' })),
        waitForConnection: vi.fn(async () => ({ id: 'ca_9', status: 'ACTIVE', data: { email: 'me@gmail.com' } })),
      },
    }
    await startConnectionFlow(db, 'google', 'http://x', { composio })

    await completeConnectionFlow(db, { composio, providerFor: () => fakeProvider })

    expect(db.prepare('SELECT composio_connected_account_id, account_label, status FROM connections').get()).toEqual({
      composio_connected_account_id: 'ca_9', account_label: 'me@gmail.com', status: 'active',
    })
    expect(db.prepare('SELECT provider_calendar_id, name FROM calendars').all()).toEqual([{ provider_calendar_id: 'cal-1', name: 'Work' }])
  })

  it('marks the connection as error when activation fails', async () => {
    const db = createDb()
    setSetting(db, 'outlook_auth_config_id', 'ac_o')
    const composio = {
      connectedAccounts: {
        link: vi.fn(async () => ({ id: 'req-2', redirectUrl: 'u' })),
        waitForConnection: vi.fn(async () => { throw new Error('denied') }),
      },
    }
    await startConnectionFlow(db, 'outlook', 'http://x', { composio })

    await completeConnectionFlow(db, { composio, providerFor: () => fakeProvider })

    expect(db.prepare('SELECT status FROM connections').get()).toEqual({ status: 'error' })
  })

  it('is a no-op when nothing is pending', async () => {
    const db = createDb()
    await expect(completeConnectionFlow(db, {
      composio: { connectedAccounts: { link: vi.fn(), waitForConnection: vi.fn() } },
      providerFor: () => fakeProvider,
    })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/connections.test.ts`
Expected: FAIL — cannot find module './connections'.

- [ ] **Step 3: Write implementation**

`src/lib/connections.ts`:
```ts
import { getComposio, USER_ID } from './composio'
import type { DB } from './db'
import { googleProvider } from './providers/google'
import { outlookProvider } from './providers/outlook'
import type { CalendarProvider } from './providers/types'
import { getSetting } from './settings'

export type ComposioLike = {
  connectedAccounts: {
    link: (userId: string, authConfigId: string, opts: { callbackUrl: string }) => Promise<{ id: string; redirectUrl: string }>
    waitForConnection: (requestId: string, timeoutMs?: number) => Promise<{ id: string; status: string; data?: Record<string, unknown> }>
  }
}

export type ProviderFor = (p: 'google' | 'outlook') => CalendarProvider

type Deps = { composio?: ComposioLike; providerFor?: ProviderFor }

const defaultProviderFor: ProviderFor = (p) => (p === 'google' ? googleProvider : outlookProvider)

export async function startConnectionFlow(db: DB, provider: 'google' | 'outlook', baseUrl: string, deps: Deps = {}): Promise<string> {
  const authConfigId = getSetting(db, `${provider}_auth_config_id`, '')
  if (!authConfigId) throw new Error('missing-auth-config')
  const composio = deps.composio ?? (getComposio() as unknown as ComposioLike)
  const request = await composio.connectedAccounts.link(USER_ID, authConfigId, {
    callbackUrl: `${baseUrl}/api/connect/callback`,
  })
  // ponytail: stale pending rows from abandoned flows are cleaned up here rather than by a job
  db.prepare("DELETE FROM connections WHERE status = 'pending' AND created_at < datetime('now', '-1 hour')").run()
  db.prepare("INSERT INTO connections (provider, composio_request_id, status) VALUES (?, ?, 'pending')").run(provider, request.id)
  return request.redirectUrl
}

export async function completeConnectionFlow(db: DB, deps: Deps = {}): Promise<void> {
  const pending = db
    .prepare("SELECT id, provider, composio_request_id FROM connections WHERE status = 'pending' ORDER BY id DESC LIMIT 1")
    .get() as { id: number; provider: 'google' | 'outlook'; composio_request_id: string } | undefined
  if (!pending) return

  const composio = deps.composio ?? (getComposio() as unknown as ComposioLike)
  const providerFor = deps.providerFor ?? defaultProviderFor
  try {
    const account = await composio.connectedAccounts.waitForConnection(pending.composio_request_id, 120_000)
    if (account.status !== 'ACTIVE') throw new Error(`connection status: ${account.status}`)
    const label = String((account.data as Record<string, unknown> | undefined)?.email ?? `${pending.provider} account`)
    db.prepare("UPDATE connections SET composio_connected_account_id = ?, account_label = ?, status = 'active' WHERE id = ?")
      .run(account.id, label, pending.id)
    const calendars = await providerFor(pending.provider).listCalendars(account.id)
    const insert = db.prepare(
      'INSERT INTO calendars (connection_id, provider_calendar_id, name) VALUES (?, ?, ?) ON CONFLICT(connection_id, provider_calendar_id) DO UPDATE SET name = excluded.name',
    )
    for (const cal of calendars) insert.run(pending.id, cal.id, cal.name)
  } catch {
    db.prepare("UPDATE connections SET status = 'error' WHERE id = ?").run(pending.id)
  }
}
```

`src/app/api/connect/callback/route.ts`:
```ts
import { redirect } from 'next/navigation'
import { completeConnectionFlow } from '../../../../lib/connections'
import { getDb } from '../../../../lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  await completeConnectionFlow(getDb())
  redirect('/')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/connections.test.ts` — Expected: PASS (5 tests).
Run: `npx tsc --noEmit && npm run build` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/connections.ts src/lib/connections.test.ts src/app/api/connect/callback/route.ts
git commit -m "feat: composio oauth connection flow"
```

---

### Task 11: Dashboard UI (connections, sync links, runs, sync now)

**Files:**
- Create: `src/app/actions.ts`
- Modify: `src/app/page.tsx` (replace placeholder entirely)

**Interfaces:**
- Consumes: `requireAuth`, `getDb`, `startConnectionFlow`, `runOnce`, provider modules (indirectly), `getSetting`.
- Produces: server actions `connect`, `deleteConnection`, `createSyncLink`, `deleteSyncLink`, `syncNow` (used only by the dashboard page's forms).

**Behavior contract:**
- `createSyncLink` validates source ≠ target; when "two-way" is checked it creates two rows sharing a fresh `pair_id` (crypto.randomUUID); it clears `sync_state` for each new source calendar so existing events get a full sync.
- `deleteSyncLink` deletes the link row AND its pair (same `pair_id`), best-effort deleting all mapped target events first (sequentially; ignore individual failures).
- `deleteConnection` deletes the connection row (calendars/links/mappings cascade). No remote cleanup — document as a limitation on the page ("delete sync links first to remove blockers").

- [ ] **Step 1: Write server actions**

`src/app/actions.ts`:
```ts
'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireAuth } from '../lib/auth'
import { startConnectionFlow } from '../lib/connections'
import { getDb } from '../lib/db'
import { NotFoundError } from '../lib/composio'
import { googleProvider } from '../lib/providers/google'
import { outlookProvider } from '../lib/providers/outlook'
import { runOnce } from '../lib/scheduler'
import { getSetting } from '../lib/settings'

const providerFor = (p: 'google' | 'outlook') => (p === 'google' ? googleProvider : outlookProvider)

export async function connect(formData: FormData) {
  await requireAuth()
  const provider = String(formData.get('provider')) as 'google' | 'outlook'
  let redirectUrl: string
  try {
    redirectUrl = await startConnectionFlow(getDb(), provider, process.env.BASE_URL ?? 'http://localhost:3000')
  } catch (e) {
    redirect(e instanceof Error && e.message === 'missing-auth-config' ? '/settings?error=missing-auth-config' : '/?error=connect-failed')
  }
  redirect(redirectUrl)
}

export async function deleteConnection(formData: FormData) {
  await requireAuth()
  getDb().prepare('DELETE FROM connections WHERE id = ?').run(Number(formData.get('id')))
  revalidatePath('/')
}

export async function createSyncLink(formData: FormData) {
  await requireAuth()
  const db = getDb()
  const source = Number(formData.get('source'))
  const target = Number(formData.get('target'))
  const mode = String(formData.get('mode')) === 'clone' ? 'clone' : 'busy'
  const busyTitle = String(formData.get('busy_title') || getSetting(db, 'default_busy_title', 'Busy'))
  const twoWay = formData.get('two_way') === 'on'
  if (!source || !target || source === target) redirect('/?error=same-calendar')

  const pairId = twoWay ? randomUUID() : null
  const insert = db.prepare('INSERT INTO sync_links (source_calendar_id, target_calendar_id, mode, busy_title, pair_id) VALUES (?, ?, ?, ?, ?)')
  const clearCursor = db.prepare('DELETE FROM sync_state WHERE calendar_id = ?')
  insert.run(source, target, mode, busyTitle, pairId)
  clearCursor.run(source)
  if (twoWay) {
    insert.run(target, source, mode, busyTitle, pairId)
    clearCursor.run(target)
  }
  revalidatePath('/')
}

export async function deleteSyncLink(formData: FormData) {
  await requireAuth()
  const db = getDb()
  const id = Number(formData.get('id'))
  const link = db.prepare('SELECT id, pair_id FROM sync_links WHERE id = ?').get(id) as { id: number; pair_id: string | null } | undefined
  if (!link) return
  const ids = link.pair_id
    ? (db.prepare('SELECT id FROM sync_links WHERE pair_id = ?').all(link.pair_id) as { id: number }[]).map((r) => r.id)
    : [link.id]

  for (const linkId of ids) {
    const rows = db.prepare(
      `SELECT m.target_event_id, tc.provider_calendar_id AS tgt_cal, tcon.provider AS tgt_provider, tcon.composio_connected_account_id AS tgt_account
       FROM event_mappings m
       JOIN sync_links l ON l.id = m.sync_link_id
       JOIN calendars tc ON tc.id = l.target_calendar_id
       JOIN connections tcon ON tcon.id = tc.connection_id
       WHERE m.sync_link_id = ?`,
    ).all(linkId) as { target_event_id: string; tgt_cal: string; tgt_provider: 'google' | 'outlook'; tgt_account: string }[]
    for (const row of rows) {
      try {
        await providerFor(row.tgt_provider).deleteEvent(row.tgt_account, row.tgt_cal, row.target_event_id)
      } catch (e) {
        if (!(e instanceof NotFoundError)) console.error('cleanup failed:', e)
      }
    }
    db.prepare('DELETE FROM sync_links WHERE id = ?').run(linkId)
  }
  revalidatePath('/')
}

export async function syncNow() {
  await requireAuth()
  await runOnce()
  revalidatePath('/')
}
```

- [ ] **Step 2: Write the dashboard page**

`src/app/page.tsx`:
```tsx
import Link from 'next/link'
import { requireAuth } from '../lib/auth'
import { getDb } from '../lib/db'
import { connect, createSyncLink, deleteConnection, deleteSyncLink, syncNow } from './actions'

export const dynamic = 'force-dynamic'

type ConnectionRow = { id: number; provider: string; account_label: string; status: string }
type CalendarRow = { id: number; name: string; account_label: string; provider: string }
type LinkRow = {
  id: number; mode: string; pair_id: string | null; last_run_at: string | null; last_error: string | null
  src_name: string; src_label: string; tgt_name: string; tgt_label: string
}
type RunRow = { started_at: string; duration_ms: number; events_processed: number; errors: string | null }

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireAuth()
  const { error } = await searchParams
  const db = getDb()
  const connections = db.prepare('SELECT id, provider, account_label, status FROM connections ORDER BY id').all() as ConnectionRow[]
  const calendars = db.prepare(
    `SELECT c.id, c.name, con.account_label, con.provider FROM calendars c JOIN connections con ON con.id = c.connection_id WHERE con.status = 'active' ORDER BY con.id, c.name`,
  ).all() as CalendarRow[]
  const links = db.prepare(
    `SELECT l.id, l.mode, l.pair_id, l.last_run_at, l.last_error,
            sc.name AS src_name, scon.account_label AS src_label, tc.name AS tgt_name, tcon.account_label AS tgt_label
     FROM sync_links l
     JOIN calendars sc ON sc.id = l.source_calendar_id JOIN connections scon ON scon.id = sc.connection_id
     JOIN calendars tc ON tc.id = l.target_calendar_id JOIN connections tcon ON tcon.id = tc.connection_id
     ORDER BY l.id`,
  ).all() as LinkRow[]
  const runs = db.prepare('SELECT started_at, duration_ms, events_processed, errors FROM sync_runs ORDER BY id DESC LIMIT 10').all() as RunRow[]

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">opencal-sync</h1>
        <nav className="space-x-4 text-sm text-zinc-600">
          <Link href="/availability">Availability</Link>
          <Link href="/settings">Settings</Link>
        </nav>
      </header>

      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">Error: {error}</p>}

      <section className="rounded-lg border border-zinc-200 bg-white p-6">
        <h2 className="mb-4 font-medium">Connected accounts</h2>
        <ul className="space-y-2">
          {connections.map((c) => (
            <li key={c.id} className="flex items-center justify-between text-sm">
              <span>
                {c.provider === 'google' ? 'Google' : 'Outlook'} — {c.account_label || 'pending…'}{' '}
                <span className={c.status === 'active' ? 'text-green-600' : 'text-amber-600'}>({c.status})</span>
              </span>
              <form action={deleteConnection}>
                <input type="hidden" name="id" value={c.id} />
                <button className="text-red-600 hover:underline">remove</button>
              </form>
            </li>
          ))}
          {connections.length === 0 && <li className="text-sm text-zinc-500">No accounts connected yet.</li>}
        </ul>
        <div className="mt-4 flex gap-2">
          <form action={connect}>
            <input type="hidden" name="provider" value="google" />
            <button className="rounded border border-zinc-300 px-3 py-1.5 text-sm">+ Connect Google</button>
          </form>
          <form action={connect}>
            <input type="hidden" name="provider" value="outlook" />
            <button className="rounded border border-zinc-300 px-3 py-1.5 text-sm">+ Connect Outlook</button>
          </form>
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-medium">Sync links</h2>
          <form action={syncNow}>
            <button className="rounded bg-zinc-900 px-3 py-1.5 text-sm text-white">Sync now</button>
          </form>
        </div>
        <ul className="space-y-2">
          {links.map((l) => (
            <li key={l.id} className="flex items-center justify-between text-sm">
              <span>
                {l.src_label}/{l.src_name} → {l.tgt_label}/{l.tgt_name} <span className="text-zinc-500">({l.mode}{l.pair_id ? ', two-way pair' : ''})</span>
                {l.last_error && <span className="ml-2 text-red-600" title={l.last_error}>⚠ {l.last_error.slice(0, 60)}</span>}
              </span>
              <form action={deleteSyncLink}>
                <input type="hidden" name="id" value={l.id} />
                <button className="text-red-600 hover:underline">delete</button>
              </form>
            </li>
          ))}
          {links.length === 0 && <li className="text-sm text-zinc-500">No sync links yet.</li>}
        </ul>

        {calendars.length >= 2 ? (
          <form action={createSyncLink} className="mt-4 grid grid-cols-2 gap-2 text-sm">
            <select name="source" className="rounded border border-zinc-300 px-2 py-1.5">
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>{c.account_label}/{c.name}</option>
              ))}
            </select>
            <select name="target" className="rounded border border-zinc-300 px-2 py-1.5">
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>{c.account_label}/{c.name}</option>
              ))}
            </select>
            <select name="mode" className="rounded border border-zinc-300 px-2 py-1.5">
              <option value="busy">Busy blocker</option>
              <option value="clone">Full clone</option>
            </select>
            <input name="busy_title" placeholder="Blocker title (Busy)" className="rounded border border-zinc-300 px-2 py-1.5" />
            <label className="flex items-center gap-2"><input type="checkbox" name="two_way" /> two-way</label>
            <button className="rounded bg-zinc-900 px-3 py-1.5 text-white">Add sync</button>
          </form>
        ) : (
          <p className="mt-4 text-sm text-zinc-500">Connect at least two calendars to create a sync.</p>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-6">
        <h2 className="mb-4 font-medium">Recent sync runs</h2>
        <ul className="space-y-1 text-sm text-zinc-600">
          {runs.map((r, i) => (
            <li key={i}>
              {r.started_at} — {r.events_processed} events in {r.duration_ms}ms
              {r.errors && <span className="text-red-600"> — {r.errors.slice(0, 80)}</span>}
            </li>
          ))}
          {runs.length === 0 && <li className="text-zinc-500">No runs yet.</li>}
        </ul>
      </section>
    </main>
  )
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm run build && npx vitest run` — Expected: all pass.
Run: `ADMIN_PASSWORD=test COMPOSIO_API_KEY=fake BASE_URL=http://localhost:3000 npm run dev` — visit http://localhost:3000, confirm redirect to /login, log in with "test", dashboard renders with empty states. Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add src/app/actions.ts src/app/page.tsx
git commit -m "feat: dashboard with connections, sync links and runs"
```

---

### Task 12: Settings page

**Files:**
- Create: `src/app/settings/page.tsx`

**Interfaces:**
- Consumes: `requireAuth`, `getDb`, `getSetting`, `setSetting`.
- Produces: nothing consumed downstream; writes settings keys defined in Task 2.

- [ ] **Step 1: Write the page**

`src/app/settings/page.tsx`:
```tsx
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireAuth } from '../../lib/auth'
import { getDb } from '../../lib/db'
import { getSetting, setSetting } from '../../lib/settings'

export const dynamic = 'force-dynamic'

const FIELDS = [
  { key: 'google_auth_config_id', label: 'Composio auth config ID — Google Calendar', placeholder: 'ac_…', hint: 'Requires your own Google OAuth app (see README).' },
  { key: 'outlook_auth_config_id', label: 'Composio auth config ID — Outlook', placeholder: 'ac_…', hint: 'Composio managed auth works — no Azure app needed.' },
  { key: 'poll_interval_minutes', label: 'Poll interval (minutes)', placeholder: '5', hint: '2 source calendars at 5 min ≈ 17k Composio calls/month (free tier: 20k).' },
  { key: 'sync_window_days', label: 'Sync window (days ahead)', placeholder: '60', hint: '' },
  { key: 'default_busy_title', label: 'Default blocker title', placeholder: 'Busy', hint: '' },
] as const

const DEFAULTS: Record<string, string> = {
  google_auth_config_id: '', outlook_auth_config_id: '',
  poll_interval_minutes: '5', sync_window_days: '60', default_busy_title: 'Busy',
}

async function save(formData: FormData) {
  'use server'
  await requireAuth()
  const db = getDb()
  for (const key of Object.keys(DEFAULTS)) setSetting(db, key, String(formData.get(key) ?? DEFAULTS[key]))
  redirect('/settings?saved=1')
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  await requireAuth()
  const { saved, error } = await searchParams
  const db = getDb()
  return (
    <main className="mx-auto max-w-xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Settings</h1>
        <Link href="/" className="text-sm text-zinc-600">← Dashboard</Link>
      </header>
      {saved && <p className="rounded bg-green-50 p-3 text-sm text-green-700">Saved.</p>}
      {error === 'missing-auth-config' && (
        <p className="rounded bg-amber-50 p-3 text-sm text-amber-800">
          Set the Composio auth config ID for that provider first (create one at app.composio.dev, see README).
        </p>
      )}
      <form action={save} className="space-y-4 rounded-lg border border-zinc-200 bg-white p-6">
        {FIELDS.map((f) => (
          <label key={f.key} className="block text-sm">
            <span className="mb-1 block font-medium">{f.label}</span>
            <input
              name={f.key}
              defaultValue={getSetting(db, f.key, DEFAULTS[f.key])}
              placeholder={f.placeholder}
              className="w-full rounded border border-zinc-300 px-3 py-2"
            />
            {f.hint && <span className="mt-1 block text-xs text-zinc-500">{f.hint}</span>}
          </label>
        ))}
        <button className="rounded bg-zinc-900 px-4 py-2 text-sm text-white">Save</button>
      </form>
    </main>
  )
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npm run build` — Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/settings/page.tsx
git commit -m "feat: settings page"
```

---

### Task 13: Availability computation (pure)

**Files:**
- Create: `src/lib/availability.ts`
- Test: `src/lib/availability.test.ts`

**Interfaces:**
- Consumes: nothing app-internal (pure module).
- Produces (Task 14 depends on):
  - `type Interval = { start: number; end: number }` (epoch ms)
  - `mergeIntervals(intervals: Interval[]): Interval[]` — sorted, overlaps merged, zero/negative-length dropped.
  - `zonedTimeToUtc(date: string, time: string, tz: string): number` — epoch ms of `date`(YYYY-MM-DD) `time`(HH:mm) in IANA `tz`; DST-correct via Intl.
  - `type WorkingHours = { days: string[]; start: string; end: string }` — days are `['mon','tue','wed','thu','fri','sat','sun']` subset.
  - `type DaySlots = { date: string; weekday: string; slots: { start: string; end: string }[] }` — local HH:mm strings.
  - `computeFreeSlots(opts: { busy: Interval[]; hours: WorkingHours; timezone: string; daysAhead: number; from: number }): DaySlots[]`
  - `formatSummary(days: DaySlots[]): string` — one line per day with slots, e.g. `Wed 2026-07-08: 10:00–12:30, 14:00–17:00`.

- [ ] **Step 1: Write the failing test**

`src/lib/availability.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { computeFreeSlots, formatSummary, mergeIntervals, zonedTimeToUtc } from './availability'

describe('mergeIntervals', () => {
  it('merges overlapping and adjacent intervals', () => {
    expect(mergeIntervals([
      { start: 10, end: 20 }, { start: 15, end: 25 }, { start: 25, end: 30 }, { start: 50, end: 60 },
    ])).toEqual([{ start: 10, end: 30 }, { start: 50, end: 60 }])
  })
  it('drops empty intervals and handles unsorted input', () => {
    expect(mergeIntervals([{ start: 5, end: 5 }, { start: 3, end: 1 }, { start: 2, end: 4 }])).toEqual([{ start: 2, end: 4 }])
  })
})

describe('zonedTimeToUtc', () => {
  it('converts wall-clock time in a timezone to epoch ms', () => {
    // Sofia is UTC+3 in July (EEST)
    expect(zonedTimeToUtc('2026-07-08', '09:00', 'Europe/Sofia')).toBe(Date.parse('2026-07-08T06:00:00Z'))
    // and UTC+2 in January (EET)
    expect(zonedTimeToUtc('2026-01-08', '09:00', 'Europe/Sofia')).toBe(Date.parse('2026-01-08T07:00:00Z'))
  })
  it('handles UTC', () => {
    expect(zonedTimeToUtc('2026-07-08', '12:30', 'UTC')).toBe(Date.parse('2026-07-08T12:30:00Z'))
  })
})

describe('computeFreeSlots', () => {
  const hours = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00' }
  // from = Wed 2026-07-08 00:00 UTC
  const from = Date.parse('2026-07-08T00:00:00Z')

  it('returns full working day when nothing is busy', () => {
    const days = computeFreeSlots({ busy: [], hours, timezone: 'UTC', daysAhead: 1, from })
    expect(days).toEqual([{ date: '2026-07-08', weekday: 'wed', slots: [{ start: '09:00', end: '17:00' }] }])
  })

  it('subtracts busy intervals and skips non-working days', () => {
    const busy = [
      { start: Date.parse('2026-07-08T10:00:00Z'), end: Date.parse('2026-07-08T11:30:00Z') },
      { start: Date.parse('2026-07-08T08:00:00Z'), end: Date.parse('2026-07-08T09:15:00Z') },
    ]
    const days = computeFreeSlots({ busy, hours, timezone: 'UTC', daysAhead: 4, from })
    expect(days[0]).toEqual({
      date: '2026-07-08', weekday: 'wed',
      slots: [{ start: '09:15', end: '10:00' }, { start: '11:30', end: '17:00' }],
    })
    // Jul 11 is Saturday, Jul 12 Sunday — not present
    expect(days.map((d) => d.date)).toEqual(['2026-07-08', '2026-07-09', '2026-07-10'])
  })

  it('drops slots shorter than 15 minutes and fully-busy days keep empty slot lists', () => {
    const busy = [{ start: Date.parse('2026-07-08T09:00:00Z'), end: Date.parse('2026-07-08T16:50:00Z') }]
    const days = computeFreeSlots({ busy, hours, timezone: 'UTC', daysAhead: 1, from })
    expect(days[0].slots).toEqual([])
  })

  it('respects timezones for day boundaries', () => {
    // busy 06:00-14:00 UTC = 09:00-17:00 in Sofia (UTC+3) — the whole working day
    const busy = [{ start: Date.parse('2026-07-08T06:00:00Z'), end: Date.parse('2026-07-08T14:00:00Z') }]
    const days = computeFreeSlots({ busy, hours, timezone: 'Europe/Sofia', daysAhead: 1, from })
    expect(days[0].slots).toEqual([])
  })
})

describe('formatSummary', () => {
  it('formats one line per day', () => {
    expect(formatSummary([
      { date: '2026-07-08', weekday: 'wed', slots: [{ start: '09:15', end: '10:00' }, { start: '11:30', end: '17:00' }] },
      { date: '2026-07-09', weekday: 'thu', slots: [] },
    ])).toBe('Wed 2026-07-08: 09:15–10:00, 11:30–17:00\nThu 2026-07-09: no availability')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/availability.test.ts`
Expected: FAIL — cannot find module './availability'.

- [ ] **Step 3: Write implementation**

`src/lib/availability.ts`:
```ts
export type Interval = { start: number; end: number }

export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start)
  const out: Interval[] = []
  for (const cur of sorted) {
    const last = out[out.length - 1]
    if (last && cur.start <= last.end) last.end = Math.max(last.end, cur.end)
    else out.push({ ...cur })
  }
  return out
}

function tzParts(tz: string, utcMs: number): Record<string, string> {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short',
  })
  return Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]))
}

function tzOffset(tz: string, utcMs: number): number {
  const p = tzParts(tz, utcMs)
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second)
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

export function zonedTimeToUtc(date: string, time: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  const naive = Date.UTC(y, m - 1, d, hh, mm)
  const off1 = tzOffset(tz, naive)
  let ts = naive - off1
  const off2 = tzOffset(tz, ts)
  if (off2 !== off1) ts = naive - off2
  return ts
}

export type WorkingHours = { days: string[]; start: string; end: string }
export type DaySlots = { date: string; weekday: string; slots: { start: string; end: string }[] }

const MIN_SLOT_MS = 15 * 60_000

function localHm(tz: string, utcMs: number): string {
  const p = tzParts(tz, utcMs)
  return `${p.hour === '24' ? '00' : p.hour}:${p.minute}`
}

export function computeFreeSlots(opts: {
  busy: Interval[]
  hours: WorkingHours
  timezone: string
  daysAhead: number
  from: number
}): DaySlots[] {
  const busy = mergeIntervals(opts.busy)
  const days: DaySlots[] = []
  // anchor at local noon of the start day and step 24h — immune to DST day-length changes
  const startParts = tzParts(opts.timezone, opts.from)
  const startDate = `${startParts.year}-${startParts.month}-${startParts.day}`
  let anchor = zonedTimeToUtc(startDate, '12:00', opts.timezone)

  for (let i = 0; i < opts.daysAhead; i++, anchor += 86_400_000) {
    const p = tzParts(opts.timezone, anchor)
    const weekday = p.weekday.toLowerCase().slice(0, 3)
    if (!opts.hours.days.includes(weekday)) continue
    const date = `${p.year}-${p.month}-${p.day}`
    const windowStart = Math.max(zonedTimeToUtc(date, opts.hours.start, opts.timezone), opts.from)
    const windowEnd = zonedTimeToUtc(date, opts.hours.end, opts.timezone)
    if (windowEnd <= windowStart) {
      days.push({ date, weekday, slots: [] })
      continue
    }

    const slots: { start: string; end: string }[] = []
    let cursor = windowStart
    for (const b of busy) {
      if (b.end <= cursor || b.start >= windowEnd) continue
      if (b.start - cursor >= MIN_SLOT_MS) slots.push({ start: localHm(opts.timezone, cursor), end: localHm(opts.timezone, b.start) })
      cursor = Math.max(cursor, b.end)
    }
    if (windowEnd - cursor >= MIN_SLOT_MS) slots.push({ start: localHm(opts.timezone, cursor), end: localHm(opts.timezone, windowEnd) })
    days.push({ date, weekday, slots })
  }
  return days
}

export function formatSummary(days: DaySlots[]): string {
  return days
    .map((d) => {
      const label = `${d.weekday[0].toUpperCase()}${d.weekday.slice(1)} ${d.date}`
      return d.slots.length ? `${label}: ${d.slots.map((s) => `${s.start}–${s.end}`).join(', ')}` : `${label}: no availability`
    })
    .join('\n')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/availability.test.ts` — Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/availability.ts src/lib/availability.test.ts
git commit -m "feat: timezone-aware free slot computation"
```

---

### Task 14: Availability pages (admin UI + public page)

**Files:**
- Create: `src/app/availability/page.tsx`, `src/app/a/[slug]/page.tsx`, `src/lib/availability-data.ts`

**Interfaces:**
- Consumes: `requireAuth`, `getDb`, `computeFreeSlots`/`formatSummary`/`zonedTimeToUtc`/`mergeIntervals` (Task 13), providers (Task 5/6).
- Produces: `getAvailability(slug: string): Promise<{ page: PageRow; days: DaySlots[]; summary: string } | null>` in `availability-data.ts`, cached 5 minutes per slug in-memory.

- [ ] **Step 1: Write the data helper**

`src/lib/availability-data.ts`:
```ts
import { computeFreeSlots, formatSummary, mergeIntervals, zonedTimeToUtc, type DaySlots, type Interval, type WorkingHours } from './availability'
import { getDb } from './db'
import { googleProvider } from './providers/google'
import { outlookProvider } from './providers/outlook'

export type PageRow = {
  id: number
  slug: string
  calendar_ids: string
  working_hours: string
  timezone: string
  days_ahead: number
  enabled: number
}

type CacheEntry = { at: number; value: { page: PageRow; days: DaySlots[]; summary: string } }

declare global {
  // eslint-disable-next-line no-var
  var __opencalAvailCache: Map<string, CacheEntry> | undefined
}

const CACHE_MS = 5 * 60_000

export async function getAvailability(slug: string): Promise<{ page: PageRow; days: DaySlots[]; summary: string } | null> {
  const cache = (globalThis.__opencalAvailCache ??= new Map())
  const hit = cache.get(slug)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value

  const db = getDb()
  const page = db.prepare('SELECT * FROM availability_pages WHERE slug = ? AND enabled = 1').get(slug) as PageRow | undefined
  if (!page) return null

  const hours = JSON.parse(page.working_hours) as WorkingHours
  const calendarIds = JSON.parse(page.calendar_ids) as number[]
  const from = Date.now()
  const timeMax = new Date(from + page.days_ahead * 86_400_000).toISOString()

  const busy: Interval[] = []
  for (const calId of calendarIds) {
    const cal = db.prepare(
      `SELECT c.provider_calendar_id, con.provider, con.composio_connected_account_id AS account
       FROM calendars c JOIN connections con ON con.id = c.connection_id
       WHERE c.id = ? AND con.status = 'active'`,
    ).get(calId) as { provider_calendar_id: string; provider: 'google' | 'outlook'; account: string } | undefined
    if (!cal) continue
    const provider = cal.provider === 'google' ? googleProvider : outlookProvider
    const events = await provider.listEvents(cal.account, cal.provider_calendar_id, new Date(from).toISOString(), timeMax)
    for (const ev of events) {
      if (ev.status !== 'active' || ev.transparent) continue
      const start = ev.allDay ? zonedTimeToUtc(ev.start, '00:00', page.timezone) : Date.parse(ev.start)
      const end = ev.allDay ? zonedTimeToUtc(ev.end, '00:00', page.timezone) : Date.parse(ev.end)
      if (Number.isFinite(start) && Number.isFinite(end)) busy.push({ start, end })
    }
  }

  const days = computeFreeSlots({ busy: mergeIntervals(busy), hours, timezone: page.timezone, daysAhead: page.days_ahead, from })
  const value = { page, days, summary: formatSummary(days) }
  cache.set(slug, { at: Date.now(), value })
  return value
}
```

- [ ] **Step 2: Write the admin page**

`src/app/availability/page.tsx`:
```tsx
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireAuth } from '../../lib/auth'
import { getDb } from '../../lib/db'

export const dynamic = 'force-dynamic'

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

async function savePage(formData: FormData) {
  'use server'
  await requireAuth()
  const db = getDb()
  const slug = String(formData.get('slug') ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
  if (!slug) redirect('/availability?error=slug')
  const calendarIds = formData.getAll('calendar_ids').map(Number).filter(Boolean)
  const hours = {
    days: WEEKDAYS.filter((d) => formData.get(`day_${d}`) === 'on'),
    start: String(formData.get('start') || '09:00'),
    end: String(formData.get('end') || '17:00'),
  }
  db.prepare(
    `INSERT INTO availability_pages (slug, calendar_ids, working_hours, timezone, days_ahead)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET calendar_ids = excluded.calendar_ids, working_hours = excluded.working_hours,
       timezone = excluded.timezone, days_ahead = excluded.days_ahead`,
  ).run(slug, JSON.stringify(calendarIds), JSON.stringify(hours), String(formData.get('timezone') || 'UTC'), Number(formData.get('days_ahead') || 14))
  redirect('/availability')
}

async function deletePage(formData: FormData) {
  'use server'
  await requireAuth()
  getDb().prepare('DELETE FROM availability_pages WHERE id = ?').run(Number(formData.get('id')))
  redirect('/availability')
}

export default async function AvailabilityAdmin() {
  await requireAuth()
  const db = getDb()
  const pages = db.prepare('SELECT id, slug, timezone, days_ahead FROM availability_pages ORDER BY id').all() as {
    id: number; slug: string; timezone: string; days_ahead: number
  }[]
  const calendars = db.prepare(
    `SELECT c.id, c.name, con.account_label FROM calendars c JOIN connections con ON con.id = c.connection_id WHERE con.status = 'active' ORDER BY con.id, c.name`,
  ).all() as { id: number; name: string; account_label: string }[]
  const timezones = Intl.supportedValuesOf('timeZone')

  return (
    <main className="mx-auto max-w-xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Availability pages</h1>
        <Link href="/" className="text-sm text-zinc-600">← Dashboard</Link>
      </header>

      <ul className="space-y-2">
        {pages.map((p) => (
          <li key={p.id} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-4 text-sm">
            <span>
              <a href={`/a/${p.slug}`} className="font-medium text-blue-700 hover:underline">/a/{p.slug}</a>
              <span className="ml-2 text-zinc-500">{p.timezone}, next {p.days_ahead} days</span>
            </span>
            <form action={deletePage}>
              <input type="hidden" name="id" value={p.id} />
              <button className="text-red-600 hover:underline">delete</button>
            </form>
          </li>
        ))}
        {pages.length === 0 && <li className="text-sm text-zinc-500">No availability pages yet.</li>}
      </ul>

      <form action={savePage} className="space-y-3 rounded-lg border border-zinc-200 bg-white p-6 text-sm">
        <h2 className="font-medium">Create / update page</h2>
        <input name="slug" placeholder="slug (e.g. me)" required className="w-full rounded border border-zinc-300 px-3 py-2" />
        <fieldset>
          <legend className="mb-1 font-medium">Calendars counted as busy</legend>
          {calendars.map((c) => (
            <label key={c.id} className="mr-4 inline-flex items-center gap-1">
              <input type="checkbox" name="calendar_ids" value={c.id} /> {c.account_label}/{c.name}
            </label>
          ))}
          {calendars.length === 0 && <p className="text-zinc-500">Connect calendars first.</p>}
        </fieldset>
        <fieldset>
          <legend className="mb-1 font-medium">Working days</legend>
          {WEEKDAYS.map((d) => (
            <label key={d} className="mr-3 inline-flex items-center gap-1">
              <input type="checkbox" name={`day_${d}`} defaultChecked={!['sat', 'sun'].includes(d)} /> {d}
            </label>
          ))}
        </fieldset>
        <div className="grid grid-cols-2 gap-2">
          <label>Start <input type="time" name="start" defaultValue="09:00" className="w-full rounded border border-zinc-300 px-2 py-1.5" /></label>
          <label>End <input type="time" name="end" defaultValue="17:00" className="w-full rounded border border-zinc-300 px-2 py-1.5" /></label>
          <label>Timezone
            <select name="timezone" defaultValue="UTC" className="w-full rounded border border-zinc-300 px-2 py-1.5">
              {timezones.map((tz) => <option key={tz}>{tz}</option>)}
            </select>
          </label>
          <label>Days ahead <input type="number" name="days_ahead" defaultValue={14} min={1} max={60} className="w-full rounded border border-zinc-300 px-2 py-1.5" /></label>
        </div>
        <button className="rounded bg-zinc-900 px-4 py-2 text-white">Save page</button>
      </form>
    </main>
  )
}
```

- [ ] **Step 3: Write the public page**

`src/app/a/[slug]/page.tsx`:
```tsx
import { notFound } from 'next/navigation'
import { getAvailability } from '../../../lib/availability-data'

export const dynamic = 'force-dynamic'

export default async function PublicAvailability({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const result = await getAvailability(slug)
  if (!result) notFound()
  const { page, days, summary } = result

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-8">
      <h1 className="text-xl font-semibold">Availability</h1>
      <p className="text-sm text-zinc-500">All times in {page.timezone}. Next {page.days_ahead} days.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {days.map((d) => (
          <div key={d.date} className="rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-medium">
              {d.weekday[0].toUpperCase() + d.weekday.slice(1)} {d.date}
            </h2>
            {d.slots.length ? (
              <ul className="space-y-1 text-sm text-green-700">
                {d.slots.map((s, i) => <li key={i}>{s.start} – {s.end}</li>)}
              </ul>
            ) : (
              <p className="text-sm text-zinc-400">No availability</p>
            )}
          </div>
        ))}
      </div>
      <section>
        <h2 className="mb-2 text-sm font-medium">Copy as text</h2>
        <pre className="overflow-x-auto rounded-lg border border-zinc-200 bg-white p-4 text-xs">{summary}</pre>
      </section>
    </main>
  )
}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npm run build && npx vitest run` — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/availability-data.ts src/app/availability/page.tsx src/app/a
git commit -m "feat: availability pages with public free-slot view"
```

---

### Task 15: Docker, CI, README, license

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.github/workflows/ci.yml`, `LICENSE`, `CONTRIBUTING.md`, `README.md`

- [ ] **Step 1: Write Docker files**

`Dockerfile`:
```dockerfile
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/app/data PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/src/lib/schema.sql ./src/lib/schema.sql
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "server.js"]
```

`docker-compose.yml`:
```yaml
services:
  opencal-sync:
    build: .
    ports:
      - '3000:3000'
    environment:
      COMPOSIO_API_KEY: ${COMPOSIO_API_KEY}
      ADMIN_PASSWORD: ${ADMIN_PASSWORD}
      BASE_URL: ${BASE_URL:-http://localhost:3000}
    volumes:
      - opencal-data:/app/data
    restart: unless-stopped

volumes:
  opencal-data:
```

`.dockerignore`:
```
node_modules
.next
data
.git
.env
docs
```

- [ ] **Step 2: Write CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npx vitest run
      - run: npm run build
```

- [ ] **Step 3: Write LICENSE (MIT, standard text with `Copyright (c) 2026 opencal-sync contributors`) and CONTRIBUTING.md**

`CONTRIBUTING.md`:
```markdown
# Contributing

PRs welcome. Before opening one:

1. `npm install`
2. `npx vitest run && npx tsc --noEmit && npm run build` must pass.
3. Keep Composio tool slugs/payloads inside `src/lib/providers/` only.
4. New sync logic needs a unit test (see `src/lib/sync/*.test.ts` for the style).

To verify a Composio tool's live parameter schema against the code:
`COMPOSIO_API_KEY=... npx tsx scripts/dump-tool-schema.ts GOOGLECALENDAR_CREATE_EVENT`
```

- [ ] **Step 4: Write README.md**

```markdown
# opencal-sync

Self-hosted, open-source calendar sync — a free [OneCal](https://onecal.io) alternative you run yourself.

- **Sync calendars**: mirror events between Google Calendar and Outlook accounts as privacy-safe "Busy" blockers or full clones. One-way or two-way.
- **Share availability**: a public page (`/a/your-slug`) showing your merged free slots across all calendars.
- **Own your data**: one Docker container, SQLite inside, your own API keys. No third-party service sees your events except [Composio](https://composio.dev), which brokers the calendar APIs.

## How it works

opencal-sync polls your calendars every few minutes through Composio's Google Calendar and Outlook tools using incremental sync (Google syncToken / Microsoft delta queries), then creates, updates, or deletes mirrored events. A local mapping table prevents sync loops and makes every operation idempotent. Events marked "Free" never create blockers. Attendees are never copied, so nobody gets re-invited.

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
git clone https://github.com/<you>/opencal-sync && cd opencal-sync
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
- Recurring events sync as individual instances inside the sync window (default 60 days ahead).
- Updated events are recreated (delete + create), so blocker event IDs change on edit.
- Removing a *connection* does not delete already-created blockers — delete its sync links first (that cleans up).
- Composio's tool schemas occasionally change; if a sync fails with a parameter error, check `scripts/dump-tool-schema.ts` (see CONTRIBUTING.md) and open an issue.

## Development

```bash
npm install
ADMIN_PASSWORD=dev COMPOSIO_API_KEY=... BASE_URL=http://localhost:3000 npm run dev
npx vitest run        # tests
```

MIT licensed.
```

- [ ] **Step 5: Verify Docker build**

Run: `docker build -t opencal-sync .`
Expected: image builds successfully. (If Docker is unavailable in the environment, note it and rely on CI/user verification.)

- [ ] **Step 6: Commit**

```bash
git add Dockerfile docker-compose.yml .dockerignore .github LICENSE CONTRIBUTING.md README.md
git commit -m "feat: docker packaging, CI and docs"
```

---

### Task 16: Publish public GitHub repo

- [ ] **Step 1: Final verification**

Run: `npx vitest run && npx tsc --noEmit && npm run build` — Expected: all pass.
Run: `git status` — Expected: clean tree.
Scan for secrets: `git grep -iE '(api[_-]?key|secret|password)\s*[:=]\s*["'\''][A-Za-z0-9]{16,}'` — Expected: no real credentials (only env var references and docs).

- [ ] **Step 2: Create and push the repo**

```bash
gh auth status
gh repo create opencal-sync --public --source=. --description "Self-hosted open-source calendar sync (OneCal alternative) — Google + Outlook via Composio" --push
```

Expected: repo created and `main` pushed. If `gh` is not authenticated, stop and ask the user to run `gh auth login`.

- [ ] **Step 3: Verify CI**

Run: `gh run watch --exit-status` (or `gh run list --limit 1`)
Expected: CI green.
