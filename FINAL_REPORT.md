# OrbitSuite v4.2 — Full development repository report

**Date:** 24 November 2026. The full repository preserves 11 upstream source
projects plus 2 historical branches in isolated source snapshots with their
original attribution. The active application is fully first-party branded.

## 117-feature evidence status

| Locally tested | Implemented partly / host-unverified | External pending | Excluded |
| ---: | ---: | ---: | ---: |
| **92** | **20** | **2** | **3** |

The eight previous v4.1 upgrades remain; eight further v4.2 category upgrades
are locally tested: #21 MP3 conversion, #22 ephemeral multipart Telegram upload,
#23 media host restrictions, #40 constrained Wiki/RDAP/local lookup integration,
#43 owner-authenticated Telegram Mini App, #62 codec/container/bitrate choices,
#88 guided encrypted local login, and #95 owner-private Telegram multi-step
forms. Offline testing does **not** prove live Telegram, cloud or model behavior.

## New complete local execution paths

- Private `/mini` links to an HTTPS Telegram Mini App. Server-side WebCrypto
  verifies the current owner's Telegram HMAC, expiry and uniqueness of signed
  fields before returning existing read-only dashboard metadata. No bearer
  dashboard key or bot token appears in the Mini App page.
- `/formnew`, `/formopen`, `/formresults`, `/formcancel`, `/formdelete` implement
  owner-private multi-question forms with Telegram callback Start, bounded
  text answers, 30-minute timeout and persistent SQLite/D1 results.
- The isolated media worker has actual local FFmpeg audio conversion and
  simulated Telegram multipart upload tests; temporary files are checked
  for deletion. Strict hostname/DNS validation remains in place.
- `mediaoptions` supports H.264/H.265 and MP4/MKV, and MP3/M4A/Opus with
  bounded audio bitrates. The local Bot API split ceiling was fixed to allow
  large chunk parts, and 4 GiB input may be **split** into multiple uploads
  with enough temporary disk, never promised as one Telegram file.
- The opt-in RSS/wiki/RDAP parser has an authenticated private-loopback
  Docker Compose overlay. Remote Workers still need an authenticated HTTPS
  endpoint. No arbitrary URL fetching was added.
- The separate trusted-host `login.py --login CONFIRM` program initiates
  Pyrogram terminal OTP/2FA and encrypts the resulting session via the
  existing AES-GCM vault on normal shutdown; no code enters the bot process.

## Local verification

**171 offline tests passed:** 85 Worker, 22 local Node runtime, 34 media,
16 trusted history bridge, 4 RSS, 7 AI, 3 archive portability. Those tests
include real FFmpeg audio/video operations and mocked remote APIs/models.
The upstream source snapshot integrity check is separate.

**Windows staging patch:** A native PowerShell preflight/test launcher,
foreground bot/media starters, a read-only Telegram bot/chat smoke checker
and a 30-case acceptance checklist are included. The Node entrypoint guard
now handles Windows drive letters and paths with spaces, and the local
runtime forwards only documented optional feature configuration to the bot
core. This is locally tested code, **not yet executed on the owner's actual
Windows PC or with an actual Telegram test bot**.

## Security and incompleteness

No personal Telegram account is logged into by a Worker, and unprotected
Bot API messages alone are routed by default. Group moderation and advanced
automations are opt-in; cooldowns, daily caps and uncertain-send review stay
enabled. **No code can guarantee freedom from Telegram account restrictions.**

The remaining 20 partial rows are itemized with precise acceptance work in
[`docs/20_REMAINING_ACCEPTANCE_GAPS.md`](docs/20_REMAINING_ACCEPTANCE_GAPS.md).
Remote Git publication (#48) and real Telegram/host acceptance (#49) require
authenticated external targets. Payment processing, real social extractor
coverage, host installers, PostgreSQL/Redis and huge multipart media handling
must not be described as production-certified. Some Telegram Bot API behaviors
such as generic source deletion or user presence are not available in that API.

**Use the separate runtime-only edition for personal deployment.** Cloudflare
is optional: Node/SQLite on a trusted self-host or suitable VPS is supported.
Temporary worker media is cleaned, but a separately operated local Telegram
Bot API server may retain a cache unless configured and cleaned separately.
