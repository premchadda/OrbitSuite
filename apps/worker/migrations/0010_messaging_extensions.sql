-- Opt-in routing controls. None changes the behavior of existing routes.
ALTER TABLE routes ADD COLUMN auto_topics INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routes ADD COLUMN sync_topic_titles INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routes ADD COLUMN propagate_edits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routes ADD COLUMN regex_include TEXT;
ALTER TABLE routes ADD COLUMN regex_exclude TEXT;
ALTER TABLE routes ADD COLUMN mime_csv TEXT;
ALTER TABLE routes ADD COLUMN extension_csv TEXT;
ALTER TABLE routes ADD COLUMN date_from TEXT;
ALTER TABLE routes ADD COLUMN date_to TEXT;
ALTER TABLE routes ADD COLUMN window_utc TEXT;
ALTER TABLE routes ADD COLUMN weekdays_csv TEXT;
ALTER TABLE archive_items ADD COLUMN deleted_at INTEGER;
ALTER TABLE jobs ADD COLUMN dest_topic_override INTEGER;
ALTER TABLE jobs ADD COLUMN reply_to_message_id INTEGER;

-- A reservation avoids duplicate forum-topic creates after concurrent webhooks.
-- A crash during an API request leaves an uncertain reservation, not a retry.
CREATE TABLE IF NOT EXISTS topic_mappings (
  route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  source_topic INTEGER NOT NULL,
  destination_topic INTEGER,
  title TEXT,
  state TEXT NOT NULL DEFAULT 'creating' CHECK(state IN ('creating','ready','uncertain')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(route_id,source_topic)
);

-- The Telegram Bot API can preserve albums only by copying/forwarding their
-- ordered message IDs together. Original files never touch this database.
CREATE TABLE IF NOT EXISTS album_batches (
  id INTEGER PRIMARY KEY,
  route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  source_topic INTEGER NOT NULL DEFAULT 0,
  dest_topic INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','sending','done','failed','uncertain')),
  due INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  claimed_at INTEGER,
  error TEXT,
  UNIQUE(route_id,group_id)
);
CREATE INDEX IF NOT EXISTS album_batches_ready ON album_batches(state,due,id);
CREATE TABLE IF NOT EXISTS album_members (
  batch_id INTEGER NOT NULL REFERENCES album_batches(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,
  media_kind TEXT NOT NULL,
  filename TEXT,
  caption_preview TEXT,
  PRIMARY KEY(batch_id,message_id)
);

-- Checkpointed, owner-provided message-ID ranges (never scrape history).
CREATE TABLE IF NOT EXISTS batch_ranges (
  id INTEGER PRIMARY KEY,
  route_id INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  first_id INTEGER NOT NULL,
  last_id INTEGER NOT NULL,
  next_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','paused','done')),
  enqueued_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS batch_ranges_ready ON batch_ranges(state,id);

-- Named safe route settings, never executable code or credentials.
CREATE TABLE IF NOT EXISTS route_templates (
  name TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
