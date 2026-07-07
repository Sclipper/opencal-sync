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
