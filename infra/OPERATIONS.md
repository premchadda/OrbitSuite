# OrbitSuite self-hosting and reliability guide

OrbitSuite's full control bot is **not tied to Cloudflare**. The default personal
installation is a single Node.js 24+ process and SQLite database, with no paid
platform or persistent media storage. The optional Python media service streams
downloads into temporary files and sends them to Telegram; operators should
configure a bounded scratch volume, verify deletion, and not treat the bot as a
backup for Telegram content. Use only media you are authorized to handle.

## Deployment choices

| Platform | Process and store | Cost/use case | Notes |
| --- | --- | --- | --- |
| Existing Linux PC/Raspberry Pi/VPS | Node 24 + SQLite | Best zero-extra-cost personal use | Keep one polling instance and back up SQLite |
| Android Termux | Node 24 + SQLite | Personal fallback with no server bill | Android may suspend/kill background processes |
| Windows PC | Node 24 + SQLite | Task Scheduler at user login | Not available before user login or when PC sleeps |
| Oracle Cloud Always Free eligible VM | Node 24 + SQLite | Remote personal hosting if capacity and eligibility available | Verify current free-tier terms, capacity, and egress in your account; no guarantee |
| Docker Compose | Node 24 + SQLite | Reproducible personal host | Exposes health on host loopback only |
| Docker Compose + PostgreSQL | PG + Node adapter | Durable multi-process DB option | Additional memory/maintenance; not needed for one bot |
| Redis overlay | Redis singleton lease + existing DB queue | Optional coordination of multiple instances | Lease is best-effort; not a delivery exactly-once guarantee |

**One Telegram bot token should have only one polling leader.** Never enable a
Telegram webhook and long polling simultaneously. This runtime checks for an
already-configured webhook and refuses to start polling if one exists. Configure
polling by default on personal hosts; no public inbound port is needed.

## Secrets and account safety

1. Use a bot token from BotFather, not a personal-account session. Avoid personal
   login automation or account rotation; neither is needed for topic-aware bot
   features and both increase account-lock and exposure risks.
2. Copy `.env.example` to `.env`, fill `BOT_TOKEN`, numeric `OWNER_ID`, and an
   independent long random `WEBHOOK_SECRET`. If media is enabled set a different
   `MEDIA_WORKER_KEY`. Run `chmod 600 .env` on Unix.
3. Add bot permissions only in chats/topics you own or have explicit permission
   to archive. A bot cannot fetch arbitrary historical group messages, bypass
   Telegram protection, or read invisible topics.
4. Set conservative daily caps and rate limits. Stale or ambiguous sends become
   `uncertain` for human review, never automatically retried. Blind retries can
   duplicate Telegram messages or trigger rate limits.
5. Do not paste tokens into Git, screenshots, logs, task arguments, support
   tickets, or public environment dumps. Never publish the database, media
   scratch folder, PostgreSQL, or Redis ports.

## Standalone Linux / existing VPS

Install Node.js **24 or newer** using a trusted platform package or the official
Node.js downloads, then from the checked-out repository:

```sh
cp .env.example .env
chmod 600 .env
# Edit credentials locally; do not paste them in the terminal history.
node --env-file=.env apps/local/src/runtime.js
```

By default `ORBIT_DB_PATH=data/orbitsuite.sqlite`. Keep `ORBIT_HOST=127.0.0.1`
for a local process, and `ORBIT_MODE=polling`. Probe from the same machine:

```sh
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/readyz
```

Readiness reports only `ok` and whether this instance owns the Redis leader
lease. Failure returns HTTP 503 without leaking database details. The more
detailed `healthSnapshot()` API remains internal.

For Ubuntu/Debian VPS or Oracle Linux-compatible hosts, use the install script
only after verifying it meets Node/systemd/rsync prerequisites:

```sh
sudo bash infra/install-vps.sh
# Prepare private.env yourself outside the source repository.
sudo install -m 0600 -o orbitsuite -g orbitsuite private.env /etc/orbitsuite/orbitsuite.env
sudo systemctl enable --now orbitsuite
sudo systemctl status orbitsuite
journalctl -u orbitsuite -f
```

The installer refuses to overwrite `/opt/orbitsuite` if populated, creates a
dedicated unprivileged user, installs `infra/systemd/orbitsuite.service`, and
**does not start the service** or touch `.env` automatically. To upgrade, stop
the service, save a backup, audit changes, and copy only reviewed app files.

For Oracle Always Free, choose an eligible Linux compute shape according to
the region's present free allocation and capacity. Add no inbound rule for
polling. Use SSH key authentication and a host firewall, restrict SSH to your
IP if practical, and keep the OS/security updates current. A reverse proxy
with HTTPS is mandatory if you later enable a public webhook; do not expose
port 8787 directly. Oracle availability and free status can change, so verify
the provider's live conditions before launch.

## Android / Termux

Install the maintained Termux app, grant only permissions you actually need,
clone or copy the reviewed repository inside Termux's private directory, then:

```sh
bash infra/termux/install.sh
cp .env.example .env
chmod 600 .env
# Fill private credentials with an editor.
bash infra/termux/run.sh
```

The installer uses Termux's package manager for Git and Node LTS, verifies
Node >=24, and never requests credentials. Termux's Android background battery
limits can stop polling; disable battery optimization where appropriate, keep
the device powered/networked, and don't count on this for strict 24/7 uptime.
`termux-wake-lock` is optional, consumes battery, and does not override all OS
limits. Do not publish Termux's storage directory via shared Android storage.

## Windows personal workstation

Install Node 24+, copy `.env.example` to `.env` and keep it private. Run:

