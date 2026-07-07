import { notFound } from 'next/navigation'
import { getAvailability } from '../../../lib/availability-data'

export const dynamic = 'force-dynamic'

export default async function PublicAvailability({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const result = await getAvailability(slug)
  if (!result) notFound()
  const { page, days, summary } = result

  return (
    <>
      <header className="masthead">
        <div className="mx-auto flex max-w-3xl flex-wrap items-baseline justify-between gap-x-6 gap-y-1 px-4 py-4 sm:px-6">
          <h1 className="wordmark text-xl" style={{ color: 'var(--paper)' }}>
            Availability
          </h1>
          <p className="mono text-[10px] uppercase tracking-[0.14em]" style={{ color: 'rgb(243 239 229 / 0.7)' }}>
            {page.timezone} · next {page.days_ahead} days
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-8 px-4 py-8 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-2">
          {days.map((d, i) => (
            <div key={d.date} className={`ticket rise p-4 ${i % 4 === 1 ? 'd1' : i % 4 === 2 ? 'd2' : i % 4 === 3 ? 'd3' : ''}`}>
              <div className="mb-3 flex items-baseline justify-between border-b-2 pb-2" style={{ borderColor: 'var(--ink)' }}>
                <span className="overline">{d.weekday}</span>
                <span className="mono text-sm font-bold">{d.date}</span>
              </div>
              {d.slots.length ? (
                <ul className="space-y-1.5">
                  {d.slots.map((s, j) => (
                    <li key={j} className="mono flex items-center gap-2.5 text-sm">
                      <span className="inline-block h-2 w-2" style={{ background: 'var(--signal)' }} aria-hidden />
                      {s.start} – {s.end}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mono text-sm" style={{ color: 'var(--ink-25)' }}>— fully booked</p>
              )}
            </div>
          ))}
        </div>

        <section className="rise d3">
          <p className="overline mb-2">Copy as text</p>
          <pre className="ticket ticket-dashed mono overflow-x-auto p-4 text-xs leading-relaxed">{summary}</pre>
        </section>

        <footer className="overline pb-4 text-center">
          powered by opencal⇆sync
        </footer>
      </main>
    </>
  )
}
