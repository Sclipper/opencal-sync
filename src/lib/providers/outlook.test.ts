import { beforeEach, describe, expect, it, vi } from 'vitest'

const executeTool = vi.fn()
vi.mock('../composio', () => ({
  executeTool: (...args: unknown[]) => executeTool(...args),
}))

const { outlookProvider } = await import('./outlook')

beforeEach(() => executeTool.mockReset())

describe('outlookProvider.listChanges', () => {
  it('does a full-window snapshot fetch, maps Graph events, and ignores the cursor', async () => {
    executeTool.mockResolvedValueOnce({
      value: [
        {
          id: 'ev1',
          subject: 'Standup',
          bodyPreview: 'daily',
          location: { displayName: 'Teams' },
          start: { dateTime: '2026-07-08T07:00:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-07-08T07:30:00.0000000', timeZone: 'UTC' },
          isAllDay: false,
          showAs: 'busy',
          isCancelled: false,
        },
        { '@removed': { reason: 'deleted' }, id: 'ev2' },
        {
          id: 'ev3',
          subject: 'OOO',
          start: { dateTime: '2026-07-09T00:00:00.0000000', timeZone: 'UTC' },
          end: { dateTime: '2026-07-10T00:00:00.0000000', timeZone: 'UTC' },
          isAllDay: true,
          showAs: 'free',
        },
      ],
    })

    const res = await outlookProvider.listChanges('acc1', 'cal1', 'some-stale-cursor', '2026-07-07T00:00:00Z', '2026-09-05T00:00:00Z')

    expect(executeTool).toHaveBeenCalledWith('OUTLOOK_OUTLOOK_LIST_EVENTS', 'acc1', {
      filter: "start/dateTime lt '2026-09-05T00:00:00Z' and end/dateTime gt '2026-07-07T00:00:00Z'",
      top: 250,
      skip: 0,
      expand_recurring_events: true,
    })
    expect(res.nextCursor).toBeNull()
    expect(res.snapshot).toBe(true)
    expect(res.events).toEqual([
      {
        id: 'ev1', status: 'active', title: 'Standup', description: 'daily', location: 'Teams',
        start: '2026-07-08T07:00:00.0000000Z', end: '2026-07-08T07:30:00.0000000Z', allDay: false, transparent: false,
      },
      { id: 'ev2', status: 'cancelled', title: '', description: '', location: '', start: '', end: '', allDay: false, transparent: false },
      {
        id: 'ev3', status: 'active', title: 'OOO', description: '', location: '',
        start: '2026-07-09', end: '2026-07-10', allDay: true, transparent: true,
      },
    ])
  })

  it('unwraps response_data envelopes', async () => {
    executeTool.mockResolvedValueOnce({ response_data: { value: [] } })
    const res = await outlookProvider.listChanges('acc1', 'cal1', null, '2026-07-07T00:00:00Z', '2026-09-05T00:00:00Z')
    expect(res).toEqual({ events: [], nextCursor: null, snapshot: true })
  })

  it('paginates with skip when a page comes back full (250 items)', async () => {
    const graphEvent = (id: string) => ({
      id,
      subject: 'E',
      start: { dateTime: '2026-07-08T07:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-07-08T07:30:00.0000000', timeZone: 'UTC' },
    })
    executeTool
      .mockResolvedValueOnce({ value: Array.from({ length: 250 }, (_, i) => graphEvent(`ev${i}`)) })
      .mockResolvedValueOnce({ value: [graphEvent('ev250')] })

    const res = await outlookProvider.listChanges('acc1', 'cal1', null, '2026-07-07T00:00:00Z', '2026-09-05T00:00:00Z')

    const filter = "start/dateTime lt '2026-09-05T00:00:00Z' and end/dateTime gt '2026-07-07T00:00:00Z'"
    expect(executeTool).toHaveBeenNthCalledWith(1, 'OUTLOOK_OUTLOOK_LIST_EVENTS', 'acc1', {
      filter, top: 250, skip: 0, expand_recurring_events: true,
    })
    expect(executeTool).toHaveBeenNthCalledWith(2, 'OUTLOOK_OUTLOOK_LIST_EVENTS', 'acc1', {
      filter, top: 250, skip: 250, expand_recurring_events: true,
    })
    expect(executeTool).toHaveBeenCalledTimes(2)
    expect(res.events).toHaveLength(251)
    expect(res.events[0].id).toBe('ev0')
    expect(res.events[250].id).toBe('ev250')
  })
})

