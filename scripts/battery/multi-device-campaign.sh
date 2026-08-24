#!/usr/bin/env bash
# Campagne parallèle : batterie+perf (Samsung + Nothing débranchés) + smoke Blackview.
#
# Usage :
#   bash scripts/battery/multi-device-campaign.sh
#   DURATION_MIN=30 bash scripts/battery/multi-device-campaign.sh
#
# Sorties :
#   logs/campaigns/<stamp>/{samsung,nothing}/report.json + live.log
#   docs/reports/dual-smoke-* (Blackview)
#   logs/campaigns/<stamp>/CAMPAIGN.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ADB="${ADB_BIN:-adb}"
STAMP="${CAMPAIGN_STAMP:-$(date +%Y%m%d-%H%M%S)}"
OUT="$ROOT/logs/campaigns/$STAMP"
DURATION_MIN="${DURATION_MIN:-20}"
SAMPLE_SECS="${SAMPLE_SECS:-30}"

SAM="${DEVICE_SAM:-192.168.1.184:5555}"
NOTHING="${DEVICE_NOTHING:-}"
BV="${DEVICE_BV:-192.168.1.12:5555}"

mkdir -p "$OUT"
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$OUT/campaign.log"; }

# Résout Nothing (port Wi‑Fi dynamique)
if [[ -z "$NOTHING" ]]; then
  NOTHING="$("$ADB" devices -l | awk '/model:A059|Asteroids/{print $1; exit}')"
fi
[[ -n "$NOTHING" ]] || { log "❌ Nothing absent — make adb-wifi-ensure"; exit 1; }

log "═══ Campagne $STAMP — endurance ${DURATION_MIN}min (Samsung + Nothing) + smoke Blackview ═══"
log "Samsung=$SAM Nothing=$NOTHING Blackview=$BV"

snapshot_device() {
  local serial="$1" label="$2" dir="$OUT/baseline"
  mkdir -p "$dir"
  {
    echo "label=$label"
    echo "serial=$serial"
    echo "model=$("$ADB" -s "$serial" shell getprop ro.product.model 2>/dev/null | tr -d '\r')"
    echo "pkg_prod=$("$ADB" -s "$serial" shell dumpsys package ovh.delhomme.ytmusic 2>/dev/null | awk '/versionName/{print; exit}')"
    echo "battery:"
    "$ADB" -s "$serial" shell dumpsys battery 2>/dev/null | grep -E 'level:|USB powered:|AC powered:|temperature:' | head -6
    echo "meminfo:"
    "$ADB" -s "$serial" shell dumpsys meminfo ovh.delhomme.ytmusic 2>/dev/null | awk '/TOTAL PSS/{print; exit}'
  } >"$dir/${label}.txt" 2>&1 || true
}

for pair in "Samsung:$SAM" "Nothing:$NOTHING" "Blackview:$BV"; do
  snapshot_device "${pair#*:}" "${pair%%:*}"
done

for pair in "Samsung:$SAM" "Nothing:$NOTHING"; do
  serial="${pair#*:}"
  usb="$("$ADB" -s "$serial" shell dumpsys battery 2>/dev/null | awk -F': ' '/USB powered:/{print $2; exit}' | tr -d ' \r')"
  ac="$("$ADB" -s "$serial" shell dumpsys battery 2>/dev/null | awk -F': ' '/AC powered:/{print $2; exit}' | tr -d ' \r')"
  if [[ "$usb" != "false" || "$ac" != "false" ]]; then
    log "⚠️  ${pair%%:*} encore en charge (usb=$usb ac=$ac) — mesures batterie biaisées"
  fi
done

run_endurance() {
  local serial="$1" name="$2"
  local dir="$OUT/${name,,}"
  mkdir -p "$dir"
  log "▶ endurance $name ($serial) ${DURATION_MIN}min"
  setsid env DEVICE="$serial" DURATION_MIN="$DURATION_MIN" SAMPLE_SECS="$SAMPLE_SECS" MAPS_STRESS=0 \
    python3 -u "$ROOT/scripts/android/prod-endurance-1h.py" \
    >"$dir/live.log" 2>&1 &
  echo $! >"$dir/pid"
  log "  pid=$(cat "$dir/pid") log=$dir/live.log"
}

run_endurance "$SAM" "Samsung"
run_endurance "$NOTHING" "Nothing"

