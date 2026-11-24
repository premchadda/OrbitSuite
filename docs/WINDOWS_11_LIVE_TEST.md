# OrbitSuite v4.2 — Windows 11 live staging guide

**Purpose:** Verify the actual bot with a dedicated token and private Telegram
test chats before any personal or cloud deployment. No Cloudflare or paid VPS
is needed for the first run. **These instructions have not yet been executed
on the owner's Windows 11 computer.** The repository's PowerShell entrypoints
must still pass their first native-Windows acceptance run.

## 0. Safety boundary and working directory

- Use a fresh **BotFather test bot token**, never your personal Telegram account
  session. Only use chats/media you control or are explicitly permitted to use.
- Use **two different private Telegram supergroups** (source and destination),
  with forum topics enabled if testing topic-to-topic routing. OrbitSuite
  deliberately rejects routes whose source and destination *chat IDs are the
  same*. Two topics within a single group are insufficient for that test.
- Make the bot an administrator of the test chats with the minimum necessary
  permissions for the test, including topic management if creating topics.
  Check bot privacy/message visibility settings if normal group messages do
  not reach it. Do not modify your production groups for staging.
- Keep only **one polling process** for the token. Staging tests never require
  a publicly exposed listening port; health endpoints bind to `127.0.0.1`.
- Extract the **runtime-only** ZIP to a private folder, e.g.
  `C:\OrbitSuite-Staging`, **outside OneDrive or another sync/shared folder**.
  The example commands assume PowerShell is opened in that repository root.
- No script here auto-installs packages, registers a scheduled task, logs into
  an account, creates a bot, deletes a webhook, or sends messages to chats.

## 1. Install prerequisites

In an ordinary Windows PowerShell terminal, run the following *if missing*.
Windows Package Manager may request installer approval. Review prompts before
accepting; restart PowerShell afterward so PATH updates take effect.

```powershell
winget install --exact --id OpenJS.NodeJS.LTS
winget install --exact --id Python.Python.3.12
winget install --exact --id Gyan.FFmpeg
winget install --exact --id yt-dlp.yt-dlp
```

Optional for source-control work: `winget install --exact --id Git.Git`.
Node.js **24 or later** is required; a newer active LTS meets the requirement.
The Python service Docker image uses 3.12. `ffmpeg`, `ffprobe` and `yt-dlp`
must be on PATH for the full media test path. Check:

```powershell
node --version
py -3.12 --version
ffmpeg -version
ffprobe -version
yt-dlp --version
```

Create a dedicated Python environment **inside the repo**. It is Git-ignored:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r services/media_worker/requirements.txt
.\.venv\Scripts\python.exe -m pip install -r services/user_bridge/requirements.txt
```

Pyrogram is installed here only for local dependency tests; do **not** use its
login CLI until the separate account-history test phase. If installing
TgCrypto encounters a platform compiler/wheel issue, postpone the optional
user-history package and install `cryptography` only, then report the issue.

Run preflight and all offline tests **before creating `.env`**:

```powershell
.\infra\windows\preflight.ps1 -Mode Offline
.\infra\windows\test-offline.ps1
```

These commands do not contact Telegram. The suite also performs actual local
FFmpeg processing and mocked network/API exchanges. Watch for skipped tests:
an exit code of zero alone is not proof all integration fixtures ran.

If PowerShell blocks a downloaded script, read the script first. Then, if you
trust this exact file, unblock that file through Windows file Properties or
`Unblock-File -Path .\infra\windows\preflight.ps1`. Do not disable execution
policy machine-wide or run the scripts as Administrator unnecessarily.

## 2. Create staging secrets without exposing them in chat

Copy the template, open it in a private local editor, and replace placeholders:

```powershell
Copy-Item .env.example .env
notepad .env
```

Required settings for this stage:

```dotenv
BOT_TOKEN=YOUR_NEW_BOTFATHER_TEST_BOT_TOKEN
OWNER_ID=YOUR_REAL_NUMERIC_TELEGRAM_ID
WEBHOOK_SECRET=INDEPENDENT_RANDOM_STRING_AT_LEAST_16_CHARS
MEDIA_WORKER_KEY=ANOTHER_RANDOM_STRING_AT_LEAST_24_CHARS
ORBIT_MODE=polling
ORBIT_STORE=sqlite
ORBIT_DB_PATH=data/orbitsuite.sqlite
ORBIT_HOST=127.0.0.1
ORBIT_PORT=8787
ORBIT_ALERTS=0
# Add these after discovering your two private supergroup IDs:
# ORBIT_TEST_CHAT_ID=-1001234567890
# ORBIT_TEST_DEST_CHAT_ID=-1009876543210
```

Use your real values, not the example IDs. The test-group IDs must differ.
To generate independent secrets on your PC, run the following **twice** and
paste the resulting private values into `.env`; do not upload a screenshot:

```powershell
.\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(36))"
```

The filename `.env`, SQLite databases and `.venv` are Git-ignored. Check
Windows file Properties → Security so only your account and trusted local
administrators can read `.env`. Keep the folder off shared drives.
The test bot token is not a substitute for `API_ID`/`API_HASH` (those are for
the separate **optional** trusted user-history login).

## 3. Read-only Telegram connection check

Send `/start` to the new bot privately in Telegram; add it to the two test
groups. Find the numeric `OWNER_ID` using a trusted Telegram ID method, then
fill `.env`. Without starting the local polling process, run:

```powershell
.\infra\windows\preflight.ps1 -Mode Live
node --env-file=.env infra/windows/telegram-smoke.mjs
```

This smoke checker calls only `getMe`, `getWebhookInfo` and, if the test chat
IDs are configured, `getChat` and `getChatMember`. It prints limited status,
**never** tokens, chat titles, messages or webhook URLs. It does not delete
webhooks or consume updates. If `webhook_active` is true, review the previous
deployment and explicitly remove that test bot's webhook through Telegram's
Bot API with **`drop_pending_updates=false`**. Do not do this on a production
bot. A token cannot poll while a webhook is active.

Initially, `ORBIT_TEST_CHAT_ID` may be unset. After starting the bot, send
`/id` inside a source forum topic and inside a destination topic. Use the
reported IDs to fill both chat IDs in `.env`, then re-run the smoke check.
Telegram may require the bot to be an administrator for some group operations.

## 4. Start the bot and collect the first evidence

Open PowerShell terminal **A** in the repository root:

```powershell
.\infra\windows\start-bot.ps1
```

In terminal **B**, while terminal A remains open:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
Invoke-RestMethod http://127.0.0.1:8787/readyz
```

