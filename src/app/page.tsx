import { requireAuth } from '../lib/auth'
import { getDb } from '../lib/db'
import { GOOGLE_EVENT_COLORS, COLOR_HEX } from '../lib/event-colors'
import { connect, createSyncLink, deleteConnection, deleteSyncLink, refreshConnection, syncNow, updateSyncLink } from './actions'
import { Masthead } from './masthead'

export const dynamic = 'force-dynamic'

type ConnectionRow = { id: number; provider: string; account_label: string; status: string }
type CalendarRow = {
  id: number; name: string; is_primary: number; access_role: string
  connection_id: number; account_label: string; provider: string
}
type LinkRow = {
  id: number; mode: string; pair_id: string | null; event_color: string; title_prefix: string; title_suffix: string; busy_title: string
  private_copy: number; last_run_at: string | null; last_error: string | null
  src_name: string; src_label: string; tgt_name: string; tgt_label: string
}
type RunRow = { started_at: string; duration_ms: number; events_processed: number; errors: string | null }

const ERRORS: Record<string, string> = {
  'same-calendar': 'Source and target must be different calendars.',
  'duplicate-link': 'That sync link already exists.',
  'readonly-target': 'The target calendar is read-only — pick one you can write to.',
  'connect-failed': 'Connecting the account failed. Check the auth config in Settings.',
  'refresh-failed': 'Re-scanning calendars failed. Try again.',
  'cleanup-partial': 'Some synced events could not be deleted — the link was kept. Delete it again to retry.',
}

const isReadOnly = (role: string) => role === 'reader' || role === 'freeBusyReader'

const runTime = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
})

const syncTime = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

// sync_links.last_run_at is SQLite datetime('now'): "YYYY-MM-DD HH:MM:SS" in UTC, no zone marker
const formatLastSync = (v: string | null) => (v ? syncTime.format(new Date(`${v.replace(' ', 'T')}Z`)) : null)

function ColorSwatches({ current }: { current: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <input type="radio" name="event_color" value="" defaultChecked={!current} className="swatch swatch-none" title="Calendar default" />
      {GOOGLE_EVENT_COLORS.map((c) => (
        <input
          key={c.id}
          type="radio"
          name="event_color"
          value={c.id}
          defaultChecked={current === c.id}
          className="swatch"
          style={{ ['--c' as string]: c.hex }}
          title={c.name}
        />
      ))}
    </div>
  )
}

