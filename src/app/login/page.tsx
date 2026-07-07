import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { checkPassword, createToken, SESSION_COOKIE } from '../../lib/session'

async function login(formData: FormData) {
  'use server'
  const password = String(formData.get('password') ?? '')
  if (!checkPassword(password)) redirect('/login?error=1')
  const store = await cookies()
  store.set(SESSION_COOKIE, createToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: (process.env.BASE_URL ?? '').startsWith('https'),
    maxAge: 30 * 86_400,
    path: '/',
  })
  redirect('/')
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams
  return (
    <main className="mx-auto mt-24 max-w-sm rounded-lg border border-zinc-200 bg-white p-8">
      <h1 className="mb-4 text-xl font-semibold">opencal-sync</h1>
      {error && <p className="mb-3 text-sm text-red-600">Wrong password.</p>}
      <form action={login} className="space-y-3">
        <input
          type="password"
          name="password"
          placeholder="Admin password"
          required
          className="w-full rounded border border-zinc-300 px-3 py-2"
        />
        <button className="w-full rounded bg-zinc-900 px-3 py-2 text-white">Log in</button>
      </form>
    </main>
  )
}
