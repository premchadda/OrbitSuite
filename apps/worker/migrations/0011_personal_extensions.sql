-- Optional personal automation. All outbound broadcast/auto-response features
-- are OFF by default and require explicit owner configuration.
INSERT OR IGNORE INTO feature_flags(feature,enabled) VALUES
  ('personal_auto_replies',0),
  ('personal_rss',0),
  ('personal_broadcasts',0),
  ('personal_workflows',0),
  ('personal_afk',0);

CREATE TABLE IF NOT EXISTS personal_aliases (
  alias TEXT PRIMARY KEY,
  phrase TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS personal_auto_replies (
  id INTEGER PRIMARY KEY,
  chat TEXT NOT NULL,
  keyword TEXT NOT NULL,
  response TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sent INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS personal_auto_reply_chat ON personal_auto_replies(chat,enabled);

CREATE TABLE IF NOT EXISTS personal_rss_feeds (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  dest_chat TEXT NOT NULL,
  dest_topic INTEGER NOT NULL DEFAULT 0,
  last_guid TEXT,
  last_checked INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(url,dest_chat,dest_topic)
);

CREATE TABLE IF NOT EXISTS personal_rss_items (
  feed_id INTEGER NOT NULL,
  guid TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY(feed_id,guid)
);

CREATE TABLE IF NOT EXISTS personal_subscribers (
  user_id TEXT PRIMARY KEY,
  opted_in_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS personal_announcements (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  due INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS personal_announcement_targets (
  announcement_id INTEGER NOT NULL REFERENCES personal_announcements(id),
  user_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  attempted_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(announcement_id,user_id)
);

CREATE TABLE IF NOT EXISTS personal_afk (
  user_id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  started_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS personal_afk_cooldowns (
  chat_id TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS personal_recipes (
  id INTEGER PRIMARY KEY,
  chat TEXT NOT NULL,
  keyword TEXT NOT NULL,
  response TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sent INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS personal_recipes_chat ON personal_recipes(chat,enabled);
