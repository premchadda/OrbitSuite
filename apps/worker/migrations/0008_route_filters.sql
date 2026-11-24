-- Optional sender/file-size filtering for authorized source chats.
ALTER TABLE routes ADD COLUMN sender_id TEXT;
ALTER TABLE routes ADD COLUMN min_bytes INTEGER;
ALTER TABLE routes ADD COLUMN max_bytes INTEGER;
