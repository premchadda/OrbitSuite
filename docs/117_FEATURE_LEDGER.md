# OrbitSuite v4.2 — 117-feature implementation and acceptance ledger

**Reviewed:** 24 November 2026. **Baseline:** the 117-item audit in the prior v3 report; 49 originally source-audited capability entries plus 68 additional individually numbered proposals. **Result:** 68 of the 70 eligible previously outstanding entries advanced into locally tested code or a bounded/partial implementation; 2 still need external access. The 3 explicitly excluded high-risk techniques remain excluded.

## What the counts mean

| Evidence category | v3 | v4.2 | Meaning |
| --- | ---: | ---: | --- |
| **T** — local test | 32 | **92** | Code exercised by offline unit/integration tests; **not** live Telegram/platform acceptance |
| **I** — partial or unverified integration | 12 | **20** | Some implementation, adapter, tested primitive, or host manifest exists, but exact full request/real service needs more work |
| **S** — upstream source only | 29 | **0** | All 29 were addressed by a new implementation or partial substitute; does not imply upstream command parity |
| **P** — pending | 41 | **2** | No completed requested capability yet |
| **X** — excluded | 3 | **3** | Intentional safety boundaries |
| **Total** | **117** | **117** | **112 T/I**, 2 P, 3 X; **not** 112 production-certified features |

The status is attached to each *capability category*, not to every subcommand. Several I rows involve substantial missing integration (especially payments, user-specific quotas, Mini App, real AI, full 4 GB handling, and exact host deployment).

### A. Original 49 source-audited entries

| # | Capability | Status |
| ---: | --- | :---: |
| 1 | Owner-only command access | T |
| 2 | Secret-validated webhook | T |
| 3 | Per-feature enable/disable | T |
| 4 | Emergency stop and cooldown | T |
| 5 | Minimal metadata audit events | T |
| 6 | Bot API copy/forward | T |
| 7 | Source/destination topic routing | T |
| 8 | Exclude own, bot and protected messages | T |
| 9 | Topic/chat lookup `/id` | T |
| 10 | Bot membership `/checkroute` | T |
| 11 | Media-type route filter | T |
| 12 | Include/exclude text keywords | T |
| 13 | Static media caption replacement | T |
| 14 | Known-ID batches and job dedup | T |
| 15 | Single accessible Telegram link `/save` | T |
| 16 | Cancel/resume/reconcile/manual retry | T |
| 17 | Album grouping on forward/copy | T |
| 18 | Cross-chat auto topic creation | T |
| 19 | External HTTPS media URL queue | T |
| 20 | Optional yt-dlp download worker | I |
| 21 | FFmpeg MP3 extraction | T |
| 22 | Ephemeral Telegram media upload | T |
| 23 | Explicit permitted media-source domains | T |
| 24 | Video transformations, thumbnails, captions | T |
| 25 | Video screenshots and ffprobe metadata | T |
| 26 | Rich message blocks, inline buttons | T |
| 27 | Bounded authorized history-range scan | I |
| 28 | History source-topic filter | I |
| 29 | Explicit local user Saved Messages transfer | I |
| 30 | Personal login inside Cloudflare Worker | X |
| 31 | Multi-account rotation to evade limits | X |
| 32 | Bypass protected-content restrictions | X |
| 33 | Pin/unpin/delete replied group message | T |
| 34 | Ban/mute/promote/permission controls | T |
| 35 | Auto replies and group anti-spam | T |
| 36 | Multi-recipient opt-in announcements | T |
| 37 | Personal notes | T |
| 38 | Reminders | T |
| 39 | RSS/news feeds | T |
| 40 | Search, translation, Wiki, WHOIS tools | T |
| 41 | Aliases, AFK, private menu | T |
| 42 | Broad yt-dlp site coverage | I |
| 43 | Unified dashboard / Telegram Mini App | T |
| 44 | Commercial plans, payments, subscriptions | I |
| 45 | D1/SQLite migrations (now 17) | T |
| 46 | Isolated Python dependencies | I |
| 47 | Termux, Oracle and Docker deployment artifacts | I |
| 48 | Publish private or public remote Git repository | P |
| 49 | Live Telegram and actual-host acceptance tests | P |

### B1. Routing and topics

