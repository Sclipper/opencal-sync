import { beforeEach, describe, expect, it, vi } from 'vitest'

const executeTool = vi.fn()
const proxyRequest = vi.fn()
vi.mock('../composio', () => ({
  executeTool: (...args: unknown[]) => executeTool(...args),
  proxyRequest: (...args: unknown[]) => proxyRequest(...args),
}))

const { googleProvider } = await import('./google')

beforeEach(() => {
  executeTool.mockReset()
  proxyRequest.mockReset()
})

describe('googleProvider.listChanges', () => {
  it('does a full windowed fetch when cursor is null and maps events', async () => {
    executeTool.mockResolvedValueOnce({
      items: [
        {
          id: 'ev1',
          status: 'confirmed',
          summary: 'Standup',
          description: 'daily',
          location: 'Zoom',
          start: { dateTime: '2026-07-08T10:00:00+03:00' },
          end: { dateTime: '2026-07-08T10:30:00+03:00' },
        },
        { id: 'ev2', status: 'cancelled' },
        {
          id: 'ev3',
          status: 'confirmed',
          summary: 'OOO',
          transparency: 'transparent',
          start: { date: '2026-07-09' },
          end: { date: '2026-07-10' },
        },
      ],
      nextSyncToken: 'tok-1',
    })

    const res = await googleProvider.listChanges('acc1', 'cal1', null, '2026-07-07T00:00:00Z', '2026-09-05T00:00:00Z')

    expect(executeTool).toHaveBeenCalledWith('GOOGLECALENDAR_EVENTS_LIST', 'acc1', {
      calendarId: 'cal1',
      timeMin: '2026-07-07T00:00:00Z',
      timeMax: '2026-09-05T00:00:00Z',
      singleEvents: true,
      showDeleted: true,
      maxResults: 250,
      pageToken: undefined,
    })
    expect(res.nextCursor).toBe('tok-1')
    expect(res.events).toEqual([
      {
        id: 'ev1', status: 'active', title: 'Standup', description: 'daily', location: 'Zoom',
        start: '2026-07-08T10:00:00+03:00', end: '2026-07-08T10:30:00+03:00', allDay: false, transparent: false,
      },
      { id: 'ev2', status: 'cancelled', title: '', description: '', location: '', start: '', end: '', allDay: false, transparent: false },
      {
        id: 'ev3', status: 'active', title: 'OOO', description: '', location: '',
        start: '2026-07-09', end: '2026-07-10', allDay: true, transparent: true,
      },
    ])
  })

  it('uses syncToken when cursor exists and follows pagination', async () => {
    executeTool
      .mockResolvedValueOnce({ items: [{ id: 'a', status: 'confirmed', start: { dateTime: 'x' }, end: { dateTime: 'y' } }], nextPageToken: 'p2' })
      .mockResolvedValueOnce({ items: [], nextSyncToken: 'tok-2' })

    const res = await googleProvider.listChanges('acc1', 'cal1', 'tok-1', 'ws', 'we')

    expect(executeTool).toHaveBeenNthCalledWith(1, 'GOOGLECALENDAR_EVENTS_LIST', 'acc1', {
      calendarId: 'cal1', syncToken: 'tok-1', pageToken: undefined,
    })
    expect(executeTool).toHaveBeenNthCalledWith(2, 'GOOGLECALENDAR_EVENTS_LIST', 'acc1', {
      calendarId: 'cal1', syncToken: 'tok-1', pageToken: 'p2',
    })
    expect(res.events).toHaveLength(1)
    expect(res.nextCursor).toBe('tok-2')
  })

  it('unwraps response_data envelopes', async () => {
    executeTool.mockResolvedValueOnce({ response_data: { items: [], nextSyncToken: 't' } })
    const res = await googleProvider.listChanges('acc1', 'cal1', null, 'ws', 'we')
    expect(res).toEqual({ events: [], nextCursor: 't' })
  })
})

