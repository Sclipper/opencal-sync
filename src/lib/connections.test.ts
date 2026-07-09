import { describe, expect, it, vi } from 'vitest'
import { createDb } from './db'
import { setSetting } from './settings'
import { completeConnectionFlow, refreshCalendars, startConnectionFlow } from './connections'
import type { CalendarProvider } from './providers/types'

const fakeProvider: CalendarProvider = {
  listCalendars: vi.fn(async () => [
    { id: 'me@gmail.com', name: 'me@gmail.com', primary: true, accessRole: 'owner' },
    { id: 'cal-1', name: 'Work' },
  ]),
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
    expect(link).toHaveBeenCalledWith('default', 'ac_123', { callbackUrl: 'http://localhost:3000/api/connect/callback', allowMultiple: true })
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

    expect(db.prepare('SELECT composio_connected_account_id, account_label, composio_user_id, status FROM connections').get()).toEqual({
      composio_connected_account_id: 'ca_9', account_label: 'me@gmail.com', composio_user_id: 'default', status: 'active',
    })
    expect(db.prepare('SELECT provider_calendar_id, name, is_primary, access_role FROM calendars ORDER BY id').all()).toEqual([
      { provider_calendar_id: 'me@gmail.com', name: 'me@gmail.com', is_primary: 1, access_role: 'owner' },
      { provider_calendar_id: 'cal-1', name: 'Work', is_primary: 0, access_role: '' },
    ])
  })

  it('falls back to the primary calendar id when composio omits the email', async () => {
    const db = createDb()
    setSetting(db, 'google_auth_config_id', 'ac_123')
    const composio = {
      connectedAccounts: {
        link: vi.fn(async () => ({ id: 'req-1', redirectUrl: 'u' })),
        waitForConnection: vi.fn(async () => ({ id: 'ca_9', status: 'ACTIVE', data: {} })),
      },
    }
    await startConnectionFlow(db, 'google', 'http://x', { composio })

    await completeConnectionFlow(db, { composio, providerFor: () => fakeProvider })

    expect(db.prepare('SELECT account_label, status FROM connections').get()).toEqual({
      account_label: 'me@gmail.com', status: 'active',
    })
  })

  it('keeps the generic label when the primary calendar id is opaque (no @)', async () => {
    const db = createDb()
    setSetting(db, 'google_auth_config_id', 'ac_123')
    const composio = {
      connectedAccounts: {
        link: vi.fn(async () => ({ id: 'req-1', redirectUrl: 'u' })),
        waitForConnection: vi.fn(async () => ({ id: 'ca_9', status: 'ACTIVE', data: {} })),
      },
    }
    const opaqueProvider = {
      ...fakeProvider,
      listCalendars: vi.fn(async () => [{ id: 'AQMkADAwATM0MDAAMS1iOTZj', name: 'Calendar', primary: true }]),
    } as unknown as CalendarProvider
    await startConnectionFlow(db, 'google', 'http://x', { composio })

    await completeConnectionFlow(db, { composio, providerFor: () => opaqueProvider })

    expect(db.prepare('SELECT account_label, status FROM connections').get()).toEqual({
      account_label: 'google account', status: 'active',
    })
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

  it('never downgrades an active connection when a duplicate callback fails late', async () => {
    const db = createDb()
    setSetting(db, 'google_auth_config_id', 'ac_123')
    let call = 0
    const composio = {
      connectedAccounts: {
        link: vi.fn(async () => ({ id: 'req-1', redirectUrl: 'u' })),
        waitForConnection: vi.fn(async () => {
          call++
          if (call === 1) return { id: 'ca_9', status: 'ACTIVE', data: { email: 'me@gmail.com' } }
          throw new Error('timeout')
        }),
      },
    }
    await startConnectionFlow(db, 'google', 'http://x', { composio })

    // two overlapping callbacks resolve the same pending row
    await Promise.all([
      completeConnectionFlow(db, { composio, providerFor: () => fakeProvider }),
      completeConnectionFlow(db, { composio, providerFor: () => fakeProvider }),
    ])

    expect(db.prepare('SELECT status FROM connections').get()).toEqual({ status: 'active' })
  })

  it('is a no-op when nothing is pending', async () => {
    const db = createDb()
    await expect(completeConnectionFlow(db, {
      composio: { connectedAccounts: { link: vi.fn(), waitForConnection: vi.fn() } },
      providerFor: () => fakeProvider,
    })).resolves.toBeUndefined()
  })
})

describe('refreshCalendars', () => {
  it('upserts new calendars and backfills roles without deleting removed ones', async () => {
    const db = createDb()
    db.prepare("INSERT INTO connections (provider, composio_connected_account_id, account_label, status) VALUES ('google', 'ca_9', 'me@gmail.com', 'active')").run()
    const connId = (db.prepare('SELECT id FROM connections').get() as { id: number }).id
    // pre-migration row: no primary flag, no role, plus one calendar the provider no longer returns
    db.prepare("INSERT INTO calendars (connection_id, provider_calendar_id, name) VALUES (?, 'me@gmail.com', 'me@gmail.com')").run(connId)
    db.prepare("INSERT INTO calendars (connection_id, provider_calendar_id, name) VALUES (?, 'gone-cal', 'Old')").run(connId)

    const provider = {
      ...fakeProvider,
      listCalendars: vi.fn(async () => [
        { id: 'me@gmail.com', name: 'me@gmail.com', primary: true, accessRole: 'owner' },
        { id: 'family', name: 'Family', accessRole: 'reader' },
      ]),
    } as unknown as CalendarProvider

    await refreshCalendars(db, connId, { providerFor: () => provider })

    expect(db.prepare('SELECT provider_calendar_id, is_primary, access_role FROM calendars ORDER BY id').all()).toEqual([
      { provider_calendar_id: 'me@gmail.com', is_primary: 1, access_role: 'owner' },
      { provider_calendar_id: 'gone-cal', is_primary: 0, access_role: '' },
      { provider_calendar_id: 'family', is_primary: 0, access_role: 'reader' },
    ])
  })

  it('does nothing for inactive or unknown connections', async () => {
    const db = createDb()
    const listCalendars = vi.fn()
    await refreshCalendars(db, 999, { providerFor: () => ({ ...fakeProvider, listCalendars }) as unknown as CalendarProvider })
    expect(listCalendars).not.toHaveBeenCalled()
  })
})
