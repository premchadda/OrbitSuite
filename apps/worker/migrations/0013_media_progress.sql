-- Optional bounded processing settings and telemetry; no media bytes are saved.
ALTER TABLE media_jobs ADD COLUMN urls_json TEXT;
ALTER TABLE media_jobs ADD COLUMN options_json TEXT;
ALTER TABLE media_jobs ADD COLUMN progress_stage TEXT;
ALTER TABLE media_jobs ADD COLUMN progress_bytes INTEGER;
ALTER TABLE media_jobs ADD COLUMN progress_total_bytes INTEGER;
ALTER TABLE media_jobs ADD COLUMN progress_speed_bps INTEGER;
ALTER TABLE media_jobs ADD COLUMN progress_eta_seconds INTEGER;
ALTER TABLE media_jobs ADD COLUMN progress_done INTEGER;
ALTER TABLE media_jobs ADD COLUMN progress_items_total INTEGER;
ALTER TABLE media_jobs ADD COLUMN progress_at INTEGER;
