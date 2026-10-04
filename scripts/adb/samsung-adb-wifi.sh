#!/usr/bin/env bash
# Répare l’ADB Wi‑Fi du Samsung (R5CT7263YJL) SANS toucher Nothing, SANS kill-server.
#
#   make samsung-wifi
#   bash scripts/adb/samsung-adb-wifi.sh
#
# Pairing (Débogage sans fil, 6 chiffres) — une ligne, pas de questions :
#   bash scripts/adb/samsung-adb-wifi.sh pair IP:PORT_ASSO CODE [IP:PORT_CONNEXION]
#
# USB 2 secondes (le plus fiable) : branche le câble, relance la même commande.
set -euo pipefail

ADB="${ADB_BIN:-adb}"
HW="R5CT7263YJL"
NAME="Samsung S21 FE"
# IP actuelle (LAN) + ancienne, dans cet ordre
IPS=( "${SAMSUNG_IP:-192.168.1.184}" "192.168.1.177" )
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="${ADB_WIFI_STATE:-$ROOT/logs/adb-wifi}"
mkdir -p "$STATE"
ENDPOINTS="$STATE/samsung-endpoints.txt"

log() { printf '%s\n' "$*" >&2; }
ok() { printf 'OK  %s\n' "$*" >&2; }
warn() { printf '..  %s\n' "$*" >&2; }
err() { printf 'KO  %s\n' "$*" >&2; }

how_to_repair() {
  cat >&2 <<'EOF'

Réparer le Samsung en ADB Wi‑Fi (choisis UN chemin) :

  1) Le plus simple — câble USB 2 secondes
     • Déverrouille le Samsung
     • Options développeur → Débogage USB ON
     • Branche le câble (Transfert de fichiers), accepte « Toujours autoriser »
     • Sur le PC :
         cd products/music && make samsung-wifi
     • Débranche : ça reste en Wi‑Fi sur le port 5555

  2) Sans câble — Débogage sans fil
     • Options développeur → Débogage sans fil = ON
     • « Associer avec un code » → note IP:port + code 6 chiffres
     • Sur l’écran principal du débogage sans fil, note aussi IP:port de connexion
     • Sur le PC (une ligne) :
         bash scripts/adb/samsung-adb-wifi.sh pair 192.168.1.184:XXXXX 123456 192.168.1.184:YYYYY

Rien d’autre à faire. Nothing n’est pas déconnecté. Pas de adb kill-server.

EOF
}

is_samsung() {
  local t="$1" blob
  blob="$("$ADB" -s "$t" shell getprop ro.serialno 2>/dev/null | tr -d '\r')"
  [[ "$blob" == "$HW" ]] && return 0
  blob="$("$ADB" devices -l | awk -v s="$t" '$1==s{print; exit}')"
  echo "$blob" | grep -qiE 'SM-G990B2|r9q|R5CT7263YJL' && return 0
  return 1
}

samsung_transport() {
  local t
  while read -r t st _; do
    [[ "$st" == "device" ]] || continue
    is_samsung "$t" && { echo "$t"; return 0; }
  done < <("$ADB" devices | awk 'NR>1 && NF{print}')
  return 1
}

remember() {
  local ip="$1" port="$2"
  [[ -n "$ip" && -n "$port" ]] || return 0
  grep -v " ${ip} " "$ENDPOINTS" >"${ENDPOINTS}.tmp" 2>/dev/null || true
  echo "$HW $ip $port" >>"${ENDPOINTS}.tmp"
  mv "${ENDPOINTS}.tmp" "$ENDPOINTS"
}

try_connect() {
  local host="$1" out
  "$ADB" disconnect "$host" >/dev/null 2>&1 || true
  out="$("$ADB" connect "$host" 2>&1 || true)"
  if echo "$out" | grep -qiE 'connected|already connected'; then
    sleep 0.4
    if is_samsung "$host"; then
      remember "${host%%:*}" "${host##*:}"
      ok "Samsung connecté → $host"
      return 0
    fi
    # pas le Samsung (autre téléphone) : on lâche
    "$ADB" disconnect "$host" >/dev/null 2>&1 || true
  fi
  return 1
}

scan_ports() {
  local ip="$1"
  python3 - "$ip" <<'PY' 2>/dev/null || true
import socket, sys
ip = sys.argv[1]
ports = {5555, 40115, 5554}
ports.update(range(37000, 43000, 25))
ports.update(range(30000, 52000, 150))
openp = []
for p in sorted(ports):
    s = socket.socket(); s.settimeout(0.07)
    try:
        if s.connect_ex((ip, p)) == 0:
            openp.append(str(p))
    except OSError:
        pass
    finally:
        s.close()
print(" ".join(openp))
PY
}

