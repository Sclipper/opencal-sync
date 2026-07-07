import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'session'

function secret(): Buffer {
  return createHmac('sha256', 'opencal-sync-session-v1').update(process.env.ADMIN_PASSWORD ?? '').digest()
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('hex')
}

export function createToken(ttlMs = 30 * 86_400_000, now = Date.now()): string {
  const exp = String(now + ttlMs)
  return `${exp}.${sign(exp)}`
}

export function verifyToken(token: string, now = Date.now()): boolean {
  if (!process.env.ADMIN_PASSWORD) return false
  const [exp, sig] = token.split('.')
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < now) return false
  const expected = sign(exp)
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
}

export function checkPassword(input: string): boolean {
  if (!process.env.ADMIN_PASSWORD) return false
  const a = createHmac('sha256', 'opencal-pw').update(input).digest()
  const b = createHmac('sha256', 'opencal-pw').update(process.env.ADMIN_PASSWORD).digest()
  return timingSafeEqual(a, b)
}