| # | Capability | Status |
| ---: | --- | :---: |
| 50 | Reusable route templates | T |
| 51 | One-source multi-destination fanout | T |
| 52 | Two Telegram links as bounded range | T |
| 53 | Checkpointed 10K known-ID batch queue | T |
| 54 | Bounded safe regex filters | T |
| 55 | Filter by sender | T |
| 56 | MIME, extension, size and date filters | T |
| 57 | UTC delivery windows and weekdays | T |
| 58 | Select discovered topics via interactive owner UI | T |
| 59 | Topic-title synchronization | T |
| 60 | Edit/delete propagation | I |
| 61 | Preserve reply context in copied messages | T |

### B2. Media and conversions

| # | Capability | Status |
| ---: | --- | :---: |
| 62 | Video quality and audio encoding choice | T |
| 63 | Multi-URL batches and bounded playlists | T |
| 64 | Social-media extractors | I |
| 65 | Download progress and ETA | T |
| 66 | Upload progress and ETA | T |
| 67 | Very large / claimed 4 GB uploads | I |
| 68 | Split oversized files | T |
| 69 | Join previously split files | T |
| 70 | Custom thumbnail | T |
| 71 | Thumbnail removal/replacement | T |
| 72 | Filename normalization/rename | T |
| 73 | Filename/caption replacements | T |
| 74 | Video trim, crop, rotate | T |
| 75 | CRF compression/presets | T |
| 76 | Subtitle extraction/selection/embedding | T |
| 77 | Owner watermark | T |

### B3–B4. Archive, sessions and administration

| # | Capability | Status |
| ---: | --- | :---: |
| 78 | Searchable Telegram file metadata without host media | T |
| 79 | Filter archive by chat/topic/date/type/name | T |
| 80 | Offline calendar/timeline metadata | T |
| 81 | One-shot scheduled historical backfill | T |
| 82 | Full dry-run preview/skipped reasons | T |
| 83 | Durable checkpoint, resume and manual reconciliation | T |
| 84 | File-ID/content-hash deduplication | I |
| 85 | Export/import metadata and route configuration | T |
| 86 | Local user session encryption at rest | T |
| 87 | Explicit local session logout/revoke | T |
| 88 | Protected login/OTP flow | T |
| 89 | Ban/unban | T |
| 90 | Timed mute/unmute | T |
| 91 | Promote/demote permissions | T |
| 92 | Optional group/channel membership requirement | T |
| 93 | Multi-user role tiers, quotas and access rules | T |

### B5. Personal tools, AI, dashboards

| # | Capability | Status |
| ---: | --- | :---: |
| 94 | Auto-response templates | T |
| 95 | Interactive prompts/forms/buttons | T |
| 96 | Scheduled opted-in announcements | T |
| 97 | Presence/AFK/ghost/privacy conveniences | I |
| 98 | Coin toss, random choice and utilities | T |
| 99 | Bounded keyword-triggered recipes | T |
| 100 | AI-assisted filenames | T |
| 101 | AI captions/summaries | T |
| 102 | AI categorization and persistent media tags | T |
| 103 | Speech-to-text | T |
| 104 | Natural-language archive metadata search | T |
| 105 | Visual route/queue/file dashboard | T |

### B6. Hosting and reliability

| # | Capability | Status |
| ---: | --- | :---: |
| 106 | Standalone Node HTTP/polling runtime | T |
| 107 | Portable runtime interfaces and configuration | T |
| 108 | SQLite personal backend | T |
| 109 | PostgreSQL backend | I |
| 110 | Redis queue and leases | I |
| 111 | Docker Compose stack | I |
| 112 | Native Android Termux polling installation | I |
| 113 | Linux systemd and Windows service/task setup | I |
| 114 | Oracle/VPS deployment and secret handling | I |
| 115 | Single-host essential stack | I |
| 116 | Health/readiness checks and owner alerts | T |
| 117 | Dead-letter review, safe retry and heartbeats | T |

## Important qualifications

