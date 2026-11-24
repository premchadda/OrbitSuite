# OrbitSuite

OrbitSuite is a self-hostable Telegram automation toolkit maintained by
[premchadda](https://github.com/premchadda/OrbitSuite). Run a personal bot
to route messages between authorized chats, maintain a searchable archive,
and schedule deliveries. Media processing and account-history imports run
in optional, separate services.

## Start on Windows 11

Install Node.js 24 or later. From the repository root, run these commands
in PowerShell. Edit the three settings below before starting the bot.

```powershell
Copy-Item .env.example .env
notepad .env
```

Set `BOT_TOKEN` to your BotFather token, `OWNER_ID` to your numeric Telegram
user ID, and `WEBHOOK_SECRET` to a random private value of at least 16
characters. The default polling mode needs outbound access to Telegram.
Use a bot with no active webhook.

```powershell
node --env-file=.env apps/local/src/runtime.js
```

In a second PowerShell window, run
`Invoke-RestMethod http://127.0.0.1:8787/readyz`. Then send `/id` to the
bot from the owner account to check Telegram delivery. SQLite stores data
locally. See the [self-host guide](docs/SELF_HOST.md) for Docker and webhook
setup. The active runtime and development tools are both on `main`.

## Repository layout

| Location | Purpose |
| --- | --- |
| `apps/worker` | Shared Bot API logic and optional Cloudflare Worker/D1 entry point |
| `apps/local` | Standalone Node runtime: SQLite, polling/webhook, background jobs; no Cloudflare account |
| `apps/dashboard` | Optional read-only admin browser with a separate dashboard API key |
| `services/media_worker` | Optional Python yt-dlp/FFmpeg downloader and Telegram uploader; temporary files only |
| `services/user_bridge` | Optional manual Pyrogram history-to-archive copier; dry-run by default |
| `services/automation` | Optional allowlisted, DNS-pinned RSS and external lookup service |
| `services/ai` | Fixed-provider lookup/translation adapters and optional local Whisper CLI transcription |
| `infra` | Self-host, Termux, Windows, Linux/Oracle, PostgreSQL and Redis deployment options |
| `third_party` | 9 public upstream source directories and 2 historical snapshots |
| `legal/THIRD_PARTY_NOTICES.md` | Attribution, origin commits, licensing conditions |
| `docs/FEATURES.md` | Operational feature matrix with qualified availability |
| `docs/117_FEATURE_LEDGER.md` | Every numbered feature, evidence tier and outstanding gap |
| `docs/20_REMAINING_ACCEPTANCE_GAPS.md` | Exact criteria for closing the remaining partial integrations |
| `docs/DEPLOY.md` | Cloudflare, Termux, and private-server setup |
| `docs/SELF_HOST.md` | Single-machine, Docker, Windows/Linux/Termux-oriented deployment |
| `docs/WINDOWS_11_LIVE_TEST.md` | Windows 11 prerequisites, secrets and live staging steps |
| `docs/WINDOWS_11_ACCEPTANCE_CHECKLIST.md` | Pass/fail evidence log for Windows tests |
| `docs/SECURITY.md` | Session protection, account risk, media hygiene, and audit findings |
| `tools/audit_upstream.py` | Static read-only source triage |

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
- Optional trusted-host Pyrogram login wizard that encrypts the local session at rest
- Self-hosted Node/SQLite option using long polling or webhooks
- Docker Compose base service, optional FFmpeg/yt-dlp media profile
- Owner `/topiccreate`, `/batchlinks`, and metadata-only `/library`/`/find`/`/files`
- Optional source-sender and media-size route filters
- Quality-specific media download jobs via `/dlq` and `/adlq` (live extraction pending)
- Opt-in group moderation: ban/unban, mute/unmute, promote/demote
- Grouped media album forwarding; automatic mapped forum topics and title sync
- Safe regex, MIME, extension, date, sender and UTC delivery-window filters
- Checkpointed 10K known-ID batches, route templates, reply-context and edit mirroring
- Media playlists/batches, strict JSON processing options, upload/download progress and heartbeat
- Optional FFmpeg transforms, thumbnails, screenshots, compression, splitting and subtitles
- Optional searchable local history timeline, checkpoints, preview exports and encrypted session vault
- Personal aliases, AFK, RSS, private polls, opt-in subscriber announcements and offline metadata tools
- Opt-in moderation and membership checks, rate-limited workflows and a key-protected read-only dashboard
- Inert multi-user role/quota and commercial plan adapters (no payment provider)
- Optional PostgreSQL storage, Redis leadership lease, dead-letter review, alerts and backup commands
- Linux/Oracle VPS, Termux and Windows host setup guides and offline GitHub Actions CI
- Explicit owner-only AI-assisted text metadata through an opt-in Ollama-compatible provider
- Persistent searchable archive tags and portable SQLite archive/route JSON import/export
- Delegated per-chat moderator actions enforced by role checks and daily quotas
- Owner-requested Telegram file-part joining with temporary Bot API transfers and SHA-256 receipts
- Real FFmpeg MP4 subtitle embedding in the optional media worker
- Owner-replied Telegram voice/audio transcription through an explicitly installed local Whisper model
- Telegram Mini App read-only dashboard with verified owner HMAC and recent Telegram initData
- Owner-private multi-question forms with callback Start, persisted answers, cancellation and expiry
- Media conversion choices for H.264/H.265, MP4/MKV, MP3/M4A/Opus and bounded audio bitrates
- Self-hosted RSS/Wikipedia/RDAP parser Compose overlay restricted to authenticated bot loopback
- Real local FFmpeg MP3-to-upload integration tests and corrected high-capacity local file splitting

## Run local tests

For Windows 11, use `infra/windows/preflight.ps1 -Mode Offline` and
`infra/windows/test-offline.ps1`, then follow
[the Windows 11 staging guide](docs/WINDOWS_11_LIVE_TEST.md). The read-only
`infra/windows/telegram-smoke.mjs` validates the bot and test chat permissions
without modifying Telegram state.

    cd apps/worker && npm test
    cd ../local && npm test
    cd ../../services/media_worker && python3 -m unittest discover -v
    cd ../user_bridge && python3 -m unittest discover -v
    cd ../.. && python3 -m unittest discover -s services/automation -v
    python3 -m unittest discover -s services/ai -v
    python3 -m unittest tools.test_archive_portability -v
    python3 tools/audit_upstream.py
    bash verify-sources.sh

Test passes do **not** imply a successful live deployment. The next stage
needs a dedicated Telegram test bot/chat and secrets, then verification on
your chosen host. Cloudflare D1 is **optional**, not required for self-hosting.

## Privacy and account restrictions

Neither control runtime downloads Telegram media, stores personal Telegram
sessions, logs into your personal account, or bypasses protected content.
The optional media service writes only to a temporary directory and deletes
it after each job. The optional user bridge requires a local session on a
**trusted, separately hosted machine**; the session is decrypted temporarily
while it runs. It does not auto-join chats or blindly retry unknown deliveries.

Advanced features remain **OFF until explicitly enabled or installed**.
Strict media/API limits still apply, and platform-specific deployments and
real Telegram traffic have not been acceptance-tested. `docs/117_FEATURE_LEDGER.md`
distinguishes tested, partial and pending work.

**No automation can guarantee immunity from Telegram restrictions.**
Follow the permissions of every source chat and keep throughput modest.
See `docs/SECURITY.md`.

## License

Original OrbitSuite code and accompanying documentation are released under the
[MIT License](LICENSE). Third-party material is covered by its respective license.

## Third-party sources

The runtime builds from `apps/`. The source snapshots under `third_party/`
have their own authors and licenses. See the [upstream notices](legal/THIRD_PARTY_NOTICES.md)
and [public source inventory](legal/PUBLIC_MIRROR_SCOPE.md).
