import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireAuth } from '../../lib/auth'
import { getDb } from '../../lib/db'

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

export default async function AvailabilityAdmin() {
  await requireAuth()
  const db = getDb()
  const pages = db.prepare('SELECT id, slug, timezone, days_ahead FROM availability_pages ORDER BY id').all() as {
    id: number; slug: string; timezone: string; days_ahead: number
  }[]
  const calendars = db.prepare(
    `SELECT c.id, c.name, con.account_label FROM calendars c JOIN connections con ON con.id = c.connection_id WHERE con.status = 'active' ORDER BY con.id, c.name`,
  ).all() as { id: number; name: string; account_label: string }[]
  const timezones = Intl.supportedValuesOf('timeZone')

  return (
    <main className="mx-auto max-w-xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Availability pages</h1>
        <Link href="/" className="text-sm text-zinc-600">← Dashboard</Link>
      </header>

      <ul className="space-y-2">
        {pages.map((p) => (
          <li key={p.id} className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-4 text-sm">
            <span>
              <a href={`/a/${p.slug}`} className="font-medium text-blue-700 hover:underline">/a/{p.slug}</a>
              <span className="ml-2 text-zinc-500">{p.timezone}, next {p.days_ahead} days</span>
            </span>
            <form action={deletePage}>
              <input type="hidden" name="id" value={p.id} />
              <button className="text-red-600 hover:underline">delete</button>
            </form>
          </li>
        ))}
        {pages.length === 0 && <li className="text-sm text-zinc-500">No availability pages yet.</li>}
      </ul>

      <form action={savePage} className="space-y-3 rounded-lg border border-zinc-200 bg-white p-6 text-sm">
        <h2 className="font-medium">Create / update page</h2>
        <input name="slug" placeholder="slug (e.g. me)" required className="w-full rounded border border-zinc-300 px-3 py-2" />
        <fieldset>
          <legend className="mb-1 font-medium">Calendars counted as busy</legend>
          {calendars.map((c) => (
            <label key={c.id} className="mr-4 inline-flex items-center gap-1">
              <input type="checkbox" name="calendar_ids" value={c.id} /> {c.account_label}/{c.name}
            </label>
          ))}
          {calendars.length === 0 && <p className="text-zinc-500">Connect calendars first.</p>}
        </fieldset>
        <fieldset>
          <legend className="mb-1 font-medium">Working days</legend>
          {WEEKDAYS.map((d) => (
            <label key={d} className="mr-3 inline-flex items-center gap-1">
              <input type="checkbox" name={`day_${d}`} defaultChecked={!['sat', 'sun'].includes(d)} /> {d}
            </label>
          ))}
        </fieldset>
        <div className="grid grid-cols-2 gap-2">
          <label>Start <input type="time" name="start" defaultValue="09:00" className="w-full rounded border border-zinc-300 px-2 py-1.5" /></label>
          <label>End <input type="time" name="end" defaultValue="17:00" className="w-full rounded border border-zinc-300 px-2 py-1.5" /></label>
          <label>Timezone
            <select name="timezone" defaultValue="UTC" className="w-full rounded border border-zinc-300 px-2 py-1.5">
              {timezones.map((tz) => <option key={tz}>{tz}</option>)}
            </select>
          </label>
          <label>Days ahead <input type="number" name="days_ahead" defaultValue={14} min={1} max={60} className="w-full rounded border border-zinc-300 px-2 py-1.5" /></label>
        </div>
        <button className="rounded bg-zinc-900 px-4 py-2 text-white">Save page</button>
      </form>
    </main>
  )
}
