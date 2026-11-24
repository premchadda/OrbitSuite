# OrbitSuite deployment guide

**Deployment choice is yours.** For self-hosted Linux/Windows/Termux or a
generic Docker VPS/Oracle VM, start with [SELF_HOST.md](SELF_HOST.md). This
document retains the optional Cloudflare-specific setup.

## A. Free-tier-oriented control plane: Cloudflare Worker + D1

Deployment has **not** been performed. Platform free-tier quotas and
eligibility change; confirm current Cloudflare limits before committing.
The Worker does not download Telegram media.

1. Create a dedicated bot through Telegram BotFather. Keep the token private.
2. Choose a source group and a separate archive group/channel you control.
3. Authenticate Wrangler, from `apps/worker`:

       npm install
       npm test
       npx wrangler login
       npx wrangler d1 create orbitsuite

4. Put the returned D1 identifier in `apps/worker/wrangler.toml`, replacing
   `REPLACE_WITH_D1_ID`.
5. Apply all seventeen database migrations (0001 through 0017):

       npx wrangler d1 migrations apply orbitsuite --remote

6. Add secrets using interactive prompts:

       npx wrangler secret put BOT_TOKEN
       npx wrangler secret put OWNER_ID
       npx wrangler secret put WEBHOOK_SECRET
       npx wrangler secret put MEDIA_WORKER_KEY

   Optional read-only dashboard: additionally set `ORBIT_DASHBOARD_KEY`
   to a different random secret of at least 24 characters. Use HTTPS
   and `/adminfeature dashboard on` only when you intend to expose its UI.

   The last key is needed only if enabling the Python media processor.
7. Deploy with `npm run deploy`.
8. Register the resulting Worker URL using Telegram `setWebhook` and send
   the same `WEBHOOK_SECRET` as the `secret_token`. Include
   `message`, `channel_post`, `edited_message`, and
   `edited_channel_post`, and `callback_query` in `allowed_updates`.

## B. Set up Telegram routes

Send `/id` inside your source/destination group topics to discover chat
and topic IDs. In your private conversation with the bot:

    /route -1001234567890 12 -1009876543210 34 pdf copy
    /checkroute 1
    /routes
    /topicchoose 1 source
    /topicchoose 1 dest
    /filter 1 include SSC CGL
    /stop
    /run

Messages are copied by Telegram using identifiers. The Worker retains
metadata and notes, **not media bytes**.

Manual one-off saves:

    /setarchive -1009876543210 34
    /save https://t.me/c/1234567890/12/502
    /savejobs

The Bot API cannot traverse arbitrary old group history or bypass
protected-content restrictions.

## C. Optional media downloads on Termux or a private server

The Python service uses yt-dlp, an optional FFmpeg installation, and
the same BotFather bot token. It pulls jobs over HTTPS; the server needs
**no inbound port**. A Termux device must remain running to process jobs.

On a Linux machine or Termux with Python, FFmpeg, and a virtual environment
available, from `services/media_worker`:

    python3 -m venv .venv
    . .venv/bin/activate
    pip install -r requirements.txt
    python3 -m unittest discover -v

Set environment secrets using a private secret store, not source code:

| Variable | Description |
| --- | --- |
| `ORBIT_CONTROL_URL` | Deployed HTTPS Worker URL, no trailing slash |
| `ORBIT_SERVICE_KEY` | The same strong value as Worker `MEDIA_WORKER_KEY` |
| `BOT_TOKEN` | Dedicated BotFather bot token |
| `ORBIT_MEDIA_HOSTS` | Comma-separated allowed source domains; default includes YouTube and Vimeo |
| `ORBIT_POLL_SECONDS` | Delay between polls, default 30 seconds |

Start:

    python3 worker.py

Then, in the Telegram bot's private chat:

    /feature media_downloads on
    /dl https://www.youtube.com/watch?v=EXAMPLE
    /adl https://www.youtube.com/watch?v=EXAMPLE
    /mediabatch video https://example.com/first https://example.com/second
    /mediaoptions 1 {"height":720,"thumbnail":true,"compress_crf":26}
    /mediaoptions 1 {"embed_subtitles":true,"subtitles":true}
    /mediajobs

The media host temporarily downloads the file, checks its size,
uploads it to Telegram, then removes the temporary directory. Bot API
file-size limits apply. Never turn this into an unrestricted public
downloader without additional network and content restrictions.
The download worker reports bounded progress and heartbeat through
authenticated `/internal/media/progress` and `/internal/media/heartbeat`
endpoints; the control database stores **telemetry, not media bytes**.
The default Bot API upload limit is conservatively 45 MiB; a larger local
Bot API limit requires a separately installed loopback server and explicit
opt-in. `services/media_worker/README.md` documents all media options.

For file reassembly, send numbered documents such as `lecture.mp4.part001`
and `lecture.mp4.part002` to the bot's **owner-private chat**, in order,
then send `/joinparts 2`. The bot queues only Telegram file IDs; the media
worker temporarily downloads and joins the parts. The regular Bot API limits
both part downloading and final uploading, so larger jobs need the opted-in
local Bot API server and adequate temporary disk space.

