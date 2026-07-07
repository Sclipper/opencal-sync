import { describe, expect, it } from 'vitest'
import { classifyError, CursorExpiredError, NotFoundError, RateLimitError } from './composio'

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
