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
    db.prepare("UPDATE connections SET composio_connected_account_id = ?, account_label = ?, status = 'active' WHERE id = ? AND status = 'pending'")
      .run(account.id, label, pending.id)
    const calendars = await providerFor(pending.provider).listCalendars(account.id)
    const insert = db.prepare(
      'INSERT INTO calendars (connection_id, provider_calendar_id, name) VALUES (?, ?, ?) ON CONFLICT(connection_id, provider_calendar_id) DO UPDATE SET name = excluded.name',
    )
    for (const cal of calendars) insert.run(pending.id, cal.id, cal.name)
  } catch {
    db.prepare("UPDATE connections SET status = 'error' WHERE id = ? AND status = 'pending'").run(pending.id)
  }
}
