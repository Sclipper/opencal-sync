import { redirect } from 'next/navigation'
import { requireAuth } from '../../lib/auth'
import { getDb } from '../../lib/db'
import { Masthead } from '../masthead'

export const dynamic = 'force-dynamic'

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

async function savePage(formData: FormData) {
  'use server'
  await requireAuth()
  const db = getDb()
  const slug = String(formData.get('slug') ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
  if (!slug) redirect('/availability?error=slug')
  const calendarIds = formData.getAll('calendar_ids').map(Number).filter(Boolean)
  const hours = {
    days: WEEKDAYS.filter((d) => formData.get(`day_${d}`) === 'on'),
    start: String(formData.get('start') || '09:00'),
    end: String(formData.get('end') || '17:00'),
  }
  db.prepare(
    `INSERT INTO availability_pages (slug, calendar_ids, working_hours, timezone, days_ahead)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(slug) DO UPDATE SET calendar_ids = excluded.calendar_ids, working_hours = excluded.working_hours,
       timezone = excluded.timezone, days_ahead = excluded.days_ahead`,
  ).run(slug, JSON.stringify(calendarIds), JSON.stringify(hours), String(formData.get('timezone') || 'UTC'), Number(formData.get('days_ahead') || 14))
  redirect('/availability')
}

async function deletePage(formData: FormData) {
  'use server'
  await requireAuth()
  getDb().prepare('DELETE FROM availability_pages WHERE id = ?').run(Number(formData.get('id')))
  redirect('/availability')
}

type CalRow = { id: number; name: string; connection_id: number; account_label: string }

export default async function AvailabilityAdmin({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireAuth()
  const { error } = await searchParams
  const db = getDb()
  const pages = db.prepare('SELECT id, slug, timezone, days_ahead FROM availability_pages ORDER BY id').all() as {
    id: number; slug: string; timezone: string; days_ahead: number
  }[]
  const calendars = db.prepare(
    `SELECT c.id, c.name, c.connection_id, con.account_label
     FROM calendars c JOIN connections con ON con.id = c.connection_id
     WHERE con.status = 'active' ORDER BY con.id, c.is_primary DESC, c.name`,
  ).all() as CalRow[]
  const byConnection = new Map<number, CalRow[]>()
  for (const c of calendars) byConnection.set(c.connection_id, [...(byConnection.get(c.connection_id) ?? []), c])
  const timezones = Intl.supportedValuesOf('timeZone')

  return (
    <>
      <Masthead active="/availability" />
      <main className="mx-auto max-w-xl space-y-6 px-4 py-8 sm:px-6">
        <div className="sect-head rise">
          <span className="sect-num">04</span>
          <h1 className="sect-title">Availability pages</h1>
        </div>
        {error === 'slug' && <p className="banner banner-err rise">Give the page a slug (letters, numbers, dashes).</p>}

        {pages.length > 0 && (
          <ul className="ticket rise d1">
            {pages.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-dashed px-4 py-3 text-sm last:border-b-0" style={{ borderColor: 'var(--ink-25)' }}>
                <span className="min-w-0">
                  <a href={`/a/${p.slug}`} className="mono font-bold underline decoration-2 underline-offset-4" style={{ textDecorationColor: 'var(--signal)' }}>
                    /a/{p.slug}
                  </a>
                  <span className="overline ml-3">{p.timezone} · next {p.days_ahead} days</span>
                </span>
                <form action={deletePage}>
                  <input type="hidden" name="id" value={p.id} />
                  <button className="link-danger">Delete</button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <form action={savePage} className="ticket ticket-dashed rise d2 space-y-5 p-5 sm:p-6">
          <p className="overline" style={{ color: 'var(--signal)' }}>Create / update page</p>
          <label className="block">
            <span className="lbl">Slug — public URL /a/…</span>
            <input name="slug" placeholder="me" required className="input" />
          </label>

          <fieldset>
            <legend className="lbl">Calendars counted as busy</legend>
            {calendars.length === 0 && <p className="overline">Connect calendars first.</p>}
            <div className="space-y-3">
              {[...byConnection.values()].map((group) => (
                <div key={group[0].connection_id}>
                  <p className="overline mb-1">{group[0].account_label}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {group.map((c) => (
                      <label key={c.id} className="inline-flex items-center gap-1.5 text-sm">
                        <input type="checkbox" name="calendar_ids" value={c.id} className="check" /> {c.name}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="lbl">Working days</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {WEEKDAYS.map((d) => (
                <label key={d} className="mono inline-flex items-center gap-1.5 text-xs uppercase">
                  <input type="checkbox" name={`day_${d}`} defaultChecked={!['sat', 'sun'].includes(d)} className="check" /> {d}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-2 gap-4">
            <label className="block">
              <span className="lbl">Start</span>
              <input type="time" name="start" defaultValue="09:00" className="input" />
            </label>
            <label className="block">
              <span className="lbl">End</span>
              <input type="time" name="end" defaultValue="17:00" className="input" />
            </label>
            <label className="block">
              <span className="lbl">Timezone</span>
              <select name="timezone" defaultValue="UTC" className="select">
                {timezones.map((tz) => <option key={tz}>{tz}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="lbl">Days ahead</span>
              <input type="number" name="days_ahead" defaultValue={14} min={1} max={60} className="input" />
            </label>
          </div>
          <button className="btn">Save page</button>
        </form>
      </main>
    </>
  )
}
