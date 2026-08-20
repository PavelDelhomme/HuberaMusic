#!/usr/bin/env bash
# Affiche Samsung / Nothing / Blackview / tablette (+ extras) pour `make status`.
set -euo pipefail
ADB="${ADB_BIN:-adb}"
ADB_OUT="$("$ADB" devices -l 2>/dev/null || true)"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE_DIR="${ADB_WIFI_STATE:-$ROOT/logs/adb-wifi}"
STATE="$STATE_DIR/endpoints.txt"

print_dev() {
  local role="$1" label="$2" serial="$3" iphost="$4" extra="${5:-}"
  local line
  line="$(
    printf '%s\n' "$ADB_OUT" | awk -v s="$serial" -v ip="$iphost" -v ex="$extra" '
      $2 != "device" { next }
      index($0, s) { print; exit }
      ip != "" && index($1, ip ":") { print; exit }
      ip != "" && index($1, ip) { print; exit }
      ex != "" && index($0, ex) { print; exit }
    '
  )"
  if [[ -n "$line" ]]; then
    printf "  \033[1;32m✅ %s\033[0m %-10s %s\n" "$role" "$label" "$line"
  else
    # offline sur IP connue ?
    local off
    off="$(
      printf '%s\n' "$ADB_OUT" | awk -v ip="$iphost" '
        $2 == "offline" && ip != "" && index($1, ip) { print; exit }
      '
    )"
    if [[ -n "$off" ]]; then
      printf "  \033[1;33m⚠ %s\033[0m %-10s offline  %s  → relance Débogage sans fil / make adb-wifi-pair\n" \
        "$role" "$label" "$off"
    else
      printf "  \033[1;31m❌ %s\033[0m %-10s manquant  → make adb-both / make adb-wifi-pair  (%s / %s*)\n" \
        "$role" "$label" "$serial" "${iphost:-USB}"
    fi
  fi
}

KNOWN_MARKERS='R5CT7263YJL|00145153K001434|EEA9700PRO0014587|SM_G990B2|A059|BV9700Pro|192.168.1.184|192.168.1.44|192.168.1.12|emulator-'

print_dev "DEV " "Samsung" "R5CT7263YJL" "192.168.1.184" "SM_G990B2"
print_dev "PROD" "Nothing" "00145153K001434" "192.168.1.44" "A059"
print_dev "USB " "Blackview" "EEA9700PRO0014587" "" "BV9700Pro"

# Tablette : fingerprint Lenovo / TB-J / YT-J / endpoints enregistrés hors trio
TAB_IP=""
TAB_SERIAL=""
if [[ -f "$STATE" ]]; then
  while read -r hw ip port rest; do
    [[ -z "${hw:-}" || "$hw" == \#* ]] && continue
    case "$hw" in
      R5CT7263YJL|00145153K001434|EEA9700PRO0014587|paired|manual) continue ;;
    esac
    TAB_SERIAL="$hw"
    TAB_IP="$ip"
    break
  done <"$STATE"
fi

tab_line="$(
  printf '%s\n' "$ADB_OUT" | awk '
    $2 != "device" { next }
    tolower($0) ~ /lenovo|tb-j|yt-j|yoga|p11|tablet|tab / { print; exit }
  '
)"
if [[ -z "$tab_line" && -n "$TAB_IP" ]]; then
  tab_line="$(
    printf '%s\n' "$ADB_OUT" | awk -v ip="$TAB_IP" -v s="$TAB_SERIAL" '
      $2 != "device" { next }
      (ip != "" && index($1, ip ":")) || (s != "" && index($0, s)) { print; exit }
    '
  )"
fi
if [[ -n "$tab_line" ]]; then
  printf "  \033[1;32m✅ TAB \033[0m %-10s %s\n" "Lenovo" "$tab_line"
elif [[ -n "$TAB_IP" ]]; then
  off="$(
    printf '%s\n' "$ADB_OUT" | awk -v ip="$TAB_IP" '
      $2 == "offline" && index($1, ip) { print; exit }
    '
  )"
  if [[ -n "$off" ]]; then
    printf "  \033[1;33m⚠ TAB \033[0m %-10s offline  %s  → Débogage sans fil ON + make adb-wifi-pair\n" "Lenovo" "$off"
  else
    printf "  \033[1;31m❌ TAB \033[0m %-10s manquant  → make adb-wifi-pair  (%s*)\n" "Lenovo" "$TAB_IP"
  fi
fi

# Autres appareils device (hors connus)
printf '%s\n' "$ADB_OUT" | awk -v known="$KNOWN_MARKERS" '
  NR > 1 && $2 == "device" {
    if ($0 ~ known) next
    if (tolower($0) ~ /lenovo|tb-j|yt-j|yoga|p11/) next
    printf "  \033[1;32m✅ EXTRA\033[0m %-10s %s\n", "autre", $0
  }
  NR > 1 && NF && $2 != "device" {
    if ($2 == "unauthorized")
      printf "  \033[1;33m⚠ unauthorized\033[0m %s  → accepte la popup USB\n", $1
    else if ($2 == "offline") {
      if ($0 ~ known) next
      printf "  \033[1;33m⚠ offline\033[0m %s  → make adb-wifi-pair\n", $1
    } else
      printf "  \033[0;90m· %s\033[0m\n", $0
  }
'
