CREATE TABLE IF NOT EXISTS google_tokens (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_events (
  task_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS stuudium_sessions (
  token TEXT PRIMARY KEY,
  device TEXT NOT NULL DEFAULT 'unknown',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
