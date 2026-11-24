#!/usr/bin/env bash
# Minimal Ubuntu/Debian VPS installer. Does NOT install Node.js or deploy keys.
# Run from the checked-out repo: sudo bash infra/install-vps.sh
set -euo pipefail
if [[ "$EUID" -ne 0 ]]; then
  printf 'Run as root with sudo.\n' >&2
  exit 1
fi
for executable in node rsync useradd systemctl; do
  if ! command -v "$executable" >/dev/null 2>&1; then
    printf 'Missing prerequisite: %s. Install it before running.\n' "$executable" >&2
    exit 1
  fi
done
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if ((node_major < 24)); then
  printf 'Node 24+ required; detected %s. Install a supported Node.js release.\n' "$node_major" >&2
  exit 1
fi
if [[ ! -x /usr/bin/node ]]; then
  printf 'This systemd unit uses /usr/bin/node; point it at the installed Node 24 binary first.\n' >&2
  exit 1
fi
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
dest=/opt/orbitsuite
if [[ -d "$dest" ]] && [[ -n "$(find "$dest" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  printf '%s already contains files. Refusing to overwrite an existing install.\n' "$dest" >&2
  exit 1
fi
if ! id orbitsuite >/dev/null 2>&1; then
  useradd --system --home /var/lib/orbitsuite --shell /usr/sbin/nologin orbitsuite
fi
install -d -m 0755 "$dest"
install -d -m 0700 -o orbitsuite -g orbitsuite /var/lib/orbitsuite
install -d -m 0700 /etc/orbitsuite
rsync -a "$repo_dir/apps/" "$dest/apps/"
install -m 0644 "$repo_dir/infra/systemd/orbitsuite.service" /etc/systemd/system/orbitsuite.service
chown -R root:root "$dest"
systemctl daemon-reload
printf '\nInstalled files (service NOT started). Next:\n'
printf '1. sudo install -m 0600 -o orbitsuite -g orbitsuite /path/to/private.env /etc/orbitsuite/orbitsuite.env\n'
printf '2. sudo systemctl enable --now orbitsuite\n'
printf '3. sudo systemctl status orbitsuite\n'
printf 'For polling, do NOT expose port 8787 on the VPS firewall.\n'
