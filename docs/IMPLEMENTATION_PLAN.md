# OrbitSuite — swarm implementation plan for 70 eligible backlog items

**Baseline:** 117 tracked capability entries, of which 32 were locally tested,
12 implemented/configured without live proof, 29 source-only, 41 planned, and
3 permanently excluded. The current 70-item development scope comprises the
29 source-only and 41 planned entries; exclusions are not implementation goals.

**Execution update (24 November 2026):** Workstreams were implemented and
integrated. **68/70** eligible entries advanced to locally tested or partial
implementation; **2 remain pending** (#48 remote repo publication, #49 live
Telegram/host tests). The interactive topic chooser (#58) is now locally
tested in private Telegram owner chat. Final distribution is
T=92, I=20, S=0, P=2, X=3 after the v4.2 gap-closure tranche. See
[117_FEATURE_LEDGER.md](117_FEATURE_LEDGER.md)
for the row-by-row evidence and important caveats. These counts do **not**
mean all 68 additions are production-ready.

## Workstreams and ownership

| Workstream | Existing ledger IDs | Count | Deliverables |
| --- | --- | ---: | --- |
| Messaging/topics | 17, 18, 50, 53, 54, 56–61 | 11 | Topic/album queue, route filters, templates and safe message handling |
| Media | 24, 25, 63–77 | 17 | Isolated downloader/upload tooling, FFmpeg transform and metadata utilities |
| History/archive | 80–88 | 9 | Opt-in history backfill, reports, resumes, dedup and private session controls |
| Dashboard/admin/business | 26, 35, 36, 43, 44, 92, 93, 105 | 8 | Restricted admin UI, opt-in moderation and multiuser primitives |
| Personal automation/AI | 39–41, 94–104 | 14 | Pluggable personal commands, feeds, reminders and optional AI adapters |
| Hosting/operations | 47–49, 107, 109, 110, 112–114, 116–117 | 11 | Cross-host deployment, DB/queue adapters, install guides and health controls |
| **Total** | | **70** | |

## Integration approach

1. Implement feature modules in isolated files with tests; make any database
   migrations additive and compatible with both Cloudflare D1 and SQLite.
2. Integrate modules through a small entry-point API with owner authorization,
   feature switches, bounded workload, and metadata-only logs.
3. Run Node and Python tests, static source verification, and package validation.
4. Mark each feature **T** only for substantive local tests, **I** for coded
   features requiring a live host/account, and **P** for scaffolds or missing
   integration. Source inclusion by itself remains **S**.
5. Prepare the full development and slim runtime repository editions. Preserve
   third-party legal notices in the full archive.

## Important constraints

- No Cloudflare dependency for self-hosting. One-machine SQLite/Node and
  Docker/Linux should continue to work. Hosting adapters remain optional.
- No permanent host-media storage by default; temporary media must be cleaned
  after upload and failure.
- Keep personal-account history bridge isolated with explicit local login,
  dry-run default and no protected-content extraction.
- Limit requests and concurrency; halt on FloodWait; do not promise a zero-ban
  guarantee. High-volume/multiuser/commercial functions default OFF.
- Do not activate remote shell/eval, mass account rotation, or bypass tools.
- Never label publication, real Telegram delivery, live media extraction,
  Oracle/Termux hosting, or payment settlement as tested without actual proof.

## External verification blockers

Production Telegram transfer testing requires a disposable test bot and
authorized test groups. Oracle, VPS, Termux, paid-gateway and public Git
publication require live infrastructure, credentials, explicit access and
sometimes license review. Implementable code and a local test harness can be
completed without those external services; live claims cannot.
