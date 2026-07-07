import { Composio } from '@composio/core'

export const USER_ID = 'default'

let client: Composio | undefined
export function getComposio(): Composio {
  if (!client) {
    const apiKey = process.env.COMPOSIO_API_KEY
    if (!apiKey) throw new Error('COMPOSIO_API_KEY is not set')
    client = new Composio({ apiKey })
  }
  return client
}

export class RateLimitError extends Error {}
export class CursorExpiredError extends Error {}
export class NotFoundError extends Error {}

export function classifyError(message: string): Error {
  if (/rate ?limit|too many requests|\b429\b/i.test(message)) return new RateLimitError(message)
  if (/\b410\b|\bgone\b|sync ?token|delta ?token|full ?sync/i.test(message))
    return new CursorExpiredError(message)
  if (/\b404\b|not ?found/i.test(message)) return new NotFoundError(message)
  return new Error(message)
}

export async function executeTool(
  slug: string,
  connectedAccountId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const res = await getComposio().tools.execute(slug, {
    userId: USER_ID,
    connectedAccountId,
    arguments: args,
  })
  if (!res.successful) throw classifyError(String(res.error ?? `Tool ${slug} failed`))
  return res.data
}
