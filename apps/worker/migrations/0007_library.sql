-- Metadata only: Telegram's servers retain the actual media.
ALTER TABLE jobs ADD COLUMN media_kind TEXT;
ALTER TABLE jobs ADD COLUMN filename TEXT;
ALTER TABLE jobs ADD COLUMN caption_preview TEXT;
CREATE TABLE IF NOT EXISTS archive_items (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  source_message_id INTEGER NOT NULL,
  dest TEXT NOT NULL,
  dest_topic INTEGER NOT NULL DEFAULT 0,
  dest_message_id INTEGER,
  route_id INTEGER,
  media_kind TEXT NOT NULL DEFAULT 'unknown',
  filename TEXT,
  caption_preview TEXT,
  saved_at INTEGER NOT NULL,
  UNIQUE(source,source_message_id,dest,dest_topic)
);
CREATE INDEX IF NOT EXISTS archive_by_time ON archive_items(saved_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS archive_by_source ON archive_items(source,source_message_id);
