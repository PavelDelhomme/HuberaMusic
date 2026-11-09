#!/usr/bin/env bash
# Répare ADB Wi‑Fi du Samsung (S21 FE / R5CT7263YJL) depuis USB.
# Usage : bash scripts/adb/samsung-wifi-repair.sh
# Ne touche pas Nothing. Blackview ignoré.
set -euo pipefail
ADB="${ADB_BIN:-adb}"
HW=R5CT7263YJL
PORT="${ADB_WIFI_PORT:-5555}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="${ADB_WIFI_STATE:-$ROOT/logs/adb-wifi}"
mkdir -p "$STATE"

usb=""
for t in $("$ADB" devices | awk '/\tdevice$/{print $1}'); do
  case "$t" in
    *:* ) continue ;;
  esac
  ser="$("$ADB" -s "$t" shell getprop ro.serialno 2>/dev/null | tr -d '\r')"
  if [[ "$ser" == "$HW" ]]; then
    usb="$t"
    break
  fi
done

if [[ -z "$usb" ]]; then
  echo "USB Samsung ($HW) absent. Branche le câble, débogage USB ON, puis relance." >&2
  echo "Transports :" >&2
  "$ADB" devices -l >&2
  exit 1
fi

echo "==> USB $usb → tcpip $PORT"
"$ADB" -s "$usb" tcpip "$PORT" >/dev/null
ip=""
for _ in 1 2 3 4 5 6 7 8; do
  sleep 1
  ip="$("$ADB" -s "$usb" shell ip -f inet addr show wlan0 2>/dev/null | awk '/inet /{gsub(/\/.*/,"",$2); print $2; exit}' | tr -d '\r')"
  [[ -n "$ip" ]] && break
done
if [[ -z "$ip" ]]; then
  echo "IP wlan0 introuvable" >&2
  exit 1
fi
echo "==> connect $ip:$PORT"
"$ADB" disconnect "$ip:$PORT" >/dev/null 2>&1 || true
"$ADB" connect "$ip:$PORT"
echo "$HW $ip $PORT" >"$STATE/samsung-wifi.txt"
# une ligne propre dans endpoints
touch "$STATE/endpoints.txt"
grep -v "^${HW} " "$STATE/endpoints.txt" 2>/dev/null | grep -v " ${ip} " >"$STATE/endpoints.txt.tmp" || true
echo "${HW} ${ip} ${PORT}" >>"$STATE/endpoints.txt.tmp"
mv "$STATE/endpoints.txt.tmp" "$STATE/endpoints.txt"
sleep 1
"$ADB" devices -l
echo "OK Samsung Wi‑Fi $ip:$PORT (USB encore utile tant que le câble est branché)"
