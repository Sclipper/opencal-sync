import { redirect } from 'next/navigation'
import { requireAuth } from '../../lib/auth'
import { getDb } from '../../lib/db'
import { getSetting, setSetting } from '../../lib/settings'
import { Masthead } from '../masthead'

export const dynamic = 'force-dynamic'

const FIELDS = [
  { key: 'google_auth_config_id', label: 'Composio auth config — Google Calendar', placeholder: 'ac_…', hint: 'Requires your own Google OAuth app (see README).' },
  { key: 'outlook_auth_config_id', label: 'Composio auth config — Outlook', placeholder: 'ac_…', hint: 'Composio managed auth works — no Azure app needed.' },
  { key: 'poll_interval_minutes', label: 'Poll interval (minutes)', placeholder: '5', hint: '2 source calendars at 5 min ≈ 17k Composio calls/month (free tier: 20k).' },
  { key: 'sync_window_days', label: 'Sync window (days ahead)', placeholder: '60', hint: '' },
  { key: 'default_busy_title', label: 'Default blocker title', placeholder: 'Busy', hint: '' },
] as const

const DEFAULTS: Record<string, string> = {
  google_auth_config_id: '', outlook_auth_config_id: '',
  poll_interval_minutes: '5', sync_window_days: '60', default_busy_title: 'Busy',
}

async function save(formData: FormData) {
  'use server'
  await requireAuth()
  const db = getDb()
  for (const key of Object.keys(DEFAULTS)) setSetting(db, key, String(formData.get(key) ?? DEFAULTS[key]))
  redirect('/settings?saved=1')
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  await requireAuth()
  const { saved, error } = await searchParams
  const db = getDb()
  return (
    <>
      <Masthead active="/settings" />
      <main className="mx-auto max-w-xl space-y-6 px-4 py-8 sm:px-6">
        <div className="sect-head rise">
          <span className="sect-num">05</span>
          <h1 className="sect-title">Settings</h1>
        </div>
        {saved && <p className="banner banner-ok rise">Saved.</p>}
        {error === 'missing-auth-config' && (
          <p className="banner banner-err rise">
            Set the Composio auth config ID for that provider first (create one at app.composio.dev, see README).
          </p>
        )}
        <form action={save} className="ticket rise d1 space-y-5 p-5 sm:p-6">
          {FIELDS.map((f, i) => (
            <label key={f.key} className="block">
              <span className="lbl">
                <span style={{ color: 'var(--signal)' }}>{String(i + 1).padStart(2, '0')}</span> {f.label}
              </span>
              <input name={f.key} defaultValue={getSetting(db, f.key, DEFAULTS[f.key])} placeholder={f.placeholder} className="input" />
              {f.hint && <span className="mt-1.5 block text-xs" style={{ color: 'var(--ink-45)' }}>{f.hint}</span>}
            </label>
          ))}
          <button className="btn w-full sm:w-auto">Save settings</button>
        </form>
      </main>
    </>
  )
}
