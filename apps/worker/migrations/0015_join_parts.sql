-- File IDs are sent explicitly by the owner in private chat. No file bytes.
CREATE TABLE IF NOT EXISTS media_part_inputs (
  owner_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,message_id)
);
CREATE INDEX IF NOT EXISTS media_part_inputs_recent ON media_part_inputs(owner_id,message_id DESC);
-- Existing media_jobs.kind remains video/audio; `parts_json` switches to
-- an explicit authenticated Telegram file-ID join instead of yt-dlp.
ALTER TABLE media_jobs ADD COLUMN parts_json TEXT;
