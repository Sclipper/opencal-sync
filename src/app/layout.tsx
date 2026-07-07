import type { Metadata } from 'next'
import { Archivo, Martian_Mono } from 'next/font/google'
import './globals.css'

const sans = Archivo({ subsets: ['latin'], variable: '--font-sans', axes: ['wdth'] })
const mono = Martian_Mono({ subsets: ['latin'], variable: '--font-mono', weight: ['400', '500', '700'] })

export const metadata: Metadata = {
  title: 'opencal-sync',
  description: 'Self-hosted calendar sync',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${sans.variable} ${mono.variable} min-h-screen`}>{children}</body>
    </html>
  )
}