from_usb() {
  local t ip
  while read -r t st; do
    [[ "$st" == "device" && "$t" != *:* ]] || continue
    is_samsung "$t" || continue
    ok "Samsung USB $t → tcpip 5555 (pas de kill-server)"
    "$ADB" -s "$t" tcpip 5555 >/dev/null
    sleep 1
    ip="$("$ADB" -s "$t" shell ip -f inet addr show wlan0 2>/dev/null | awk '/inet /{gsub(/\/.*/,"",$2); print $2; exit}' | tr -d '\r')"
    [[ -z "$ip" ]] && ip="${IPS[0]}"
    remember "$ip" 5555
    try_connect "${ip}:5555" && return 0
  done < <("$ADB" devices | awk 'NR>1 && NF{print $1, $2}')
  return 1
}

cmd_pair() {
  local pair_host="${1:-}" code="${2:-}" conn="${3:-}"
  if [[ -z "$pair_host" || -z "$code" ]]; then
    err "Usage : bash scripts/adb/samsung-adb-wifi.sh pair IP:PORT_ASSO CODE [IP:PORT_CONNEXION]"
    how_to_repair
    exit 2
  fi
  log "==> adb pair $pair_host"
  if ! "$ADB" pair "$pair_host" "$code"; then
    err "Pairing refusé — code / port d’association à jour ?"
    exit 1
  fi
  ok "Pairing OK"
  if [[ -z "$conn" ]]; then
    conn="${pair_host%%:*}:5555"
    warn "Pas de port connexion → essai $conn (et scan)"
  fi
  try_connect "$conn" && return 0
  local ip="${conn%%:*}" p
  for p in $(scan_ports "$ip"); do
    try_connect "${ip}:$p" && return 0
  done
  err "Pairé mais pas connecté — relance avec le port de connexion affiché sur le téléphone"
  exit 1
}

cmd_repair() {
  local t ip p saved
  t="$(samsung_transport || true)"
  if [[ -n "$t" ]]; then
    ok "Déjà là : $t"
    "$ADB" -s "$t" shell cmd audio set-stream-volume 3 0 >/dev/null 2>&1 || true
    # USB présent → bascule tcpip 5555 pour rester en Wi‑Fi après débranchement
    if [[ "$t" != *:* ]]; then
      from_usb || true
    elif [[ "$t" != *:5555 ]]; then
      # TLS wireless déjà là : mémorise aussi 5555 si USB est branché en parallèle
      from_usb || true
    fi
    "$ADB" devices -l | awk '/R5CT7263YJL|r9q/'
    t="$(samsung_transport || true)"
    [[ -n "$t" ]] && return 0
  fi

  from_usb && return 0

  if [[ -f "$ENDPOINTS" ]]; then
    while read -r _hw ip p; do
      [[ -n "${ip:-}" ]] || continue
      try_connect "${ip}:${p:-5555}" && return 0
    done <"$ENDPOINTS"
  fi
  if [[ -f "$STATE/endpoints.txt" ]]; then
    while read -r _hw ip p; do
      [[ "${_hw:-}" == "$HW" && -n "${ip:-}" ]] || continue
      try_connect "${ip}:${p:-5555}" && return 0
    done <"$STATE/endpoints.txt"
  fi

  for ip in "${IPS[@]}"; do
    ping -c 1 -W 1 "$ip" >/dev/null 2>&1 || { warn "$ip ne ping pas"; continue; }
    ok "$ip ping"
    for p in 5555 40115; do
      try_connect "${ip}:$p" && return 0
    done
    saved="$(scan_ports "$ip")"
    if [[ -z "$saved" ]]; then
      warn "$ip : aucun port ADB ouvert (Débogage sans fil OFF)"
      continue
    fi
    log "ports ouverts $ip : $saved"
    for p in $saved; do
      try_connect "${ip}:$p" && return 0
    done
  done

  err "$NAME ($HW) introuvable en ADB Wi‑Fi"
  how_to_repair
  return 1
}

cmd="${1:-repair}"
shift || true
case "$cmd" in
  repair|ensure|go|"") cmd_repair ;;
  pair) cmd_pair "$@" ;;
  how|help|-h|--help) how_to_repair ;;
  *) err "inconnu: $cmd"; how_to_repair; exit 2 ;;
esac
