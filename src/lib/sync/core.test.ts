import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '../providers/types'
import { buildWriteEvent, contentHash, findOrphanTargets, planActions } from './core'

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

  it('clone mode appends the title suffix with a space', () => {
    const link = { ...cloneLink, titleSuffix: '(Hyperion)' }
    expect(buildWriteEvent(event(), link).title).toBe('Meeting (Hyperion)')
    expect(buildWriteEvent(event({ title: '' }), link).title).toBe('(No title) (Hyperion)')
  })

  it('clone mode without a suffix leaves the title unchanged', () => {
    expect(buildWriteEvent(event(), cloneLink).title).toBe('Meeting')
  })

  it('busy mode ignores the title suffix', () => {
    expect(buildWriteEvent(event(), { ...busyLink, titleSuffix: '(Hyperion)' }).title).toBe('Busy')
  })

  it('sets colorId in both modes when the link has an event color', () => {
    expect(buildWriteEvent(event(), { ...busyLink, eventColor: '7' }).colorId).toBe('7')
    expect(buildWriteEvent(event(), { ...cloneLink, eventColor: '7' }).colorId).toBe('7')
  })

  it('omits colorId entirely when the link has no event color', () => {
    expect('colorId' in buildWriteEvent(event(), busyLink)).toBe(false)
    expect('colorId' in buildWriteEvent(event(), { ...cloneLink, eventColor: '' })).toBe(false)
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

  it('clone-mode hash changes when a title suffix is added (drives recreation of existing clones)', () => {
    const without = contentHash(buildWriteEvent(event(), cloneLink))
    const withSuffix = contentHash(buildWriteEvent(event(), { ...cloneLink, titleSuffix: '(Hyperion)' }))
    expect(without).not.toBe(withSuffix)
  })

  it('colorId changes the hash, but colorless events hash as before the color feature existed', () => {
    const plain = buildWriteEvent(event(), busyLink)
    expect(contentHash({ ...plain, colorId: '7' })).not.toBe(contentHash(plain))
    // pre-color mappings must keep their hashes: explicit undefined is identical to absent
    expect(contentHash({ ...plain, colorId: undefined })).toBe(contentHash(plain))
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

  describe('snapshot mode (cursorless providers)', () => {
    it('deletes a mapping whose event is absent from the snapshot', () => {
      const mappings = new Map([
        ['src1', { targetEventId: 'tgt1', contentHash: hash(event()) }],
        ['gone', { targetEventId: 'tgt-gone', contentHash: 'h' }],
      ])
      const actions = planActions({ events: [event()], link: busyLink, mappings, isOwnEvent: () => false, snapshot: true })
      expect(actions).toEqual([{ type: 'delete', sourceEventId: 'gone', targetEventId: 'tgt-gone' }])
    })

    it('skips mass-delete when the snapshot is empty but mappings exist (likely API hiccup)', () => {
      const mappings = new Map([['src1', { targetEventId: 'tgt1', contentHash: 'h' }]])
      const actions = planActions({ events: [], link: busyLink, mappings, isOwnEvent: () => false, snapshot: true })
      expect(actions).toEqual([])
    })

    it('does not synthesize deletes for absent mappings outside snapshot mode', () => {
      const mappings = new Map([['gone', { targetEventId: 'tgt-gone', contentHash: 'h' }]])
      const actions = planActions({ events: [], link: busyLink, mappings, isOwnEvent: () => false })
      expect(actions).toEqual([])
    })
  })
})

describe('findOrphanTargets', () => {
  const write = (over: Partial<import('../providers/types').WriteEvent> = {}) => ({
    title: 'Busy', start: '2026-07-08T10:00:00Z', end: '2026-07-08T11:00:00Z', allDay: false, ...over,
  })
  const tgt = (id: string, over: Partial<NormalizedEvent> = {}) => event({ id, title: 'Busy', ...over })

  it('flags unmapped events matching a write shape, sparing mapped and unrelated ones', () => {
    const events = [
      tgt('mapped-1'),
      tgt('orphan-1'),
      tgt('user-1', { title: 'Dentist' }),
      tgt('other-time', { start: '2026-07-08T12:00:00Z', end: '2026-07-08T13:00:00Z' }),
    ]
    expect(findOrphanTargets(events, [write()], new Set(['mapped-1']))).toEqual(['orphan-1'])
  })

  it('matches across timezone notations (offset vs Z)', () => {
    const events = [tgt('orphan-1', { start: '2026-07-08T13:00:00+03:00', end: '2026-07-08T14:00:00+03:00' })]
    expect(findOrphanTargets(events, [write()], new Set())).toEqual(['orphan-1'])
  })

  it('matches all-day writes against the timed 24h events google actually creates', () => {
    // googleProvider.createEvent writes an all-day WriteEvent as a timed event: 00:00Z + 24h
    const events = [tgt('orphan-1', { start: '2026-07-09T00:00:00Z', end: '2026-07-10T00:00:00Z' })]
    const w = write({ start: '2026-07-09', end: '2026-07-10', allDay: true })
    expect(findOrphanTargets(events, [w], new Set())).toEqual(['orphan-1'])
  })

  it('matches >24h writes against their clamped 24h created form', () => {
    // a 3-day event is created clamped to 24h — the orphan copy has the clamped end
    const events = [tgt('orphan-1', { start: '2026-07-08T10:00:00Z', end: '2026-07-09T10:00:00Z' })]
    const w = write({ end: '2026-07-11T10:00:00Z' })
    expect(findOrphanTargets(events, [w], new Set())).toEqual(['orphan-1'])
  })

  it('ignores cancelled events', () => {
    const events = [tgt('orphan-1', { status: 'cancelled' as const })]
    expect(findOrphanTargets(events, [write()], new Set())).toEqual([])
  })
})
