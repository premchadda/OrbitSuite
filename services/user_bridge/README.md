# OrbitSuite optional local user-history bridge

This is an **isolated, manually operated** companion for copying a bounded
range of accessible Telegram messages into a chat you control. It runs under
your own user account on a trusted machine, **not** inside the public bot, web
worker, hosting provider, or Telegram bot-token process. It does not auto-join
chats, bypass copying restrictions, rotate sessions, scrape hidden content,
forward login codes, or download persistent media files.

Telegram may restrict or ban accounts for automation. Only use sources and
destinations you are authorized to access, start with a dry run, respect
Telegram limits, and stop on a flood wait. This tool is not a way around
protected-content settings or copyright/permission requirements.

## Install

Use a separate Python virtual environment:

```sh
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install -r requirements.txt
```

Configure `API_ID` and `API_HASH` locally from your own Telegram application
credentials. Do not put those, login SMS/OTP codes, or session files in the bot
configuration, a git repository, Telegram chat, deployment dashboard, or report.

Set a strong local `ORBIT_SESSION_KEY` (at least 16 characters), ideally supplied
by a secret manager or interactive shell. The vault AES-GCM-encrypts the local
SQLite session while idle. Pyrogram requires a temporary plaintext SQLite copy
while connected. **For safer runtime isolation**, use a private encrypted
filesystem or RAM-backed directory and set `ORBIT_SECURE_RUNTIME_DIR` to it.
Forced termination may leave temporary files. Keep local disk encryption and
filesystem permissions enabled.

```sh
export API_ID='your_numeric_api_id'
export API_HASH='your_api_hash'
export ORBIT_SESSION_KEY='your-long-secret-passphrase'
# Optional on suitable trusted Linux hosts: export ORBIT_SECURE_RUNTIME_DIR=/dev/shm
```

The user bridge will request Telegram login interactively if no authorized
session exists. No programmatic OTP endpoint or code logging is provided.

To verify or set up the separately encrypted local session explicitly:

```sh
python3 login.py --status
python3 login.py --login CONFIRM
```

The login utility refuses short/missing local credentials, uses the existing
AES-GCM session vault, delegates OTP and 2FA prompts to Pyrogram on your
trusted terminal, and re-encrypts the SQLite session after sign-in. The
server/bot never receives the login code. The end-to-end orchestration is
covered by offline mocked-client tests; **real Telegram OTP login has not
been acceptance-tested**. Do not run this command in a public cloud Worker.

## Preview first; execute only after reviewing

```sh
python3 history.py \
  --source -1001234567890 --dest me --first 120 --last 135 --topic 42 \
  --checkpoint ./private/preview-checkpoint.json \
  --report ./private/preview-report.jsonl --dedup-file-ids
```

The default mode only inspects accessible message metadata. At most **50
message IDs per invocation**; the topic filter is optional (`0` means any).
`--report` is optional. Reports contain event, source, message ID, topic,
media type and, if available, UTC time; `--include-filename` additionally
opts into bounded filenames. They never store captions, message text, phone
codes, file contents, or raw Telegram `file_unique_id` values.

After reviewing preview output, run with a **separate** execution checkpoint:

```sh
python3 history.py \
  --source -1001234567890 --dest me --first 120 --last 135 --topic 42 \
  --execute --checkpoint ./private/copy-checkpoint.json \
  --report ./private/copy-report.jsonl --dedup-file-ids
```

The copy uses Telegram's `copy_message` API; content protection is respected.
The minimum delay is three seconds (default five) between successful copies,
and any API or flood-wait error stops the run. It never silently retries an
ambiguous send.

To resume a matching checkpoint, append `--resume`, including exactly the same
source/destination/range/topic and preview-vs-execute mode. If an operation
stopped after starting a send but before confirmation, **inspect the destination
manually** before choosing one of:

- `--resume --skip-uncertain`: do not re-send that ID (it may have succeeded).
- `--resume --retry-uncertain CONFIRM`: explicitly risk a duplicate after review.

Neither choice is applied automatically. A checkpoint is metadata-only JSON
with a pre-send in-flight marker, SHA-256 hashes of unique Telegram media
identifiers for deduplication, counters, and next ID. Its lock file prevents
concurrent runs against the same checkpoint. Deduplication by Telegram
`file_unique_id` works for files exposing that field; it is not a media-content
hash and cannot detect all duplicates.

To run a one-shot batch at an explicit time, add an ISO-8601 offset timestamp,
e.g. `--scheduled-at 2026-12-01T06:00:00+05:30` (maximum 30 days ahead).
The process must remain running. There is no recurring scheduler or automatic
background account access.

To revoke the active local Telegram session and remove its encrypted vault:

```sh
python3 history.py --logout CONFIRM
```

This requires the existing encrypted local session and Telegram credentials;
it is a deliberate network action, not a dry run.

## Offline metadata timeline, export, and import

This catalog command requires **no Telegram credentials or connection**:

```sh
python3 catalog.py timeline --report ./private/preview-report.jsonl
python3 catalog.py timeline --report ./private/preview-report.jsonl --month 2026-11
python3 catalog.py export --report ./private/preview-report.jsonl --output ./private/catalog.json
python3 catalog.py import --input ./private/catalog.json --report ./private/imported.jsonl
```

The timeline groups counts by UTC day/source/topic and media kind. Export
retains only a whitelisted subset of previewed/copied metadata; importing a
catalog creates a **new local report**, never triggers Telegram copies. Output
files are private and will not overwrite existing ones. The catalog is not a
backup of media, messages or the account session.

## Development and limitations

```sh
python3 -m unittest discover -v
```

This service has no runtime dependency on Cloudflare or any hosting platform.
The operator must maintain their own consent and access, adequate local
storage for the temporary session, and a safe encrypted backup of the
encryption key if recovery is required. Telegram may reject copying certain
message types or destination permissions. For complex topic mappings the
destination thread is not auto-created: choose the destination explicitly.
