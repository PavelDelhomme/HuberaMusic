#!/usr/bin/env bash
# Stress + batterie mobile (DEV Samsung / PROD Nothing).
# Usage:
#   DEVICE=R5CT7263YJL bash scripts/android/mobile-stress-battery.sh
#   DEVICE=00145153K001434 API_BASE_URL=https://ytmusic.delhomme.ovh bash scripts/android/mobile-stress-battery.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ADB="${ADB_BIN:-adb}"
DEVICE="${DEVICE:-${ANDROID_SERIAL:-$($ADB devices | awk '/\tdevice$/{print $1; exit}')}}"
PKG=ovh.delhomme.ytmusic
REPORT_DIR=/tmp/ytmusic-stress-battery
mkdir -p "$REPORT_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
REPORT="$REPORT_DIR/report-$DEVICE-$STAMP.txt"
: >"$REPORT"
log() { echo "$*" | tee -a "$REPORT"; }

if [[ -z "${DEVICE:-}" ]]; then
  echo "FAIL aucun device" >&2
  exit 1
fi

adb() { command "$ADB" -s "$DEVICE" "$@"; }

uid="$(adb shell dumpsys package "$PKG" 2>/dev/null | awk '/userId=/{print $1; exit}' | sed 's/userId=//' || true)"
log "==> device=$DEVICE uid=${uid:-?} report=$REPORT"

# Baseline batterie
adb shell dumpsys batterystats --reset >/dev/null 2>&1 || true
LEVEL0="$(adb shell dumpsys battery 2>/dev/null | awk -F': ' '/level:/{print $2; exit}' | tr -d '\r')"
TEMP0="$(adb shell dumpsys battery 2>/dev/null | awk -F': ' '/temperature:/{print $2; exit}' | tr -d '\r')"
log "battery_start level=${LEVEL0:-?} temp_raw=${TEMP0:-?} (dizièmes °C)"

MEM0="$(adb shell dumpsys meminfo "$PKG" 2>/dev/null | awk '/TOTAL PSS|TOTAL:/ {print; exit}' | tr -d '\r')"
log "mem_start: ${MEM0:-?}"

adb shell am force-stop "$PKG" || true
adb logcat -c
adb shell am start -n "$PKG/.MainActivity" >/dev/null
sleep 3

# Inject session si possible
if [[ -f "$ROOT/scripts/adb/adb-login.sh" ]]; then
  DEVICE="$DEVICE" API_BASE_URL="${API_BASE_URL:-}" bash "$ROOT/scripts/adb/adb-login.sh" >>"$REPORT" 2>&1 || true
  sleep 2
fi

dump_ui() {
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || true
  adb pull /sdcard/ui.xml "$REPORT_DIR/ui-$DEVICE.xml" >/dev/null 2>&1 || true
}

