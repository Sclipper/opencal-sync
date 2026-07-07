export type NormalizedEvent = {
  id: string
  status: 'active' | 'cancelled'
  title: string
  description: string
  location: string
  start: string // ISO datetime with offset, or YYYY-MM-DD when allDay
  end: string
  allDay: boolean
  transparent: boolean // marked "Free" — never creates blockers
}

export type WriteEvent = {
  title: string
  description?: string
  location?: string
  start: string
  end: string
  allDay: boolean
}

// snapshot=true means `events` is the COMPLETE set for the window; any previously mapped
// event absent from it was deleted (used by cursorless providers with no delta/sync-token tool).
export type Changes = { events: NormalizedEvent[]; nextCursor: string | null; snapshot?: boolean }

export interface CalendarProvider {
  listCalendars(accountId: string): Promise<{ id: string; name: string }[]>
  listChanges(
    accountId: string,
    calendarId: string,
    cursor: string | null,
    windowStart: string,
    windowEnd: string,
  ): Promise<Changes>
  listEvents(accountId: string, calendarId: string, timeMin: string, timeMax: string): Promise<NormalizedEvent[]>
  createEvent(accountId: string, calendarId: string, event: WriteEvent): Promise<string>
  deleteEvent(accountId: string, calendarId: string, eventId: string): Promise<void>
}
