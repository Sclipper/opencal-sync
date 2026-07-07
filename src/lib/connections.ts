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

function upsertCalendars(db: DB, connectionId: number, calendars: Awaited<ReturnType<CalendarProvider['listCalendars']>>): void {
  const upsert = db.prepare(
    `INSERT INTO calendars (connection_id, provider_calendar_id, name, is_primary, access_role) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(connection_id, provider_calendar_id) DO UPDATE SET name = excluded.name, is_primary = excluded.is_primary, access_role = excluded.access_role`,
  )
  // ponytail: upsert only, never delete — a calendar vanishing from the provider list must not cascade-drop sync links
  for (const cal of calendars) upsert.run(connectionId, cal.id, cal.name, cal.primary ? 1 : 0, cal.accessRole ?? '')
}

// Re-list calendars for an active connection: picks up newly created calendars and backfills is_primary/access_role.
export async function refreshCalendars(db: DB, connectionId: number, deps: Deps = {}): Promise<void> {
  const conn = db
    .prepare("SELECT id, provider, composio_connected_account_id AS account FROM connections WHERE id = ? AND status = 'active'")
    .get(connectionId) as { id: number; provider: 'google' | 'outlook'; account: string } | undefined
  if (!conn) return
  const providerFor = deps.providerFor ?? defaultProviderFor
  upsertCalendars(db, conn.id, await providerFor(conn.provider).listCalendars(conn.account))
}

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
    const calendars = await providerFor(pending.provider).listCalendars(account.id)
    // Composio returns no email in account.data for Google OAuth — but Google's primary calendar id
    // IS the account email. Outlook primary ids are opaque Graph ids, hence the '@' guard.
    const email = (account.data as Record<string, unknown> | undefined)?.email
    const primaryId = calendars.find((c) => c.primary)?.id
    const label =
      (typeof email === 'string' && email) ||
      (primaryId?.includes('@') ? primaryId : '') ||
      `${pending.provider} account`
    // status != 'active': never touch an already-active row, but DO recover one that a racing
    // duplicate callback marked 'error' while we were still listing calendars — we hold a
    // confirmed ACTIVE account, so activation is correct regardless of that interleaving.
    db.prepare("UPDATE connections SET composio_connected_account_id = ?, account_label = ?, composio_user_id = ?, status = 'active' WHERE id = ? AND status != 'active'")
      .run(account.id, label, USER_ID, pending.id)
    upsertCalendars(db, pending.id, calendars)
  } catch {
    db.prepare("UPDATE connections SET status = 'error' WHERE id = ? AND status = 'pending'").run(pending.id)
  }
}
