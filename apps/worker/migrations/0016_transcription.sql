-- Explicit owner replied-to audio transcription; no audio bytes in database.
ALTER TABLE media_jobs ADD COLUMN task TEXT NOT NULL DEFAULT 'download';
ALTER TABLE media_jobs ADD COLUMN file_id TEXT;
INSERT OR IGNORE INTO feature_flags(feature,enabled) VALUES('personal_transcription',0);
