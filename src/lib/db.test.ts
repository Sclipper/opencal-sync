import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('is idempotent — schema can be applied twice to the same database', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'opencal-')), 'test.db')
    const db1 = createDb(path)
    db1.prepare("INSERT INTO connections (provider, status) VALUES ('google', 'active')").run()
    db1.close()
    const db2 = createDb(path) // re-applies schema to existing db — must not throw or drop data
    expect(db2.prepare('SELECT COUNT(*) AS n FROM connections').get()).toEqual({ n: 1 })
    db2.close()
  })

  it('cascades calendar + mapping deletes from connections', () => {
    const db = createDb()
    db.prepare("INSERT INTO connections (provider, status) VALUES ('google', 'active')").run()
    db.prepare("INSERT INTO calendars (connection_id, provider_calendar_id, name) VALUES (1, 'cal1', 'Work')").run()
    db.prepare("INSERT INTO connections (provider, status) VALUES ('outlook', 'active')").run()
    db.prepare("INSERT INTO calendars (connection_id, provider_calendar_id, name) VALUES (2, 'cal2', 'Personal')").run()
    db.prepare('INSERT INTO sync_links (source_calendar_id, target_calendar_id) VALUES (1, 2)').run()
    db.prepare("INSERT INTO event_mappings (sync_link_id, source_event_id, target_event_id, content_hash) VALUES (1, 'src1', 'tgt1', 'hash1')").run()
    db.prepare('DELETE FROM connections WHERE id = 1').run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM calendars').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_links').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM event_mappings').get()).toEqual({ n: 0 })
  })

  it('rejects duplicate sync_links for the same calendar pair', () => {
    const db = createDb()
    db.prepare("INSERT INTO connections (provider, status) VALUES ('google', 'active')").run()
    db.prepare("INSERT INTO calendars (connection_id, provider_calendar_id, name) VALUES (1, 'cal1', 'Work')").run()
    db.prepare("INSERT INTO connections (provider, status) VALUES ('outlook', 'active')").run()
    db.prepare("INSERT INTO calendars (connection_id, provider_calendar_id, name) VALUES (2, 'cal2', 'Personal')").run()
    db.prepare('INSERT INTO sync_links (source_calendar_id, target_calendar_id) VALUES (1, 2)').run()
    expect(() => db.prepare('INSERT INTO sync_links (source_calendar_id, target_calendar_id) VALUES (1, 2)').run()).toThrow(
      /UNIQUE constraint failed/,
    )
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
