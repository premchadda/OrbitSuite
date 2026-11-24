# OrbitSuite optional media worker

This service retrieves **public, supported** `yt-dlp` media from HTTPS host
allowlists, uses FFmpeg for opt-in processing, uploads through the official
Telegram Bot API, and deletes its job-specific temporary directory on both
success and failure. It uses a **bot token only**; it never imports a personal
Telegram account, cookies, saved browser sessions, or arbitrary shell commands.

It is independent of Cloudflare: `ORBIT_CONTROL_URL` may point to a local
OrbitSuite control runtime or the Cloudflare Worker. It can run as a Docker
sidecar, container, VPS process, or home computer. Running this service does
not activate any feature until the control plane queues a compatible job.

## Configuration

| Environment variable | Use |
| --- | --- |
| `ORBIT_CONTROL_URL` | Authenticated control URL (`https://…`), required |
| `ORBIT_SERVICE_KEY` | Dedicated service key, at least 24 characters |
| `BOT_TOKEN` | Bot API token for Telegram uploads |
| `ORBIT_MEDIA_HOSTS` | Comma-separated source allowlist, defaults to YouTube and Vimeo |
| `ORBIT_ALLOW_SOCIAL_HOSTS=1` | Opt in to Instagram, TikTok, Facebook, X, Reddit, SoundCloud, Dailymotion, Bilibili hostnames; no login/DRM bypass |
| `ORBIT_ALLOW_LOCAL_HTTP=1` | Permit local control plane at `http://127.0.0.1:8787` |
| `ORBIT_TELEGRAM_API_BASE` | Defaults to `https://api.telegram.org` |
| `ORBIT_ALLOW_LOCAL_BOT_API=1` | Permit only `http://127.0.0.1:8081` as local Bot API (must also set previous variable) |
| `ORBIT_MEDIA_PROGRESS=0` | Disable progress telemetry (default: enabled, 404-safe) |
| `ORBIT_MEDIA_HEARTBEAT_SECONDS=0` | Disable heartbeat (default: every 60 s; 404-safe) |
| `ORBIT_POLL_SECONDS` | Claim interval, clamped 10–300 s (default 30 s) |

