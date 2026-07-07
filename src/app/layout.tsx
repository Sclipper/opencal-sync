import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'opencal-sync',
  description: 'Self-hosted calendar sync',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-50 text-zinc-900">{children}</body>
    </html>
  )
}
