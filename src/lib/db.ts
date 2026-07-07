import Database from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type DB = Database.Database

export function createDb(path = ':memory:'): DB {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(readFileSync(join(process.cwd(), 'src/lib/schema.sql'), 'utf8'))
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
