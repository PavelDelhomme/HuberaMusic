#!/usr/bin/env bash
# Endurance Aléatoire Blackview — ~5 h, sessions 30–40 min, muet.
# Usage:
#   DEVICE=EEA9700PRO0014587 bash scripts/qa/blackview-shuffle-endurance-5h.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
[[ -f .env ]] && set -a && # shellcheck disable=SC1091
source .env && set +a || true

DEVICE="${DEVICE:-EEA9700PRO0014587}"
PKG="${PKG:-ovh.delhomme.ytmusic}"
API="${API_BASE_URL:-https://ytmusic.delhomme.ovh}"
TOTAL_MIN="${TOTAL_MIN:-300}"          # 5 h
SESSION_MIN="${SESSION_MIN:-35}"       # 30–40 min
SKIP_EVERY_SECS="${SKIP_EVERY_SECS:-28}"  # avance loin dans la file
RESHUFFLE_EVERY_SECS="${RESHUFFLE_EVERY_SECS:-420}"
SAMPLE_SECS="${SAMPLE_SECS:-12}"
SLOW_BUFFER_MS="${SLOW_BUFFER_MS:-3500}"
PAUSE_BETWEEN_SECS="${PAUSE_BETWEEN_SECS:-45}"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$ROOT/logs/endurance/bv-5h-$STAMP"
mkdir -p "$OUT"
MASTER="$OUT/master.log"
AGG="$OUT/aggregate.json"

log() { echo "$(date +%H:%M:%S) $*" | tee -a "$MASTER"; }

# Token API pour diag stream
TOKEN=""
if [[ -n "${SEED_EMAIL:-}" && -n "${SEED_PASSWORD:-}" ]]; then
  TOKEN="$(
    node --env-file=.env -e '
      const e=process.env.SEED_EMAIL,p=process.env.SEED_PASSWORD,a=process.env.API||"'"$API"'";
      fetch(a.replace(/\/$/,"")+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:e,password:p})})
        .then(r=>r.json()).then(j=>{if(j.token) process.stdout.write(j.token); else process.exit(2);})
        .catch(()=>process.exit(2));
    ' 2>/dev/null || true
  )"
fi

log "START Blackview endurance device=$DEVICE total=${TOTAL_MIN}m session=${SESSION_MIN}m out=$OUT"
log "mute + ensure pkg=$PKG"

adb -s "$DEVICE" shell settings put system volume_music_speaker 0 >/dev/null 2>&1 || true
adb -s "$DEVICE" shell cmd media_session volume --stream 3 --set 0 >/dev/null 2>&1 || true
adb -s "$DEVICE" shell media volume --stream 3 --set 0 >/dev/null 2>&1 || true

VER="$(adb -s "$DEVICE" shell dumpsys package "$PKG" 2>/dev/null | awk -F= '/versionName=/{print $2; exit}')"
log "installed versionName=$VER"

t0="$(date +%s)"
end=$((t0 + TOTAL_MIN * 60))
session_i=0
reports=()

while (( $(date +%s) < end )); do
  session_i=$((session_i + 1))
  left=$(( (end - $(date +%s)) / 60 ))
  dur="$SESSION_MIN"
  if (( left < SESSION_MIN )); then
    dur="$left"
  fi
  if (( dur < 8 )); then
    log "STOP remaining=${left}m too short"
    break
  fi
  log "======== SESSION $session_i duration=${dur}m remaining≈${left}m ========"
  set +e
  DEVICE="$DEVICE" PKG="$PKG" API_BASE_URL="$API" API_TOKEN="$TOKEN" \
    DURATION_MIN="$dur" SKIP_EVERY_SECS="$SKIP_EVERY_SECS" \
    RESHUFFLE_EVERY_SECS="$RESHUFFLE_EVERY_SECS" SAMPLE_SECS="$SAMPLE_SECS" \
    SLOW_BUFFER_MS="$SLOW_BUFFER_MS" \
    python3 -u "$ROOT/scripts/android/prod-library-shuffle-stress.py" \
    2>&1 | tee -a "$MASTER"
  rc=${PIPESTATUS[0]}
  set -e
  # Copie dernier report.json
  last="$(ls -1dt "$ROOT"/logs/endurance/libshuffle-*-* 2>/dev/null | head -1 || true)"
  if [[ -n "$last" && -f "$last/report.json" ]]; then
    cp "$last/report.json" "$OUT/session-${session_i}.json"
    reports+=("$OUT/session-${session_i}.json")
    log "session $session_i report → $OUT/session-${session_i}.json rc=$rc"
  else
    log "session $session_i WARN no report.json rc=$rc"
  fi
  if (( $(date +%s) + PAUSE_BETWEEN_SECS < end )); then
    log "pause ${PAUSE_BETWEEN_SECS}s entre sessions"
    sleep "$PAUSE_BETWEEN_SECS"
  fi
done

# Agrégat
python3 - <<PY | tee -a "$MASTER"
import json, glob, os
from pathlib import Path
out = Path("$OUT")
sessions = sorted(out.glob("session-*.json"))
slow = []
errs = 0
unique = set()
skips = 0
trans = 0
for p in sessions:
    d = json.loads(p.read_text())
    skips += d.get("skips") or 0
    trans += d.get("transitions") or 0
    errs += d.get("errorCount") or 0
    for t in d.get("uniqueTitles") or []:
        unique.add(t)
    # slow_buffer from sibling errors.jsonl if present
agg = {
  "sessions": len(sessions),
  "skips": skips,
  "transitions": trans,
  "uniqueTitles": len(unique),
  "errorCountSum": errs,
  "sessionFiles": [str(p.name) for p in sessions],
  "titlesSample": sorted(unique)[:40],
}
# Parse master for SLOW_BUFFER
slow_n = 0
ready = []
for line in Path("$MASTER").read_text(errors="replace").splitlines():
    if "SLOW_BUFFER" in line:
        slow_n += 1
    if "SKIP_OK" in line or "SLOW_BUFFER" in line:
        import re
        m = re.search(r"(\\d+)ms", line)
        if m:
            ready.append(int(m.group(1)))
agg["slowBufferEvents"] = slow_n
if ready:
    ready.sort()
    agg["readyMs"] = {
        "n": len(ready),
        "p50": ready[len(ready)//2],
        "p95": ready[min(len(ready)-1, int(len(ready)*0.95))],
        "max": ready[-1],
        "avg": int(sum(ready)/len(ready)),
    }
Path("$AGG").write_text(json.dumps(agg, ensure_ascii=False, indent=2))
print(json.dumps(agg, ensure_ascii=False, indent=2))
PY

log "DONE aggregate=$AGG"
