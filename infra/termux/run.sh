#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_dir"
if [[ ! -f .env ]]; then
  printf 'Missing .env; see .env.example\n' >&2
  exit 1
fi
exec node --env-file=.env apps/local/src/runtime.js
