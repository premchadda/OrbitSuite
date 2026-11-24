# OrbitSuite full feature inventory

This table is deliberately explicit about availability. **Tested locally**
does not mean tested against a production Telegram or Cloudflare account.
For the complete numbered 117-item ledger, including partial integrations and
remaining work, see [117_FEATURE_LEDGER.md](117_FEATURE_LEDGER.md).

| Area | Capability | Current state |
| --- | --- | --- |
| Control | Private owner authentication | Tested locally |
| Control | Webhook secret validation | Tested locally |
| Control | Feature enable/disable registry | Tested locally |
| Control | Emergency stop and cooldown | Tested locally |
| Control | Minimal metadata audit events | Tested locally |
| Messaging | Native copy and forward | Tested locally |
| Messaging | Route source and destination topics | Tested locally |
| Messaging | Detect own/bot messages and protected content | Tested locally |
| Messaging | Topic IDs with `/id` | Tested locally |
| Messaging | Bot membership check `/checkroute` | Tested locally |
| Messaging | Media-type filters | Tested locally |
| Messaging | Include/exclude captions and text | Tested locally |
| Messaging | Static media caption override | Tested locally |
| Messaging | Known-ID batch jobs and deduplication | Tested locally |
| Messaging | Single Telegram link `/save` | Tested locally |
| Messaging | Owner `/batchlinks` from two source links, max 50 IDs | Tested locally |
| Messaging | Manual destination forum topic creation | Tested locally |
| Messaging | Filter routes by source sender | Tested locally |
| Messaging | Filter routes by media size | Tested locally |
| Messaging | Cancel, resume, reconcile, manual retry | Tested locally |
| Messaging | Media albums preserved as grouped albums | Tested locally (up to 10 items; conservative cooldown and uncertainty handling) |
| Messaging | Cross-chat automatic topic creation | Tested locally; opt-in and requires forum permissions |
| Messaging | Private Telegram inline topic picker `/topicchoose` | Tested locally; owner-only and observed topics only |
| Messaging | Safe regex, MIME, extension, date, UTC weekday/time-window rules | Tested locally |
| Messaging | Large checkpointed known-ID batches and route templates | Tested locally; not history scraping |
| Messaging | Reply-context mapping, topic renames, edited-copy mirroring | Tested locally; deletion is owner-confirmed only |
| Media | External HTTPS URL queue | Tested locally |
| Media | yt-dlp download (optional separate host) | Implemented; live test pending |
| Media | MP3 extraction using FFmpeg | Real local FFmpeg conversion and mocked Bot API upload tested; live test pending |
| Media | Telegram upload without permanent host storage | Ephemeral multipart job locally tested; live delivery pending |
| Media | Multiple allowed media hosts | Strict HTTPS/DNS/host matching tested; actual extractor sites unverified |
| Media | Explicit video quality, container, codec, audio format and bitrate | Fixed options and local command construction tested; provider-specific extraction unverified |
| Media | Video transcoding, thumbnail controls, captions | Tested locally; requires FFmpeg host |
| Media | Screenshots and metadata inspection | Tested locally; requires FFmpeg/ffprobe |
| Media | Batch/playlist, progress/ETA, splitting, secure telemetry and worker heartbeat | Tested locally; real upload limits depend on Bot API mode |
| Media | Rejoin owner-submitted Telegram parts and embed English subtitles | Tested locally; Bot API file limits apply; some languages/formats unsupported |
| Messaging | Rich message blocks and safe inline button definitions | Tested locally; owner-private multi-question callback forms now available |
| History | Manual accessible message range scan | Implemented; live test pending |
| History | Source-topic filtering in manual scan | Implemented; live test pending |
| History | User Saved Messages (with explicit local login) | Implemented; live test pending |
| History | Guided encrypted terminal login and 2FA handoff | Locally tested with mock Pyrogram client; real Telegram OTP requires trusted-host acceptance |
| History | Personal login through Cloudflare | Intentionally not provided |
| History | Multiple account rotation | Intentionally not provided |
| History | Protected-content extraction | Intentionally not provided |
| Admin | Pin/unpin/delete one replied message | Tested locally |
| Admin | Ban/mute/promote/permissions management | Tested locally; owner-only and opt-in |
| Admin | Auto-replies and anti-spam filters | Tested locally; explicit per-chat opt-in |
| Admin | Broadcast to opted-in subscribers | Tested locally; default OFF, unsubscribe cancels jobs |
| Admin | Membership gates, delegated moderation roles and atomic daily quotas | Tested locally for allowed per-chat moderation; other multi-user tiers remain partial |
| Personal | Notes | Tested locally |
| Personal | Reminders | Tested locally |
| Personal | RSS/news feeds | Tested locally; optional secured HTTPS parser service |
| Personal | Search, translation, Wikipedia, WHOIS | Tested adapters and optional private loopback parser Compose profile; real external service acceptance pending |
| Personal | Userbot aliases, AFK, menus | Tested locally |
| Personal | Keywords/recipes, interactive private polls, coin/random choice | Tested locally; outbound modes disabled by default |
| Personal | Filename ideas, summaries, tags, natural-language metadata search | Tested locally; heuristics plus optional owner-only Ollama text inference |
| Personal | Persistent per-file archive tags and tag search | Tested locally; owner-supplied or explicit AI suggestions |
| Personal | Owner-private `/transcribe` audio-to-text with local Whisper | Integrated and locally tested with mocked model; executable/model must be installed |
| Personal | Content download from many supported sites | yt-dlp service; site-specific testing pending |
| Personal | Read-only owner dashboard and Telegram Mini App | Signed Telegram Mini App owner HMAC/expiry checks tested locally; requires HTTPS public deployment |
| Personal | Owner-private multi-step forms | Telegram callback start, bounded answers, timeout, cancellation and saved results tested locally |
| Personal | Metadata-only archive index and filename/caption lookup | Tested locally |
| Personal | Archive search by media type, chat, destination topic, UTC date, filename | Tested locally |
| Admin | Optional owner-only member ban/mute/promote controls | Tested locally |
| Business | Draft plans, payments, subscriptions | Inert plan registry and payment interface; no checkout/gateway |
| Operations | Cloudflare D1/SQLite migrations (17 total) | Locally validated |
| Operations | Isolated Python service dependencies | Implemented |
| Operations | Standalone Node 24+ SQLite control runtime | Tested locally |
| Operations | Telegram long polling with persistent offset | Tested locally |
| Operations | Self-host HTTP webhook with secret validation | Tested locally |
| Operations | Docker Compose self-host manifests | Implemented; Docker validation pending |
| Operations | HTTP health endpoint | Tested locally |
| Operations | Termux, Oracle/VPS, Windows Task, Linux systemd installers | Implemented; actual host installation not yet tested |
| Operations | PostgreSQL adapter and optional Redis singleton leases | Tested with mocks; real PostgreSQL/Redis not deployed; Redis is not the job queue |
| Operations | Readiness, opt-in owner alerts, dead-letter review, SQLite backup | Locally tested |
| Operations | Portable metadata-only archive and route config export/preview/import | Tested locally; import routes stay disabled |
| Operations | Public GitHub publication | Pending; private repo recommended |
| Operations | Live Telegram & Cloudflare acceptance tests | Pending |

This inventory is a build specification for later feature-by-feature
integration, not a claim that every archived script has been incorporated
into the same running bot.
