'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireAuth } from '../lib/auth'
import { startConnectionFlow } from '../lib/connections'
import { getDb } from '../lib/db'
import { NotFoundError } from '../lib/composio'
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

export async function deleteConnection(formData: FormData) {
  await requireAuth()
  getDb().prepare('DELETE FROM connections WHERE id = ?').run(Number(formData.get('id')))
  revalidatePath('/')
}

export async function createSyncLink(formData: FormData) {
  await requireAuth()
  const db = getDb()
  const source = Number(formData.get('source'))
  const target = Number(formData.get('target'))
  const mode = String(formData.get('mode')) === 'clone' ? 'clone' : 'busy'
  const busyTitle = String(formData.get('busy_title') || getSetting(db, 'default_busy_title', 'Busy'))
  const twoWay = formData.get('two_way') === 'on'
  if (!source || !target || source === target) redirect('/?error=same-calendar')

  const existingLink = db.prepare('SELECT 1 FROM sync_links WHERE source_calendar_id = ? AND target_calendar_id = ?')
  if (existingLink.get(source, target) || (twoWay && existingLink.get(target, source))) redirect('/?error=duplicate-link')

  const pairId = twoWay ? randomUUID() : null
  const insert = db.prepare('INSERT INTO sync_links (source_calendar_id, target_calendar_id, mode, busy_title, pair_id) VALUES (?, ?, ?, ?, ?)')
  const clearCursor = db.prepare('DELETE FROM sync_state WHERE calendar_id = ?')
  insert.run(source, target, mode, busyTitle, pairId)
  clearCursor.run(source)
  if (twoWay) {
    insert.run(target, source, mode, busyTitle, pairId)
    clearCursor.run(target)
  }
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

  for (const linkId of ids) {
    const rows = db.prepare(
      `SELECT m.target_event_id, tc.provider_calendar_id AS tgt_cal, tcon.provider AS tgt_provider, tcon.composio_connected_account_id AS tgt_account
       FROM event_mappings m
       JOIN sync_links l ON l.id = m.sync_link_id
       JOIN calendars tc ON tc.id = l.target_calendar_id
       JOIN connections tcon ON tcon.id = tc.connection_id
       WHERE m.sync_link_id = ?`,
    ).all(linkId) as { target_event_id: string; tgt_cal: string; tgt_provider: 'google' | 'outlook'; tgt_account: string }[]
    for (const row of rows) {
      try {
        await providerFor(row.tgt_provider).deleteEvent(row.tgt_account, row.tgt_cal, row.target_event_id)
      } catch (e) {
        if (!(e instanceof NotFoundError)) console.error('cleanup failed:', e)
      }
    }
    db.prepare('DELETE FROM sync_links WHERE id = ?').run(linkId)
  }
  revalidatePath('/')
}

export async function syncNow() {
  await requireAuth()
  await runOnce()
  revalidatePath('/')
}
