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
  changes?: (cursor: string | null) => { events: NormalizedEvent[]; nextCursor: string | null; snapshot?: boolean }
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

  function deps(google: CalendarProvider, outlook: CalendarProvider, now?: () => Date) {
    return { db, providerFor: (p: 'google' | 'outlook') => (p === 'google' ? google : outlook), now }
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

  it('deletes a blocker whose source event vanished between two snapshot polls', async () => {
    let phase = 0
    const g = makeFakeProvider({
      changes: () => (phase === 0
        ? { events: [ev('e1'), ev('e2')], nextCursor: null, snapshot: true }
        : { events: [ev('e1')], nextCursor: null, snapshot: true }),
    })
    const o = makeFakeProvider({})
    await runSyncCycle(deps(g.provider, o.provider))
    phase = 1
    o.calls.length = 0

    const res = await runSyncCycle(deps(g.provider, o.provider))

    expect(res.processed).toBe(1)
    expect(o.calls).toEqual([{ method: 'deleteEvent', args: ['tgt-2'] }])
    expect(db.prepare('SELECT source_event_id FROM event_mappings').all()).toEqual([{ source_event_id: 'e1' }])
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
    // anchored_at fresh (just now) — isolates this test to the CursorExpiredError retry path,
    // not the daily re-anchor logic covered separately below.
    db.prepare("INSERT INTO sync_state (calendar_id, sync_cursor, anchored_at) VALUES (1, 'stale', datetime('now'))").run()
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

  it('rethrows RateLimitError raised mid-write without advancing the cursor', async () => {
    const g = makeFakeProvider({ changes: () => ({ events: [ev('e1')], nextCursor: 'c1' }) })
    const o = makeFakeProvider({ failCreateWith: new RateLimitError('429') })

    await expect(runSyncCycle(deps(g.provider, o.provider))).rejects.toBeInstanceOf(RateLimitError)
    // cycle logged, cursor NOT advanced, no mapping row left behind → next cycle self-heals with a clean create
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_runs').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_state').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM event_mappings').get()).toEqual({ n: 0 })
  })

  it('ignores links with inactive connections', async () => {
    db.prepare("UPDATE connections SET status = 'pending' WHERE id = 1").run()
    const g = makeFakeProvider({})
    const o = makeFakeProvider({})
    const res = await runSyncCycle(deps(g.provider, o.provider))
    expect(res.processed).toBe(0)
    expect(g.calls).toEqual([])
  })

  it('re-anchors with a full refetch when the stored anchor is stale (>24h)', async () => {
    const now = new Date('2026-07-10T00:00:00Z')
    const staleAnchor = new Date(now.getTime() - 25 * 3_600_000).toISOString()
    db.prepare("INSERT INTO sync_state (calendar_id, sync_cursor, anchored_at) VALUES (1, 'old', ?)").run(staleAnchor)
    const g = makeFakeProvider({ changes: (cursor) => ({ events: cursor === null ? [ev('e1')] : [], nextCursor: 'new-cursor' }) })
    const o = makeFakeProvider({})

    const res = await runSyncCycle(deps(g.provider, o.provider, () => now))

    expect(g.calls.map((c) => c.args[0])).toEqual([null])
    expect(res.processed).toBe(1)
    const row = db.prepare('SELECT sync_cursor, anchored_at FROM sync_state WHERE calendar_id = 1').get() as {
      sync_cursor: string
      anchored_at: string
    }
    expect(row.sync_cursor).toBe('new-cursor')
    expect(row.anchored_at).toBe(now.toISOString())
  })

  it('keeps the incremental cursor and preserves anchored_at when the anchor is fresh (<24h)', async () => {
    const now = new Date('2026-07-10T00:00:00Z')
    const freshAnchor = new Date(now.getTime() - 3_600_000).toISOString()
    db.prepare("INSERT INTO sync_state (calendar_id, sync_cursor, anchored_at) VALUES (1, 'cur', ?)").run(freshAnchor)
    const g = makeFakeProvider({ changes: () => ({ events: [], nextCursor: 'cur2' }) })
    const o = makeFakeProvider({})

    await runSyncCycle(deps(g.provider, o.provider, () => now))

    expect(g.calls.map((c) => c.args[0])).toEqual(['cur'])
    const row = db.prepare('SELECT sync_cursor, anchored_at FROM sync_state WHERE calendar_id = 1').get() as {
      sync_cursor: string
      anchored_at: string
    }
    expect(row.sync_cursor).toBe('cur2')
    expect(row.anchored_at).toBe(freshAnchor)
  })

  it('skips the cycle entirely while another cycle holds the lock', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('sync_lock', ?)").run(String(Date.now() + 60_000))
    const g = makeFakeProvider({ changes: () => ({ events: [ev('e1')], nextCursor: 'c' }) })
    const o = makeFakeProvider({})

    const res = await runSyncCycle(deps(g.provider, o.provider))

    expect(res).toEqual({ processed: 0, errors: [], skipped: true })
    expect(g.calls).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_runs').get()).toEqual({ n: 0 })
    // the foreign lock must survive a skipped cycle
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'sync_lock'").get()).toEqual({ n: 1 })
  })

  it('steals an expired lock (crashed holder) and releases its own on completion', async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('sync_lock', ?)").run(String(Date.now() - 1000))
    const g = makeFakeProvider({ changes: () => ({ events: [ev('e1')], nextCursor: 'c' }) })
    const o = makeFakeProvider({})

    const res = await runSyncCycle(deps(g.provider, o.provider))

    expect(res.processed).toBe(1)
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'sync_lock'").get()).toEqual({ n: 0 })
  })

  it('does not resurrect a cursor row an edit cleared mid-cycle (forced refetch survives)', async () => {
    db.prepare("INSERT INTO sync_state (calendar_id, sync_cursor, anchored_at) VALUES (1, 'cur', datetime('now'))").run()
    const g = makeFakeProvider({
      changes: () => {
        // simulate updateSyncLink racing the running cycle: it deletes the row to force a full refetch
        db.prepare('DELETE FROM sync_state WHERE calendar_id = 1').run()
        return { events: [], nextCursor: 'cur2' }
      },
    })
    const o = makeFakeProvider({})

    await runSyncCycle(deps(g.provider, o.provider))

    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_state WHERE calendar_id = 1').get()).toEqual({ n: 0 })
  })

  describe('janitor (google targets, full-refetch cycles)', () => {
    function seedGoogleToGoogle(db: DB) {
      db.prepare("INSERT INTO connections (provider, composio_connected_account_id, status) VALUES ('google', 'acc-g2', 'active')").run()
      db.prepare("INSERT INTO calendars (connection_id, provider_calendar_id, name) VALUES (3, 'gcal2', 'Target')").run()
      db.prepare("INSERT INTO sync_links (source_calendar_id, target_calendar_id, mode, busy_title) VALUES (1, 3, 'busy', 'Busy')").run()
      db.prepare('DELETE FROM sync_links WHERE id = 1').run() // drop the seed's outlook link
    }

    it('deletes untracked copies that match a link write-shape, sparing user events and mapped ones', async () => {
      seedGoogleToGoogle(db)
      const g = makeFakeProvider({ changes: () => ({ events: [ev('e1')], nextCursor: 'c1' }) })
      g.provider.listEvents = async () => [
        ev('tgt-1', { title: 'Busy' }), // the mapping created this cycle
        ev('orphan-1', { title: 'Busy', start: '2026-07-08T13:00:00+03:00', end: '2026-07-08T14:00:00+03:00' }), // same instants, offset notation
        ev('user-1', { title: 'Dentist' }), // real user event — untouched
      ]
      const deleted: string[] = []
      g.provider.deleteEvent = async (_a, _c, id) => { deleted.push(id) }

      const res = await runSyncCycle(deps(g.provider, makeFakeProvider({}).provider))

      expect(deleted).toEqual(['orphan-1'])
      expect(res.processed).toBe(2) // 1 create + 1 janitor delete
      expect(res.errors).toEqual([])
    })

    it('does not run on incremental cycles', async () => {
      seedGoogleToGoogle(db)
      db.prepare("INSERT INTO sync_state (calendar_id, sync_cursor, anchored_at) VALUES (1, 'cur', datetime('now'))").run()
      const g = makeFakeProvider({ changes: () => ({ events: [], nextCursor: 'c2' }) })
      let listed = 0
      g.provider.listEvents = async () => { listed++; return [] }

      await runSyncCycle(deps(g.provider, makeFakeProvider({}).provider))

      expect(listed).toBe(0)
    })

    it('reports janitor failures without failing the link or the cursor advance', async () => {
      seedGoogleToGoogle(db)
      const g = makeFakeProvider({ changes: () => ({ events: [], nextCursor: 'c1' }) })
      g.provider.listEvents = async () => { throw new Error('list boom') }

      const res = await runSyncCycle(deps(g.provider, makeFakeProvider({}).provider))

      expect(res.errors).toEqual(['janitor link 2: list boom'])
      expect(db.prepare('SELECT last_error FROM sync_links WHERE id = 2').get()).toEqual({ last_error: null })
      expect(db.prepare('SELECT sync_cursor FROM sync_state WHERE calendar_id = 1').get()).toEqual({ sync_cursor: 'c1' })
    })
  })
})
