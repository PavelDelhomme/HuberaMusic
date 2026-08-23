#!/usr/bin/env bash
# Test lecture + skip + seek sur device ADB (prod APK).
# Usage: DEVICE=192.168.1.184:5555 bash scripts/test/mobile-playback-qa.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PKG=ovh.delhomme.ytmusic
DEVICE="${DEVICE:-}"
ADB=adb
REPORT="${REPORT:-/tmp/ytmusic-mobile-qa-$(date +%Y%m%d-%H%M%S).txt}"

if [[ -z "$DEVICE" ]]; then
  DEVICE="$($ADB devices | awk '/\tdevice$/{print $1; exit}')"
fi
[[ -n "$DEVICE" ]] || { echo "FAIL aucun device"; exit 1; }

adb() { $ADB -s "$DEVICE" "$@"; }

log() { echo "$*" | tee -a "$REPORT"; }
: >"$REPORT"

log "==> Mobile playback QA device=$DEVICE"
VER="$(adb shell dumpsys package "$PKG" 2>/dev/null | grep versionName | head -1 | tr -d ' \r' || true)"
log "${VER:-versionName=?}"

adb shell am force-stop "$PKG" || true
adb logcat -c
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 4

# Play via media key
adb shell cmd media_session dispatch play 2>/dev/null || true
sleep 5

media_info() {
  adb shell dumpsys media_session 2>/dev/null | python3 -c "
import sys,re
pkg='$PKG'
t=sys.stdin.read()
m=re.search(r'package='+re.escape(pkg)+r'.*?state=PlaybackState \{state=(\d+).*?position=(\d+)', t, re.S)
if not m: print('NONE 0'); sys.exit(0)
states={3:'PLAYING',2:'PAUSED',6:'BUFFERING',7:'ERROR'}
print(states.get(int(m.group(1)), m.group(1)), m.group(2))
" 2>/dev/null || echo "NONE 0"
}

read -r STATE POS < <(media_info)
log "initial: state=$STATE pos=$POS"

FAIL=0
if [[ "$STATE" != "PLAYING" && "$STATE" != "BUFFERING" ]]; then
  log "WARN pas en lecture — tente play x2"
  adb shell cmd media_session dispatch play
  sleep 6
  read -r STATE POS < <(media_info)
fi

if [[ "$STATE" == "PLAYING" || "$STATE" == "BUFFERING" ]]; then
  log "OK  lecture active pos=$POS"
else
  log "FAIL pas de lecture (state=$STATE) — connecte-toi dans l'app"
  FAIL=1
fi

# Skip next x2
for n in 1 2; do
  adb shell cmd media_session dispatch next
  sleep 4
  read -r STATE POS < <(media_info)
  log "skip$n: state=$STATE pos=$POS"
  if [[ "$STATE" != "PLAYING" && "$STATE" != "BUFFERING" ]]; then
    log "FAIL skip $n"
    FAIL=1
  fi
done

# Attente progression
sleep 15
read -r STATE POS2 < <(media_info)
log "after 15s: state=$STATE pos=$POS2"
if [[ "$POS2" -gt "$((POS + 3000))" ]] || [[ "$STATE" == "PLAYING" ]]; then
  log "OK  progression temporelle"
else
  log "WARN progression faible ($POS → $POS2)"
fi

# Erreurs logcat
adb logcat -d -t 200 > /tmp/ytm-qa-log.txt 2>/dev/null || true
ERRS="$(grep -cE 'onPlayerError|PlaybackException|←-- 502.*stream|←-- 503.*stream' /tmp/ytm-qa-log.txt 2>/dev/null || echo 0)"
log "errors logcat: $ERRS"
if [[ "$ERRS" -gt 0 ]]; then
  grep -E 'onPlayerError|PlaybackException|stream/' /tmp/ytm-qa-log.txt | tail -10 >>"$REPORT"
  log "FAIL erreurs lecteur détectées"
  FAIL=1
else
  log "OK  pas d'erreur stream/lecteur"
fi

log "Rapport: $REPORT"
exit "$FAIL"
