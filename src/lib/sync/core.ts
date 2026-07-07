import { createHash } from 'node:crypto'
import type { NormalizedEvent, WriteEvent } from '../providers/types'

export type SyncLinkConfig = { mode: 'busy' | 'clone'; busyTitle: string }

export function buildWriteEvent(src: NormalizedEvent, link: SyncLinkConfig): WriteEvent {
  if (link.mode === 'busy') {
    return { title: link.busyTitle, start: src.start, end: src.end, allDay: src.allDay }
  }
  return {
    title: src.title || '(No title)',
    description: src.description || undefined,
    location: src.location || undefined,
    start: src.start,
    end: src.end,
    allDay: src.allDay,
  }
}

export function contentHash(w: WriteEvent): string {
  return createHash('sha256')
    .update(JSON.stringify([w.title, w.description ?? '', w.location ?? '', w.start, w.end, w.allDay]))
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
}): Action[] {
  const actions: Action[] = []
  for (const ev of opts.events) {
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
  return actions
}
