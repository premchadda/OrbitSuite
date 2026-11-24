#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
for module in saver-v2 saver-v3 auto-forward-v2 userbot-utilities transfer-tools rich-message aiogram-starter mtproto-client conversation-helper; do
  if [[ ! -d "third_party/$module" ]]; then
    printf 'Missing: %s\n' "$module" >&2
    exit 1
  fi
done
for excluded in saver-v4 batch-forwarder; do
  if [[ -e "third_party/$excluded" ]]; then
    printf 'Unexpected excluded snapshot: %s\n' "$excluded" >&2
    exit 1
  fi
done
for branch in v1 v2; do
  if [[ ! -d "third_party/saver-v2-historical/$branch" ]]; then
    printf 'Missing: historical saver %s\n' "$branch" >&2
    exit 1
  fi
done
if find third_party -type f \( -name '*.session' -o -name '.env' -o -name '*.pyc' \) -print | grep -q .; then
  printf 'Sensitive/generated file discovered; do not publish.\n' >&2
  exit 1
fi
printf '9 public source modules plus 2 branch snapshots present; session files absent.\n'
