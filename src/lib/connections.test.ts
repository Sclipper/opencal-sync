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
