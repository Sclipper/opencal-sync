import { computeFreeSlots, formatSummary, mergeIntervals, zonedTimeToUtc, type DaySlots, type Interval, type WorkingHours } from './availability'
import { getDb } from './db'
import { googleProvider } from './providers/google'
import { outlookProvider } from './providers/outlook'

export type PageRow = {
  id: number
  slug: string
  calendar_ids: string
  working_hours: string
  timezone: string
  days_ahead: number
  enabled: number
}

type CacheEntry = { at: number; value: { page: PageRow; days: DaySlots[]; summary: string } }

declare global {
  // eslint-disable-next-line no-var
  var __opencalAvailCache: Map<string, CacheEntry> | undefined
}

const CACHE_MS = 5 * 60_000

export async function getAvailability(slug: string): Promise<{ page: PageRow; days: DaySlots[]; summary: string } | null> {
  const cache = (globalThis.__opencalAvailCache ??= new Map())
  const hit = cache.get(slug)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value

  const db = getDb()
  const page = db.prepare('SELECT * FROM availability_pages WHERE slug = ? AND enabled = 1').get(slug) as PageRow | undefined
  if (!page) return null

  const hours = JSON.parse(page.working_hours) as WorkingHours
  const calendarIds = JSON.parse(page.calendar_ids) as number[]
  const from = Date.now()
  const timeMax = new Date(from + page.days_ahead * 86_400_000).toISOString()

  const busy: Interval[] = []
  for (const calId of calendarIds) {
    const cal = db.prepare(
      `SELECT c.provider_calendar_id, con.provider, con.composio_connected_account_id AS account
       FROM calendars c JOIN connections con ON con.id = c.connection_id
       WHERE c.id = ? AND con.status = 'active'`,
    ).get(calId) as { provider_calendar_id: string; provider: 'google' | 'outlook'; account: string } | undefined
    if (!cal) continue
    const provider = cal.provider === 'google' ? googleProvider : outlookProvider
    const events = await provider.listEvents(cal.account, cal.provider_calendar_id, new Date(from).toISOString(), timeMax)
    for (const ev of events) {
      if (ev.status !== 'active' || ev.transparent) continue
      const start = ev.allDay ? zonedTimeToUtc(ev.start, '00:00', page.timezone) : Date.parse(ev.start)
      const end = ev.allDay ? zonedTimeToUtc(ev.end, '00:00', page.timezone) : Date.parse(ev.end)
      if (Number.isFinite(start) && Number.isFinite(end)) busy.push({ start, end })
    }
  }

  const days = computeFreeSlots({ busy: mergeIntervals(busy), hours, timezone: page.timezone, daysAhead: page.days_ahead, from })
  const value = { page, days, summary: formatSummary(days) }
  cache.set(slug, { at: Date.now(), value })
  return value
}
