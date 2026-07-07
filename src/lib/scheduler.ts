import { RateLimitError } from './composio'
import { getDb } from './db'
import { googleProvider } from './providers/google'
import { outlookProvider } from './providers/outlook'
import { getSetting } from './settings'
import { runSyncCycle } from './sync/engine'

const providerFor = (p: 'google' | 'outlook') => (p === 'google' ? googleProvider : outlookProvider)

declare global {
  // eslint-disable-next-line no-var
  var __opencalTimer: ReturnType<typeof setTimeout> | undefined
}

let running = false
// ponytail: in-memory backoff, resets on restart; persist it if rate limits ever become chronic
let backoffMs = 0

export async function runOnce(): Promise<{ processed: number; errors: string[] }> {
  if (running) return { processed: 0, errors: ['sync already running'] }
  running = true
  try {
    const result = await runSyncCycle({ db: getDb(), providerFor })
    backoffMs = 0
    return result
  } catch (e) {
    if (e instanceof RateLimitError) {
      backoffMs = Math.min(backoffMs ? backoffMs * 2 : 60_000, 30 * 60_000)
      return { processed: 0, errors: [`rate limited — backing off ${backoffMs / 1000}s`] }
    }
    return { processed: 0, errors: [e instanceof Error ? e.message : String(e)] }
  } finally {
    running = false
  }
}

export function startScheduler(): void {
  if (globalThis.__opencalTimer) return
  const tick = async () => {
    await runOnce()
    const interval = Number(getSetting(getDb(), 'poll_interval_minutes', '5')) * 60_000
    globalThis.__opencalTimer = setTimeout(tick, Math.max(interval, backoffMs))
  }
  globalThis.__opencalTimer = setTimeout(tick, 5_000)
}
