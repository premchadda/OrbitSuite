# Optional personal automation and RSS/lookup service

The edge Worker module is `apps/worker/src/personal_extensions.js` with schema
`apps/worker/migrations/0011_personal_extensions.sql`. The module exports:

```js
handlePersonalCommand(env, name, args, helpers) // Promise<string|null>
ingestPersonalUpdate(env, telegramMessage, helpers) // Promise<boolean>
runPersonalScheduled(env, helpers) // Promise<number>
```

Owner authorization belongs to the caller. `helpers` must supply D1-style
`query(sql,...args).first()/.run()`, `rows(sql,...args)` returning arrays,
`telegram(method,body)`, and `ownerId`; `now()`, `audit(...)`, `lookup(...)`, and
`fetchRss(url)` are optional. **Do not invoke `handlePersonalCommand` for
non-owners.** Private `/subscribe` and `/unsubscribe` are the only accepted
non-owner direct-message commands. Scheduled announcements go only to users
who explicitly subscribed and have not unsubscribed.

All outbound personal features are off initially. Owner can enable
`personal_auto_replies`, `personal_rss`, `personal_broadcasts`, `personal_workflows`,
and `personal_afk` individually using `/feature NAME on`. Auto-replies and
recipes are restricted to explicitly configured group IDs, one reply per rule
per 60 seconds. AFK responses are at most one per group per 10 minutes. RSS
checks a feed no more than once per 15 minutes and posts at most one article per
scheduled tick. An announcement snapshots a maximum of 50 current subscribers,
and the scheduler attempts just one recipient per tick. Failed or ambiguous
sends are recorded as uncertain, never automatically retried. Unsubscribe
cancels that user's queued deliveries.

`/prompt QUESTION | OPTION 1 | OPTION 2` uses Telegram's native anonymous poll
options in the owner's private chat; no callback handler or voter tracking is
required.

## Secure RSS parser / lookup service

RSS is intentionally **not fetched directly by the Cloudflare Worker**. An
optional local Python parser validates each feed URL against `ORBIT_RSS_HOSTS`,
looks up all DNS answers and rejects any non-public IP, connects TLS directly to
the validated IP with the correct hostname certificate verification, disables
redirects, limits responses to 256 KiB, and parses RSS/Atom. It has a read-only,
token-protected `/rss?url=...` endpoint, plus `/lookup` for Wikipedia search and
summaries, `.com/.net` RDAP, and installed offline Argos translations.

Example local launch (insert private values; never commit the token):

```bash
export ORBIT_RSS_HOSTS='feeds.example.org,news.example.com'
export ORBIT_RSS_PARSER_TOKEN='choose-at-least-16-random-characters'
python3 -m services.automation.rss --serve --host 127.0.0.1 --port 8188
```

The service listens only on loopback by default. To use it from a remote
Worker, front it with **an owner-controlled HTTPS reverse proxy** with strict
access, and configure the Worker with:

```text
ORBIT_RSS_HOSTS=feeds.example.org,news.example.com
ORBIT_RSS_PARSER_URL=https://your-private-parser.example.com
ORBIT_RSS_PARSER_TOKEN=the-exact-same-secret-as-on-parser
```

For one-machine Docker self-hosting, the optional
`infra/compose.parser.yaml` profile runs the Python lookup service on the
**bot's loopback namespace** (nothing is exposed publicly):

```sh
docker compose -f compose.yaml -f infra/compose.parser.yaml --profile parser up -d
```

Set `ORBIT_RSS_PARSER_TOKEN` (16+ random characters) and an explicit
`ORBIT_RSS_HOSTS` feed allowlist in `.env` before starting. This overlay
opts into local `http://127.0.0.1:8188` on a fixed port; the Worker itself
continues to reject arbitrary HTTP parser endpoints. No external calls occur
until an owner command or subscribed RSS tick needs them.

The module automatically calls this service if both parser URL and secret are
present. If using another server, inject `helpers.fetchRss(url)` and
`helpers.lookup(kind,query)`; those adapters must maintain the same URL/DNS,
redirect, response-size, and rate restrictions. **Do not expose a raw HTTP
proxy for arbitrary URLs or allow auto-joining Telegram channels.**

`/wiki TOPIC` queries English Wikipedia. `/websearch KEYWORDS` searches its
article titles (not an unrestricted web index). `/whois DOMAIN` queries public
RDAP for `.com/.net` only, omitting personal contacts. `/translate en:hi TEXT`
uses installed Argos language packs locally and never downloads a pack in the
request path. No API key is required, and external calls happen only on command.

## Offline verification

From the repository root:

```bash
node --test apps/worker/test/personal_extensions.test.js
python3 -m unittest discover -s services/automation -p 'test_*.py'
python3 -m unittest discover -s services/ai -p 'test_*.py'
```

No tests require network access, Telegram credentials, or model downloads.