```powershell
node --env-file=.env apps/local/src/runtime.js
```

To start at the current user's next login, run the reviewed PowerShell script:

```powershell
./infra/windows/install-task.ps1
```

The script creates Task Scheduler task `OrbitSuitePersonal`, with the current
user and no admin privilege. It does not create a privileged Windows Service,
start the task immediately, or store a password. Check task history and the
user's sign-in state for troubleshooting. Restrict `.env` ACLs using Windows
file security properties; never put the bot token directly in task arguments.

## Docker Compose profiles and isolation

```sh
cp .env.example .env
chmod 600 .env
# Fill private values; use a strong and distinct media key.
docker compose up -d --build
# Optional Python media processing (temporary bytes, bounded workers):
docker compose --profile media up -d --build
```

The default bot uses an unprivileged Node container, read-only root filesystem,
private volume for SQLite, loopback-bound HTTP, dropped Linux capabilities,
and no-new-privileges. The media worker is deliberately opt-in.

To opt in to PostgreSQL on the **same Docker-private network**, set a strong
`POSTGRES_PASSWORD` in `.env`, then:

```sh
docker compose -f compose.yaml -f infra/compose.postgres.yaml up -d --build
```

Only the PostgreSQL overlay installs optional Node package `pg@8` (and
`redis@5`). Without the overlay, the default image has zero npm dependencies.
Never run the SQLite and PostgreSQL modes concurrently on the same bot token.
For an independently hosted PostgreSQL service set `ORBIT_STORE=postgres` and
`DATABASE_URL` or `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`;
install the optional package with `npm install --no-save pg@8` within
`apps/local`. Migrations execute on startup under an advisory lock; take a DB
backup first. PostgreSQL compatibility has mock-backed contract tests but has
not been exercised against a real production database in this build.

To opt in to Redis leader leases, combine both overlays:

```sh
docker compose -f compose.yaml -f infra/compose.postgres.yaml -f infra/compose.redis.yaml up -d --build
```

Redis is not published to the host, and the included example is for a dedicated
trusted Compose network only. For a shared network or managed Redis, require
authentication/TLS and configure a private `REDIS_URL`. Do not use Redis as an
alternative media store. The runtime's durable queue remains in the DB; Redis
only coordinates scheduled drains and polling. A network partition can still
create lease ambiguity; monitor duplicate sends and keep only one bot instance
unless you have a tested operational reason to scale.

## Backups and recovery

For default SQLite, use the Node backup API, which produces a consistent online
snapshot even if WAL mode is active:

```sh
node apps/local/src/backup.js backup data/orbitsuite.sqlite backups/orbitsuite-2026-11-24.sqlite
```

The command refuses to overwrite a backup path and restricts file permissions.
Encrypt the resulting snapshot, store it off-host with restricted access, and
periodically test restoration. The database contains chat/topic identifiers,
message metadata and configured routes; treat backups as private.

For recovery, **stop the bot first**. Keep the prior DB as a separate rollback
artifact; the restore command intentionally refuses to overwrite any existing
database:

```sh
node apps/local/src/backup.js restore backups/orbitsuite-2026-11-24.sqlite data/recovered.sqlite
# Inspect recovered.sqlite before replacing the offline original.
```

On Docker, run the same command inside the bot container with mounted backup
destination, or stop the stack and carefully copy the volume to an encrypted
off-host backup. On PostgreSQL use `pg_dump --format=custom` and `pg_restore`
with PostgreSQL's native consistency guarantees, not the SQLite backup tool.

## Dead letters, heartbeats and alerts

- SQLite/PostgreSQL `ops_dead_letters` records job type, ID, reason and time,
  not file payloads. Stuck `jobs`, `manual_jobs`, and `album_batches` with no
  progress for 10 minutes (`ORBIT_STALE_SECONDS`) become `uncertain`.
- A media download/upload can legitimately last much longer; default media
  timeout is six hours (`ORBIT_MEDIA_STALE_SECONDS=21600`). A media worker may
  refresh an active job with `POST /internal/media/heartbeat`, header
  `X-Orbit-Service-Key: MEDIA_WORKER_KEY`, JSON `{ "id": 123 }` every ~60 seconds.
  This heartbeat is currently exposed by the Node runtime; clients on other
  runtimes should use their supported endpoint or abstain.
- `uncertain` means a human must examine the Telegram destination before
  deciding whether `/retry` is safe. Never blindly requeue an ambiguous send.
- `ORBIT_ALERTS=1` enables owner-only Telegram health/stale-job alerts; cooldown
  defaults to 3600 seconds. Alert text contains no secrets. API failures are
  reported without printing bot tokens.
- Monitor free disk space, outbound connectivity, backlog, bot permissions,
  media scratch usage, and SQLite backup age. Redis and PostgreSQL are optional
  infrastructure, not required for a personal bot.

## Integration contract for custom hosts

The Worker core receives an `env` object holding `BOT_TOKEN`, `OWNER_ID`,
`WEBHOOK_SECRET`, optional `MEDIA_WORKER_KEY`, and an `env.DB` implementing:

```js
await DB.prepare(sql).bind(...args).first(); // row or null
await DB.prepare(sql).bind(...args).all();   // {results: rows}
await DB.prepare(sql).bind(...args).run();   // {meta: {changes: n}}
await DB.batch([DB.prepare(sql).bind(...args)]); // atomic
await DB.close();
```

Both SQLite and optional PostgreSQL implement this shape. Runtime modes are
`polling` (default) and `webhook`. Media upload/download takes place in the
separately deployed media worker, not in the control DB or HTTP health route.
