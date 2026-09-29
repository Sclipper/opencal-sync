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
  const guests = (src.attendees ?? []).filter((a) => a.email)
  // ponytail: guests go in the description, not as real attendees — Google propagates attendees to
  // their calendars (sendUpdates only mutes the email), so a copy would put a phantom invite on every
  // guest's calendar. Real RSVP chips need events.import + privateCopy; upgrade there if wanted.
  const footer = [
    src.conferenceUri && `Join: ${src.conferenceUri}`,
    guests.length &&
      `Guests: ${guests.map((a) => (a.responseStatus ? `${a.email} (${a.responseStatus})` : a.email)).join(', ')}`,
    src.sourceLink && `Original: ${src.sourceLink}`,
  ].filter(Boolean).join('\n')
  return {
    title: [link.titlePrefix, base, link.titleSuffix].filter(Boolean).join(' '),
    description: [src.description, footer].filter(Boolean).join('\n\n') || undefined,
    location: src.location || undefined,
    start: src.start,
    end: src.end,
    allDay: src.allDay,
    ...flags,
    ...(src.conferenceUri && { conferenceUri: src.conferenceUri }),
  }
}

// Bump when the WRITTEN form of every copy changes (not just new optional fields): every mapping's
// hash then misses and the engine recreates each copy once with the new shape.
//   v2: real all-day events + reminders off (previously 00:00Z+24h timed spans with default reminders)
const HASH_VERSION = 'v2'

export function contentHash(w: WriteEvent): string {
  // Optional fields are appended only when set, so mappings written before each field existed keep
  // their hashes (no mass recreate on upgrade). Guests and the original link ride in description.
  return createHash('sha256')
    .update(
      JSON.stringify([
        HASH_VERSION, w.title, w.description ?? '', w.location ?? '', w.start, w.end, w.allDay,
        ...(w.colorId ? [w.colorId] : []),
        ...(w.conferenceUri ? [w.conferenceUri] : []),
        ...(w.private ? ['private'] : []),
      ]),
    )
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
// Shape matching: providers now write the exact instants they are given (all-day as real all-day
// events), so a write and its copy share title + start + end. All-day dates and timed instants both
// reduce to epochs (date = UTC midnight), which also keeps copies written before all-day support
// (00:00Z + 24h timed) collectable. ponytail: google-target semantics only — the engine gates the janitor.

const toEpoch = (v: string) => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v)

function writeShapeKey(w: WriteEvent): string {
  return `${w.title}|${toEpoch(w.start)}|${toEpoch(w.end)}`
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
