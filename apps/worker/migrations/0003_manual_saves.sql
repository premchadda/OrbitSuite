-- Manual owner-queued archive links. Separate from auto routes to avoid
-- accidentally subscribing to an entire channel when saving one message.
CREATE TABLE IF NOT EXISTS manual_jobs (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  dest TEXT NOT NULL,
  dest_topic INTEGER NOT NULL DEFAULT 0,
  message_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  due INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  UNIQUE(source,dest,dest_topic,message_id)
);
CREATE INDEX IF NOT EXISTS manual_jobs_ready ON manual_jobs(state,due,id);
