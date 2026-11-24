-- User-explicit, opt-in local/HTTPS inference; off unless enabled by owner.
INSERT OR IGNORE INTO feature_flags(feature,enabled) VALUES('personal_ai',0);
-- Only small metadata labels and archive item references; no media bytes.
CREATE TABLE IF NOT EXISTS archive_tags (
  item_id INTEGER NOT NULL REFERENCES archive_items(id) ON DELETE CASCADE,
  tag TEXT NOT NULL CHECK(length(tag) BETWEEN 2 AND 32),
  origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN ('manual','heuristic','ai')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(item_id,tag)
);
CREATE INDEX IF NOT EXISTS archive_tag_lookup ON archive_tags(tag,item_id);