log "▶ smoke Blackview ($BV)"
(
  cd "$ROOT"
  DEVICE_BV="$BV" BLACKVIEW_ONLY=1 PKG_BV=ovh.delhomme.ytmusic TRACKS=5 LISTEN_S=15 \
    python3 -u scripts/android/dual-device-smoke.py >"$OUT/blackview-smoke.log" 2>&1
  echo $? >"$OUT/blackview-smoke.exit"
) &
echo $! >"$OUT/blackview-smoke.pid"

log "Attente fin Blackview (~3–8 min) puis endurance (~${DURATION_MIN} min)…"

wait "$(cat "$OUT/blackview-smoke.pid" 2>/dev/null)" 2>/dev/null || true
bv_exit="$(cat "$OUT/blackview-smoke.exit" 2>/dev/null || echo '?')"
log "Blackview smoke terminé exit=$bv_exit"

deadline=$(( $(date +%s) + DURATION_MIN * 60 + 600 ))
while [[ $(date +%s) -lt $deadline ]]; do
  sam_alive=false; not_alive=false
  kill -0 "$(cat "$OUT/samsung/pid" 2>/dev/null)" 2>/dev/null && sam_alive=true
  kill -0 "$(cat "$OUT/nothing/pid" 2>/dev/null)" 2>/dev/null && not_alive=true
  if ! $sam_alive && ! $not_alive; then break; fi
  sleep 30
done
log "Endurance Samsung + Nothing terminée"

# Copie les derniers report.json vers le dossier campagne
python3 - "$OUT" "$SAM" "$NOTHING" "$DURATION_MIN" "$bv_exit" <<'PY'
import json, shutil, sys
from pathlib import Path

out = Path(sys.argv[1])
sam, nothing, dur, bv_exit = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
endurance_root = out.parents[1] / "endurance"

def latest_for(serial: str) -> Path | None:
    hits = []
    for p in endurance_root.glob("*/report.json"):
        try:
            r = json.loads(p.read_text())
            if r.get("device") == serial:
                hits.append((p.stat().st_mtime, p))
        except Exception:
            pass
    if not hits:
        return None
    return max(hits, key=lambda x: x[0])[1]

paths = {}
for label, serial in [("Samsung", sam), ("Nothing", nothing)]:
    p = latest_for(serial)
    if p:
        dest = out / f"{label.lower()}-report.json"
        shutil.copy2(p, dest)
        paths[label] = str(p)
        (out / f"{label.lower()}-report.path").write_text(str(p))

lines = [
    f"# Campagne batterie/perf — {out.name}",
    "",
    f"- Durée endurance : **{dur} min** / appareil",
    f"- Samsung : `{sam}`",
    f"- Nothing : `{nothing}`",
    f"- Blackview smoke exit : `{bv_exit}`",
    "",
    "## Baseline",
    "",
]
for f in sorted((out / "baseline").glob("*.txt")):
    lines.append(f"### {f.stem}")
    lines.append("```")
    lines.append(f.read_text(encoding="utf-8", errors="replace").strip()[:1200])
    lines.append("```")
    lines.append("")

lines += ["## Endurance (mémoire / CPU / batterie UID)", ""]

for label, serial in [("Samsung", sam), ("Nothing", nothing)]:
    p = latest_for(serial)
    lines.append(f"### {label}")
    if not p:
        lines.append("(rapport non trouvé)")
        lines.append("")
        continue
    r = json.loads(p.read_text())
    lines.append(f"- Rapport : `{p}`")
    lines.append(f"- OK : **{r.get('ok')}** · transitions : {r.get('transitions')}")
    lines.append(f"- PSS pic : **{r.get('memPeakPssKb')} KB** · PSS moy : **{r.get('memAvgPssKb')} KB**")
    if r.get("batteryCsv"):
        lines.append(f"- battery.csv : `{r.get('batteryCsv')}`")
    batt = r.get("battery") or {}
    if batt.get("cpuMah"):
        lines.append(f"- CPU batterystats : {batt.get('cpuMah')} mAh")
    lines.append(f"- Exo errors logcat : {r.get('exoErrors', 0)}")
    lines.append("")

(out / "CAMPAIGN.md").write_text("\n".join(lines), encoding="utf-8")
print("Wrote", out / "CAMPAIGN.md")
PY

log "✅ Rapport → $OUT/CAMPAIGN.md"
head -80 "$OUT/CAMPAIGN.md"
