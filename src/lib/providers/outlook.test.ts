import { beforeEach, describe, expect, it, vi } from 'vitest'

const executeTool = vi.fn()
vi.mock('../composio', () => ({
  executeTool: (...args: unknown[]) => executeTool(...args),
}))

const { outlookProvider } = await import('./outlook')

beforeEach(() => executeTool.mockReset())

describe('outlookProvider.listChanges', () => {
  it('maps Graph events, @removed entries, and delta link', async () => {
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
      '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=abc',
    })

    const res = await outlookProvider.listChanges('acc1', 'cal1', null, '2026-07-07T00:00:00Z', '2026-09-05T00:00:00Z')

    expect(executeTool).toHaveBeenCalledWith('OUTLOOK_LIST_CALENDAR_VIEW_DELTA', 'acc1', {
      calendar_id: 'cal1',
      start_datetime: '2026-07-07T00:00:00Z',
      end_datetime: '2026-09-05T00:00:00Z',
    })
    expect(res.nextCursor).toBe('https://graph.microsoft.com/delta?token=abc')
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

  it('passes the stored delta cursor and follows nextLink pages', async () => {
    executeTool
      .mockResolvedValueOnce({ value: [], '@odata.nextLink': 'https://graph/next?x=1' })
      .mockResolvedValueOnce({ value: [], '@odata.deltaLink': 'https://graph/delta?y=2' })

    const res = await outlookProvider.listChanges('acc1', 'cal1', 'https://graph/delta?old=1', 'ws', 'we')

    expect(executeTool).toHaveBeenNthCalledWith(1, 'OUTLOOK_LIST_CALENDAR_VIEW_DELTA', 'acc1', {
      calendar_id: 'cal1', start_datetime: 'ws', end_datetime: 'we', delta_token: 'https://graph/delta?old=1',
    })
    expect(executeTool).toHaveBeenNthCalledWith(2, 'OUTLOOK_LIST_CALENDAR_VIEW_DELTA', 'acc1', {
      calendar_id: 'cal1', start_datetime: 'ws', end_datetime: 'we', delta_token: 'https://graph/next?x=1',
    })
    expect(res.nextCursor).toBe('https://graph/delta?y=2')
  })
})

describe('outlookProvider writes', () => {
  it('creates events in a specific calendar', async () => {
    executeTool.mockResolvedValueOnce({ response_data: { id: 'new1' } })
    const id = await outlookProvider.createEvent('acc1', 'cal1', {
      title: 'Busy', description: 'x', start: '2026-07-08T10:00:00+03:00', end: '2026-07-08T11:00:00+03:00', allDay: false,
    })
    expect(id).toBe('new1')
    expect(executeTool).toHaveBeenCalledWith('OUTLOOK_CREATE_CALENDAR_EVENT_IN_CALENDAR', 'acc1', {
      calendar_id: 'cal1',
      subject: 'Busy',
      body: 'x',
      location: undefined,
      is_all_day: false,
      start_datetime: '2026-07-08T07:00:00.000Z',
      end_datetime: '2026-07-08T08:00:00.000Z',
      time_zone: 'UTC',
      show_as: 'busy',
    })
  })

  it('creates all-day events with date bounds preserved', async () => {
    executeTool.mockResolvedValueOnce({ id: 'new2' })
    await outlookProvider.createEvent('acc1', 'cal1', { title: 'Busy', start: '2026-07-09', end: '2026-07-10', allDay: true })
    expect(executeTool).toHaveBeenCalledWith('OUTLOOK_CREATE_CALENDAR_EVENT_IN_CALENDAR', 'acc1', {
      calendar_id: 'cal1',
      subject: 'Busy',
      body: undefined,
      location: undefined,
      is_all_day: true,
      start_datetime: '2026-07-09T00:00:00.000Z',
      end_datetime: '2026-07-10T00:00:00.000Z',
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

  it('deletes events', async () => {
    executeTool.mockResolvedValueOnce({})
    await outlookProvider.deleteEvent('acc1', 'cal1', 'ev9')
    expect(executeTool).toHaveBeenCalledWith('OUTLOOK_DELETE_CALENDAR_EVENT', 'acc1', { event_id: 'ev9' })
  })
})

describe('outlookProvider reads', () => {
  it('lists calendars', async () => {
    executeTool.mockResolvedValueOnce({ value: [{ id: 'c1', name: 'Calendar' }] })
    expect(await outlookProvider.listCalendars('acc1')).toEqual([{ id: 'c1', name: 'Calendar' }])
    expect(executeTool).toHaveBeenCalledWith('OUTLOOK_LIST_CALENDARS', 'acc1', {})
  })

  it('lists events in a range via calendar view', async () => {
    executeTool.mockResolvedValueOnce({ value: [] })
    await outlookProvider.listEvents('acc1', 'cal1', 't1', 't2')
    expect(executeTool).toHaveBeenCalledWith('OUTLOOK_LIST_USER_CALENDAR_VIEW', 'acc1', {
      calendar_id: 'cal1', start_datetime: 't1', end_datetime: 't2',
    })
  })
})
