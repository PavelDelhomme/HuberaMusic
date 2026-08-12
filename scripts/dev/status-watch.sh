#!/usr/bin/env bash
# Boucle make status — INTERVAL=4 par défaut (secondes)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INTERVAL="${INTERVAL:-4}"
CLEAR="${CLEAR:-1}"

cleanup() { printf '\033[?25h'; exit 0; }
trap cleanup INT TERM

printf '\033[?25l'
while true; do
  if [[ "$CLEAR" == "1" ]]; then clear; fi
  echo "PLM status-watch · toutes les ${INTERVAL}s · Ctrl+C pour quitter"
  echo "────────────────────────────────────────────────────────"
  make -C "$ROOT" status || true
  sleep "$INTERVAL"
done
