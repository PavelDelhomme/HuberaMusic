#!/usr/bin/env bash
# Audit léger batterie / offline Android via ADB (pas une mesure labo, un sanity check).
# Usage:
#   DEVICE=R5CT7263YJL bash scripts/android/android-battery-offline-check.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ADB="${ADB_BIN:-adb}"
DEVICE="${DEVICE:-$($ADB devices | awk '/\tdevice$/{print $1; exit}')}"
PKG=ovh.delhomme.ytmusic

if [[ -z "${DEVICE:-}" ]]; then
  echo "FAIL aucun device ADB" >&2
  exit 1
fi

echo "==> device=$DEVICE"
$ADB -s "$DEVICE" shell dumpsys batterystats --reset >/dev/null 2>&1 || true
sleep 1

uid="$($ADB -s "$DEVICE" shell dumpsys package "$PKG" 2>/dev/null | awk '/userId=/{print $1; exit}' | sed 's/userId=//')"
echo "==> uid=${uid:-?}"

echo "==> État réseau actuel"
$ADB -s "$DEVICE" shell dumpsys connectivity 2>/dev/null | grep -E 'NetworkAgentInfo|CONNECTED|VALIDATED' | head -8 || true

echo "==> Process app"
$ADB -s "$DEVICE" shell dumpsys activity processes 2>/dev/null | grep -F "$PKG" | head -5 || true

echo "==> Batterie / charge"
$ADB -s "$DEVICE" shell dumpsys battery 2>/dev/null | grep -E 'level|status|plugged|temperature' | head -10

echo "==> Wake locks (app)"
$ADB -s "$DEVICE" shell dumpsys power 2>/dev/null | grep -i "$PKG\|WakeLock" | head -15 || true

echo "==> Jobs / alarmes (échantillon)"
$ADB -s "$DEVICE" shell dumpsys jobscheduler 2>/dev/null | grep -F "$PKG" | head -10 || true
$ADB -s "$DEVICE" shell dumpsys alarm 2>/dev/null | grep -F "$PKG" | head -10 || true

echo "==> Mémoire"
$ADB -s "$DEVICE" shell dumpsys meminfo "$PKG" 2>/dev/null | head -25 || true

echo "==> Test offline soft : désactive Wi‑Fi data 8s puis réactive"
wifi_was="$($ADB -s "$DEVICE" shell settings get global wifi_on 2>/dev/null | tr -d '\r' || echo 1)"
$ADB -s "$DEVICE" shell svc wifi disable >/dev/null 2>&1 || true
$ADB -s "$DEVICE" shell svc data disable >/dev/null 2>&1 || true
sleep 3
echo "    offline dump connectivity:"
$ADB -s "$DEVICE" shell dumpsys connectivity 2>/dev/null | grep -E 'NetworkAgentInfo|CONNECTED' | head -4 || echo "    (pas de réseau VALIDATED — attendu)"
# Relance UI pour observer (pas de crash)
$ADB -s "$DEVICE" shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1 || true
sleep 2
# Pas de spam "FATAL" dans logcat pendant offline
fatals="$($ADB -s "$DEVICE" logcat -d -t 80 2>/dev/null | grep -cE "FATAL EXCEPTION.*$PKG|AndroidRuntime.*$PKG" || true)"
echo "    fatals_recent=${fatals:-0}"
$ADB -s "$DEVICE" shell svc wifi enable >/dev/null 2>&1 || true
$ADB -s "$DEVICE" shell svc data enable >/dev/null 2>&1 || true
if [[ "$wifi_was" == "0" ]]; then
  $ADB -s "$DEVICE" shell svc wifi disable >/dev/null 2>&1 || true
fi
sleep 4
echo "    online restored (si possible)"

echo "OK — sanity check terminé (voir dumps ci-dessus ; e2e API = scripts/e2e-battery.mjs)"
