import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDb } from './db'

process.env.COMPOSIO_API_KEY = 'test-key'

const executeMock = vi.fn()
vi.mock('@composio/core', () => ({
  Composio: vi.fn().mockImplementation(() => ({ tools: { execute: executeMock } })),
}))

const { classifyError, CursorExpiredError, NotFoundError, RateLimitError, executeTool, toolkitSlugFor, resolveUserId } =
  await import('./composio')

describe('classifyError', () => {
  it('classifies rate limits', () => {
    expect(classifyError('Rate limit exceeded')).toBeInstanceOf(RateLimitError)
    expect(classifyError('HTTP 429 Too Many Requests')).toBeInstanceOf(RateLimitError)
    expect(classifyError('userRateLimitExceeded')).toBeInstanceOf(RateLimitError)
  })

  it('classifies expired sync cursors', () => {
    expect(classifyError('Sync token is no longer valid, a full sync is required')).toBeInstanceOf(
      CursorExpiredError,
    )
    expect(classifyError('HTTP 410 Gone')).toBeInstanceOf(CursorExpiredError)
    expect(classifyError('The delta token has expired')).toBeInstanceOf(CursorExpiredError)
  })

  it('classifies not-found', () => {
    expect(classifyError('Event not found')).toBeInstanceOf(NotFoundError)
    expect(classifyError('HTTP 404')).toBeInstanceOf(NotFoundError)
  })

  it('falls back to plain Error', () => {
    const err = classifyError('something else')
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(RateLimitError)
  })
})

describe('toolkitSlugFor', () => {
  it('lowercases the first underscore-segment of a tool slug', () => {
    expect(toolkitSlugFor('GOOGLECALENDAR_EVENTS_LIST')).toBe('googlecalendar')
    expect(toolkitSlugFor('OUTLOOK_OUTLOOK_LIST_EVENTS')).toBe('outlook')
  })
})

describe('executeTool', () => {
  beforeEach(() => {
    executeMock.mockReset()
    vi.unstubAllGlobals()
  })

  it('resolves the toolkit version at runtime and passes it through to tools.execute', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ meta: { version: '20260623_00' } }) })
    vi.stubGlobal('fetch', fetchMock)
    executeMock.mockResolvedValueOnce({ successful: true, data: { ok: true } })

    const result = await executeTool('GOOGLECALENDAR_LIST_CALENDARS_UNIT1', 'ca_unit_test_1', { max_results: 250 })

    expect(fetchMock).toHaveBeenCalledWith('https://backend.composio.dev/api/v3/toolkits/googlecalendar', {
      headers: { 'x-api-key': 'test-key' },
    })
    expect(executeMock).toHaveBeenCalledWith(
      'GOOGLECALENDAR_LIST_CALENDARS_UNIT1',
      expect.objectContaining({
        connectedAccountId: 'ca_unit_test_1',
        arguments: { max_results: 250 },
        version: '20260623_00',
      }),
    )
    expect(result).toEqual({ ok: true })
  })

  it('caches the resolved version across calls for the same toolkit', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ meta: { version: '1' } }) })
    vi.stubGlobal('fetch', fetchMock)
    executeMock.mockResolvedValue({ successful: true, data: {} })

    await executeTool('OUTLOOK_OUTLOOK_LIST_EVENTS_UNIT2', 'ca_x', {})
    await executeTool('OUTLOOK_OUTLOOK_CREATE_EVENT_UNIT2', 'ca_x', {})

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws a classified error when the toolkit version lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, text: async () => 'HTTP 404 toolkit not found' }))

    await expect(executeTool('MSTEAMS_LIST_CHANNELS_UNIT3', 'ca_y', {})).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('resolveUserId', () => {
  it('falls back to USER_ID when no db is available', () => {
    expect(resolveUserId(null, 'ca_1')).toBe('default')
  })

  it('falls back to USER_ID when no connection row matches', () => {
    const db = createDb()
    expect(resolveUserId(db, 'ca_missing')).toBe('default')
  })

  it("returns the connection's own composio_user_id when a row matches", () => {
    const db = createDb()
    db.prepare(
      "INSERT INTO connections (provider, status, composio_connected_account_id, composio_user_id) VALUES ('google', 'active', 'ca_9', 'pg-test-abacae3a-392c-4fdd-b680-45fed37eb40b')",
    ).run()
    expect(resolveUserId(db, 'ca_9')).toBe('pg-test-abacae3a-392c-4fdd-b680-45fed37eb40b')
  })
})