`ORBIT_ALLOW_LOCAL_BOT_API` needs a separately installed, authenticated
[official local Bot API server](https://github.com/tdlib/telegram-bot-api).
That server may keep its **own** files/cache: configure and clean its storage
separately if avoiding persistent host media is a hard requirement. The worker
itself does not retain media after the job.

The ordinary Bot API is capped conservatively at 45 MiB per document. With
local Bot API opt-in, the implementation caps documents at 1,900 MiB, below
Telegram's documented local 2,000 MB ceiling. Larger public-API downloads
require explicit `split` mode and can produce at most ten file parts per job.
For disk protection the **default download limit stays 45 MiB** even when the
local API is enabled; set a higher `max_bytes` only for intended files.
With `split: true` and a separately installed local Bot API server, the
worker accepts sources of up to **4 GiB** by splitting them into several
documents, *not* by uploading one 4 GiB Telegram document. Allow for both
source and split parts on temporary disk (potentially more than 8 GiB).
The real 4 GiB flow has not been acceptance-tested.

## Internal `process` contract

`process(job, client, bot_token, allowed_hosts, api_base=..., progress=...)`
accepts the existing `job.url` and optional `job.urls` (1–10 HTTPS URLs),
`kind` (`video` or `audio`), `dest`, optional `dest_topic`, optional `quality`,
and a strict `options` object. Example control-plane payload:

```json
{
  "id": 234,
  "kind": "video",
  "urls": ["https://www.youtube.com/watch?v=EXAMPLE"],
  "dest": "-1001234567890",
  "dest_topic": 45,
  "options": {
    "playlist_limit": 3,
    "max_bytes": 100000000,
    "split": true,
    "subtitles": true,
    "embed_subtitles": true,
    "caption": "Personal copy",
    "filename": "archive",
    "replacements": [["Old", "New"]],
    "trim_start": 10,
    "trim_duration": 60,
    "crop": [0, 0, 1280, 720],
    "height": 720,
    "video_codec": "h264",
    "container": "mp4",
    "compress_crf": 26,
    "thumbnail": true,
    "thumbnail_at": 15,
    "screenshot_at": 15,
    "watermark": "My own footage",
    "ffprobe": true,
    "embed_metadata": true
  }
}
```

The example options demonstrate the schema, not a recommended single job:
trimming and watermarking re-encode, source crop must fit the source frame,
and playlist media may need a larger temporary disk budget. `crop` is
`[x, y, width, height]`; `rotate` may be `90`, `180`, or `270`; `height` may be
`360`, `480`, `720`, or `1080`; `compress_crf` may be 18–35. Filename and
caption rewrites are literal string replacements, not regular expressions.
`video_codec` accepts `h264` or `h265`; `container` accepts `mp4` or `mkv`.
Audio jobs can use `audio_format: mp3|m4a|opus` and `audio_bitrate` of
64, 96, 128, 192, 256 or 320 kbps. Audio-only options are rejected for
video jobs and vice versa. Options are fixed, not shell arguments.
English subtitle files are uploaded as sidecar documents when `subtitles`
is true. With `embed_subtitles: true`, the worker fetches a supported English
SRT/VTT sidecar and muxes it into the output MP4 as `mov_text`; this runs
FFmpeg with a fixed argument list. A missing subtitle fails that job, without
inventing a caption. Real FFmpeg stream embedding is covered by a local test.

An optional `progress(event)` callback receives:

```json
{"stage":"download","bytes":1048576,"total":2097152,"speed_bps":400000,"eta_seconds":3}
```

Upload progress uses the same fields with `stage: "upload"`. Beginning and
completed counters use `{"stage":"download_started","done":1,"total":2}`
and `{"stage":"uploaded_file","done":1,"total":10}`. The running worker
forwards redacted events at most once every five seconds to authenticated
`POST /internal/media/progress` with the job `id`. It heartbeats the active
claim to `POST /internal/media/heartbeat` every 60 s. Both are optional and
disable gracefully on control endpoints without those routes.

The caller receives receipts, subtitle counts, and optional FFprobe metadata.
The owner can now send 2–10 numbered Telegram documents (`name.part001`,
`name.part002`, ...) directly to the bot and request `/joinparts COUNT`. The
control plane stores only authorized Bot API file IDs; this worker uses
`getFile` and temporary streaming downloads, verifies expected lengths,
reassembles exact sequential parts, calculates SHA-256, and uploads once.
The public Bot API typically limits `getFile` downloads to 20 MiB per part,
and its upload ceiling still applies to the joined result. Larger parts need
a separately operated local Bot API server with accessible HTTP file delivery.
The controller also accepts `urls` and `options` from `/mediabatch` and
`/mediaoptions`; neither provides arbitrary file access.

### Optional private speech-to-text

Install the audited `whisper.cpp` `whisper-cli` executable plus a compatible
local `.bin` model separately. Set `ORBIT_WHISPER_MODEL_ROOT` and
`ORBIT_WHISPER_MODEL`. In the bot's **owner-private** chat, enable both
`/feature media_downloads on` and `/feature personal_transcription on`,
then reply `/transcribe` to an accessible voice/audio message. A bounded
file ID is queued, the worker fetches it through the authorized Bot API,
converts it to mono 16-kHz PCM in a temporary directory, calls the fixed
local Whisper adapter, and sends a plain-text transcript back to the owner.
No cloud model or persistent audio storage is used. Public Bot API getFile
size limits apply; for larger audio use a separately managed local Bot API.
The model/executable are **not included** in this repository or default
Docker image; if using Docker, customize the image to install `whisper-cli`
and use `infra/compose.whisper.yaml` with a read-only model directory.

## Account and network safety

- No protected-content bypass, unrestricted remote URL fetch, user-session
  access, browser cookies, or account-specific yt-dlp configuration.
- Source HTTPS URLs are host-allowlisted and checked for public DNS
  resolution; do not add untrusted arbitrary extractor hosts to the
  allowlist. Extractors and remote redirects still warrant deployment-level
  outbound firewall controls in an untrusted multi-user environment.
- Files are processed under one temporary directory, never stored in D1,
  and cleaned after uploads. Logs suppress subprocess output and bot tokens.
- At most ten media outputs/documents per job, conservative one-second
  spacing between file sends, and no automatic retry after partial Telegram
  delivery: the job is marked `uncertain` for human reconciliation.
- Some social URLs require login or contain protected/DRM media; these fail
  normally rather than attempting to bypass access restrictions.

## Test

```bash
python3 -m unittest discover -v -s services/media_worker
```

Tests are hermetic except for one local FFmpeg still-frame smoke test (it is
skipped if FFmpeg is unavailable). Live yt-dlp extraction and Telegram upload
require separate testing with an explicitly authorized test bot/chat.
