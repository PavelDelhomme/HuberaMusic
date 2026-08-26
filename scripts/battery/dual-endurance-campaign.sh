#!/usr/bin/env bash
# Lance endurance ~90 min Blackview + Samsung en parallèle (son coupé, métriques).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$ROOT/logs/endurance/campaign-$STAMP"
mkdir -p "$OUT"

BV="${DEVICE_BV:-192.168.1.12:5555}"
SAM="${DEVICE_SAM:-192.168.1.184:5555}"
DURATION_MIN="${DURATION_MIN:-90}"
SAMPLE_SECS="${SAMPLE_SECS:-30}"
PKG="${PKG:-ovh.delhomme.ytmusic}"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$OUT/campaign.log"; }

mute_device() {
  local d="$1"
  adb -s "$d" shell settings put system volume_music_speaker 0 2>/dev/null || true
  adb -s "$d" shell cmd media_session volume --stream 3 --set 0 2>/dev/null || true
}

log "Campaign $STAMP — ${DURATION_MIN} min · pkg=$PKG"
log "Blackview=$BV · Samsung=$SAM · OUT=$OUT"

for d in "$BV" "$SAM"; do
  mute_device "$d"
  adb -s "$d" shell dumpsys battery 2>/dev/null | rg 'level:|USB powered|AC powered|status:' | head -4 | tee -a "$OUT/campaign.log" || true
done

run_one() {
  local dev="$1" name="$2"
  log "start $name ($dev)" >&2
  setsid env DEVICE="$dev" PKG="$PKG" DURATION_MIN="$DURATION_MIN" SAMPLE_SECS="$SAMPLE_SECS" \
    MAPS_STRESS=0 \
    python3 -u "$ROOT/scripts/android/prod-endurance-1h.py" >"$OUT/${name}.log" 2>&1 &
  local pid=$!
  echo "$pid" >"$OUT/${name}.pid"
  echo "$pid"
}

PID_BV=$(run_one "$BV" "blackview")
PID_SAM=$(run_one "$SAM" "samsung")
log "pids blackview=$PID_BV samsung=$PID_SAM"

# Superviseur : résumé toutes les 5 min + alertes
(
  while kill -0 "$PID_BV" 2>/dev/null || kill -0 "$PID_SAM" 2>/dev/null; do
    sleep 300
    {
      echo "--- $(date +%H:%M:%S) snapshot ---"
      for pair in "$BV:blackview" "$SAM:samsung"; do
        d="${pair%%:*}"; n="${pair##*:}"
        echo "[$n $d]"
        adb -s "$d" shell dumpsys battery 2>/dev/null | rg 'level:|temperature:|USB powered' | head -3 || true
        adb -s "$d" shell dumpsys meminfo "$PKG" 2>/dev/null | rg 'TOTAL PSS|Native Heap|Java Heap' | head -3 || true
        tail -3 "$OUT/${n}.log" 2>/dev/null || true
        rg -c 'STUCK|TRANS |PlaybackException|FATAL' "$OUT/${n}.log" 2>/dev/null | head -5 || true
      done
    } >>"$OUT/supervisor.log"
  done
  echo "[$(date +%H:%M:%S)] supervisor: both processes ended" >>"$OUT/supervisor.log"
) &
echo $! >"$OUT/supervisor.pid"

log "Running… tail -f $OUT/blackview.log $OUT/samsung.log"
wait "$PID_BV" 2>/dev/null; ec_bv=$? || ec_bv=$?
wait "$PID_SAM" 2>/dev/null; ec_sam=$? || ec_sam=$?
log "DONE exit blackview=$ec_bv samsung=$ec_sam"
echo "$OUT" >"$ROOT/logs/endurance/latest-campaign.txt"
ln -sfn "$OUT" "$ROOT/logs/endurance/latest-campaign" 2>/dev/null || true

# Synthèse rapide
python3 - <<PY
import json, re
from pathlib import Path
out = Path("$OUT")
for name in ("blackview", "samsung"):
    log = out / f"{name}.log"
    reports = sorted(Path("$ROOT/logs/endurance").glob("*"), key=lambda p: p.stat().st_mtime, reverse=True)
    rep = None
    for r in reports:
        if r.is_dir() and name.replace("blackview","192_168_1_12_5555").replace("samsung","192_168_1_184_5555") in r.name or True:
            rp = r / "report.json"
            if rp.exists() and name in (r / "live.log").read_text()[:200] if (r/"live.log").exists() else False:
                rep = rp
                break
    # find report from log line
    if log.exists():
        m = re.search(r'report=(\S+report\.json)', log.read_text()[-8000:])
        if m:
            rep = Path(m.group(1))
    print(f"=== {name} ===")
    if rep and rep.exists():
        d = json.loads(rep.read_text())
        print(f"  ok={d.get('ok')} transitions={d.get('transitions')} exo={d.get('exoErrors')} stuck={len(d.get('stuckEvents') or [])}")
        print(f"  memPeak={d.get('memPeakPssKb')}KB memAvg={d.get('memAvgPssKb')}KB")
        print(f"  battery={d.get('battery')}")
    else:
        stuck = len(re.findall(r'STUCK', log.read_text())) if log.exists() else 0
        trans = len(re.findall(r'TRANS #', log.read_text())) if log.exists() else 0
        print(f"  (report pending) trans~{trans} stuck~{stuck}")
PY

log "Rapports individuels dans logs/endurance/*/report.json"