tap_label() {
  local needle="$1"
  DEVICE="$DEVICE" REPORT_DIR="$REPORT_DIR" python3 - <<'PY' "$needle" || return 1
import re, sys, subprocess, os
needle = sys.argv[1].lower()
path = os.path.join(os.environ["REPORT_DIR"], f"ui-{os.environ['DEVICE']}.xml")
xml = open(path, encoding="utf-8", errors="ignore").read()
cands = []
for m in re.finditer(
    r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
    xml,
):
    label, x1, y1, x2, y2 = m.group(1), *map(int, m.groups()[1:])
    if needle in label.lower():
        cands.append((len(label), (x1 + x2) // 2, (y1 + y2) // 2, label))
if not cands:
    sys.exit(1)
cands.sort(key=lambda t: t[0])
_, x, y, lab = cands[0]
print(f"TAP {lab!r} @ {x},{y}", flush=True)
subprocess.check_call(["adb", "-s", os.environ["DEVICE"], "shell", "input", "tap", str(x), str(y)])
PY
}

log "==> Stress 1 : lecture + skips rapides (12×)"
dump_ui
tap_label "Aléatoire" || tap_label "Welcome" || true
sleep 4
for i in $(seq 1 12); do
  adb shell input keyevent 87 >/dev/null 2>&1 || true  # MEDIA_NEXT
  sleep 0.55
done
sleep 2
FATALS="$(adb logcat -d 2>/dev/null | grep -cE "FATAL EXCEPTION.*$PKG|AndroidRuntime.*Fatal" || true)"
STREAM_OK="$(adb logcat -d 2>/dev/null | grep -cE 'isPlaying:true|STATE_PLAYING|←-- 200 .*/api/stream' || true)"
STREAM_BAD="$(adb logcat -d 2>/dev/null | grep -cE 'PlaybackException|Source error|←-- 502 .*/api/stream' || true)"
log "after_skips fatals=$FATALS stream_ok_lines=$STREAM_OK stream_bad=$STREAM_BAD"

log "==> Stress 2 : ouverture file / now playing (taps UI)"
dump_ui
# Ouvre éventuel mini-lecteur / file
adb shell input swipe 540 2000 540 800 300 >/dev/null 2>&1 || true
sleep 1
adb shell input swipe 540 400 540 1600 300 >/dev/null 2>&1 || true
sleep 1
for i in $(seq 1 8); do
  adb shell input keyevent 85 >/dev/null 2>&1 || true # MEDIA_PLAY_PAUSE
  sleep 0.35
  adb shell input keyevent 85 >/dev/null 2>&1 || true
  sleep 0.25
done

log "==> Stress 3 : sauts MEDIA_PREV/NEXT en rafale"
for i in $(seq 1 20); do
  if (( i % 2 == 0 )); then
    adb shell input keyevent 87 >/dev/null 2>&1 || true
  else
    adb shell input keyevent 88 >/dev/null 2>&1 || true
  fi
  sleep 0.28
done
sleep 3
FATALS2="$(adb logcat -d 2>/dev/null | grep -cE "FATAL EXCEPTION.*$PKG" || true)"
log "after_burst fatals=$FATALS2"

log "==> Stress 4 : offline soft 6s"
adb shell svc wifi disable >/dev/null 2>&1 || true
adb shell svc data disable >/dev/null 2>&1 || true
sleep 6
OFF_FATAL="$(adb logcat -d -t 40 2>/dev/null | grep -cE "FATAL EXCEPTION.*$PKG" || true)"
adb shell svc wifi enable >/dev/null 2>&1 || true
adb shell svc data enable >/dev/null 2>&1 || true
sleep 3
log "offline_fatals=$OFF_FATAL"

LEVEL1="$(adb shell dumpsys battery 2>/dev/null | awk -F': ' '/level:/{print $2; exit}' | tr -d '\r')"
TEMP1="$(adb shell dumpsys battery 2>/dev/null | awk -F': ' '/temperature:/{print $2; exit}' | tr -d '\r')"
MEM1="$(adb shell dumpsys meminfo "$PKG" 2>/dev/null | awk '/TOTAL PSS|TOTAL:/ {print; exit}' | tr -d '\r')"
log "battery_end level=${LEVEL1:-?} temp_raw=${TEMP1:-?}"
log "mem_end: ${MEM1:-?}"

log "==> WakeLocks / CPU (échantillon)"
adb shell dumpsys power 2>/dev/null | grep -i "$PKG\|WakeLock" | head -12 | tee -a "$REPORT" || true
if [[ -n "${uid:-}" ]]; then
  adb shell dumpsys batterystats 2>/dev/null | grep -A2 "uid $uid\|Uid $uid" | head -20 | tee -a "$REPORT" || true
fi

log ""
log "==== VERDICT ===="
ok=1
[[ "${FATALS:-0}" == "0" && "${FATALS2:-0}" == "0" && "${OFF_FATAL:-0}" == "0" ]] || ok=0
[[ "${STREAM_BAD:-0}" -lt 5 ]] || ok=0
if [[ "$ok" == 1 ]]; then
  log "OK — pas de crash ; skips/burst/offline soft tenus (voir détails ci-dessus)"
else
  log "WARN — anomalies (fatals ou nombreux 502) — lire $REPORT"
fi
log "Rapport: $REPORT"
