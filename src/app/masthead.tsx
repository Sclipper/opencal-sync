import Link from 'next/link'

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/availability', label: 'Availability' },
  { href: '/settings', label: 'Settings' },
] as const

export function Masthead({ active }: { active: (typeof LINKS)[number]['href'] }) {
  return (
    <header className="masthead">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3.5 sm:px-6">
        <Link href="/" className="wordmark text-lg no-underline" style={{ color: 'var(--paper)' }}>
          opencal<span className="tie">⇆</span>sync
        </Link>
        <nav className="flex items-center gap-5">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="m-link" aria-current={l.href === active ? 'page' : undefined}>
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  )
}
