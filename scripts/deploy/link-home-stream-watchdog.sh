#!/usr/bin/env bash
# Garde le tunnel maison→VPS vivant (cron */2 ou systemd timer).
# Usage : bash scripts/deploy/link-home-stream-watchdog.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:${HOME}/.local/bin:${PATH:-}"

STATUS_OUT="$(bash "$ROOT/scripts/deploy/link-home-stream.sh" status 2>&1 || true)"
if echo "$STATUS_OUT" | grep -q 'tunnel UP' && echo "$STATUS_OUT" | grep -q 'API locale OK'; then
  # Bridge joignable depuis le host VPS ?
  if ssh -o BatchMode=yes -o ConnectTimeout=8 "${DEPLOY_SSH:-pavel-server}" \
    'curl -fsS --max-time 4 http://127.0.0.1:18788/api/health >/dev/null' 2>/dev/null; then
    exit 0
  fi
fi

echo "[watchdog] tunnel/bridge KO — relance link-home-stream.sh"
bash "$ROOT/scripts/deploy/link-home-stream.sh" start
