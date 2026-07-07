import { notFound } from 'next/navigation'
import { getAvailability } from '../../../lib/availability-data'

export const dynamic = 'force-dynamic'

export default async function PublicAvailability({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const result = await getAvailability(slug)
  if (!result) notFound()
  const { page, days, summary } = result

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-8">
      <h1 className="text-xl font-semibold">Availability</h1>
      <p className="text-sm text-zinc-500">All times in {page.timezone}. Next {page.days_ahead} days.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {days.map((d) => (
          <div key={d.date} className="rounded-lg border border-zinc-200 bg-white p-4">
            <h2 className="mb-2 text-sm font-medium">
              {d.weekday[0].toUpperCase() + d.weekday.slice(1)} {d.date}
            </h2>
            {d.slots.length ? (
              <ul className="space-y-1 text-sm text-green-700">
                {d.slots.map((s, i) => <li key={i}>{s.start} – {s.end}</li>)}
              </ul>
            ) : (
              <p className="text-sm text-zinc-400">No availability</p>
            )}
          </div>
        ))}
      </div>
      <section>
        <h2 className="mb-2 text-sm font-medium">Copy as text</h2>
        <pre className="overflow-x-auto rounded-lg border border-zinc-200 bg-white p-4 text-xs">{summary}</pre>
      </section>
    </main>
  )
}
