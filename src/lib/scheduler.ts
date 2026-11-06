import { RateLimitError } from './composio'
import { getDb } from './db'
import { processRemovals } from './link-cleanup'
import { googleProvider } from './providers/google'
import { outlookProvider } from './providers/outlook'
import { getSetting } from './settings'
import { runSyncCycle } from './sync/engine'

const providerFor = (p: 'google' | 'outlook') => (p === 'google' ? googleProvider : outlookProvider)

declare global {
  // eslint-disable-next-line no-var
  var __opencalTimer: ReturnType<typeof setTimeout> | undefined
  // global, like the timer: instrumentation and server actions can load separate copies of this module
  var __opencalRemoving: boolean | undefined
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

// Runs outside the sync lock: a large removal takes an hour and must not hold up syncing other links.
// shortcut: a removal queued during a pass waits for the next tick, fine at the 5–30 min poll interval.
export async function runRemovals(): Promise<void> {
  if (globalThis.__opencalRemoving) return
  globalThis.__opencalRemoving = true
  try {
    await processRemovals(getDb(), providerFor)
  } catch (e) {
    console.error('[opencal-sync] removal pass failed:', e instanceof Error ? e.message : e)
  } finally {
    globalThis.__opencalRemoving = false
  }
}

export function startScheduler(): void {
  if (globalThis.__opencalTimer) return
  const tick = async () => {
    let delayMs = 5 * 60_000
    void runRemovals()
    try {
      const result = await runOnce()
      if (result.errors.length) console.error('[opencal-sync] sync errors:', result.errors)
      const interval = Number(getSetting(getDb(), 'poll_interval_minutes', '5')) * 60_000
      if (Number.isFinite(interval) && interval >= 60_000) delayMs = interval
    } catch (e) {
      // ponytail: tick must never die — reschedule with the default delay on any failure
      console.error('[opencal-sync] scheduler tick failed:', e)
    }
    globalThis.__opencalTimer = setTimeout(tick, Math.max(delayMs, backoffMs))
  }
  globalThis.__opencalTimer = setTimeout(tick, 5_000)
}
