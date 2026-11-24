# OrbitSuite v4.2 — 20 remaining partial capability acceptance tasks

**24 November 2026.** The system now has 92 locally tested, 20 partial,
2 externally pending and 3 intentionally excluded categories, out of 117.
This is a concrete closure checklist, not an assertion that live deployment
or all upstream commands were reproduced. T means *offline local testing*.

The following are the **20 I rows**. To close any of them, complete the
remaining technical work and collect the stated acceptance evidence. Never
use a production personal account as the first test account.

| # | Remaining gap | What is needed to call the requested capability complete |
| ---: | --- | --- |
| 20 | yt-dlp downloader | Install a maintained yt-dlp binary; download an authorized, non-DRM test fixture from a supported public site; confirm extractor updates, limits and temp cleanup on the chosen host |
| 27 | Authorized historical scan | Run a dry-run followed by a confirmed small scan against an authorized test group; inspect rate limits, flood wait and checkpoint/resume behavior with a disposable account |
| 28 | History source-topic filtering | Test topic selection on a real forum source against messages inside and outside the selected topic, with permitted access and skip reporting |
| 29 | Local Saved Messages transfer | Use a trusted local Pyrogram test session to copy a small authorized sample into `me`; confirm no unintended account-session exposure and inspect delivery results |
| 42 | Wide extractor coverage | Select specific legal test sites and URLs and record actual extractor support/quality; arbitrary domains and protected media are not accepted by default |
| 44 | Paid plans, checkout, refunds | Choose a gateway and account type, obtain sandbox test credentials, implement and test signed webhook/order/receipt/entitlement/refund lifecycle with idempotency, then separately verify live settlement before activation |
| 46 | Isolated Python dependencies | Build and dependency-scan each optional image/virtualenv on a deployment machine, including ffmpeg, yt-dlp, optional Whisper, Pyrogram and provider SDK versions |
| 47 | Docker, Termux, Oracle host artifacts | Execute the provided installers against disposable chosen hosts and verify startup/restart, file ownership, firewall and secrets |
| 60 | Edit and delete propagation | Edited copies are implemented; generic source-delete updates are **not emitted** by Telegram Bot API. Keep owner-confirmed deletion or design a separate explicitly authorized client observer with additional account risk |
| 64 | Social-media extractors | Test supported, public and authorized Instagram/TikTok/Facebook/X/etc. URLs with explicit host opt-in. Private/DRM/credential-required content cannot be assumed available |
| 67 | 4 GiB source handling | Test 4 GiB **multipart** path against an installed local Bot API and adequate temporary disk space; one 4 GiB Telegram document is not promised. Verify disk exhaustion handling, cleanup and app-visible rejoin procedure |
| 84 | Full media content-hash dedup | Choose whether optional temporary file download/hashing is acceptable for personal privacy/bandwidth. Telegram unique-file IDs alone are not byte hashes; exact global content dedup cannot be proved from metadata alone |
| 97 | Ghost/presence/privacy | Real Telegram online/last-seen controls are outside the ordinary Bot API; define acceptable bot-only behavior (AFK, reduced notifications, privacy settings guidance) rather than claiming to alter client presence |
| 109 | PostgreSQL | Start a real PostgreSQL service, apply migrations, test concurrency, rollback, queues and restarts; current adapter has offline translation/mocks |
| 110 | Redis queue/leases | Real Redis lease integration and failover testing are needed. Current implementation is a leader lease, not a Redis-backed job queue; decide whether a true Redis queue is necessary for a single owner |
| 111 | Docker Compose | Build/recreate base and opt-in media/parser/PostgreSQL/Redis variants on Docker; test profiles, healthchecks, volumes and secrets with actual services |
| 112 | Native Termux | Test on an Android device under Termux, including process survival, battery optimization, reconnects and storage permissions |
| 113 | Linux and Windows services | Install and reboot-test systemd and Windows Task Scheduler integrations on actual machines, including least-privilege permissions and crash recovery |
| 114 | Oracle/VPS deployment | Provision actual Oracle or other VPS, restrict SSH/network and secrets, prove resource and firewall rules, then load-test the chosen process set |
| 115 | Single-host personal stack | Complete end-to-end Telegram acceptance on Node/SQLite, add only selected optional services, inspect real disk/network consumption, then document recoverable backup and cold restart |

## Two externally pending actions

- **#48 Remote Git publication:** requires a connected writable Git host and a target name/privacy choice. Both editions currently have local Git commits and ZIP distributions.
- **#49 Live Telegram acceptance:** requires a dedicated test bot token, authorized test group/forum topics, and a selected self-host/cloud account. Do not send credentials in chat; configure them only through a trusted deployment secret store.

## Three deliberate exclusions

- **#30:** User-account login **inside** a Cloudflare Worker. A separate encrypted trusted-host local bridge exists instead.
- **#31:** Account rotation to evade restrictions. No legitimate ban-safety guarantee results from it.
- **#32:** Protected-content bypass. The suite must respect Telegram source restrictions and content rights.

## Order of the remaining work

1. **Free personal baseline:** one Node/SQLite host, test bot and authorized forum group. Verify health, topic copy, media upload and restart with low traffic.
2. **Optional media host:** test yt-dlp on permitted sources, actual Telegram sizes and account cooldown, then local Bot API multipart only if needed.
3. **Trusted history bridge:** guided local login, dry-run and a short test-range copy; never place a user session in the Worker.
4. **Provider and platform choices:** select a future payment gateway and which optional PostgreSQL/Redis/Mini App host variants are truly required before building production-grade external integrations.
5. **Host-specific acceptance:** Docker, Oracle/VPS, Termux, Windows, model inference and the remaining feature-specific tests on real targets.

**Account safety:** do not enable every broadcast, history or social extractor
simultaneously on your personal Telegram identity. Start with the bot token
and tiny authorized samples; pause on FloodWait and uncertain sends.
