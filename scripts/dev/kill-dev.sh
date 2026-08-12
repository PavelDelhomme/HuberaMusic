#!/usr/bin/env bash
# Libère les ports Vite / API PLM
# Usage :
#   scripts/dev/kill-dev.sh           # 5173 + 5174 + 8787
#   scripts/dev/kill-dev.sh vite-only # 5173 + 5174 (garde l’API)
#   scripts/dev/kill-dev.sh api-only  # 8787 seul
set -euo pipefail

MODE="${1:-all}"

free_one() {
  local port="$1"
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  fi
  if [[ -z "$pids" ]] && command -v fuser >/dev/null 2>&1; then
    pids="$(fuser "${port}/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true)"
  fi
  if [[ -z "$pids" ]]; then
    echo "  :$port — libre"
    return 0
  fi
  echo "  :$port — kill $pids"
  for pid in $pids; do
    if [[ -r "/proc/$pid/cmdline" ]]; then
      echo "    $(tr '\0' ' ' <"/proc/$pid/cmdline" | cut -c1-100)"
    fi
    kill "$pid" 2>/dev/null || true
  done
  sleep 0.4
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
  fuser -k "${port}/tcp" 2>/dev/null || true
}

echo "==> kill-dev ($MODE)"
case "$MODE" in
  vite-only)
    free_one 5173
    free_one 5174
    pkill -f "vite.*(PLM|web)" 2>/dev/null || true
    echo "✅ Ports Vite 5173/5174 libérés (API intacte)"
    ;;
  api-only)
    free_one 8787
    pkill -f "tsx watch src/index.ts" 2>/dev/null || true
    pkill -f "tsx api/src/index.ts" 2>/dev/null || true
    echo "✅ Port API 8787 libéré"
    ;;
  *)
    free_one 5173
    free_one 5174
    free_one 8787
    pkill -f "tsx watch src/index.ts" 2>/dev/null || true
    pkill -f "tsx api/src/index.ts" 2>/dev/null || true
    pkill -f "vite.*(PLM|web)" 2>/dev/null || true
    echo "✅ Ports 5173 / 5174 / 8787 libérés"
    ;;
esac
