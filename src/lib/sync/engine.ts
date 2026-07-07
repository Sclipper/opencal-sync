import { CursorExpiredError, NotFoundError, RateLimitError } from '../composio'
import type { DB } from '../db'
import type { CalendarProvider, Changes } from '../providers/types'
import { getSetting } from '../settings'
import { buildWriteEvent, findOrphanTargets, planActions, type Mapping } from './core'

export type EngineDeps = {
  db: DB
  providerFor: (provider: 'google' | 'outlook') => CalendarProvider
  now?: () => Date
}

type LinkRow = {
  id: number
  mode: 'busy' | 'clone'
  busy_title: string
  title_suffix: string
  event_color: string
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
  SELECT l.id, l.mode, l.busy_title, l.title_suffix, l.event_color, l.source_calendar_id, l.target_calendar_id,
         sc.provider_calendar_id AS src_cal, scon.provider AS src_provider, scon.composio_connected_account_id AS src_account,
         tc.provider_calendar_id AS tgt_cal, tcon.provider AS tgt_provider, tcon.composio_connected_account_id AS tgt_account
  FROM sync_links l
  JOIN calendars sc ON sc.id = l.source_calendar_id
  JOIN connections scon ON scon.id = sc.connection_id
  JOIN calendars tc ON tc.id = l.target_calendar_id
  JOIN connections tcon ON tcon.id = tc.connection_id
  WHERE l.enabled = 1 AND scon.status = 'active' AND tcon.status = 'active'
`

// Concurrent cycles double-create every event: each one sees the same missing/stale mappings
// and writes its own copy. In-memory guards don't survive dev HMR module duplication or a second
// process on the same DB, so the mutex lives in SQLite: an atomic upsert that only wins when the
// held lock is absent or expired (expiry covers crashed holders).
const LOCK_KEY = 'sync_lock'
const LOCK_TTL_MS = 15 * 60_000

function acquireLock(db: DB, nowMs: number): boolean {
  const res = db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) < ?`,
    )
    .run(LOCK_KEY, String(nowMs + LOCK_TTL_MS), nowMs)
  return res.changes === 1
}

export async function runSyncCycle(deps: EngineDeps): Promise<{ processed: number; errors: string[]; skipped?: boolean }> {
  const { db } = deps
  const now = (deps.now ?? (() => new Date()))()
  if (!acquireLock(db, now.getTime())) {
    console.warn('sync cycle skipped: another cycle is already running')
    return { processed: 0, errors: [], skipped: true }
  }
  try {
    return await runSyncCycleLocked(deps, now)
  } finally {
    db.prepare('DELETE FROM settings WHERE key = ?').run(LOCK_KEY)
  }
}

async function runSyncCycleLocked(deps: EngineDeps, now: Date): Promise<{ processed: number; errors: string[] }> {
  const { db } = deps
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
      // cursorless providers (outlook) always return nextCursor null — re-anchor logic is a harmless no-op for them
      const cursorRow = db.prepare('SELECT sync_cursor, anchored_at FROM sync_state WHERE calendar_id = ?').get(calendarId) as
        | { sync_cursor: string | null; anchored_at: string | null }
        | undefined
      // ponytail: missing/stale anchor forces one full windowed refetch — idempotent thanks to mappings/hashes,
      // and it's what keeps long-running instances from silently falling behind the provider's remembered window.
      const anchorStale = Boolean(cursorRow?.sync_cursor) && (!cursorRow?.anchored_at || now.getTime() - Date.parse(cursorRow.anchored_at) > 86_400_000)
      let usedNullCursor = anchorStale || !cursorRow?.sync_cursor

      let changes: Changes
      let rowReset = false
      try {
        try {
          changes = await provider.listChanges(src.src_account, src.src_cal, anchorStale ? null : (cursorRow?.sync_cursor ?? null), windowStart, windowEnd)
        } catch (e) {
          if (!(e instanceof CursorExpiredError)) throw e
          db.prepare('DELETE FROM sync_state WHERE calendar_id = ?').run(calendarId)
          rowReset = true
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
        const cfg = { mode: link.mode, busyTitle: link.busy_title, titleSuffix: link.title_suffix || undefined, eventColor: link.event_color || undefined }
        const isOwn = (id: string) => Boolean(isOwnStmt.get(calendarId, id))
        const actions = planActions({
          events: changes.events,
          link: cfg,
          mappings,
          isOwnEvent: isOwn,
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
          continue
        }

        // Janitor: on full-refetch cycles, sweep untracked copies (from crashes or past concurrent
        // cycles) out of the target calendar. Runs after this link's actions so mappings are current.
        // ponytail: gated to cursor-based sources (skips every-cycle outlook snapshots — call budget)
        // and google targets (shape math mirrors google's create semantics).
        if (usedNullCursor && !changes.snapshot && link.tgt_provider === 'google') {
          try {
            const mappedIds = new Set(
              (db
                .prepare('SELECT target_event_id FROM event_mappings m JOIN sync_links l2 ON l2.id = m.sync_link_id WHERE l2.target_calendar_id = ?')
                .all(link.target_calendar_id) as { target_event_id: string }[]).map((r) => r.target_event_id),
            )
            const expected = changes.events
              .filter((e) => e.status === 'active' && !e.transparent && !isOwn(e.id))
              .map((e) => buildWriteEvent(e, cfg))
            const targetEvents = await target.listEvents(link.tgt_account, link.tgt_cal, windowStart, windowEnd)
            for (const orphanId of findOrphanTargets(targetEvents, expected, mappedIds)) {
              try {
                await target.deleteEvent(link.tgt_account, link.tgt_cal, orphanId)
                processed++
                console.warn(`janitor: removed untracked copy ${orphanId} from calendar ${link.target_calendar_id}`)
              } catch (err) {
                if (!(err instanceof NotFoundError)) throw err
              }
            }
          } catch (e) {
            if (e instanceof RateLimitError) throw e
            errors.push(`janitor link ${link.id}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }

      if (calendarOk) {
        const anchoredAt = usedNullCursor ? now.toISOString() : (cursorRow?.anchored_at ?? now.toISOString())
        if (cursorRow && !rowReset) {
          // Optimistic write-back: an edit deletes this row mid-cycle to force a full refetch —
          // only advance the cursor if the row still holds the value we started from.
          db.prepare(
            `UPDATE sync_state SET sync_cursor = ?, anchored_at = ?, last_synced_at = datetime('now')
             WHERE calendar_id = ? AND sync_cursor IS ?`,
          ).run(changes.nextCursor, anchoredAt, calendarId, cursorRow.sync_cursor)
        } else {
          db.prepare(
            "INSERT OR IGNORE INTO sync_state (calendar_id, sync_cursor, anchored_at, last_synced_at) VALUES (?, ?, ?, datetime('now'))",
          ).run(calendarId, changes.nextCursor, anchoredAt)
        }
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
