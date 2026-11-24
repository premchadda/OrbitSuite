# OrbitSuite security model

## Separation of trust

- `apps/worker` uses only the Telegram Bot API. Tokens and internal service
  keys must be stored as Cloudflare secrets.
- `services/media_worker` handles public media using an allowlisted host
  policy, public-DNS validation, a 45 MiB output cap, a temporary directory,
  and a bounded extractor runtime. Files are not retained after the job.
- `services/user_bridge` is a separate local-only utility with a personal
  session stored outside the repository, restrictive file permissions,
  a dry-run-first flow, and no automatic account switching.
- `third_party` is archival source, not trusted executable runtime.

## Telegram account safety

The app does not promise immunity from bans. It uses queue caps, a daily
confirmed send limit for native copies, cooldowns after Telegram 429,
manual review after uncertain sends, and one scheduled copy per minute.
The personal bridge stops on FloodWait or access errors, never repeatedly
tries to join private groups, and requires explicit operator execution.

Telegram Bot API protected-content limitations are respected. The app
cannot save arbitrary historical posts without access or send directly
to a person's Saved Messages using only a bot token.

## Source review observations

The archived sources include dynamic Python execution commands, a shell
command handler, session-string storage/collection, automatic chat-join
helpers, overlapping Pyrogram/Pyrofork packages, and one historical
Python syntax error. Two SQLite login-session files were removed from
the bundled copy. Some upstream session-encryption settings use weak
fixed fallback keys. Do not deploy those modules without review.

Run `python3 tools/audit_upstream.py` for a read-only triage. This scanner
does not prove the absence of all vulnerabilities. Dependency advisory
reviews and live end-to-end tests remain necessary.

## Worker data and secrets

D1 stores route IDs, chat IDs, topic IDs, job metadata, notes, reminders,
and optional requested media URLs. **Media URLs may contain sensitive
query tokens**; do not expose the D1 database or logs. No Telegram media
bytes are intentionally written to D1 or Worker disk.

Set at least:

- `BOT_TOKEN` — token for a dedicated bot
- `OWNER_ID` — your Telegram numeric ID
- `WEBHOOK_SECRET` — strong random webhook secret
- `MEDIA_WORKER_KEY` — different strong random service secret (optional)

Never paste credentials or session strings into a public chat or commit
them. Keep a private archive group or channel to which the bot has
only the necessary rights.

## Media processor caveats

The worker validates public DNS and a configurable allowlist before
starting yt-dlp. Extractors may follow redirects or use other hosts;
this is **not a hardened network sandbox**. Prefer running the worker
without access to private networks and never use an open arbitrary URL
allowlist on shared infrastructure. If upload or callback timing is
ambiguous, the job is held for manual review.

The service uses temporary storage during processing; the requirement
is **no persistent media retention**, not zero RAM/disk consumption at
every instant.
