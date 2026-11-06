import { describe, expect, it, vi } from 'vitest'
import { createDb, type DB } from './db'
import { NotFoundError, RateLimitError } from './composio'
import type { CalendarProvider } from './providers/types'
import { deleteLinkEvents, processRemovals } from './link-cleanup'

function seed(db: DB) {
  db.prepare("INSERT INTO connections (provider, composio_connected_account_id, status) VALUES ('google', 'acc-g', 'active')").run()
  db.prepare("INSERT INTO calendars (connection_id, provider_calendar_id, name) VALUES (1, 'src-cal', 'Src')").run()
  db.prepare("INSERT INTO calendars (connection_id, provider_calendar_id, name) VALUES (1, 'tgt-cal', 'Tgt')").run()
  db.prepare("INSERT INTO sync_links (source_calendar_id, target_calendar_id, mode, busy_title) VALUES (1, 2, 'busy', 'Busy')").run()
  db.prepare("INSERT INTO event_mappings (sync_link_id, source_event_id, target_event_id, content_hash) VALUES (1, 's1', 't1', 'h')").run()
  db.prepare("INSERT INTO event_mappings (sync_link_id, source_event_id, target_event_id, content_hash) VALUES (1, 's2', 't2', 'h')").run()
}

function provider(deleteEvent: (a: string, c: string, id: string) => Promise<void>): CalendarProvider {
  return { listCalendars: vi.fn(), listChanges: vi.fn(), listEvents: vi.fn(), createEvent: vi.fn(), deleteEvent } as unknown as CalendarProvider
}

describe('deleteLinkEvents', () => {
  it('deletes every mapped target event and its mapping', async () => {
    const db = createDb()
    seed(db)
    const deleted: string[] = []
    const res = await deleteLinkEvents(db, [1], () => provider(async (_a, _c, id) => { deleted.push(id) }))

    expect(res).toEqual({ deleted: 2, failed: 0 })
    expect(deleted).toEqual(['t1', 't2'])
    expect(db.prepare('SELECT COUNT(*) AS n FROM event_mappings').get()).toEqual({ n: 0 })
  })

  it('treats already-gone events as deleted', async () => {
    const db = createDb()
    seed(db)
    const res = await deleteLinkEvents(db, [1], () => provider(async () => { throw new NotFoundError('404') }))

    expect(res).toEqual({ deleted: 2, failed: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM event_mappings').get()).toEqual({ n: 0 })
  })

  it('keeps the mappings of failed deletions so a retry can finish the job', async () => {
    const db = createDb()
    seed(db)
    const res = await deleteLinkEvents(db, [1], () =>
      provider(async (_a, _c, id) => {
        if (id === 't2') throw new Error('rate limited')
      }),
    )

    expect(res).toEqual({ deleted: 1, failed: 1 })
    expect(db.prepare('SELECT target_event_id FROM event_mappings').all()).toEqual([{ target_event_id: 't2' }])
  })
})

describe('processRemovals', () => {
  const count = (db: DB, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  const fail = () => provider(async () => { throw new Error('boom') })

  it('leaves links and connections alone unless queued', async () => {
    const db = createDb()
    seed(db)
    const del = vi.fn(async () => {})
    await processRemovals(db, () => provider(del))
    expect(del).not.toHaveBeenCalled()
    expect(count(db, 'sync_links')).toBe(1)
  })

  it('removes a queued link once its events are gone', async () => {
    const db = createDb()
    seed(db)
    db.prepare('UPDATE sync_links SET enabled = 0').run()
    await processRemovals(db, () => provider(async () => {}))
    expect(count(db, 'sync_links')).toBe(0)
    expect(count(db, 'connections')).toBe(1)
  })

  it('keeps a queued link and retries while some events cannot be deleted', async () => {
    const db = createDb()
    seed(db)
    db.prepare('UPDATE sync_links SET enabled = 0').run()
    await processRemovals(db, fail)
    expect(db.prepare('SELECT last_error FROM sync_links').get()).toEqual({ last_error: '2 synced events could not be deleted yet, retrying' })

    await processRemovals(db, () => provider(async () => {}))
    expect(count(db, 'sync_links')).toBe(0)
  })

  it('removes a queued connection even when its deletes fail', async () => {
    const db = createDb()
    seed(db)
    db.prepare("UPDATE connections SET status = 'removing'").run()
    db.prepare('UPDATE sync_links SET enabled = 0').run()
    await processRemovals(db, fail)
    expect(count(db, 'connections')).toBe(0)
    expect(count(db, 'sync_links')).toBe(0)
  })

  it('stops on a rate limit and keeps the queued connection for the next pass', async () => {
    const db = createDb()
    seed(db)
    db.prepare("UPDATE connections SET status = 'removing'").run()
    await expect(processRemovals(db, () => provider(async () => { throw new RateLimitError('429') }))).rejects.toBeInstanceOf(RateLimitError)
    expect(count(db, 'connections')).toBe(1)
    expect(count(db, 'event_mappings')).toBe(2)
  })
})
