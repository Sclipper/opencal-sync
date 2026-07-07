import { executeTool } from '../composio'
import type { CalendarProvider, Changes, NormalizedEvent, WriteEvent } from './types'

// Composio wraps some tool outputs in { response_data: ... }; tolerate both.
function unwrap(data: unknown): Record<string, any> {
  const d = data as Record<string, any>
  return (d?.response_data ?? d ?? {}) as Record<string, any>
}

function mapEvent(raw: Record<string, any>): NormalizedEvent {
  return {
    id: String(raw.id),
    status: raw.status === 'cancelled' ? 'cancelled' : 'active',
    title: raw.summary ?? '',
    description: raw.description ?? '',
    location: raw.location ?? '',
    start: raw.start?.dateTime ?? raw.start?.date ?? '',
    end: raw.end?.dateTime ?? raw.end?.date ?? '',
    allDay: Boolean(raw.start?.date),
    transparent: raw.transparency === 'transparent',
  }
}

// For all-day WriteEvents (YYYY-MM-DD), treat the date as UTC midnight.
// ponytail: all-day blockers are written as 24h timed events; Composio's create tool has no confirmed all-day support.
function toUtcIso(value: string): string {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value).toISOString()
}

async function listRange(
  accountId: string,
  calendarId: string,
  cursor: string | null,
  timeMin: string,
  timeMax: string,
  showDeleted: boolean,
): Promise<Changes> {
  const events: NormalizedEvent[] = []
  let pageToken: string | undefined
  let nextCursor: string | null = cursor
  do {
    const args: Record<string, unknown> = cursor
      ? { calendarId, syncToken: cursor, pageToken }
      : { calendarId, timeMin, timeMax, singleEvents: true, showDeleted, maxResults: 250, pageToken }
    const payload = unwrap(await executeTool('GOOGLECALENDAR_EVENTS_LIST', accountId, args))
    for (const item of payload.items ?? []) events.push(mapEvent(item))
    pageToken = payload.nextPageToken ?? undefined
    if (payload.nextSyncToken) nextCursor = payload.nextSyncToken
  } while (pageToken)
  return { events, nextCursor }
}

export const googleProvider: CalendarProvider = {
  async listCalendars(accountId) {
    const payload = unwrap(await executeTool('GOOGLECALENDAR_LIST_CALENDARS', accountId, {}))
    return (payload.items ?? []).map((c: Record<string, any>) => ({ id: String(c.id), name: c.summary ?? String(c.id) }))
  },

  listChanges(accountId, calendarId, cursor, windowStart, windowEnd) {
    return listRange(accountId, calendarId, cursor, windowStart, windowEnd, true)
  },

  async listEvents(accountId, calendarId, timeMin, timeMax) {
    const { events } = await listRange(accountId, calendarId, null, timeMin, timeMax, false)
    return events
  },

  async createEvent(accountId, calendarId, event: WriteEvent) {
    const startIso = toUtcIso(event.start)
    const minutes = Math.max(1, Math.round((Date.parse(toUtcIso(event.end)) - Date.parse(startIso)) / 60_000))
    const payload = unwrap(
      await executeTool('GOOGLECALENDAR_CREATE_EVENT', accountId, {
        calendar_id: calendarId,
        summary: event.title,
        description: event.description,
        location: event.location,
        start_datetime: startIso,
        event_duration_hour: Math.floor(minutes / 60),
        event_duration_minutes: minutes % 60,
        timezone: 'UTC',
      }),
    )
    const id = payload.id
    if (id === undefined || id === null || id === '') throw new Error('GOOGLECALENDAR_CREATE_EVENT returned no event id')
    return String(id)
  },

  async deleteEvent(accountId, calendarId, eventId) {
    await executeTool('GOOGLECALENDAR_DELETE_EVENT', accountId, { calendar_id: calendarId, event_id: eventId })
  },
}