describe('outlookProvider writes', () => {
  it('creates events with naive UTC datetimes on the default calendar', async () => {
    executeTool.mockResolvedValueOnce({ response_data: { id: 'new1' } })
    const id = await outlookProvider.createEvent('acc1', 'cal1', {
      title: 'Busy', description: 'x', start: '2026-07-08T10:00:00+03:00', end: '2026-07-08T11:00:00+03:00', allDay: false,
    })
    expect(id).toBe('new1')
    expect(executeTool).toHaveBeenCalledWith('OUTLOOK_OUTLOOK_CALENDAR_CREATE_EVENT', 'acc1', {
      subject: 'Busy',
      body: 'x',
      location: undefined,
      start_datetime: '2026-07-08T07:00:00',
      end_datetime: '2026-07-08T08:00:00',
      time_zone: 'UTC',
      show_as: 'busy',
    })
  })

  it('creates all-day events as an untruncated multi-day timed span', async () => {
    executeTool.mockResolvedValueOnce({ id: 'new2' })
    await outlookProvider.createEvent('acc1', 'cal1', { title: 'Busy', start: '2026-07-09', end: '2026-07-12', allDay: true })
    expect(executeTool).toHaveBeenCalledWith('OUTLOOK_OUTLOOK_CALENDAR_CREATE_EVENT', 'acc1', {
      subject: 'Busy',
      body: '',
      location: undefined,
      start_datetime: '2026-07-09T00:00:00',
      end_datetime: '2026-07-12T00:00:00',
      time_zone: 'UTC',
      show_as: 'busy',
    })
  })

  it('throws when the create response has no id', async () => {
    executeTool.mockResolvedValueOnce({ response_data: {} })
    await expect(
      outlookProvider.createEvent('acc1', 'cal1', { title: 'Busy', start: '2026-07-08T10:00:00Z', end: '2026-07-08T11:00:00Z', allDay: false }),
    ).rejects.toThrow('no event id')
  })

  it('deletes events without sending cancellation notifications', async () => {
    executeTool.mockResolvedValueOnce({})
    await outlookProvider.deleteEvent('acc1', 'cal1', 'ev9')
    expect(executeTool).toHaveBeenCalledWith('OUTLOOK_OUTLOOK_DELETE_EVENT', 'acc1', { event_id: 'ev9', send_notifications: false })
  })
})

describe('outlookProvider reads', () => {
  it('returns only the default calendar, suffixed', async () => {
    executeTool.mockResolvedValueOnce({
      value: [
        { id: 'c1', name: 'Calendar', isDefaultCalendar: false },
        { id: 'c2', name: 'Personal', isDefaultCalendar: true },
      ],
    })
    expect(await outlookProvider.listCalendars('acc1')).toEqual([{ id: 'c2', name: 'Personal (default)', primary: true }])
    expect(executeTool).toHaveBeenCalledWith('OUTLOOK_LIST_CALENDARS', 'acc1', {})
  })

  it('falls back to the first calendar when none is flagged default', async () => {
    executeTool.mockResolvedValueOnce({ value: [{ id: 'c1', name: 'Calendar' }] })
    expect(await outlookProvider.listCalendars('acc1')).toEqual([{ id: 'c1', name: 'Calendar (default)', primary: true }])
  })

  it('lists events in a range via the shared window helper', async () => {
    executeTool.mockResolvedValueOnce({ value: [] })
    await outlookProvider.listEvents('acc1', 'cal1', '2026-07-07T00:00:00Z', '2026-09-05T00:00:00Z')
    expect(executeTool).toHaveBeenCalledWith('OUTLOOK_OUTLOOK_LIST_EVENTS', 'acc1', {
      filter: "start/dateTime lt '2026-09-05T00:00:00Z' and end/dateTime gt '2026-07-07T00:00:00Z'",
      top: 250,
      skip: 0,
      expand_recurring_events: true,
    })
  })
})
