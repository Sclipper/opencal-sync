CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'outlook')),
  composio_request_id TEXT,
  composio_connected_account_id TEXT,
  account_label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | active | error
  composio_user_id TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calendars (
  id INTEGER PRIMARY KEY,
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  provider_calendar_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  access_role TEXT NOT NULL DEFAULT '', -- google accessRole: owner|writer|reader|freeBusyReader; '' = unknown (pre-migration)
  UNIQUE (connection_id, provider_calendar_id)
);

CREATE TABLE IF NOT EXISTS sync_links (
  id INTEGER PRIMARY KEY,
  source_calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  target_calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'busy' CHECK (mode IN ('busy', 'clone')),
  busy_title TEXT NOT NULL DEFAULT 'Busy',
  title_prefix TEXT NOT NULL DEFAULT '',
  title_suffix TEXT NOT NULL DEFAULT '',
  event_color TEXT NOT NULL DEFAULT '', -- google colorId 1-11; '' = calendar default; ignored by outlook targets
  private_copy INTEGER NOT NULL DEFAULT 0, -- mark created copies private at the provider

  pair_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_error TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_links_unique_pair ON sync_links (source_calendar_id, target_calendar_id);

CREATE TABLE IF NOT EXISTS event_mappings (
  id INTEGER PRIMARY KEY,
  sync_link_id INTEGER NOT NULL REFERENCES sync_links(id) ON DELETE CASCADE,
  source_event_id TEXT NOT NULL,
  target_event_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (sync_link_id, source_event_id)
);

CREATE TABLE IF NOT EXISTS sync_state (
  calendar_id INTEGER PRIMARY KEY REFERENCES calendars(id) ON DELETE CASCADE,
  sync_cursor TEXT,
  anchored_at TEXT,
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS availability_pages (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  calendar_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array of calendars.id
  working_hours TEXT NOT NULL DEFAULT '{}',  -- JSON: {"days":["mon",...],"start":"09:00","end":"17:00"}
  timezone TEXT NOT NULL DEFAULT 'UTC',
  days_ahead INTEGER NOT NULL DEFAULT 14,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  events_processed INTEGER NOT NULL DEFAULT 0,
  errors TEXT
);
