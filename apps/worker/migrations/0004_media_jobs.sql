-- Optional media processing. Bytes are downloaded and uploaded only by the
-- external Python service, never by the Cloudflare control plane.
CREATE TABLE IF NOT EXISTS media_jobs (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('video','audio')),
  dest TEXT NOT NULL,
  dest_topic INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER NOT NULL DEFAULT 0,
  due INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS media_jobs_ready ON media_jobs(state,due,id);
CREATE TABLE IF NOT EXISTS feature_flags (
  feature TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
INSERT OR IGNORE INTO feature_flags(feature,enabled) VALUES
  ('archive',1), ('manual_save',1), ('media_downloads',0),
  ('user_bridge',0), ('group_admin',0), ('rss',0), ('reminders',0);
