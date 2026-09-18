#!/usr/bin/env bash
# Restaure volume + désactive Ne pas déranger après tests nuit.
# Usage: bash scripts/qa/restore-dnd-after-qa.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RESTORE="$ROOT/tmp/endurance-20260917/dnd-restore.txt"

restore_one() {
  local d="$1" zen="${2:-0}"
  adb -s "$d" get-state >/dev/null 2>&1 || { echo "skip $d offline"; return; }
  adb -s "$d" shell settings put global zen_mode "$zen" >/dev/null 2>&1 || true
  # Volume musique raisonnable (pas max)
  adb -s "$d" shell cmd media_session volume --stream 3 --set 8 >/dev/null 2>&1 || true
  echo "restored $d zen=$zen vol_music=8"
}

if [[ -f "$RESTORE" ]]; then
  while IFS='|' read -r d zen vol; do
    [[ -z "${d:-}" || "$d" == dnd* ]] && continue
    restore_one "$d" "${zen:-0}"
  done < <(grep -E '^[A-Za-z0-9.:|_-]+\|' "$RESTORE" || true)
else
  restore_one R5CT7263YJL 0
  restore_one 192.168.1.44:5555 0
fi
echo "OK — DND off. Tu peux remonter le volume à la main si besoin."
