import { createHash } from 'node:crypto'
import type { NormalizedEvent, WriteEvent } from '../providers/types'

export type SyncLinkConfig = { mode: 'busy' | 'clone'; busyTitle: string; titlePrefix?: string; titleSuffix?: string; eventColor?: string; privateCopy?: boolean }

export function buildWriteEvent(src: NormalizedEvent, link: SyncLinkConfig): WriteEvent {
  const colorId = link.eventColor || undefined
  const flags = { ...(colorId && { colorId }), ...(link.privateCopy && { private: true }) }
  if (link.mode === 'busy') {
    return { title: link.busyTitle, start: src.start, end: src.end, allDay: src.allDay, ...flags }
  }
  const base = src.title || '(No title)'
  return {
    title: [link.titlePrefix, base, link.titleSuffix].filter(Boolean).join(' '),
    description: src.description || undefined,
    location: src.location || undefined,
    start: src.start,
    end: src.end,
    allDay: src.allDay,
    ...flags,
  }
}

export function contentHash(w: WriteEvent): string {
  // colorId / private appended only when set so pre-feature mappings keep their hashes (no mass recreate on upgrade)
  return createHash('sha256')
    .update(JSON.stringify([w.title, w.description ?? '', w.location ?? '', w.start, w.end, w.allDay, ...(w.colorId ? [w.colorId] : []), ...(w.private ? ['private'] : [])]))
    .digest('hex')
}

export type Mapping = { targetEventId: string; contentHash: string }

export type Action =
  | { type: 'create'; sourceEventId: string; write: WriteEvent; hash: string }
  | { type: 'recreate'; sourceEventId: string; targetEventId: string; write: WriteEvent; hash: string }
  | { type: 'delete'; sourceEventId: string; targetEventId: string }

export function planActions(opts: {
  events: NormalizedEvent[]
  link: SyncLinkConfig
  mappings: Map<string, Mapping>
  isOwnEvent: (eventId: string) => boolean
  snapshot?: boolean
}): Action[] {
  const actions: Action[] = []
  const seenIds = new Set<string>()
  for (const ev of opts.events) {
    seenIds.add(ev.id)
    if (opts.isOwnEvent(ev.id)) continue
    const mapping = opts.mappings.get(ev.id)
    if (ev.status === 'cancelled' || ev.transparent) {
      if (mapping) actions.push({ type: 'delete', sourceEventId: ev.id, targetEventId: mapping.targetEventId })
      continue
    }
    const write = buildWriteEvent(ev, opts.link)
    const hash = contentHash(write)
    if (!mapping) actions.push({ type: 'create', sourceEventId: ev.id, write, hash })
    else if (mapping.contentHash !== hash) {
      actions.push({ type: 'recreate', sourceEventId: ev.id, targetEventId: mapping.targetEventId, write, hash })
    }
  }

  if (opts.snapshot) {
    // ponytail: empty snapshot with existing mappings smells like an API hiccup — skip mass-delete;
    // real deletions reconcile next cycle
    if (opts.events.length === 0 && opts.mappings.size > 0) return actions
    for (const [sourceEventId, mapping] of opts.mappings) {
      if (!seenIds.has(sourceEventId)) actions.push({ type: 'delete', sourceEventId, targetEventId: mapping.targetEventId })
    }
  }
  return actions
}

// —— orphan janitor ————————————————————————————————————————————————
// A concurrent cycle or a crash between createEvent and the mapping upsert leaves an untracked
// copy in the target calendar that nothing will ever delete. On full-refetch cycles the engine
// asks: "which active target events are NOT mapped by any link into this calendar, yet look
// exactly like something we would have written?" — those are orphans and get deleted.
//
// Shape matching mirrors what googleProvider.createEvent actually produces (all-day events are
// written as timed 24h blocks, durations are clamped to 24h) so orphans of those events still
// match. ponytail: google-target semantics only — the engine gates the janitor accordingly.

const toEpoch = (v: string) => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v)

function writeShapeKey(w: WriteEvent): string {
  const start = toEpoch(w.start)
  // mirror google.createEvent: minutes rounded, floor hours, clamp at 24h (clamped events lose their minutes)
  const minutes = Math.max(1, Math.round((toEpoch(w.end) - start) / 60_000))
  const rawHours = Math.floor(minutes / 60)
  const durationMin = Math.min(24, rawHours) * 60 + (rawHours > 24 ? 0 : minutes % 60)
  return `${w.title}|${start}|${start + durationMin * 60_000}`
}

function eventShapeKey(e: NormalizedEvent): string {
  return `${e.title}|${toEpoch(e.start)}|${toEpoch(e.end)}`
}

export function findOrphanTargets(
  targetEvents: NormalizedEvent[],
  expected: WriteEvent[],
  mappedTargetIds: Set<string>,
): string[] {
  const shapes = new Set(expected.map(writeShapeKey))
  return targetEvents
    .filter((e) => e.status === 'active' && !mappedTargetIds.has(e.id) && shapes.has(eventShapeKey(e)))
    .map((e) => e.id)
}
