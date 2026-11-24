-- Tiny private-owner multi-step forms, not a public data-collection platform.
CREATE TABLE IF NOT EXISTS owner_forms (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  questions_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_form_runs (
  owner_id TEXT PRIMARY KEY,
  form_id INTEGER NOT NULL REFERENCES owner_forms(id),
  state TEXT NOT NULL CHECK(state IN ('waiting','answering')),
  next_index INTEGER NOT NULL DEFAULT 0,
  answers_json TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS owner_form_submissions (
  id INTEGER PRIMARY KEY,
  form_id INTEGER NOT NULL REFERENCES owner_forms(id),
  answers_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS owner_form_results ON owner_form_submissions(form_id,id DESC);