describe('googleProvider.createEvent', () => {
  it('creates a timed event with computed duration and returns its id', async () => {
    executeTool.mockResolvedValueOnce({ response_data: { id: 'new-ev' } })
    const id = await googleProvider.createEvent('acc1', 'cal1', {
      title: 'Busy', start: '2026-07-08T10:00:00+03:00', end: '2026-07-08T11:30:00+03:00', allDay: false,
    })
    expect(id).toBe('new-ev')
    expect(executeTool).toHaveBeenCalledWith('GOOGLECALENDAR_CREATE_EVENT', 'acc1', {
      calendar_id: 'cal1',
      summary: 'Busy',
      description: undefined,
      location: undefined,
      start_datetime: '2026-07-08T07:00:00',
      event_duration_hour: 1,
      event_duration_minutes: 30,
      timezone: 'UTC',
    })
  })

  it('creates all-day blockers as 24h timed events', async () => {
    // ponytail: Composio create tool has no confirmed all-day support; 24h timed blocker is equivalent for busy purposes
    executeTool.mockResolvedValueOnce({ id: 'new-ev2' })
    await googleProvider.createEvent('acc1', 'cal1', { title: 'Busy', start: '2026-07-09', end: '2026-07-10', allDay: true })
    expect(executeTool).toHaveBeenCalledWith('GOOGLECALENDAR_CREATE_EVENT', 'acc1', {
      calendar_id: 'cal1',
      summary: 'Busy',
      description: undefined,
      location: undefined,
      start_datetime: '2026-07-09T00:00:00',
      event_duration_hour: 24,
      event_duration_minutes: 0,
      timezone: 'UTC',
    })
  })

  it('clamps multi-day (>24h) events to a 24h blocker with a naive start', async () => {
    executeTool.mockResolvedValueOnce({ id: 'new-ev3' })
    await googleProvider.createEvent('acc1', 'cal1', { title: 'Busy', start: '2026-07-09', end: '2026-07-12', allDay: true })
    expect(executeTool).toHaveBeenCalledWith('GOOGLECALENDAR_CREATE_EVENT', 'acc1', {
      calendar_id: 'cal1',
      summary: 'Busy',
      description: undefined,
      location: undefined,
      start_datetime: '2026-07-09T00:00:00',
      event_duration_hour: 24,
      event_duration_minutes: 0,
      timezone: 'UTC',
    })
  })

  it('throws when the create response has no id', async () => {
    executeTool.mockResolvedValueOnce({ response_data: {} })
    await expect(
      googleProvider.createEvent('acc1', 'cal1', { title: 'Busy', start: '2026-07-08T10:00:00Z', end: '2026-07-08T11:00:00Z', allDay: false }),
    ).rejects.toThrow('no event id')
  })
})

describe('googleProvider.createEvent colors', () => {
  it('patches colorId through the proxy after creating', async () => {
    executeTool.mockResolvedValueOnce({ id: 'ev1' })
    proxyRequest.mockResolvedValueOnce({})

    const id = await googleProvider.createEvent('acc1', 'my cal@x.com', {
      title: 'Busy', start: '2026-07-08T10:00:00Z', end: '2026-07-08T11:00:00Z', allDay: false, colorId: '7',
    })

    expect(id).toBe('ev1')
    expect(proxyRequest).toHaveBeenCalledWith(
      'acc1',
      'PATCH',
      'https://www.googleapis.com/calendar/v3/calendars/my%20cal%40x.com/events/ev1',
      { colorId: '7' },
    )
  })

  it('skips the proxy entirely when no colorId is set', async () => {
    executeTool.mockResolvedValueOnce({ id: 'ev1' })
    await googleProvider.createEvent('acc1', 'cal1', { title: 'Busy', start: '2026-07-08T10:00:00Z', end: '2026-07-08T11:00:00Z', allDay: false })
    expect(proxyRequest).not.toHaveBeenCalled()
  })

  it('still returns the event id when the color patch fails', async () => {
    executeTool.mockResolvedValueOnce({ id: 'ev1' })
    proxyRequest.mockRejectedValueOnce(new Error('proxy down'))

    await expect(
      googleProvider.createEvent('acc1', 'cal1', { title: 'Busy', start: '2026-07-08T10:00:00Z', end: '2026-07-08T11:00:00Z', allDay: false, colorId: '5' }),
    ).resolves.toBe('ev1')
  })
})

describe('googleProvider.deleteEvent / listCalendars / listEvents', () => {
  it('deletes by calendar and event id', async () => {
    executeTool.mockResolvedValueOnce({})
    await googleProvider.deleteEvent('acc1', 'cal1', 'ev9')
    expect(executeTool).toHaveBeenCalledWith('GOOGLECALENDAR_DELETE_EVENT', 'acc1', { calendar_id: 'cal1', event_id: 'ev9' })
  })

  it('lists calendars with primary and access role', async () => {
    executeTool.mockResolvedValueOnce({
      calendars: [
        { id: 'me@x.com', summary: 'me@x.com', primary: true, accessRole: 'owner' },
        { id: 'c1', summary: 'Work' },
        { id: 'hol', summary: 'Holidays', accessRole: 'reader' },
      ],
    })
    expect(await googleProvider.listCalendars('acc1')).toEqual([
      { id: 'me@x.com', name: 'me@x.com', primary: true, accessRole: 'owner' },
      { id: 'c1', name: 'Work' },
      { id: 'hol', name: 'Holidays', accessRole: 'reader' },
    ])
    expect(executeTool).toHaveBeenCalledWith('GOOGLECALENDAR_LIST_CALENDARS', 'acc1', { max_results: 250 })
  })

  it('lists events for a time range', async () => {
    executeTool.mockResolvedValueOnce({ items: [] })
    await googleProvider.listEvents('acc1', 'cal1', 't1', 't2')
    expect(executeTool).toHaveBeenCalledWith('GOOGLECALENDAR_EVENTS_LIST', 'acc1', {
      calendarId: 'cal1', timeMin: 't1', timeMax: 't2', singleEvents: true, showDeleted: false, maxResults: 250, pageToken: undefined,
    })
  })
})
