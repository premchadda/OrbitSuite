# OrbitSuite — unified Telegram automation monorepo

**Runtime-only edition.** This separate clean repository contains the
first-party OrbitSuite services and tests only. The 11 archived third-party
source trees are intentionally omitted; obtain the separate full
development archive if you need them for future feature ports.

**Working name:** OrbitSuite. All first-party app names, commands, service
identifiers, and configuration keys use our own naming. Original third-party
copyright/license notices remain intact in the isolated source snapshots.

## Scope and honesty

OrbitSuite combines a working Bot API control plane, optional messaging,
personal and administration modules, and separately hosted media, history,
RSS and local-AI adapters. The runtime edition ships **no** archived original
source trees. This broad development build is **not** live Telegram or host
acceptance-tested.

The original source projects are preserved in the separate full development
edition, not automatically imported. Features are ported into
independently testable services and can be enabled later. This avoids
combining incompatible versions of Pyrogram, Pyrofork, Telethon and aiogram
into one process.

## Repository layout (runtime edition)

| Location | Purpose |
| --- | --- |
| `apps/worker` | Shared Bot API business logic and optional Cloudflare Worker/D1 |
| `apps/local` | Standalone Node/SQLite runtime with webhook or long polling |
| `apps/dashboard` | Optional independently keyed read-only admin dashboard |
| `services/media_worker` | Optional Python yt-dlp/FFmpeg downloader and Telegram uploader; temporary files only |
| `services/user_bridge` | Optional manual Pyrogram history-to-archive copier; dry-run by default |
| `services/automation` | Optional RSS/lookup service with network restrictions |
| `services/ai` | Optional local lookup and transcription adapters |
| `infra` | Termux, VPS/Oracle, systemd, Windows, PostgreSQL and Redis instructions |
| `third_party` | Not shipped in this edition; only in the separate full archive |
| `legal/THIRD_PARTY_NOTICES.md` | Provided with the separate full archive |
| `docs/FEATURES.md` | Operational feature matrix |
| `docs/117_FEATURE_LEDGER.md` | Full 117-item acceptance/status ledger |
| `docs/DEPLOY.md` | Cloudflare, Termux, and private-server setup |
| `docs/SELF_HOST.md` | Free-first Docker, Linux and Termux deployment guidance |
| `docs/SECURITY.md` | Session protection, account risk, media hygiene, and audit findings |
| `tools/audit_upstream.py` | Provided with the separate full archive |
| `tools/archive_portability.py` | Previewable, opt-in SQLite route/archive metadata export/import |
| `docs/20_REMAINING_ACCEPTANCE_GAPS.md` | Specific requirements for the 20 remaining partially accepted categories |
| `docs/WINDOWS_11_LIVE_TEST.md` | Windows 11 prerequisites, secrets and live testing setup |
| `docs/WINDOWS_11_ACCEPTANCE_CHECKLIST.md` | Pass/fail evidence log for Windows tests |

## Working features in this build

- Owner-only Telegram commands and webhook authentication
- Copy/forward new messages between authorized groups/channels and forum topics
- PDF/document/photo/video/audio/voice/animation/sticker filters
- Caption/text include and exclude keywords
- Per-route static media captions, owner-editable
- Explicit archive destination, one-message link saves, route checks
- Known-message-ID batches, queued processing, job deduplication and review
- FloodWait cooldown, emergency stop, conservative daily send cap
- Owner command `/id` for discovering group and topic IDs
- Opt-in single-message group administration: pin, unpin, delete
- Opt-in reminders, scheduled delivery
- Opt-in media job queue with authenticated external Python processing
- Optional Pyrogram history import with explicit `--execute` and dry-run default
- No-Cloudflare standalone Node runtime, SQLite, Docker Compose and optional media profile
- `/topiccreate`, `/batchlinks`, `/library`, `/find`, `/files`, `/sender`, `/filesize`
- `/dlq`/`/adlq` quality selection, and opt-in ban/mute/promote administration
- Albums, automatic topics, owner `/topicchoose` buttons, route templates, rich filters, checkpointed batches, reply and edit mirroring
- Media playlists/batches, processing presets, progress/ETA, heartbeat, temporary FFmpeg transformations
- Local history timeline, dry-run/report/checkpoint, private encrypted session vault
- Owner-only personal aliases, RSS, AFK, recipes, anonymous polls, opt-in broadcasts, offline metadata helpers
- Safe anti-spam and per-chat moderation, membership checks, read-only dashboard, draft commercial adapters
- Optional PostgreSQL and Redis leader leases, dead-letter review, backup and deployment guides
- Explicit owner-only AI text assistance through an opt-in Ollama-compatible provider; no model bundled
- Persisted archive tags with owner search and safe export/import of route/archive metadata
- Opt-in per-chat delegated moderators with role and daily quota enforcement
- Owner-requested Telegram numbered file-part joining, ephemeral bytes and SHA-256 receipts
- English subtitle embedding via local FFmpeg and `/transcribe` owner-private audio jobs via optional local Whisper
- Signed, owner-only Telegram Mini App `/mini` and private multi-step `/formnew`/`/formopen` forms
- H.264/H.265 video encoding, MP4/MKV, MP3/M4A/Opus, audio bitrates, real local MP3 upload integration tests
- Corrected opt-in local Bot API multipart splitting up to a 4 GiB *source* (never a single 4 GiB Telegram upload)
- Private Docker Compose RSS/wiki/RDAP lookup parser, plus guided encrypted local Pyrogram login

## Run local tests

For **Windows 11**, use `infra/windows/preflight.ps1 -Mode Offline` and
`infra/windows/test-offline.ps1` from PowerShell in the repository root.
Start live staging only after following [the Windows testing guide](docs/WINDOWS_11_LIVE_TEST.md).
The read-only `infra/windows/telegram-smoke.mjs` checks the token, webhook
and two optional staging chats without modifying Telegram state.

    cd apps/worker && npm test
    cd ../local && npm test
    cd ../../services/media_worker && python3 -m unittest discover -v
    cd ../user_bridge && python3 -m unittest discover -v
    cd ../.. && python3 -m unittest discover -s services/automation -v
    python3 -m unittest discover -s services/ai -v
    python3 -m unittest tools.test_archive_portability -v
    # Third-party verification belongs to the full development archive.

Test passes do **not** imply a successful live deployment. The next stage
needs a dedicated Telegram test bot/chat and secrets, then verification on
your chosen host. Cloudflare is optional.

## Privacy and account restrictions

Neither control runtime downloads Telegram media, stores personal Telegram
sessions, logs into your personal account, or bypasses protected content.
The optional media service writes only to a temporary directory and deletes
it after each job. The optional user bridge requires a local session on a
trusted machine and does not auto-join chats or blindly retry an uncertain
send. A separately operated local Telegram Bot API server can keep its own
cache; its cleanup is a separate operator responsibility.

**Current audit:** 92 local-tested capability rows, 20 partial/unverified,
2 pending and 3 intentionally excluded. The status is per capability rather
than per upstream command. See `docs/117_FEATURE_LEDGER.md` for specifics.

**No automation can guarantee immunity from Telegram restrictions.**
Follow the permissions of every source chat and keep throughput modest.
See `docs/SECURITY.md`.

## Naming and third-party attribution

User-facing branding is OrbitSuite. The archived third-party packages
retain some internal original identifiers to remain unmodified and
license-compliant. Removing their notices or globally renaming their
internal symbols could break code or remove required attribution.
Those packages are not the active branded application.
