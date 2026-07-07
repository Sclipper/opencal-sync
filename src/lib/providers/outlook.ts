import { executeTool } from '../composio'
import type { CalendarProvider, Changes, NormalizedEvent, WriteEvent } from './types'

function unwrap(data: unknown): Record<string, any> {
  const d = data as Record<string, any>
  return (d?.response_data ?? d ?? {}) as Record<string, any>
}

// Graph returns naive local datetimes plus a timeZone field; delta/calendarView default to UTC.
// ponytail: assume UTC unless proven otherwise — blockers only need instants, not wall-clock fidelity.
function graphDate(dt: { dateTime?: string; timeZone?: string } | undefined): string {
  if (!dt?.dateTime) return ''
  return /Z|[+-]\d{2}:\d{2}$/.test(dt.dateTime) ? dt.dateTime : `${dt.dateTime}Z`
}

function mapEvent(raw: Record<string, any>): NormalizedEvent {
  if (raw['@removed']) {
    return { id: String(raw.id), status: 'cancelled', title: '', description: '', location: '', start: '', end: '', allDay: false, transparent: false }
  }
  return {
    id: String(raw.id),
    status: raw.isCancelled ? 'cancelled' : 'active',
    title: raw.subject ?? '',
    description: raw.bodyPreview ?? '',
    location: raw.location?.displayName ?? '',
    start: raw.isAllDay ? graphDate(raw.start).slice(0, 10) : graphDate(raw.start),
    end: raw.isAllDay ? graphDate(raw.end).slice(0, 10) : graphDate(raw.end),
    allDay: Boolean(raw.isAllDay),
    transparent: raw.showAs === 'free',
  }
}

function toUtcIso(value: string): string {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value).toISOString()
}

// filter literals follow the schema's Z-suffixed example; createEvent's structured fields are naive per their schema
function toNaiveUtc(value: string): string {
  return toUtcIso(value).replace(/\.\d{3}Z$/, '')
}

// Z-suffixed, seconds precision (milliseconds stripped) — matches the schema's own filter example.
function toUtcSeconds(value: string): string {
  return toUtcIso(value).replace(/\.\d{3}Z$/, 'Z')
}

// Composio's Outlook toolkit exposes no calendar-scoped event tool: OUTLOOK_OUTLOOK_LIST_EVENTS
// only reads user_id's default calendar via an OData `filter` string (no calendarId param), and
// has no delta/sync-token tool either — every call is a fresh full-window fetch.
// Pagination is load-bearing: a truncated fetch would read as mass deletions to the snapshot
// diff in sync/core.ts, so keep fetching while pages come back full.
const PAGE = 250
async function listWindow(accountId: string, windowStart: string, windowEnd: string): Promise<NormalizedEvent[]> {
  // window overlap, not containment: catch events that start before / end after the window edges
  const filter = `start/dateTime lt '${toUtcSeconds(windowEnd)}' and end/dateTime gt '${toUtcSeconds(windowStart)}'`
  const events: NormalizedEvent[] = []
  for (let skip = 0; ; skip += PAGE) {
    const payload = unwrap(
      await executeTool('OUTLOOK_OUTLOOK_LIST_EVENTS', accountId, {
        filter,
        top: PAGE,
        skip,
        // expand recurring series into per-occurrence entries (each with a stable id),
        // so the mapping/snapshot-diff model handles instances the same as Google.
        expand_recurring_events: true,
      }),
    )
    const page = (payload.value ?? []) as Record<string, any>[]
    for (const item of page) events.push(mapEvent(item))
    if (page.length < PAGE) return events
  }
}

export const outlookProvider: CalendarProvider = {
  async listCalendars(accountId) {
    // Composio's Outlook toolkit has no calendar-scoped event tools, so only the default calendar is usable.
    const payload = unwrap(await executeTool('OUTLOOK_LIST_CALENDARS', accountId, {}))
    const value = (payload.value ?? []) as Record<string, any>[]
    const cal = value.find((c) => c.isDefaultCalendar) ?? value[0]
    if (!cal) return []
    return [{ id: String(cal.id), name: `${cal.name ?? String(cal.id)} (default)`, primary: true, accessRole: 'owner' }]
  },

  async listChanges(accountId, _calendarId, _cursor, windowStart, windowEnd): Promise<Changes> {
    // ponytail: no calendar delta tool exists for this toolkit — full-window snapshot every poll;
    // deletions are inferred by diffing against stored mappings (sync/core.ts planActions snapshot mode).
    const events = await listWindow(accountId, windowStart, windowEnd)
    return { events, nextCursor: null, snapshot: true }
  },

  async listEvents(accountId, _calendarId, timeMin, timeMax) {
    return listWindow(accountId, timeMin, timeMax)
  },

  async createEvent(accountId, _calendarId, event: WriteEvent) {
    const payload = unwrap(
      await executeTool('OUTLOOK_OUTLOOK_CALENDAR_CREATE_EVENT', accountId, {
        subject: event.title,
        body: event.description ?? '',
        location: event.location,
        // ponytail: this tool has no is_all_day field, so all-day blockers become a plain timed
        // span; unlike Google's duration-hour schema this one takes explicit start/end datetimes,
        // so multi-day spans need no clamp — the true instants pass through untouched.
        start_datetime: toNaiveUtc(event.start),
        end_datetime: toNaiveUtc(event.end),
        time_zone: 'UTC',
        show_as: 'busy',
      }),
    )
    const id = payload.id
    if (id === undefined || id === null || id === '') throw new Error('OUTLOOK_OUTLOOK_CALENDAR_CREATE_EVENT returned no event id')
    return String(id)
  },

  async deleteEvent(accountId, _calendarId, eventId) {
    // blockers must never email anyone
    await executeTool('OUTLOOK_OUTLOOK_DELETE_EVENT', accountId, { event_id: eventId, send_notifications: false })
  },
}
