export type Interval = { start: number; end: number }

export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start)
  const out: Interval[] = []
  for (const cur of sorted) {
    const last = out[out.length - 1]
    if (last && cur.start <= last.end) last.end = Math.max(last.end, cur.end)
    else out.push({ ...cur })
  }
  return out
}

function tzParts(tz: string, utcMs: number): Record<string, string> {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short',
  })
  return Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]))
}

function tzOffset(tz: string, utcMs: number): number {
  const p = tzParts(tz, utcMs)
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second)
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

export function zonedTimeToUtc(date: string, time: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  const naive = Date.UTC(y, m - 1, d, hh, mm)
  const off1 = tzOffset(tz, naive)
  const ts1 = naive - off1
  const off2 = tzOffset(tz, ts1)
  if (off2 === off1) return ts1
  const ts2 = naive - off2
  const off3 = tzOffset(tz, ts2)
  if (off3 === off2) return ts2
  // ponytail: wall time falls in a spring-forward gap (no consistent instant exists);
  // clamp forward past the gap — e.g. 02:30 on a US spring-forward day → 03:30 local
  return Math.max(ts1, ts2)
}

export type WorkingHours = { days: string[]; start: string; end: string }
export type DaySlots = { date: string; weekday: string; slots: { start: string; end: string }[] }

const MIN_SLOT_MS = 15 * 60_000

function localHm(tz: string, utcMs: number): string {
  const p = tzParts(tz, utcMs)
  return `${p.hour === '24' ? '00' : p.hour}:${p.minute}`
}

export function computeFreeSlots(opts: {
  busy: Interval[]
  hours: WorkingHours
  timezone: string
  daysAhead: number
  from: number
}): DaySlots[] {
  const busy = mergeIntervals(opts.busy)
  const days: DaySlots[] = []
  // anchor at local noon of the start day and step 24h — immune to DST day-length changes
  const startParts = tzParts(opts.timezone, opts.from)
  const startDate = `${startParts.year}-${startParts.month}-${startParts.day}`
  let anchor = zonedTimeToUtc(startDate, '12:00', opts.timezone)

  for (let i = 0; i < opts.daysAhead; i++, anchor += 86_400_000) {
    const p = tzParts(opts.timezone, anchor)
    const weekday = p.weekday.toLowerCase().slice(0, 3)
    if (!opts.hours.days.includes(weekday)) continue
    const date = `${p.year}-${p.month}-${p.day}`
    const windowStart = Math.max(zonedTimeToUtc(date, opts.hours.start, opts.timezone), opts.from)
    const windowEnd = zonedTimeToUtc(date, opts.hours.end, opts.timezone)
    if (windowEnd <= windowStart) {
      days.push({ date, weekday, slots: [] })
      continue
    }

    const slots: { start: string; end: string }[] = []
    let cursor = windowStart
    for (const b of busy) {
      if (b.end <= cursor || b.start >= windowEnd) continue
      if (b.start - cursor >= MIN_SLOT_MS) slots.push({ start: localHm(opts.timezone, cursor), end: localHm(opts.timezone, b.start) })
      cursor = Math.max(cursor, b.end)
    }
    if (windowEnd - cursor >= MIN_SLOT_MS) slots.push({ start: localHm(opts.timezone, cursor), end: localHm(opts.timezone, windowEnd) })
    days.push({ date, weekday, slots })
  }
  return days
}

export function formatSummary(days: DaySlots[]): string {
  return days
    .map((d) => {
      const label = `${d.weekday[0].toUpperCase()}${d.weekday.slice(1)} ${d.date}`
      return d.slots.length ? `${label}: ${d.slots.map((s) => `${s.start}–${s.end}`).join(', ')}` : `${label}: no availability`
    })
    .join('\n')
}
