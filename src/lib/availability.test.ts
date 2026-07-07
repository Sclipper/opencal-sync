import { describe, expect, it } from 'vitest'
import { computeFreeSlots, formatSummary, mergeIntervals, zonedTimeToUtc } from './availability'

describe('mergeIntervals', () => {
  it('merges overlapping and adjacent intervals', () => {
    expect(mergeIntervals([
      { start: 10, end: 20 }, { start: 15, end: 25 }, { start: 25, end: 30 }, { start: 50, end: 60 },
    ])).toEqual([{ start: 10, end: 30 }, { start: 50, end: 60 }])
  })
  it('drops empty intervals and handles unsorted input', () => {
    expect(mergeIntervals([{ start: 5, end: 5 }, { start: 3, end: 1 }, { start: 2, end: 4 }])).toEqual([{ start: 2, end: 4 }])
  })
})

describe('zonedTimeToUtc', () => {
  it('converts wall-clock time in a timezone to epoch ms', () => {
    // Sofia is UTC+3 in July (EEST)
    expect(zonedTimeToUtc('2026-07-08', '09:00', 'Europe/Sofia')).toBe(Date.parse('2026-07-08T06:00:00Z'))
    // and UTC+2 in January (EET)
    expect(zonedTimeToUtc('2026-01-08', '09:00', 'Europe/Sofia')).toBe(Date.parse('2026-01-08T07:00:00Z'))
  })
  it('handles UTC', () => {
    expect(zonedTimeToUtc('2026-07-08', '12:30', 'UTC')).toBe(Date.parse('2026-07-08T12:30:00Z'))
  })
})

describe('computeFreeSlots', () => {
  const hours = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00' }
  // from = Wed 2026-07-08 00:00 UTC
  const from = Date.parse('2026-07-08T00:00:00Z')

  it('returns full working day when nothing is busy', () => {
    const days = computeFreeSlots({ busy: [], hours, timezone: 'UTC', daysAhead: 1, from })
    expect(days).toEqual([{ date: '2026-07-08', weekday: 'wed', slots: [{ start: '09:00', end: '17:00' }] }])
  })

  it('subtracts busy intervals and skips non-working days', () => {
    const busy = [
      { start: Date.parse('2026-07-08T10:00:00Z'), end: Date.parse('2026-07-08T11:30:00Z') },
      { start: Date.parse('2026-07-08T08:00:00Z'), end: Date.parse('2026-07-08T09:15:00Z') },
    ]
    const days = computeFreeSlots({ busy, hours, timezone: 'UTC', daysAhead: 4, from })
    expect(days[0]).toEqual({
      date: '2026-07-08', weekday: 'wed',
      slots: [{ start: '09:15', end: '10:00' }, { start: '11:30', end: '17:00' }],
    })
    // Jul 11 is Saturday, Jul 12 Sunday — not present
    expect(days.map((d) => d.date)).toEqual(['2026-07-08', '2026-07-09', '2026-07-10'])
  })

  it('drops slots shorter than 15 minutes and fully-busy days keep empty slot lists', () => {
    const busy = [{ start: Date.parse('2026-07-08T09:00:00Z'), end: Date.parse('2026-07-08T16:50:00Z') }]
    const days = computeFreeSlots({ busy, hours, timezone: 'UTC', daysAhead: 1, from })
    expect(days[0].slots).toEqual([])
  })

  it('respects timezones for day boundaries', () => {
    // busy 06:00-14:00 UTC = 09:00-17:00 in Sofia (UTC+3) — the whole working day
    const busy = [{ start: Date.parse('2026-07-08T06:00:00Z'), end: Date.parse('2026-07-08T14:00:00Z') }]
    const days = computeFreeSlots({ busy, hours, timezone: 'Europe/Sofia', daysAhead: 1, from })
    expect(days[0].slots).toEqual([])
  })
})

describe('formatSummary', () => {
  it('formats one line per day', () => {
    expect(formatSummary([
      { date: '2026-07-08', weekday: 'wed', slots: [{ start: '09:15', end: '10:00' }, { start: '11:30', end: '17:00' }] },
      { date: '2026-07-09', weekday: 'thu', slots: [] },
    ])).toBe('Wed 2026-07-08: 09:15–10:00, 11:30–17:00\nThu 2026-07-09: no availability')
  })
})
