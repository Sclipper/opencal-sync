// Reconcile the conference on every synced copy with what its link should show.
//
// Target accounts with "automatically add Google Meet to events I create" mint a NEW Meet room on
// every event opencal-sync creates on them, so copies written before the fix advertise a join link
// to an empty meeting. Newly created copies are correct, but existing ones are only rewritten when
// their content hash changes — which busy blockers deliberately never do. This fixes them in place.
//
// Dry run:  COMPOSIO_API_KEY=... DATA_DIR=/path/to/db npx tsx scripts/reconcile-conferences.mts
// Apply:    ... npx tsx scripts/reconcile-conferences.mts --apply
//
// Safe against a copy of the database — rows are only read; the writes go to the calendar API.
export {}

import { proxyRequest } from '../src/lib/composio'
import { getDb } from '../src/lib/db'
import { meetConferenceData } from '../src/lib/providers/google'

const apply = process.argv.includes('--apply')
if (!process.env.COMPOSIO_API_KEY) {
  console.error('COMPOSIO_API_KEY is required')
  process.exit(1)
}

type Row = {
  target_event_id: string
  source_event_id: string
  mode: string
  link_id: number
  src_cal: string
  src_acct: string
  tgt_cal: string
  tgt_acct: string
}

const eventUrl = (cal: string, id: string) =>
  `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(id)}`

const rows = getDb()
  .prepare(
    `SELECT m.target_event_id, m.source_event_id, l.mode, l.id AS link_id,
            sc.provider_calendar_id AS src_cal, scon.composio_connected_account_id AS src_acct,
            tc.provider_calendar_id AS tgt_cal, tcon.composio_connected_account_id AS tgt_acct
     FROM event_mappings m
     JOIN sync_links l ON l.id = m.sync_link_id
     JOIN calendars sc ON sc.id = l.source_calendar_id
     JOIN connections scon ON scon.id = sc.connection_id
     JOIN calendars tc ON tc.id = l.target_calendar_id
     JOIN connections tcon ON tcon.id = tc.connection_id
     WHERE tcon.provider = 'google'
     ORDER BY l.id`,
  )
  .all() as Row[]

console.log(`${rows.length} synced copies to check${apply ? '' : ' (dry run)'}`)
let wrong = 0
let fixed = 0
let failed = 0

for (const [i, row] of rows.entries()) {
  try {
    const target = (await proxyRequest(row.tgt_acct, 'GET', eventUrl(row.tgt_cal, row.target_event_id))) as Record<string, any>
    // busy blockers must never carry the link; clone copies should carry the source's own room
    let intended: Record<string, unknown> | null = null
    if (row.mode === 'clone') {
      const source = (await proxyRequest(row.src_acct, 'GET', eventUrl(row.src_cal, row.source_event_id))) as Record<string, any>
      const videoEntry = (source.conferenceData?.entryPoints ?? []).find((p: any) => p.entryPointType === 'video')
      intended = meetConferenceData(source.hangoutLink ?? videoEntry?.uri)
    }
    const current = target.hangoutLink ?? null
    const want = (intended?.entryPoints as any[] | undefined)?.[0]?.uri ?? null
    if (current === want) continue

    wrong++
    console.log(`link ${row.link_id} ${row.mode} "${target.summary}" ${current ?? 'none'} -> ${want ?? 'none'}`)
    if (!apply) continue
    await proxyRequest(row.tgt_acct, 'PATCH', `${eventUrl(row.tgt_cal, row.target_event_id)}?conferenceDataVersion=1`, {
      conferenceData: intended,
    })
    fixed++
  } catch (e) {
    failed++
    console.error(`  ${row.target_event_id}: ${e instanceof Error ? e.message.slice(0, 160) : e}`)
  }
  if ((i + 1) % 25 === 0) console.log(`  …${i + 1}/${rows.length}`)
}

console.log(`checked ${rows.length}, wrong ${wrong}, fixed ${fixed}, failed ${failed}`)
