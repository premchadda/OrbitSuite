# OrbitSuite Windows 11 — live acceptance log

**Release:** v4.2 Windows staging patch. **Location:** private Windows 11 PC.
**Tester/date:** ____________________________  **Bot:** test-only (do not record token).

Mark each line `PASS`, `FAIL`, `BLOCKED` or `NOT TESTED`. For evidence, record
time, sanitized output/result, and any manual issue number. Do **not** paste
tokens, OTP, private message contents, session files, or personal user IDs into
a public bug report. Keep this document private if you fill it with chat IDs.

| # | Test | Expected result | Status / evidence |
| ---: | --- | --- | --- |
| W01 | Node 24+, Python 3.12+, FFmpeg, FFprobe, yt-dlp available | Versions and PATH verified | |
| W02 | Windows offline preflight | Passed without secrets or Telegram | |
| W03 | All seven offline test suites | Zero failing or unexpected skipped tests; record actual count | |
| W04 | `.env` validation | Real test token/owner, random distinct secrets, private loopback | |
| W05 | Read-only Telegram smoke | `getMe` succeeds; no active webhook; correct bot | |
| W06 | Test groups | Two distinct private chat IDs; topics enabled if required | |
| W07 | Bot membership | Access in both groups; sufficient topic permissions | |
| W08 | Local bot start | No startup errors and only one polling instance | |
| W09 | HTTP health | `/healthz` and `/readyz` report `ok: true` | |
| W10 | Owner-private commands | `/start`, `/features`, `/status`, `/routes` respond correctly | |
| W11 | Non-owner restriction | Untrusted user cannot manage routes or features | |
| W12 | Topic discovery | Owner `/id` returns distinct chat/topic IDs | |
| W13 | Route creation | Cross-chat route accepted, duplicate/cycle guarded | |
| W14 | Text/photo/document routing | Exactly one correct destination copy per allowed source message | |
| W15 | Topic isolation | Source wrong-topic message is not copied by specific-topic route | |
| W16 | Edit/caption behavior | Observed edit behavior matches enabled configuration | |
| W17 | Emergency stop | `/stop` pauses new delivery and `/run` resumes conservatively | |
| W18 | Route persistence | Restart preserves route state, no unintended old replays | |
| W19 | Form flow | Create, open, answer, results, cancel and timeout work | |
| W20 | Optional Python worker startup | Authenticated localhost media claim loop operates | |
| W21 | Tiny permitted media download | Media is delivered, queue terminal state recorded, no duplicate | |
| W22 | Media temporary files | Job-specific temporary files removed after success/failure | |
| W23 | Source host restrictions | Unapproved URLs rejected; no arbitrary local-network fetching | |
| W24 | Readiness after interruptions | Restart/recovery without blind retry of uncertain jobs | |
| W25 | SQLite backup and restore | Separate backup and new restore file pass integrity checks | |
| W26 | Windows account/file permissions | `.env`, database, logs inaccessible to unrelated local users | |
| W27 | Windows Task Scheduler *(optional)* | Manual registration/reboot and startup pass if explicitly enabled | |
| W28 | Owner session history *(optional)* | Trusted local dry-run only; no session in bot or Worker | |
| W29 | HTTPS Mini App *(optional)* | Signed owner access works from genuine Telegram Web App | |
| W30 | Provider/host extensions *(later)* | PostgreSQL, Redis, Docker and Oracle each tested on actual host | |

## Explicitly out of scope for initial Windows localhost stage

- **Real payments/refunds:** requires a gateway sandbox and signed webhook tests.
- **4 GiB media:** separate local Bot API and substantial disk; split into
  multiple parts, **not** one 4 GiB document.
- **Generic source deletions and user presence:** absent from normal Telegram
  Bot API updates. Record their specifications as limited rather than passed.
- **Real user-account history:** do not first test on the primary personal
  Telegram account; do not automate OTP or rate-limit evasion.

## Final decision

- [ ] **PASS:** Basic personal bot is ready for a separate low-volume pilot.
- [ ] **CONDITIONAL:** Local runtime works but optional modules remain off.
- [ ] **FAIL/BLOCKED:** Do not deploy to real groups; resolve logged defects.

**Notes / remaining issues:**

1. _______________________________
2. _______________________________
3. _______________________________