- **Never deployed:** no real Telegram bot/chat, Cloudflare, Oracle, Termux, Windows service, PostgreSQL or Redis connection was exercised. Node/SQLite webhook and cron tests use mocked Telegram responses. Docker/Compose could not run in the available environment.
- **Ban-risk controls:** Bot API routing only uses accessible, unprotected messages; daily cap 200; cooldown after 429; no forced group joining, no session swapping, no automatic repeated retry when delivery is uncertain; group broadcasts/moderation are OFF by default. Telegram restrictions can still occur.
- **No permanent downloaded-media storage:** the Python media worker uses per-job temporary directories and cleanup, and the DB only holds URLs, options, Telegram owner-submitted file IDs, file metadata, and limited telemetry. `/joinparts COUNT` streams authorized parts through a temporary directory and produces a SHA-256 receipt. Real local FFmpeg MP3 conversion, simulated multipart Telegram upload, media-domain/DNS rules and temporary cleanup are exercised. Public Bot API download/upload limits apply. A separately installed **local Telegram Bot API server** may keep its own cache unless configured and cleaned independently; a 4 GiB input can be *split* into several local-Bot-API documents, not sent as one 4 GiB Telegram file, and this enormous path has not been load-tested. Default upload is conservative (45 MiB); enhanced local Bot API configuration is explicit. English SRT/VTT-to-MP4 subtitle muxing is tested; arbitrary subtitle language selection is not.
- **Partial routing:** Telegram Bot API does not send generic message-deletion events. Text/caption edits on confirmed copies are supported; deleting a confirmed copy needs owner `/mirrorremove ... CONFIRM`. No source-history scraping.
- **History and portable archive:** file-ID dedup uses hashed Telegram `file_unique_id`, **not** an actual cryptographic hash of media bytes. The SQLite archive exporter/importer covers route settings and archive metadata, not sessions, Telegram files, queues or every configuration setting; import is previewable and all new routes begin disabled. The new trusted-machine `login.py --login CONFIRM` flow encrypts sessions and delegates OTP/2FA to Pyrogram's terminal prompts; local mocked-client tests cover vault lifecycle, **not** a real Telegram login. Session plaintext exists temporarily during trusted Pyrogram use and is removed on normal exit.
- **Personal, AI and business:** filename ideas, summaries, and tags use local heuristics unless the owner explicitly configures and enables an Ollama-compatible inference endpoint. Text-only inference and persistent tag search are locally tested with a mock provider, not an installed production model. Owner-replied `/transcribe` queues accessible audio to the isolated Python media worker; its Bot API file retrieval, FFmpeg conversion, local Whisper call and private result are tested with a mocked model. A real model/CLI is not bundled and live recognition has not been verified. Native anonymous polls and owner-private multi-step text forms with Telegram callbacks are locally tested; arbitrary public forms are not. A read-only Telegram Mini App now has signed, time-limited owner authentication, but has not been launched on a real Telegram client. The self-hosted lookup parser is wired through a private loopback Compose profile, with offline provider mocks and no runtime provider acceptance. Moderator roles, per-chat controls, and daily quotas are integrated and tested; commercial multi-user billing is not. Plan catalog is inert; no payment provider or checkout was implemented.
- **Partial hosting:** PostgreSQL SQL translation and migrations passed mocks, not live PG. Redis is a **leader lease**, not a Redis-backed queue. Termux/Oracle installers and Linux/Windows units are untested on destination OS. The original dashboard remains key-protected, while the new Telegram Mini App requires deployment to a genuine public HTTPS origin.

## Two pending eligible items

1. **#48** — A remote GitHub/private Git repository cannot be created/pushed until the owner supplies a connected Git host/repository or authenticated Git transport; the local repository and two distributable ZIP variants are ready.
2. **#49** — Real Telegram and host acceptance needs a dedicated test bot token, authorized test chats and the selected deployment account/host.

**#58 is now locally tested:** `/topicchoose ROUTE_ID source|dest` displays only topics already observed in that chat and uses owner-authenticated Telegram inline buttons to update the selected route. It is a Telegram in-chat chooser, not a full Mini App.

## Verified offline paths

`apps/worker` contains integration tests for owner/secret gating, grouped albums, mapped topics, authenticated private topic selection, reply/edit propagation, scoped moderator quotas, optional Ollama-compatible text inference, persistent archive tags, admin moderation, independently keyed dashboard, media batch options, authenticated progress and job heartbeats. `apps/local` tests SQLite/polling, PostgreSQL adapter mocks, Redis-leader lease, stale-job DLQ and backup. Separate Python tests cover media, history, RSS security, local lookup/transcription adapters, and route/metadata portability. Run the commands in [README.md](../README.md).

This ledger is the acceptance report for a development source snapshot, not a security certification or permission to operate on content you cannot access.
