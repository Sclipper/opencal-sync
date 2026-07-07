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
    start: graphDate(raw.start),
    end: graphDate(raw.end),
    allDay: Boolean(raw.isAllDay),
    transparent: raw.showAs === 'free',
  }
}

function toUtcIso(value: string): string {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value).toISOString()
}

export const outlookProvider: CalendarProvider = {
  async listCalendars(accountId) {
    const payload = unwrap(await executeTool('OUTLOOK_LIST_CALENDARS', accountId, {}))
    return (payload.value ?? []).map((c: Record<string, any>) => ({ id: String(c.id), name: c.name ?? String(c.id) }))
  },

  async listChanges(accountId, calendarId, cursor, windowStart, windowEnd): Promise<Changes> {
    const events: NormalizedEvent[] = []
    let token: string | null = cursor
    let nextCursor: string | null = cursor
    for (;;) {
      const args: Record<string, unknown> = { calendar_id: calendarId, start_datetime: windowStart, end_datetime: windowEnd }
      if (token) args.delta_token = token
      const payload = unwrap(await executeTool('OUTLOOK_LIST_CALENDAR_VIEW_DELTA', accountId, args))
      for (const item of payload.value ?? []) events.push(mapEvent(item))
      if (payload['@odata.nextLink']) {
        token = String(payload['@odata.nextLink'])
        continue
      }
      if (payload['@odata.deltaLink']) nextCursor = String(payload['@odata.deltaLink'])
      return { events, nextCursor }
    }
  },

  async listEvents(accountId, calendarId, timeMin, timeMax) {
    const payload = unwrap(
      await executeTool('OUTLOOK_LIST_USER_CALENDAR_VIEW', accountId, {
        calendar_id: calendarId,
        start_datetime: timeMin,
        end_datetime: timeMax,
      }),
    )
    return (payload.value ?? []).map(mapEvent)
  },

  async createEvent(accountId, calendarId, event: WriteEvent) {
    const payload = unwrap(
      await executeTool('OUTLOOK_CREATE_CALENDAR_EVENT_IN_CALENDAR', accountId, {
        calendar_id: calendarId,
        subject: event.title,
        body: event.description,
        location: event.location,
        is_all_day: event.allDay,
        start_datetime: toUtcIso(event.start),
        end_datetime: toUtcIso(event.end),
        time_zone: 'UTC',
        show_as: 'busy',
      }),
    )
    const id = payload.id
    if (id === undefined || id === null || id === '') throw new Error('OUTLOOK_CREATE_CALENDAR_EVENT_IN_CALENDAR returned no event id')
    return String(id)
  },

  async deleteEvent(accountId, _calendarId, eventId) {
    await executeTool('OUTLOOK_DELETE_CALENDAR_EVENT', accountId, { event_id: eventId })
  },
}