function CalendarOptions({ calendars, writableOnly }: { calendars: CalendarRow[]; writableOnly?: boolean }) {
  const byConnection = new Map<number, CalendarRow[]>()
  for (const c of calendars) {
    if (writableOnly && isReadOnly(c.access_role)) continue
    byConnection.set(c.connection_id, [...(byConnection.get(c.connection_id) ?? []), c])
  }
  return (
    <>
      {[...byConnection.values()].map((group) => (
        <optgroup key={group[0].connection_id} label={group[0].account_label}>
          {group.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}{c.is_primary ? ' — primary' : ''}{isReadOnly(c.access_role) ? ' · read-only' : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  )
}

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireAuth()
  const { error } = await searchParams
  const db = getDb()
  const connections = db.prepare('SELECT id, provider, account_label, status FROM connections ORDER BY id').all() as ConnectionRow[]
  const calendars = db.prepare(
    `SELECT c.id, c.name, c.is_primary, c.access_role, c.connection_id, con.account_label, con.provider
     FROM calendars c JOIN connections con ON con.id = c.connection_id
     WHERE con.status = 'active'
     ORDER BY con.id, c.is_primary DESC, (c.access_role IN ('reader', 'freeBusyReader')), c.name`,
  ).all() as CalendarRow[]
  const links = db.prepare(
    `SELECT l.id, l.mode, l.pair_id, l.event_color, l.title_prefix, l.title_suffix, l.busy_title, l.private_copy, l.last_run_at, l.last_error,
            sc.name AS src_name, scon.account_label AS src_label, tc.name AS tgt_name, tcon.account_label AS tgt_label
     FROM sync_links l
     JOIN calendars sc ON sc.id = l.source_calendar_id JOIN connections scon ON scon.id = sc.connection_id
     JOIN calendars tc ON tc.id = l.target_calendar_id JOIN connections tcon ON tcon.id = tc.connection_id
     ORDER BY l.id`,
  ).all() as LinkRow[]
  const runs = db.prepare('SELECT started_at, duration_ms, events_processed, errors FROM sync_runs ORDER BY id DESC LIMIT 10').all() as RunRow[]
  const calsByConnection = new Map<number, CalendarRow[]>()
  for (const c of calendars) calsByConnection.set(c.connection_id, [...(calsByConnection.get(c.connection_id) ?? []), c])

  return (
    <>
      <Masthead active="/" />
      <main className="mx-auto max-w-5xl space-y-12 px-4 py-8 sm:px-6">
        {error && <p className="banner banner-err rise">{ERRORS[error] ?? `Error: ${error}`}</p>}

        {/* 01 — accounts */}
        <section className="rise d1">
          <div className="sect-head mb-5 flex-wrap">
            <span className="sect-num">01</span>
            <h2 className="sect-title">Accounts</h2>
            <div className="ml-auto flex gap-2">
              <form action={connect}>
                <input type="hidden" name="provider" value="google" />
                <button className="btn-ghost btn-sm">+ Google</button>
              </form>
              <form action={connect}>
                <input type="hidden" name="provider" value="outlook" />
                <button className="btn-ghost btn-sm">+ Outlook</button>
              </form>
            </div>
          </div>

          {connections.length === 0 ? (
            <p className="overline">No accounts connected yet — plug one in above.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {connections.map((c) => {
                const cals = calsByConnection.get(c.id) ?? []
                return (
                  <div key={c.id} className="ticket flex flex-col gap-3 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="overline">{c.provider}</div>
                        <div className="truncate font-bold" title={c.account_label}>{c.account_label || 'pending…'}</div>
                      </div>
                      <span className={`stamp stamp-tilt ${c.status === 'active' ? 'stamp-go' : c.status === 'pending' ? 'stamp-warn' : 'stamp-err'}`}>
                        {c.status}
                      </span>
                    </div>

                    {cals.length > 0 && (
                      <details className="cal-details">
                        <summary>{cals.length} calendar{cals.length === 1 ? '' : 's'}</summary>
                        <div className="mt-2">
                          {cals.map((cal) => (
                            <div key={cal.id} className="cal-row">
                              <span className="min-w-0 flex-1 truncate" title={cal.name}>{cal.name}</span>
                              {cal.is_primary ? <span className="role-tag role-tag-primary">primary</span> : null}
                              {isReadOnly(cal.access_role) && <span className="role-tag">read-only</span>}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    <div className="mt-auto flex items-center justify-between border-t border-dashed pt-2" style={{ borderColor: 'var(--ink-25)' }}>
                      {c.status === 'active' ? (
                        <form action={refreshConnection}>
                          <input type="hidden" name="id" value={c.id} />
                          <button className="btn-ghost btn-sm">Re-scan</button>
                        </form>
                      ) : <span />}
                      <form action={deleteConnection}>
                        <input type="hidden" name="id" value={c.id} />
                        <button className="link-danger">Remove</button>
                      </form>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* 02 — sync links */}
        <section className="rise d2">
          <div className="sect-head mb-5">
            <span className="sect-num">02</span>
            <h2 className="sect-title">Sync links</h2>
            <form action={syncNow} className="ml-auto">
              <button className="btn btn-sm">Sync now</button>
            </form>
          </div>

          {links.length > 0 && (
            <ul className="ticket mb-6">
              {links.map((l) => (
                <li key={l.id} className="dep-row">
                  <div className="min-w-0">
                    <div className="overline truncate">{l.src_label}</div>
                    <div className="truncate font-semibold" title={l.src_name}>{l.src_name}</div>
                  </div>
                  <span className="dep-arrow" aria-hidden>→</span>
                  <div className="min-w-0">
                    <div className="overline truncate">{l.tgt_label}</div>
                    <div className="truncate font-semibold" title={l.tgt_name}>
                      {l.tgt_name}
                      {l.mode === 'clone' && (l.title_prefix || l.title_suffix) ? (
                        <span className="overline"> {[l.title_prefix, '…', l.title_suffix].filter(Boolean).join(' ')}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <span className="overline hidden sm:inline" title="Last synced">
                      {formatLastSync(l.last_run_at) ?? 'never synced'}
                    </span>
                    {l.event_color && COLOR_HEX[l.event_color] && (
                      <span
                        className="inline-block h-3.5 w-3.5 rounded-full border"
                        style={{ background: COLOR_HEX[l.event_color], borderColor: 'rgb(0 0 0 / 0.25)' }}
                        title={`Event color ${l.event_color}`}
                      />
                    )}
                    <span className="stamp stamp-dim">{l.mode}</span>
                    {l.private_copy === 1 && <span className="stamp stamp-dim">private</span>}
                    {l.pair_id && <span className="stamp stamp-dim">2-way</span>}
                    <form action={deleteSyncLink}>
                      <input type="hidden" name="id" value={l.id} />
                      <button className="link-danger">Del</button>
                    </form>
                  </div>
                  <details className="cal-details col-span-full">
                    <summary>
                      Edit<span className="overline sm:hidden"> · {formatLastSync(l.last_run_at) ?? 'never synced'}</span>
                    </summary>
                    <form action={updateSyncLink} className="mt-3 space-y-4 border-l-2 pl-4" style={{ borderColor: 'var(--signal)' }}>
                      <input type="hidden" name="id" value={l.id} />
                      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        <label className="block">
                          <span className="lbl">Mode</span>
                          <select name="mode" defaultValue={l.mode} className="select">
                            <option value="busy">Busy blocker</option>
                            <option value="clone">Full clone</option>
                          </select>
                        </label>
                        <label className="busy-only block">
                          <span className="lbl">Blocker title (busy mode)</span>
                          <input name="busy_title" defaultValue={l.busy_title} className="input" />
                        </label>
                        <label className="clone-only block">
                          <span className="lbl">Title prefix (clone mode)</span>
                          <input name="title_prefix" defaultValue={l.title_prefix} className="input" />
                        </label>
                        <label className="clone-only block">
                          <span className="lbl">Title suffix (clone mode)</span>
                          <input name="title_suffix" defaultValue={l.title_suffix} className="input" />
                        </label>
                      </div>
                      <div>
                        <span className="lbl">Event color — Google targets only</span>
                        <ColorSwatches current={l.event_color} />
                      </div>
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name="private_copy" defaultChecked={l.private_copy === 1} className="check" />
                        Mark copies as private — viewers of shared calendars see no details
                      </label>
                      <div className="flex flex-wrap items-center gap-3">
                        <button className="btn btn-sm">Save changes</button>
                        <span className="overline">saving rewrites this link’s events on the next sync</span>
                      </div>
                    </form>
                  </details>
                  {l.last_error && (
                    <p className="banner banner-err col-span-full py-1.5 text-xs" title={l.last_error}>
                      {l.last_error.slice(0, 140)}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}

          {calendars.length >= 2 ? (
            <form action={createSyncLink} className="ticket ticket-dashed space-y-4 p-4 sm:p-5">
              <p className="overline" style={{ color: 'var(--signal)' }}>New link</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="lbl">From — source calendar</span>
                  <select name="source" className="select">
                    <CalendarOptions calendars={calendars} />
                  </select>
                </label>
                <label className="block">
                  <span className="lbl">To — target calendar</span>
                  <select name="target" className="select">
                    <CalendarOptions calendars={calendars} writableOnly />
                  </select>
                </label>
                <label className="block">
                  <span className="lbl">Mode</span>
                  <select name="mode" className="select">
                    <option value="busy">Busy blocker — hide details</option>
                    <option value="clone">Full clone — copy details</option>
                  </select>
                </label>
                <label className="busy-only block">
                  <span className="lbl">Blocker title (busy mode)</span>
                  <input name="busy_title" placeholder="Busy" className="input" />
                </label>
                <label className="clone-only block">
                  <span className="lbl">Title prefix (clone mode)</span>
                  <input name="title_prefix" className="input" />
                </label>
                <label className="clone-only block">
                  <span className="lbl">Title suffix (clone mode)</span>
                  <input name="title_suffix" defaultValue="(copy)" className="input" />
                </label>
                <div>
                  <span className="lbl">Event color — Google targets only</span>
                  <ColorSwatches current="" />
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-dashed pt-4" style={{ borderColor: 'var(--ink-25)' }}>
                <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="two_way" className="check" /> Two-way — sync both directions
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="private_copy" className="check" /> Mark copies as private
                  </label>
                </div>
                <button className="btn">Add sync link</button>
              </div>
            </form>
          ) : (
            <p className="overline">Connect at least two calendars to create a sync.</p>
          )}
        </section>

        {/* 03 — recent runs */}
        <section className="rise d3">
          <div className="sect-head mb-5">
            <span className="sect-num">03</span>
            <h2 className="sect-title">Recent runs</h2>
          </div>
          {runs.length === 0 ? (
            <p className="overline">No runs yet.</p>
          ) : (
            <ul className="ticket px-4 py-1">
              {runs.map((r, i) => (
                <li key={i} className="mono flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-dotted py-2.5 text-xs last:border-b-0" style={{ borderColor: 'var(--ink-12)' }}>
                  <span style={{ color: 'var(--ink-70)' }}>{runTime.format(new Date(r.started_at))}</span>
                  <span className="font-bold">{r.events_processed} events</span>
                  <span style={{ color: 'var(--ink-45)' }}>{r.duration_ms} ms</span>
                  <span className={`stamp ${r.errors ? 'stamp-err' : 'stamp-go'}`}>{r.errors ? 'errors' : 'ok'}</span>
                  {r.errors && <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--signal)' }} title={r.errors}>{r.errors.slice(0, 100)}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  )
}
