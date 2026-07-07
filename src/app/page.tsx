import Link from 'next/link'
import { requireAuth } from '../lib/auth'
import { getDb } from '../lib/db'
import { connect, createSyncLink, deleteConnection, deleteSyncLink, syncNow } from './actions'

export const dynamic = 'force-dynamic'

type ConnectionRow = { id: number; provider: string; account_label: string; status: string }
type CalendarRow = { id: number; name: string; account_label: string; provider: string }
type LinkRow = {
  id: number; mode: string; pair_id: string | null; last_run_at: string | null; last_error: string | null
  src_name: string; src_label: string; tgt_name: string; tgt_label: string
}
type RunRow = { started_at: string; duration_ms: number; events_processed: number; errors: string | null }

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireAuth()
  const { error } = await searchParams
  const db = getDb()
  const connections = db.prepare('SELECT id, provider, account_label, status FROM connections ORDER BY id').all() as ConnectionRow[]
  const calendars = db.prepare(
    `SELECT c.id, c.name, con.account_label, con.provider FROM calendars c JOIN connections con ON con.id = c.connection_id WHERE con.status = 'active' ORDER BY con.id, c.name`,
  ).all() as CalendarRow[]
  const links = db.prepare(
    `SELECT l.id, l.mode, l.pair_id, l.last_run_at, l.last_error,
            sc.name AS src_name, scon.account_label AS src_label, tc.name AS tgt_name, tcon.account_label AS tgt_label
     FROM sync_links l
     JOIN calendars sc ON sc.id = l.source_calendar_id JOIN connections scon ON scon.id = sc.connection_id
     JOIN calendars tc ON tc.id = l.target_calendar_id JOIN connections tcon ON tcon.id = tc.connection_id
     ORDER BY l.id`,
  ).all() as LinkRow[]
  const runs = db.prepare('SELECT started_at, duration_ms, events_processed, errors FROM sync_runs ORDER BY id DESC LIMIT 10').all() as RunRow[]

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">opencal-sync</h1>
        <nav className="space-x-4 text-sm text-zinc-600">
          <Link href="/availability">Availability</Link>
          <Link href="/settings">Settings</Link>
        </nav>
      </header>

      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">Error: {error}</p>}

      <section className="rounded-lg border border-zinc-200 bg-white p-6">
        <h2 className="mb-4 font-medium">Connected accounts</h2>
        <ul className="space-y-2">
          {connections.map((c) => (
            <li key={c.id} className="flex items-center justify-between text-sm">
              <span>
                {c.provider === 'google' ? 'Google' : 'Outlook'} — {c.account_label || 'pending…'}{' '}
                <span className={c.status === 'active' ? 'text-green-600' : 'text-amber-600'}>({c.status})</span>
              </span>
              <form action={deleteConnection}>
                <input type="hidden" name="id" value={c.id} />
                <button className="text-red-600 hover:underline">remove</button>
              </form>
            </li>
          ))}
          {connections.length === 0 && <li className="text-sm text-zinc-500">No accounts connected yet.</li>}
        </ul>
        <div className="mt-4 flex gap-2">
          <form action={connect}>
            <input type="hidden" name="provider" value="google" />
            <button className="rounded border border-zinc-300 px-3 py-1.5 text-sm">+ Connect Google</button>
          </form>
          <form action={connect}>
            <input type="hidden" name="provider" value="outlook" />
            <button className="rounded border border-zinc-300 px-3 py-1.5 text-sm">+ Connect Outlook</button>
          </form>
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-medium">Sync links</h2>
          <form action={syncNow}>
            <button className="rounded bg-zinc-900 px-3 py-1.5 text-sm text-white">Sync now</button>
          </form>
        </div>
        <ul className="space-y-2">
          {links.map((l) => (
            <li key={l.id} className="flex items-center justify-between text-sm">
              <span>
                {l.src_label}/{l.src_name} → {l.tgt_label}/{l.tgt_name} <span className="text-zinc-500">({l.mode}{l.pair_id ? ', two-way pair' : ''})</span>
                {l.last_error && <span className="ml-2 text-red-600" title={l.last_error}>⚠ {l.last_error.slice(0, 60)}</span>}
              </span>
              <form action={deleteSyncLink}>
                <input type="hidden" name="id" value={l.id} />
                <button className="text-red-600 hover:underline">delete</button>
              </form>
            </li>
          ))}
          {links.length === 0 && <li className="text-sm text-zinc-500">No sync links yet.</li>}
        </ul>

        {calendars.length >= 2 ? (
          <form action={createSyncLink} className="mt-4 grid grid-cols-2 gap-2 text-sm">
            <select name="source" className="rounded border border-zinc-300 px-2 py-1.5">
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>{c.account_label}/{c.name}</option>
              ))}
            </select>
            <select name="target" className="rounded border border-zinc-300 px-2 py-1.5">
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>{c.account_label}/{c.name}</option>
              ))}
            </select>
            <select name="mode" className="rounded border border-zinc-300 px-2 py-1.5">
              <option value="busy">Busy blocker</option>
              <option value="clone">Full clone</option>
            </select>
            <input name="busy_title" placeholder="Blocker title (Busy)" className="rounded border border-zinc-300 px-2 py-1.5" />
            <input name="title_suffix" placeholder="Clone title suffix, e.g. (Work)" className="rounded border border-zinc-300 px-2 py-1.5" />
            <label className="flex items-center gap-2"><input type="checkbox" name="two_way" /> two-way</label>
            <button className="rounded bg-zinc-900 px-3 py-1.5 text-white">Add sync</button>
          </form>
        ) : (
          <p className="mt-4 text-sm text-zinc-500">Connect at least two calendars to create a sync.</p>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-6">
        <h2 className="mb-4 font-medium">Recent sync runs</h2>
        <ul className="space-y-1 text-sm text-zinc-600">
          {runs.map((r, i) => (
            <li key={i}>
              {r.started_at} — {r.events_processed} events in {r.duration_ms}ms
              {r.errors && <span className="text-red-600"> — {r.errors.slice(0, 80)}</span>}
            </li>
          ))}
          {runs.length === 0 && <li className="text-zinc-500">No runs yet.</li>}
        </ul>
      </section>
    </main>
  )
}
