import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../providers/types'
import { buildWriteEvent, contentHash, planActions } from './core'

function event(over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    id: 'src1', status: 'active', title: 'Meeting', description: 'notes', location: 'HQ',
    start: '2026-07-08T10:00:00Z', end: '2026-07-08T11:00:00Z', allDay: false, transparent: false,
    ...over,
  }
}

const busyLink = { mode: 'busy' as const, busyTitle: 'Busy' }
const cloneLink = { mode: 'clone' as const, busyTitle: 'Busy' }

describe('buildWriteEvent', () => {
  it('busy mode strips all details', () => {
    expect(buildWriteEvent(event(), busyLink)).toEqual({
      title: 'Busy', start: '2026-07-08T10:00:00Z', end: '2026-07-08T11:00:00Z', allDay: false,
    })
  })

  it('clone mode copies title/description/location but never attendees', () => {
    expect(buildWriteEvent(event(), cloneLink)).toEqual({
      title: 'Meeting', description: 'notes', location: 'HQ',
      start: '2026-07-08T10:00:00Z', end: '2026-07-08T11:00:00Z', allDay: false,
    })
  })

  it('clone mode falls back for empty titles', () => {
    expect(buildWriteEvent(event({ title: '' }), cloneLink).title).toBe('(No title)')
  })
})

describe('contentHash', () => {
  it('is stable and changes when content changes', () => {
    const a = contentHash(buildWriteEvent(event(), busyLink))
    expect(a).toBe(contentHash(buildWriteEvent(event(), busyLink)))
    expect(a).not.toBe(contentHash(buildWriteEvent(event({ end: '2026-07-08T12:00:00Z' }), busyLink)))
  })

  it('busy-mode hash ignores title/description changes on the source', () => {
    const a = contentHash(buildWriteEvent(event(), busyLink))
    expect(a).toBe(contentHash(buildWriteEvent(event({ title: 'Renamed', description: 'x' }), busyLink)))
  })
})

describe('planActions', () => {
  const hash = (ev: NormalizedEvent) => contentHash(buildWriteEvent(ev, busyLink))

  it('creates unmapped active events', () => {
    const actions = planActions({ events: [event()], link: busyLink, mappings: new Map(), isOwnEvent: () => false })
    expect(actions).toEqual([{ type: 'create', sourceEventId: 'src1', write: buildWriteEvent(event(), busyLink), hash: hash(event()) }])
  })

  it('skips events we created ourselves (loop prevention)', () => {
    const actions = planActions({ events: [event()], link: busyLink, mappings: new Map(), isOwnEvent: () => true })
    expect(actions).toEqual([])
  })

  it('skips unchanged mapped events', () => {
    const mappings = new Map([['src1', { targetEventId: 'tgt1', contentHash: hash(event()) }]])
    expect(planActions({ events: [event()], link: busyLink, mappings, isOwnEvent: () => false })).toEqual([])
  })

  it('recreates changed mapped events', () => {
    const mappings = new Map([['src1', { targetEventId: 'tgt1', contentHash: 'old-hash' }]])
    const actions = planActions({ events: [event()], link: busyLink, mappings, isOwnEvent: () => false })
    expect(actions).toEqual([
      { type: 'recreate', sourceEventId: 'src1', targetEventId: 'tgt1', write: buildWriteEvent(event(), busyLink), hash: hash(event()) },
    ])
  })

  it('deletes mapped events that were cancelled', () => {
    const mappings = new Map([['src1', { targetEventId: 'tgt1', contentHash: 'h' }]])
    const actions = planActions({ events: [event({ status: 'cancelled' })], link: busyLink, mappings, isOwnEvent: () => false })
    expect(actions).toEqual([{ type: 'delete', sourceEventId: 'src1', targetEventId: 'tgt1' }])
  })

  it('ignores cancelled events with no mapping', () => {
    expect(planActions({ events: [event({ status: 'cancelled' })], link: busyLink, mappings: new Map(), isOwnEvent: () => false })).toEqual([])
  })

  it('treats transparent (Free) events as gone', () => {
    const mappings = new Map([['src1', { targetEventId: 'tgt1', contentHash: 'h' }]])
    expect(planActions({ events: [event({ transparent: true })], link: busyLink, mappings, isOwnEvent: () => false })).toEqual([
      { type: 'delete', sourceEventId: 'src1', targetEventId: 'tgt1' },
    ])
    expect(planActions({ events: [event({ transparent: true })], link: busyLink, mappings: new Map(), isOwnEvent: () => false })).toEqual([])
  })
})
