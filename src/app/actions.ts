'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireAuth } from '../lib/auth'
import { refreshCalendars, startConnectionFlow } from '../lib/connections'
import { getDb } from '../lib/db'
import { deleteLinkEvents } from '../lib/link-cleanup'
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

export async function refreshConnection(formData: FormData) {
  await requireAuth()
  try {
    await refreshCalendars(getDb(), Number(formData.get('id')))
  } catch {
    redirect('/?error=refresh-failed')
  }
  revalidatePath('/')
}

export async function deleteConnection(formData: FormData) {
  await requireAuth()
  const db = getDb()
  const id = Number(formData.get('id'))
  // Sweep everything this account's links created (in any calendar) BEFORE the rows cascade away —
  // best effort: if the account's auth is already broken the deletes fail and removal proceeds.
  const links = db
    .prepare(
      `SELECT DISTINCT l.id FROM sync_links l
       JOIN calendars sc ON sc.id = l.source_calendar_id
       JOIN calendars tc ON tc.id = l.target_calendar_id
       WHERE sc.connection_id = ? OR tc.connection_id = ?`,
    )
    .all(id, id) as { id: number }[]
  await deleteLinkEvents(db, links.map((l) => l.id), providerFor)
  db.prepare('DELETE FROM connections WHERE id = ?').run(id)
  revalidatePath('/')
}

export async function createSyncLink(formData: FormData) {
  await requireAuth()
  const db = getDb()
  const source = Number(formData.get('source'))
  const target = Number(formData.get('target'))
  const mode = String(formData.get('mode')) === 'clone' ? 'clone' : 'busy'
  const busyTitle = String(formData.get('busy_title') || getSetting(db, 'default_busy_title', 'Busy'))
  const titlePrefix = String(formData.get('title_prefix') ?? '').trim()
  const titleSuffix = String(formData.get('title_suffix') ?? '').trim()
  const rawColor = String(formData.get('event_color') ?? '')
  const eventColor = /^([1-9]|1[01])$/.test(rawColor) ? rawColor : ''
  const privateCopy = formData.get('private_copy') === 'on' ? 1 : 0
  const twoWay = formData.get('two_way') === 'on'
  if (!source || !target || source === target) redirect('/?error=same-calendar')

  const readOnly = db.prepare("SELECT 1 FROM calendars WHERE id = ? AND access_role IN ('reader', 'freeBusyReader')")
  if (readOnly.get(target) || (twoWay && readOnly.get(source))) redirect('/?error=readonly-target')

  const existingLink = db.prepare('SELECT 1 FROM sync_links WHERE source_calendar_id = ? AND target_calendar_id = ?')
  if (existingLink.get(source, target) || (twoWay && existingLink.get(target, source))) redirect('/?error=duplicate-link')

  const pairId = twoWay ? randomUUID() : null
  const insert = db.prepare(
    'INSERT INTO sync_links (source_calendar_id, target_calendar_id, mode, busy_title, title_prefix, title_suffix, event_color, private_copy, pair_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const clearCursor = db.prepare('DELETE FROM sync_state WHERE calendar_id = ?')
  insert.run(source, target, mode, busyTitle, titlePrefix, titleSuffix, eventColor, privateCopy, pairId)
  clearCursor.run(source)
  if (twoWay) {
    insert.run(target, source, mode, busyTitle, titlePrefix, titleSuffix, eventColor, privateCopy, pairId)
    clearCursor.run(target)
  }
  revalidatePath('/')
}

export async function updateSyncLink(formData: FormData) {
  await requireAuth()
  const db = getDb()
  const id = Number(formData.get('id'))
  const link = db.prepare('SELECT source_calendar_id FROM sync_links WHERE id = ?').get(id) as { source_calendar_id: number } | undefined
  if (!link) return
  const mode = String(formData.get('mode')) === 'clone' ? 'clone' : 'busy'
  const busyTitle = String(formData.get('busy_title') || getSetting(db, 'default_busy_title', 'Busy'))
  const titlePrefix = String(formData.get('title_prefix') ?? '').trim()
  const titleSuffix = String(formData.get('title_suffix') ?? '').trim()
  const rawColor = String(formData.get('event_color') ?? '')
  const eventColor = /^([1-9]|1[01])$/.test(rawColor) ? rawColor : ''
  const privateCopy = formData.get('private_copy') === 'on' ? 1 : 0
  db.prepare('UPDATE sync_links SET mode = ?, busy_title = ?, title_prefix = ?, title_suffix = ?, event_color = ?, private_copy = ? WHERE id = ?')
    .run(mode, busyTitle, titlePrefix, titleSuffix, eventColor, privateCopy, id)
  // force a full windowed refetch so the new config reaches ALL events next cycle,
  // not just ones the incremental cursor happens to report (hash mismatch drives the rewrite)
  db.prepare('DELETE FROM sync_state WHERE calendar_id = ?').run(link.source_calendar_id)
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

  const { failed } = await deleteLinkEvents(db, ids, providerFor)
  // keep the link (and the mappings of the events that survived) so deleting again retries cleanup
  if (failed > 0) redirect('/?error=cleanup-partial')
  for (const linkId of ids) db.prepare('DELETE FROM sync_links WHERE id = ?').run(linkId)
  revalidatePath('/')
}

export async function syncNow() {
  await requireAuth()
  await runOnce()
  revalidatePath('/')
}
