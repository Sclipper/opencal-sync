import { createHash } from 'node:crypto'
import type { NormalizedEvent, WriteEvent } from '../providers/types'

export type SyncLinkConfig = { mode: 'busy' | 'clone'; busyTitle: string; titleSuffix?: string; eventColor?: string }

export function buildWriteEvent(src: NormalizedEvent, link: SyncLinkConfig): WriteEvent {
  const colorId = link.eventColor || undefined
  if (link.mode === 'busy') {
    return { title: link.busyTitle, start: src.start, end: src.end, allDay: src.allDay, ...(colorId && { colorId }) }
  }
  const base = src.title || '(No title)'
  return {
    title: link.titleSuffix ? `${base} ${link.titleSuffix}` : base,
    description: src.description || undefined,
    location: src.location || undefined,
    start: src.start,
    end: src.end,
    allDay: src.allDay,
    ...(colorId && { colorId }),
  }
}

export function contentHash(w: WriteEvent): string {
  // colorId appended only when set so pre-color mappings keep their hashes (no mass recreate on upgrade)
  return createHash('sha256')
    .update(JSON.stringify([w.title, w.description ?? '', w.location ?? '', w.start, w.end, w.allDay, ...(w.colorId ? [w.colorId] : [])]))
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
