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
})
