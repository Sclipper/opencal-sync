import { CursorExpiredError, NotFoundError, RateLimitError } from '../composio'
import type { DB } from '../db'
import type { CalendarProvider, Changes } from '../providers/types'
import { getSetting } from '../settings'
import { planActions, type Mapping } from './core'

export type EngineDeps = {
  db: DB
  providerFor: (provider: 'google' | 'outlook') => CalendarProvider
  now?: () => Date
}

type LinkRow = {
  id: number
  mode: 'busy' | 'clone'
  busy_title: string
  source_calendar_id: number
  target_calendar_id: number
  src_provider: 'google' | 'outlook'
  src_account: string
  src_cal: string
  tgt_provider: 'google' | 'outlook'
  tgt_account: string
  tgt_cal: string
}

const LINKS_SQL = `
  SELECT l.id, l.mode, l.busy_title, l.source_calendar_id, l.target_calendar_id,
         sc.provider_calendar_id AS src_cal, scon.provider AS src_provider, scon.composio_connected_account_id AS src_account,
         tc.provider_calendar_id AS tgt_cal, tcon.provider AS tgt_provider, tcon.composio_connected_account_id AS tgt_account
  FROM sync_links l
  JOIN calendars sc ON sc.id = l.source_calendar_id
  JOIN connections scon ON scon.id = sc.connection_id
  JOIN calendars tc ON tc.id = l.target_calendar_id
  JOIN connections tcon ON tcon.id = tc.connection_id
  WHERE l.enabled = 1 AND scon.status = 'active' AND tcon.status = 'active'
`

export async function runSyncCycle(deps: EngineDeps): Promise<{ processed: number; errors: string[] }> {
  const { db } = deps
  const now = (deps.now ?? (() => new Date()))()
  const startedAt = now.toISOString()
  const t0 = Date.now()
  let processed = 0
  const errors: string[] = []

  const finishRun = () => {
    db.prepare('INSERT INTO sync_runs (started_at, duration_ms, events_processed, errors) VALUES (?, ?, ?, ?)')
      .run(startedAt, Date.now() - t0, processed, errors.length ? JSON.stringify(errors) : null)
    db.prepare('DELETE FROM sync_runs WHERE id NOT IN (SELECT id FROM sync_runs ORDER BY id DESC LIMIT 50)').run()
  }

  try {
    const windowDays = Number(getSetting(db, 'sync_window_days', '60'))
    const windowStart = new Date(now.getTime() - 86_400_000).toISOString()
    const windowEnd = new Date(now.getTime() + windowDays * 86_400_000).toISOString()

    const links = db.prepare(LINKS_SQL).all() as LinkRow[]
    const bySource = new Map<number, LinkRow[]>()
    for (const link of links) {
      const group = bySource.get(link.source_calendar_id) ?? []
      group.push(link)
      bySource.set(link.source_calendar_id, group)
    }

    const isOwnStmt = db.prepare(
      'SELECT 1 FROM event_mappings m JOIN sync_links l ON l.id = m.sync_link_id WHERE l.target_calendar_id = ? AND m.target_event_id = ?',
    )
    const markLink = db.prepare("UPDATE sync_links SET last_run_at = datetime('now'), last_error = ? WHERE id = ?")

    for (const [calendarId, calLinks] of bySource) {
      const src = calLinks[0]
      const provider = deps.providerFor(src.src_provider)
      const cursorRow = db.prepare('SELECT sync_cursor, anchored_at FROM sync_state WHERE calendar_id = ?').get(calendarId) as
        | { sync_cursor: string | null; anchored_at: string | null }
        | undefined
      // ponytail: missing/stale anchor forces one full windowed refetch — idempotent thanks to mappings/hashes,
      // and it's what keeps long-running instances from silently falling behind the provider's remembered window.
      const anchorStale = Boolean(cursorRow?.sync_cursor) && (!cursorRow?.anchored_at || now.getTime() - Date.parse(cursorRow.anchored_at) > 86_400_000)
      let usedNullCursor = anchorStale || !cursorRow?.sync_cursor

      let changes: Changes
      try {
        try {
          changes = await provider.listChanges(src.src_account, src.src_cal, anchorStale ? null : (cursorRow?.sync_cursor ?? null), windowStart, windowEnd)
        } catch (e) {
          if (!(e instanceof CursorExpiredError)) throw e
          db.prepare('DELETE FROM sync_state WHERE calendar_id = ?').run(calendarId)
          usedNullCursor = true
          changes = await provider.listChanges(src.src_account, src.src_cal, null, windowStart, windowEnd)
        }
      } catch (e) {
        if (e instanceof RateLimitError) throw e
        const msg = e instanceof Error ? e.message : String(e)
        for (const link of calLinks) markLink.run(msg, link.id)
        errors.push(`calendar ${calendarId}: ${msg}`)
        continue
      }

      let calendarOk = true
      for (const link of calLinks) {
        const rows = db.prepare('SELECT source_event_id, target_event_id, content_hash FROM event_mappings WHERE sync_link_id = ?').all(link.id) as {
          source_event_id: string
          target_event_id: string
          content_hash: string
        }[]
        const mappings = new Map<string, Mapping>(rows.map((r) => [r.source_event_id, { targetEventId: r.target_event_id, contentHash: r.content_hash }]))
        const actions = planActions({
          events: changes.events,
          link: { mode: link.mode, busyTitle: link.busy_title },
          mappings,
          isOwnEvent: (id) => Boolean(isOwnStmt.get(calendarId, id)),
          snapshot: changes.snapshot,
        })

        const target = deps.providerFor(link.tgt_provider)
        try {
          for (const action of actions) {
            if (action.type === 'delete' || action.type === 'recreate') {
              try {
                await target.deleteEvent(link.tgt_account, link.tgt_cal, action.targetEventId)
              } catch (e) {
                if (!(e instanceof NotFoundError)) throw e
              }
              db.prepare('DELETE FROM event_mappings WHERE sync_link_id = ? AND source_event_id = ?').run(link.id, action.sourceEventId)
            }
            if (action.type === 'create' || action.type === 'recreate') {
              const targetId = await target.createEvent(link.tgt_account, link.tgt_cal, action.write)
              db.prepare(
                `INSERT INTO event_mappings (sync_link_id, source_event_id, target_event_id, content_hash, updated_at)
                 VALUES (?, ?, ?, ?, datetime('now'))
                 ON CONFLICT(sync_link_id, source_event_id)
                 DO UPDATE SET target_event_id = excluded.target_event_id, content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
              ).run(link.id, action.sourceEventId, targetId, action.hash)
            }
            processed++
          }
          markLink.run(null, link.id)
        } catch (e) {
          if (e instanceof RateLimitError) throw e
          calendarOk = false
          const msg = e instanceof Error ? e.message : String(e)
          errors.push(`link ${link.id}: ${msg}`)
          markLink.run(msg, link.id)
        }
      }

      if (calendarOk) {
        const anchoredAt = usedNullCursor ? now.toISOString() : (cursorRow?.anchored_at ?? now.toISOString())
        db.prepare(
          `INSERT INTO sync_state (calendar_id, sync_cursor, anchored_at, last_synced_at) VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(calendar_id) DO UPDATE SET sync_cursor = excluded.sync_cursor, anchored_at = excluded.anchored_at, last_synced_at = excluded.last_synced_at`,
        ).run(calendarId, changes.nextCursor, anchoredAt)
      }
    }

    finishRun()
    return { processed, errors }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e))
    finishRun()
    throw e
  }
}
