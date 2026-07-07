import { beforeEach, describe, expect, it } from 'vitest'
import { checkPassword, createToken, verifyToken } from './session'

describe('session', () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = 'hunter2'
  })

  it('round-trips a valid token', () => {
    expect(verifyToken(createToken())).toBe(true)
  })

  it('rejects expired tokens', () => {
    const token = createToken(1000, Date.now() - 5000)
    expect(verifyToken(token)).toBe(false)
  })

  it('rejects tampered tokens', () => {
    const [exp] = createToken().split('.')
    expect(verifyToken(`${exp}.deadbeef`)).toBe(false)
    expect(verifyToken('garbage')).toBe(false)
  })

  it('tokens become invalid when password changes', () => {
    const token = createToken()
    process.env.ADMIN_PASSWORD = 'other'
    expect(verifyToken(token)).toBe(false)
  })

  it('rejects all tokens when ADMIN_PASSWORD is unset', () => {
    const token = createToken()
    delete process.env.ADMIN_PASSWORD
    expect(verifyToken(token)).toBe(false)
  })

  it('checks password in constant time', () => {
    expect(checkPassword('hunter2')).toBe(true)
    expect(checkPassword('wrong')).toBe(false)
    expect(checkPassword('')).toBe(false)
  })
})
