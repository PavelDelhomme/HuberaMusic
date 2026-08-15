#!/usr/bin/env bash
# Affiche Samsung / Nothing pour `make status` (ports Wi‑Fi dynamiques OK).
set -euo pipefail
ADB="${ADB_BIN:-adb}"
ADB_OUT="$("$ADB" devices -l 2>/dev/null || true)"

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
    printf "  \033[1;31m❌ %s\033[0m %-10s manquant  → make adb-both  (%s / %s*)\n" \
      "$role" "$label" "$serial" "$iphost"
  fi
}

print_dev "DEV " "Samsung" "R5CT7263YJL" "192.168.1.184" "SM_G990B2"
print_dev "PROD" "Nothing" "00145153K001434" "192.168.1.44" "A059"

printf '%s\n' "$ADB_OUT" | awk 'NR > 1 && NF && $2 != "device" {
  if ($2 == "unauthorized")
    printf "  \033[1;33m⚠ unauthorized\033[0m %s  → accepte la popup USB\n", $1
  else if ($2 == "offline")
    printf "  \033[1;31m❌ offline\033[0m %s\n", $1
  else
    printf "  \033[0;90m· %s\033[0m\n", $0
}'
