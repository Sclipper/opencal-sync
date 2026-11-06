import { NotFoundError, RateLimitError } from './composio'
import type { DB } from './db'
import type { CalendarProvider } from './providers/types'

export type ProviderFor = (p: 'google' | 'outlook') => CalendarProvider

// Delete every event a set of links created in their target calendars, removing each mapping as
// its event is confirmed gone (already-gone events count as deleted). Failed deletions keep their
// mappings so a retry can finish the job instead of leaking events forever.
export async function deleteLinkEvents(
  db: DB,
  linkIds: number[],
  providerFor: ProviderFor,
): Promise<{ deleted: number; failed: number }> {
  let deleted = 0
  let failed = 0
  const removeMapping = db.prepare('DELETE FROM event_mappings WHERE id = ?')
  for (const linkId of linkIds) {
    const rows = db
      .prepare(
        `SELECT m.id, m.target_event_id, tc.provider_calendar_id AS tgt_cal, tcon.provider AS tgt_provider, tcon.composio_connected_account_id AS tgt_account
         FROM event_mappings m
         JOIN sync_links l ON l.id = m.sync_link_id
         JOIN calendars tc ON tc.id = l.target_calendar_id
         JOIN connections tcon ON tcon.id = tc.connection_id
         WHERE m.sync_link_id = ?`,
      )
      .all(linkId) as { id: number; target_event_id: string; tgt_cal: string; tgt_provider: 'google' | 'outlook'; tgt_account: string }[]
    for (const row of rows) {
      try {
        await providerFor(row.tgt_provider).deleteEvent(row.tgt_account, row.tgt_cal, row.target_event_id)
        removeMapping.run(row.id)
        deleted++
      } catch (e) {
        if (e instanceof NotFoundError) {
          removeMapping.run(row.id)
          deleted++
        } else {
          if (e instanceof RateLimitError) throw e // stop hammering; the next pass resumes from the kept mappings
          failed++
          console.error('link cleanup failed:', e instanceof Error ? e.message : e)
        }
      }
    }
  }
  return { deleted, failed }
}

// Finish every queued removal: connections with status 'removing', then links with enabled = 0.
// Safe to re-run after a restart, since each mapping is dropped as its event is confirmed gone.
export async function processRemovals(db: DB, providerFor: ProviderFor): Promise<void> {
  const connections = db.prepare("SELECT id FROM connections WHERE status = 'removing'").all() as { id: number }[]
  for (const { id } of connections) {
    const links = db
      .prepare(
        `SELECT DISTINCT l.id FROM sync_links l
         JOIN calendars sc ON sc.id = l.source_calendar_id
         JOIN calendars tc ON tc.id = l.target_calendar_id
         WHERE sc.connection_id = ? OR tc.connection_id = ?`,
      )
      .all(id, id) as { id: number }[]
    // Best effort: if the account's auth is already broken the deletes fail and removal proceeds.
    await deleteLinkEvents(db, links.map((l) => l.id), providerFor)
    db.prepare('DELETE FROM connections WHERE id = ?').run(id)
  }

  const links = db.prepare('SELECT id FROM sync_links WHERE enabled = 0').all() as { id: number }[]
  for (const { id } of links) {
    const { failed } = await deleteLinkEvents(db, [id], providerFor)
    // keep the link (and the surviving mappings) so the next pass retries cleanup
    if (failed > 0) db.prepare('UPDATE sync_links SET last_error = ? WHERE id = ?').run(`${failed} synced events could not be deleted yet, retrying`, id)
    else db.prepare('DELETE FROM sync_links WHERE id = ?').run(id)
  }
}