## D. Optional local-only history bridge

Install this service into a **separate** Python virtual environment:

    cd services/user_bridge
    python3 -m venv .venv
    . .venv/bin/activate
    pip install -r requirements.txt
    python3 -m unittest discover -v

Set `API_ID` and `API_HASH` locally, preferably with a secret manager.
The first invocation may ask you to log in. Sessions are saved under a
private local folder, never in Cloudflare or the source repository.

Dry run (no copies sent):

    python3 history.py --source -1001234567890 --dest me --first 500 --last 520 --topic 12

Explicitly perform the copy after checking the dry-run results:

    python3 history.py --source -1001234567890 --dest me --first 500 --last 520 --topic 12 --execute --checkpoint ./private-history-state.json

Only messages that you can legitimately access and that are not
protected can be copied. FloodWait or permission failure stops the run.
The checkpoint requires manual review for uncertain sends. The bridge also
offers local encrypted-session storage, logout, opt-in one-shot scheduling,
dry-run reports and metadata timelines; see `services/user_bridge/README.md`.

## E. Optional private runtime, AI and administration

- Self-hosting instructions: [SELF_HOST.md](SELF_HOST.md) and
  [infra/OPERATIONS.md](../infra/OPERATIONS.md). SQLite is the simplest
  personal default. PostgreSQL and Redis leases require independent services.
- RSS/lookup service: [services/automation/README.md](../services/automation/README.md).
  It does not make outbound requests unless configured with an allowlist. The
  `infra/compose.parser.yaml` overlay connects it privately over local
  loopback; remote Workers still require an authenticated HTTPS parser.
- Transcription: [services/ai/README.md](../services/ai/README.md).
  Install a local `whisper-cli` and model, configure
  `ORBIT_WHISPER_MODEL_ROOT` and `ORBIT_WHISPER_MODEL`, then turn on
  `/feature media_downloads on` and `/feature personal_transcription on`.
  Reply `/transcribe` to an owner-private voice/audio message to queue
  ephemeral file-ID transcription. The default Docker media image does not
  bundle a model or Whisper executable.
- Owner dashboard: visit `/admin` only after enabling dashboard and
  configuring a distinct `ORBIT_DASHBOARD_KEY`. API data requires the key.
- Telegram Mini App: configure `ORBIT_PUBLIC_URL` to your public HTTPS origin,
  enable `/adminfeature dashboard on`, and send `/mini` in the owner-private
  bot chat. It verifies a recent Telegram-signed owner identity on every
  read-only API request. No dashboard password or bot token goes to the page.
- Private question forms: `/formnew TITLE | QUESTION 1 | QUESTION 2`, then
  `/formopen ID` and tap Start. Answer sequentially in your private bot chat;
  use `/formresults ID` or `/formcancel`. Submissions are small private text in
  SQLite/D1, not public responses; delete with `/formdelete ID CONFIRM`.
- Optional local model inference: configure `ORBIT_AI_BASE_URL` to your
  trusted `http://127.0.0.1:11434` Ollama service (for a self-hosted Node
  runtime), set `ORBIT_AI_MODEL` to an **already installed** model, then
  enable `/feature personal_ai on`. A trusted HTTPS Ollama-compatible
  endpoint is also supported; only explicitly submitted owner text is sent,
  and no archive content leaves the bot automatically. `/smartname`,
  `/summarize`, `/tag` and `/tagarchive ID auto` use the model if configured.
  Without it, they use local heuristics. `/tagsearch TAG` searches persisted
  archive labels. No generative model or fee is bundled with the repository.
- Portable backup for self-hosted SQLite (metadata and routes only):

      python3 tools/archive_portability.py --db data/orbitsuite.sqlite export private-export.json
      python3 tools/archive_portability.py --db data/target.sqlite preview private-export.json
      python3 tools/archive_portability.py --db data/target.sqlite import private-export.json --confirm

  Protect the exported JSON: it includes chat identifiers and filename/caption
  metadata. It has no bot secrets, sessions, queues or downloaded media.
  Imported routes start **disabled**; inspect and enable them individually.
- Optional delegated moderators: the owner must activate `group_admin`,
  register a chat with `/modchat CHAT on`, set `/adminrole USER moderator`,
  assign `/adminquota USER api LIMIT`, and enable `/adminfeature roles on`.
  Only that chat's bounded moderation actions are delegated. Role-based
  promotion is deliberately forbidden; owner privileges remain separate.
- Personal group replies, RSS, broadcasts, moderation, paid plans and
  experimental actions are disabled by default or inert until configured.

## F. Pending production work

1. Live acceptance test on a disposable test bot and test chats.
2. Confirm resource usage stays inside the selected hosting plan.
3. Configure log retention, bot token rotation, alerts, and backups.
4. Deploy only the optional services you trust and actually need.
5. Obtain permission and review third-party licenses before publishing
   the full source bundle to a public repository.
6. Test the particular PostgreSQL/Redis/Termux/Oracle/Docker combination
   before calling it production-ready; local mocks are not cloud proof.
