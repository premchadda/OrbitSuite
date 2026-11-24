#!/data/data/com.termux/files/usr/bin/bash
# Run from a checked-out OrbitSuite repository using `bash infra/termux/install.sh`.
# This installer never requests Telegram credentials or touches Android storage.
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/../.." && pwd)"

if ! command -v pkg >/dev/null 2>&1; then
  printf 'This script requires Android Termux with the pkg package manager.\n' >&2
  exit 1
fi
pkg update -y
pkg install -y nodejs-lts git
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if ((node_major < 24)); then
  printf 'OrbitSuite requires Node.js 24+. Installed major: %s. Update Termux packages first.\n' "$node_major" >&2
  exit 1
fi
if [[ ! -f "$repo_dir/.env" ]]; then
  printf 'No .env found. Copy .env.example to .env and fill your private values.\n'
  exit 0
fi
chmod 600 "$repo_dir/.env"
printf 'Ready. Run: cd %q && bash infra/termux/run.sh\n' "$repo_dir"
