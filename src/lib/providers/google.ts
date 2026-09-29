import { executeTool, proxyRequest } from '../composio'
import type { CalendarProvider, Changes, NormalizedEvent, WriteEvent } from './types'

// Composio wraps some tool outputs in { response_data: ... }; tolerate both.
function unwrap(data: unknown): Record<string, any> {
  const d = data as Record<string, any>
  return (d?.response_data ?? d ?? {}) as Record<string, any>
}

function mapEvent(raw: Record<string, any>): NormalizedEvent {
  const videoEntry = (raw.conferenceData?.entryPoints ?? []).find((p: Record<string, any>) => p.entryPointType === 'video')
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
    // detail below is omitted when absent, so events without it hash as they always did
    ...((raw.hangoutLink ?? videoEntry?.uri) && { conferenceUri: String(raw.hangoutLink ?? videoEntry.uri) }),
    ...(attendeesOf(raw).length && { attendees: attendeesOf(raw) }),
    ...(raw.htmlLink && { sourceLink: String(raw.htmlLink) }),
  }
}

// rooms and equipment are attendees too — they are not "who is coming"
function attendeesOf(raw: Record<string, any>) {
  return (raw.attendees ?? [])
    .filter((a: Record<string, any>) => a.email && !a.resource)
    .map((a: Record<string, any>) => ({ email: String(a.email), responseStatus: a.responseStatus }))
}

// Google only lets us attach a Meet conference; a Zoom/Teams URL has to stay a link in the body.
export function meetConferenceData(uri: string | undefined): Record<string, unknown> | null {
  const code = uri?.match(/^https:\/\/meet\.google\.com\/([a-z0-9-]+)/i)?.[1]
  if (!code) return null
  const url = `https://meet.google.com/${code}`
  return {
    conferenceId: code,
    conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
    entryPoints: [{ entryPointType: 'video', uri: url, label: `meet.google.com/${code}` }],
  }
}

const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)

// Google's insert takes either { date } (all-day, YYYY-MM-DD) or { dateTime } (RFC3339). Timed instants
// are normalised to UTC so odd source notations (Graph's 7-digit fractions, offsets) never reach the API.
function toGoogleTime(value: string, allDay: boolean): { date: string } | { dateTime: string } {
  return allDay && isDate(value) ? { date: value } : { dateTime: new Date(value).toISOString() }
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
    // ponytail: no page_token loop; 250 covers any sane account.
    const payload = unwrap(await executeTool('GOOGLECALENDAR_LIST_CALENDARS', accountId, { max_results: 250 }))
    return (payload.calendars ?? []).map((c: Record<string, any>) => ({
      id: String(c.id),
      name: c.summary ?? String(c.id),
      primary: c.primary === true || undefined,
      accessRole: typeof c.accessRole === 'string' ? c.accessRole : undefined,
    }))
  },

  listChanges(accountId, calendarId, cursor, windowStart, windowEnd) {
    return listRange(accountId, calendarId, cursor, windowStart, windowEnd, true)
  },

  async listEvents(accountId, calendarId, timeMin, timeMax) {
    const { events } = await listRange(accountId, calendarId, null, timeMin, timeMax, false)
    return events
  },

  async createEvent(accountId, calendarId, event: WriteEvent) {
    // Raw API insert rather than GOOGLECALENDAR_CREATE_EVENT: the Composio tool can only write timed
    // events (all-day dates became 00:00Z + 24h, i.e. 02:00-02:00 in Copenhagen), clamps anything over
    // 24h, and has no reminders field — so every copy inherited the target calendar's default popups.
    // Copies are mirrors of an event the user already gets notified about; they must never notify again.
    //
    // conferenceData is always sent: accounts with "automatically add Google Meet" mint a NEW room on
    // every event created on them, so the copy would advertise a join link to an empty meeting. Send the
    // source's real Meet when there is one, null to strip whatever the account would attach.
    const payload = unwrap(
      await proxyRequest(
        accountId,
        'POST',
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1`,
        {
          summary: event.title,
          description: event.description,
          location: event.location,
          start: toGoogleTime(event.start, event.allDay),
          end: toGoogleTime(event.end, event.allDay),
          reminders: { useDefault: false, overrides: [] },
          ...(event.private && { visibility: 'private' }),
          ...(event.colorId && { colorId: event.colorId }),
          conferenceData: meetConferenceData(event.conferenceUri),
        },
      ),
    )
    const id = payload.id
    if (id === undefined || id === null || id === '') throw new Error('google events.insert returned no event id')
    return String(id)
  },

  async deleteEvent(accountId, calendarId, eventId) {
    await executeTool('GOOGLECALENDAR_DELETE_EVENT', accountId, { calendar_id: calendarId, event_id: eventId })
  },
}
