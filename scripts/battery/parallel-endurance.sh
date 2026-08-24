#!/usr/bin/env bash
# Endurance parallèle Samsung + Nothing (setsid parent persistant).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAMP="${1:-$(date +%Y%m%d-%H%M%S)}"
DURATION_MIN="${DURATION_MIN:-20}"
SAMPLE_SECS="${SAMPLE_SECS:-30}"
SAM="${DEVICE_SAM:-192.168.1.184:5555}"
NOTHING="${DEVICE_NOTHING:-}"
OUT="$ROOT/logs/campaigns/${STAMP}-parallel"
mkdir -p "$OUT"

if [[ -z "$NOTHING" ]]; then
  NOTHING="$(adb devices -l | awk '/model:A059|Asteroids/{print $1; exit}')"
fi
[[ -n "$NOTHING" ]] || { echo "Nothing absent"; exit 1; }

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$OUT/run.log"; }

run_one() {
  local serial="$1" name="$2"
  log "start $name $serial"
  setsid env DEVICE="$serial" DURATION_MIN="$DURATION_MIN" SAMPLE_SECS="$SAMPLE_SECS" MAPS_STRESS="${MAPS_STRESS:-0}" \
    python3 -u "$ROOT/scripts/android/prod-endurance-1h.py" >"$OUT/${name}.log" 2>&1 &
  echo $!
}

PID_SAM=$(run_one "$SAM" "samsung")
PID_NOT=$(run_one "$NOTHING" "nothing")
log "pids samsung=$PID_SAM nothing=$PID_NOT duration=${DURATION_MIN}min"

wait "$PID_SAM" || log "samsung exit=$?"
wait "$PID_NOT" || log "nothing exit=$?"
log "done → $OUT"
