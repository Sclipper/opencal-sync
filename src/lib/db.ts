import Database from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type DB = Database.Database

export function createDb(path = ':memory:'): DB {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(readFileSync(join(process.cwd(), 'src/lib/schema.sql'), 'utf8'))
  // ponytail: schema.sql only creates tables; columns added after first release need guarded
  // ALTERs here — switch to numbered migrations if this list ever grows past a handful
  for (const ddl of [
    'ALTER TABLE sync_state ADD COLUMN anchored_at TEXT',
    "ALTER TABLE connections ADD COLUMN composio_user_id TEXT NOT NULL DEFAULT 'default'",
    "ALTER TABLE sync_links ADD COLUMN title_suffix TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE sync_links ADD COLUMN title_prefix TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE sync_links ADD COLUMN event_color TEXT NOT NULL DEFAULT ''",
    'ALTER TABLE sync_links ADD COLUMN private_copy INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE calendars ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE calendars ADD COLUMN access_role TEXT NOT NULL DEFAULT ''",
  ]) {
    try {
      db.exec(ddl)
    } catch {
      // column already exists
    }
  }
  return db
}

declare global {
  // eslint-disable-next-line no-var
  var __opencalDb: DB | undefined
}

export function getDb(): DB {
  if (!globalThis.__opencalDb) {
    const dir = process.env.DATA_DIR ?? join(process.cwd(), 'data')
    mkdirSync(dir, { recursive: true })
    globalThis.__opencalDb = createDb(join(dir, 'opencal.db'))
  }
  return globalThis.__opencalDb
}
