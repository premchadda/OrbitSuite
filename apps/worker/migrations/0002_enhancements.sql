-- v0.2 -> v1.0: routing mode and minimal, payload-free audit trail.
ALTER TABLE routes ADD COLUMN mode TEXT NOT NULL DEFAULT 'copy';
ALTER TABLE routes ADD COLUMN include_text TEXT;
ALTER TABLE routes ADD COLUMN exclude_text TEXT;
ALTER TABLE jobs ADD COLUMN claimed_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  route_id INTEGER,
  job_id INTEGER,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_recent ON audit_events(at DESC);
