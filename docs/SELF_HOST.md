# OrbitSuite self-hosting (no Cloudflare required)

**This is a locally tested deployment path, not a claim of live Telegram verification.**
Node 24+ and Python are independent runtimes; Docker packages both. The bot
uses SQLite, so no hosted database account is necessary for personal use.

## Docker Compose (Linux PC, Oracle VM, or any Docker VPS)

1. Create a dedicated Telegram bot; set up authorized source/archive chats.
2. Copy `.env.example` to `.env`, replace placeholders, and use restrictive
   local permissions (e.g. `chmod 600 .env` on Linux). Do not check it into Git.
3. If the bot previously used a Telegram webhook, remove that webhook using
   the Bot API **without** `drop_pending_updates` before starting polling.
   The standalone runtime refuses to start polling when a webhook is active.
4. Start the bot: `docker compose up -d --build bot`.
5. If downloads are needed, start the optional media worker:
   `docker compose --profile media up -d --build`.
6. View status: `docker compose ps` and check `http://127.0.0.1:8787/healthz`
   from the hosting machine.

Port 8787 is published **only on 127.0.0.1**. Long polling works without a
domain or inbound internet access. The media container shares the bot
container's private network namespace and can therefore use loopback HTTP;
this exception is explicitly enabled and is **not** allowed for remote hosts.
All external media sources continue to require HTTPS and a host allowlist.

The Docker volume `orbit_data` contains only SQLite settings, jobs, and
metadata; media files live in temporary directories and are deleted after
processing. **Back up the SQLite volume; do not delete it to update the app.**

Optional PostgreSQL, Redis-leader, Linux systemd, Android Termux, Windows
Task Scheduler, and Oracle/VPS installation examples are in
[infra/OPERATIONS.md](../infra/OPERATIONS.md). SQLite is still the recommended
first choice for one personal bot. These optional services and installers
have not been validated on the target hosts.

## Without Docker (Windows, Linux, Termux with compatible Node)

On Windows 11, use the [live staging guide](WINDOWS_11_LIVE_TEST.md) and
preflight/test scripts in `infra/windows/` first. Register a scheduled task
only after the foreground polling tests pass.

Install Node 24+ and run from the repository root:

```bash
export BOT_TOKEN='replace-me'
export OWNER_ID='123456789'
export WEBHOOK_SECRET='replace-with-random-16-plus-char-secret'
export ORBIT_MODE='polling'
export ORBIT_DB_PATH='./data/orbitsuite.sqlite'
node apps/local/src/runtime.js
```

This mode uses Node's built-in `node:sqlite` and has no mandatory npm install.
Keep the host on; Android background restrictions and Termux battery rules
can interrupt long-running jobs. Back up the SQLite database after safely
stopping the process.

## Webhook mode

Set `ORBIT_MODE=webhook` and place the local HTTP server behind your own
HTTPS reverse proxy. Only forward Telegram's `/telegram` endpoint; protect
the webhook with `WEBHOOK_SECRET`. Register the webhook in Telegram with the
same secret token. Do not enable long polling on the same token simultaneously.

## Cloudflare mode is still available

`apps/worker` + D1 remains an optional serverless control plane. Apply **all
seventeen** migrations before deploying that Worker. The Python media worker can
poll either the hosted control plane over HTTPS or the trusted local control
plane on loopback HTTP.

## Remaining limitations

- No real Telegram account, Oracle VM, Windows, or Termux deployment has yet
  been tested in this workspace.
- Local SQLite is suitable for a single bot process; do not run multiple
  independent instances on one database without a coordinated queue.
- This does not implement every archived userbot feature. User-account history
  bridge remains opt-in, separate, and dry-run by default.
- Owner-only moderation commands exist, but the `group_admin` feature is OFF
  by default. Verify the bot's group permissions before enabling it.
- Verify bot permissions and use modest throughput; no bot can promise zero
  risk of Telegram rate limits or account restrictions.
