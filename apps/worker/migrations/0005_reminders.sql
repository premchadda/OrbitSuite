CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY,
  body TEXT NOT NULL,
  due INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders(state,due,id);
