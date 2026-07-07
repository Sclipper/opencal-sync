import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { checkPassword, createToken, SESSION_COOKIE } from '../../lib/session'

async function login(formData: FormData) {
  'use server'
  const password = String(formData.get('password') ?? '')
  if (!checkPassword(password)) {
    // ponytail: flat 1.5s failure delay instead of per-IP rate limiting — enough to blunt brute force on a single-user app
    await new Promise((r) => setTimeout(r, 1500))
    redirect('/login?error=1')
  }
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
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="ticket ticket-dashed rise w-full max-w-sm p-8">
        <p className="overline mb-1">Self-hosted calendar sync</p>
        <h1 className="wordmark mb-6 text-2xl">
          opencal<span className="tie">⇆</span>sync
        </h1>
        {error && <p className="banner banner-err mb-4">Wrong password.</p>}
        <form action={login} className="space-y-4">
          <label className="block">
            <span className="lbl">Admin password</span>
            <input type="password" name="password" required autoFocus className="input" />
          </label>
          <button className="btn w-full">Enter</button>
        </form>
      </div>
    </main>
  )
}
