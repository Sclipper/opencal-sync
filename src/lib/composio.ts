import { Composio } from '@composio/core'
import { getDb, type DB } from './db'

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

// Composio rejects manual execution unless pinned to a real toolkit version ('latest' is not accepted).
export function toolkitSlugFor(toolSlug: string): string {
  return toolSlug.split('_')[0]!.toLowerCase()
}

const toolkitVersions = new Map<string, string>()

async function toolkitVersion(toolkit: string): Promise<string> {
  const cached = toolkitVersions.get(toolkit)
  if (cached) return cached
  const res = await fetch(`https://backend.composio.dev/api/v3/toolkits/${toolkit}`, {
    headers: { 'x-api-key': process.env.COMPOSIO_API_KEY ?? '' },
  })
  if (!res.ok) throw classifyError(await res.text())
  const { version } = (await res.json()) as { version: string }
  toolkitVersions.set(toolkit, version)
  return version
}

// Composio executes tools under a specific connected account's owning user; scoping by the
// connection row (rather than a single global USER_ID) supports multiple real Google/Outlook accounts.
export function resolveUserId(db: DB | null, connectedAccountId: string): string {
  if (!db) return USER_ID
  try {
    const row = db
      .prepare('SELECT composio_user_id FROM connections WHERE composio_connected_account_id = ?')
      .get(connectedAccountId) as { composio_user_id: string } | undefined
    return row?.composio_user_id ?? USER_ID
  } catch {
    // ponytail: legacy DBs may predate the composio_user_id column — fall back rather than crash execution
    return USER_ID
  }
}

export async function executeTool(
  slug: string,
  connectedAccountId: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let db: DB | null = null
  try {
    db = getDb()
  } catch {
    // ponytail: getDb() needs a writable DATA_DIR; not every environment has one
    db = null
  }
  const res = await getComposio().tools.execute(slug, {
    userId: resolveUserId(db, connectedAccountId),
    connectedAccountId,
    arguments: args,
    version: await toolkitVersion(toolkitSlugFor(slug)),
  })
  if (!res.successful) throw classifyError(String(res.error ?? `Tool ${slug} failed`))
  return res.data
}