Expected: JSON with `ok: true`; readiness also shows leader status. Then
message the bot privately with `/start`, `/features`, `/status`, and `/routes`.
Only the configured owner should be allowed to issue owner commands. Verify
that sending an owner-only command from another person does nothing useful.
For source and destination topic IDs, send `/id` as owner within each topic.

Create one test route **between two different chats** in your owner-private
conversation. Replace placeholders with IDs returned by `/id`:

```text
/route -100SOURCE_CHAT SOURCE_TOPIC -100DEST_CHAT DEST_TOPIC all copy
/routes
/checkroute 1
```

The route ID may not be `1`; use the ID actually returned by `/routes`.
Send one harmless text message, photo and small document into the source
topic. Verify one corresponding destination copy in the correct topic,
preserved media and no routing loop. Test a changed caption and `/stop` / `/run`
only after normal copying is confirmed. Keep volumes deliberately tiny.

## 5. Optional media worker (second Python process)

First get a healthy bot and set archive destination, e.g. in owner-private chat:

```text
/setarchive -100DEST_CHAT DEST_TOPIC
```

Then start the media worker in **another** terminal in the repository root:

```powershell
.\infra\windows\start-media.ps1
```

The script locally reads `.env`, maps `MEDIA_WORKER_KEY` to the worker's
`ORBIT_SERVICE_KEY`, and connects only to the loopback control URL. It does
not print secrets or persist them as command arguments. **Only after it is
running**, enable downloads and queue a single public authorized test URL:

```text
/feature media_downloads on
/adl YOUR_PERMITTED_PUBLIC_MEDIA_URL
/mediajobs
```

Confirm delivery, job status, no duplicates, and temporary-file deletion.
For a first test use a tiny media fixture within the standard Bot API size
limits. Large multipart testing requires a separately configured local Bot
API server, much more temporary disk and an explicit later test phase.
The ordinary Bot API should not be assumed to upload a single 4 GiB file.

## 6. Feature-specific opt-in tests

- Forms: `/formnew Test | What worked? | What failed?`, then `/formopen ID`
  and `/formresults ID`. Test cancel/expiration without sensitive responses.
- Route persistence: restart the bot; check `/routes` again. Do not restart
  while a send is uncertain; inspect destination before any retry.
- Mini App: requires a **real public HTTPS origin** plus dashboard activation;
  `http://127.0.0.1` does not qualify. Keep it off for initial localhost tests.
- Trusted history bridge: only on a trusted disk-encrypted PC, with locally
  configured `API_ID`, `API_HASH`, `ORBIT_SESSION_KEY`; first `--status`, then
  a manual logged-in dry-run over a few *permitted* test messages.
- Paid plans: the repo holds drafts only. No charges, gateway refunds or
  settlements can be accepted without an explicitly chosen provider sandbox.

## 7. Backups, recovery, clean shutdown

Stop the bot cleanly with Ctrl+C (allow its in-flight polling request to end).
For a small staging database, test backup and restore to two **fresh paths**:

```powershell
New-Item -ItemType Directory staging-results -ErrorAction SilentlyContinue
node apps/local/src/backup.js backup data/orbitsuite.sqlite staging-results/backup.sqlite
node apps/local/src/backup.js restore staging-results/backup.sqlite staging-results/restore.sqlite
```

**Do not run a restore into the live database.** The backup command refuses to
overwrite existing targets; choose new filenames for subsequent tests. The
`staging-results` folder is Git-ignored. Backups contain metadata and may
contain chat IDs or private notes, so treat them as sensitive.

Use `infra/windows/install-task.ps1` *only after* the foreground polling test
passes and you intentionally want startup at Windows user login. It registers
a real scheduled task and is not run automatically by this staging kit.
Windows sleep or sign-out can interrupt personal hosting.

## 8. Acceptance log and stop conditions

Record pass/fail/blocked outcomes with real observed evidence in
[`WINDOWS_11_ACCEPTANCE_CHECKLIST.md`](WINDOWS_11_ACCEPTANCE_CHECKLIST.md).
The bot must remain off production chats until basic routing, recovery and
account-limit behavior have passed on staging. Stop on FloodWait, unexpected
multiple sends, uncertain status, unauthorized access, or unexpected media
retention; diagnose before retrying. Never claim real Windows, Telegram or
Oracle acceptance solely from the offline test suite.
