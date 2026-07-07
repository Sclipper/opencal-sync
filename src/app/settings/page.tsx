import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireAuth } from '../../lib/auth'
import { getDb } from '../../lib/db'
import { getSetting, setSetting } from '../../lib/settings'

export const dynamic = 'force-dynamic'

const FIELDS = [
  { key: 'google_auth_config_id', label: 'Composio auth config ID — Google Calendar', placeholder: 'ac_…', hint: 'Requires your own Google OAuth app (see README).' },
  { key: 'outlook_auth_config_id', label: 'Composio auth config ID — Outlook', placeholder: 'ac_…', hint: 'Composio managed auth works — no Azure app needed.' },
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
    <main className="mx-auto max-w-xl space-y-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Settings</h1>
        <Link href="/" className="text-sm text-zinc-600">← Dashboard</Link>
      </header>
      {saved && <p className="rounded bg-green-50 p-3 text-sm text-green-700">Saved.</p>}
      {error === 'missing-auth-config' && (
        <p className="rounded bg-amber-50 p-3 text-sm text-amber-800">
          Set the Composio auth config ID for that provider first (create one at app.composio.dev, see README).
        </p>
      )}
      <form action={save} className="space-y-4 rounded-lg border border-zinc-200 bg-white p-6">
        {FIELDS.map((f) => (
          <label key={f.key} className="block text-sm">
            <span className="mb-1 block font-medium">{f.label}</span>
            <input
              name={f.key}
              defaultValue={getSetting(db, f.key, DEFAULTS[f.key])}
              placeholder={f.placeholder}
              className="w-full rounded border border-zinc-300 px-3 py-2"
            />
            {f.hint && <span className="mt-1 block text-xs text-zinc-500">{f.hint}</span>}
          </label>
        ))}
        <button className="rounded bg-zinc-900 px-4 py-2 text-sm text-white">Save</button>
      </form>
    </main>
  )
}
