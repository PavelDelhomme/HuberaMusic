#!/usr/bin/env bash
# ADB Wi‑Fi multi-appareils physiques (Samsung + Nothing) — pairing inclus.
#
# Appareils attendus (physiques) :
#   Samsung  R5CT7263YJL  SM-G990B2 / r9q*
#   Nothing  00145153K001434  A059 / Asteroids
#
# Commandes :
#   bash scripts/adb-wifi.sh doctor
#   bash scripts/adb-wifi.sh ensure          # Nothing OK + attend Samsung (USB ou pair)
#   bash scripts/adb-wifi.sh pair            # Débogage sans fil (IP:port + code)
#   bash scripts/adb-wifi.sh connect-ip IP [PORT]
#   bash scripts/adb-wifi.sh go              # ensure → wait-unplug → battery 30min → report
#
# Makefile : make adb-wifi-doctor | make adb-wifi-ensure | make adb-wifi-pair | make battery-go
set -euo pipefail

ADB="${ADB_BIN:-adb}"
PORT="${ADB_WIFI_PORT:-5555}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="${ADB_WIFI_STATE:-$ROOT/logs/adb-wifi}"
mkdir -p "$STATE_DIR"

# serial hardware → libellé (noms Bluetooth / device_name)
EXPECTED_SERIALS=(
  "R5CT7263YJL:S21 FE DD"
  "00145153K001434:Nothing"
)

# Au moins 1 appareil suffit (Samsung optionnel). REQUIRE_BOTH=1 pour exiger les 2.
MIN_DEVICES="${MIN_DEVICES:-1}"
REQUIRE_BOTH="${REQUIRE_BOTH:-0}"
if [[ "$REQUIRE_BOTH" == "1" ]]; then
  MIN_DEVICES=2
fi

log() { printf '%s\n' "$*" >&2; }
ok() { printf '✅ %s\n' "$*" >&2; }
warn() { printf '⚠️  %s\n' "$*" >&2; }
err() { printf '❌ %s\n' "$*" >&2; }

usb_serials() {
  "$ADB" devices -l | awk 'NR>1 && $2=="device" && $1 !~ /:/{print $1}'
}
wifi_serials() {
  "$ADB" devices -l | awk 'NR>1 && $2=="device" && $1 ~ /:/{print $1}'
}

hw_serial_of() {
  local target="$1"
  "$ADB" -s "$target" shell getprop ro.serialno 2>/dev/null | tr -d '\r' | head -1
}

model_of() {
  local target="$1"
  "$ADB" -s "$target" shell getprop ro.product.model 2>/dev/null | tr -d '\r' | head -1
}

device_wlan_ip() {
  local serial="$1" ip=""
  ip="$("$ADB" -s "$serial" shell ip -f inet addr show wlan0 2>/dev/null | awk '/inet /{gsub(/\/.*/,"",$2); print $2; exit}' | tr -d '\r')"
  [[ -z "$ip" ]] && ip="$("$ADB" -s "$serial" shell ip -f inet addr show wlan1 2>/dev/null | awk '/inet /{gsub(/\/.*/,"",$2); print $2; exit}' | tr -d '\r')"
  [[ -z "$ip" ]] && ip="$("$ADB" -s "$serial" shell "ip route get 1.1.1.1" 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' | tr -d '\r')"
  printf '%s' "$ip"
}

is_unplugged() {
  local serial="$1" usb ac
  usb="$("$ADB" -s "$serial" shell dumpsys battery 2>/dev/null | awk -F': ' '/USB powered:/{print $2; exit}' | tr -d ' \r')"
  ac="$("$ADB" -s "$serial" shell dumpsys battery 2>/dev/null | awk -F': ' '/AC powered:/{print $2; exit}' | tr -d ' \r')"
  [[ "$usb" == "false" && "$ac" == "false" ]]
}

# Map: hw_serial → adb transport (prefer wifi)
declare -A HW_TO_TRANSPORT=()

refresh_hw_map() {
  HW_TO_TRANSPORT=()
  local t hw
  for t in $(wifi_serials) $(usb_serials); do
    hw="$(hw_serial_of "$t")"
    [[ -z "$hw" ]] && continue
    # Prefer wifi if already mapped to usb
    if [[ -n "${HW_TO_TRANSPORT[$hw]:-}" && "$t" != *:* && "${HW_TO_TRANSPORT[$hw]}" == *:* ]]; then
      continue
    fi
    HW_TO_TRANSPORT["$hw"]="$t"
  done
}

expected_missing() {
  refresh_hw_map
  local entry hw name
  for entry in "${EXPECTED_SERIALS[@]}"; do
    hw="${entry%%:*}"
    name="${entry#*:}"
    if [[ -z "${HW_TO_TRANSPORT[$hw]:-}" ]]; then
      echo "$hw:$name"
    fi
  done
}

count_expected_wifi() {
  refresh_hw_map
  local entry hw t n=0
  for entry in "${EXPECTED_SERIALS[@]}"; do
    hw="${entry%%:*}"
    t="${HW_TO_TRANSPORT[$hw]:-}"
    [[ "$t" == *:* ]] && n=$((n + 1))
  done
  echo "$n"
}

count_expected_any() {
  refresh_hw_map
  local entry hw t n=0
  for entry in "${EXPECTED_SERIALS[@]}"; do
    hw="${entry%%:*}"
    t="${HW_TO_TRANSPORT[$hw]:-}"
    [[ -n "$t" ]] && n=$((n + 1))
  done
  echo "$n"
}

list_expected_wifi_transports() {
  refresh_hw_map
  local entry hw t
  for entry in "${EXPECTED_SERIALS[@]}"; do
    hw="${entry%%:*}"
    t="${HW_TO_TRANSPORT[$hw]:-}"
    [[ "$t" == *:* ]] && echo "$t"
  done
}

cmd_doctor() {
  log "╔══════════════════════════════════════════════════════════╗"
  log "║  ADB doctor — S21 FE DD + Nothing (min ${MIN_DEVICES})   ║"
  log "╚══════════════════════════════════════════════════════════╝"
  log ""
  "$ADB" devices -l
  log ""
  refresh_hw_map
  local entry hw name t model ip powered level kind dname
  local found=0 missing=0
  for entry in "${EXPECTED_SERIALS[@]}"; do
    hw="${entry%%:*}"
    name="${entry#*:}"
    t="${HW_TO_TRANSPORT[$hw]:-}"
    if [[ -z "$t" ]]; then
      warn "$name ($hw) — ABSENT (optionnel si ≥${MIN_DEVICES} autre OK)"
      missing=$((missing + 1))
      continue
    fi
    found=$((found + 1))
    model="$(model_of "$t")"
    dname="$("$ADB" -s "$t" shell settings get global device_name 2>/dev/null | tr -d '\r' || true)"
    kind=$([[ "$t" == *:* ]] && echo "Wi‑Fi" || echo "USB")
    ip="$(device_wlan_ip "$t")"
    powered="$("$ADB" -s "$t" shell dumpsys battery 2>/dev/null | awk -F': ' '/USB powered:/{print $2; exit}' | tr -d '\r')"
    level="$("$ADB" -s "$t" shell dumpsys battery 2>/dev/null | awk -F': ' '/^  level:/{print $2; exit}' | tr -d '\r')"
    ok "$name ($hw) model=$model name=${dname:-?} via=$kind transport=$t wlan=${ip:-?} usb_powered=${powered:-?} level=${level:-?}%"
  done
  log ""
  local t hw matched
  for t in $(wifi_serials) $(usb_serials); do
    hw="$(hw_serial_of "$t")"
    matched=0
    for entry in "${EXPECTED_SERIALS[@]}"; do
      [[ "$hw" == "${entry%%:*}" ]] && matched=1 && break
    done
    if [[ "$matched" == 0 ]]; then
      warn "Transport ignoré (pas S21/Nothing) : $t hw=${hw:-?} model=$(model_of "$t")"
    fi
  done
  log ""
  local wifi_n
  wifi_n="$(count_expected_wifi)"
  if (( found >= MIN_DEVICES && wifi_n >= MIN_DEVICES )); then
    ok "$found/2 présent(s), ${wifi_n} en Wi‑Fi — OK pour battery-go (min=${MIN_DEVICES})"
    return 0
  fi
  if (( found >= MIN_DEVICES )); then
    warn "$found/2 présent(s) mais Wi‑Fi insuffisant (${wifi_n}) — bascule USB→Wi‑Fi via ensure"
    return 1
  fi
  err "$found/2 — besoin d’au moins ${MIN_DEVICES} appareil(s)"
  expected_missing | while IFS=: read -r hw name; do
    err "  → $name ($hw)"
  done
  return 1
}

cmd_enable_one() {
  local s="$1"
  log "==> tcpip $PORT sur $s"
  "$ADB" -s "$s" tcpip "$PORT" >/dev/null
  local ip="" attempt
  for attempt in 1 2 3 4 5 6 7 8; do
    sleep 1
    "$ADB" -s "$s" wait-for-device >/dev/null 2>&1 || true
    ip="$(device_wlan_ip "$s")"
    [[ -n "$ip" ]] && break
  done
  if [[ -z "$ip" ]]; then
    err "$s : IP Wi‑Fi introuvable"
    return 1
  fi
  local hw
  hw="$(hw_serial_of "$s")"
  local tmp="$STATE_DIR/endpoints.txt.tmp"
  touch "$STATE_DIR/endpoints.txt"
  grep -v " $ip $PORT\$" "$STATE_DIR/endpoints.txt" 2>/dev/null | grep -v "^${hw:-$s} " >"$tmp" || true
  echo "${hw:-$s} $ip $PORT" >>"$tmp"
  mv "$tmp" "$STATE_DIR/endpoints.txt"
  log "   → connect $ip:$PORT"
  "$ADB" connect "$ip:$PORT" || true
  sleep 1
  ok "$s → $ip:$PORT (hw=${hw:-?})"
}

cmd_enable() {
  local serials=()
  if [[ $# -gt 0 ]]; then
    serials=("$@")
  else
    mapfile -t serials < <(usb_serials)
  fi
  if [[ ${#serials[@]} -eq 0 ]]; then
    err "Aucun USB. Branche un téléphone, ou : make adb-wifi-pair"
    exit 1
  fi
  local s
  for s in "${serials[@]}"; do
    cmd_enable_one "$s" || true
  done
  cmd_doctor || true
}

cmd_connect() {
  local targets=()
  if [[ $# -gt 0 ]]; then
    local a
    for a in "$@"; do
      case "$a" in
        *:*) targets+=("$a") ;;
        *) targets+=("$a:$PORT") ;;
      esac
    done
  elif [[ -f "$STATE_DIR/endpoints.txt" ]]; then
    while read -r _serial ip port; do
      [[ -n "${ip:-}" ]] || continue
      targets+=("${ip}:${port:-$PORT}")
    done <"$STATE_DIR/endpoints.txt"
  fi
  if [[ ${#targets[@]} -eq 0 ]]; then
    err "Aucune cible. make adb-wifi / make adb-wifi-pair"
    exit 1
  fi
  local t
  for t in "${targets[@]}"; do
    log "==> adb connect $t"
    "$ADB" connect "$t" || true
  done
  sleep 1
  cmd_doctor || true
}

cmd_connect_ip() {
  local ip="${1:?IP requise}"
  local port="${2:-$PORT}"
  log "==> adb connect $ip:$port"
  "$ADB" connect "$ip:$port"
  echo "manual $ip $port" >>"$STATE_DIR/endpoints.txt"
  sleep 1
  cmd_doctor || true
}

cmd_pair() {
  log "╔══════════════════════════════════════════════════════════╗"
  log "║  Débogage sans fil — association (pairing)              ║"
  log "╚══════════════════════════════════════════════════════════╝"
  log ""
  log "Sur le téléphone (S21 FE DD) :"
  log "  1. Options dév → Débogage sans fil = ON"
  log "  2. Associer avec un code → IP:port + code 6 chiffres"
  log "  3. Puis IP:port de connexion (souvent différent)"
  log ""
  local pair_host pair_code connect_host
  if [[ -n "${PAIR:-}" && -n "${PAIR_CODE:-}" ]]; then
    pair_host="$PAIR"
    pair_code="$PAIR_CODE"
  else
    read -r -p "IP:port d’association : " pair_host
    read -r -p "Code d’association : " pair_code
  fi
  [[ -n "$pair_host" && -n "$pair_code" ]] || { err "pair annulé"; exit 1; }
  log "==> adb pair $pair_host …"
  if ! "$ADB" pair "$pair_host" "$pair_code"; then
    err "Échec pairing"
    exit 1
  fi
  ok "Pairing OK"
  if [[ -n "${CONNECT:-}" ]]; then
    connect_host="$CONNECT"
  else
    read -r -p "IP:port de connexion : " connect_host
  fi
  [[ -n "$connect_host" ]] || { err "pas de port connexion"; exit 1; }
  case "$connect_host" in
    *:*) ;;
    *) connect_host="${connect_host}:$PORT" ;;
  esac
  "$ADB" connect "$connect_host"
  echo "paired $connect_host" >>"$STATE_DIR/endpoints.txt"
  sleep 1
  cmd_doctor || true
}

cmd_disconnect() {
  local t
  for t in $(wifi_serials); do
    log "==> disconnect $t"
    "$ADB" disconnect "$t" || true
  done
}

cmd_status() { cmd_doctor || true; }

cmd_ensure() {
  # INCLUDE_NOTHING=1 (défaut) : reconnecte Samsung + Nothing.
  # INCLUDE_NOTHING=0 : Samsung seulement — ne déconnecte PAS Nothing s’il est déjà là.
  local include_nothing="${INCLUDE_NOTHING:-1}"
  log "==> ensure (≥${MIN_DEVICES} appareil — Samsung + Nothing=${include_nothing})"
  if [[ -f "$STATE_DIR/endpoints.txt" ]]; then
    cmd_connect || true
  fi
  # Samsung LAN d’abord
  "$ADB" connect 192.168.1.184:5555 >/dev/null 2>&1 || true
  if [[ "$include_nothing" == "1" ]]; then
    "$ADB" connect 192.168.1.44:5555 >/dev/null 2>&1 || true
  else
    log "==> skip reconnect Nothing (INCLUDE_NOTHING=0) — session existante conservée"
  fi

  # Bascule USB→Wi‑Fi pour Samsung (et Nothing si INCLUDE_NOTHING)
  local s hw entry t
  for s in $(usb_serials); do
    hw="$(hw_serial_of "$s")"
    for entry in "${EXPECTED_SERIALS[@]}"; do
      if [[ "$hw" == "${entry%%:*}" ]]; then
        if [[ "$hw" == "00145153K001434" && "$include_nothing" != "1" ]]; then
          log "==> skip Nothing USB (INCLUDE_NOTHING=0)"
          continue
        fi
        log "==> USB $hw → Wi‑Fi"
        cmd_enable_one "$s" || true
      fi
    done
  done

  local wifi_n
  wifi_n="$(count_expected_wifi)"
  if (( wifi_n >= MIN_DEVICES )); then
    ok "ensure OK — ${wifi_n} appareil(s) en Wi‑Fi (min=${MIN_DEVICES})"
    cmd_doctor || true
    return 0
  fi

  # Attente courte seulement si RIEN n’est là (pas de boucle infinie pour le 2e)
  local deadline=$((SECONDS + ${ENSURE_WAIT:-60}))
  while (( SECONDS < deadline )); do
    for s in $(usb_serials); do
      hw="$(hw_serial_of "$s")"
      for entry in "${EXPECTED_SERIALS[@]}"; do
        if [[ "$hw" == "${entry%%:*}" ]]; then
          cmd_enable_one "$s" || true
        fi
      done
    done
    wifi_n="$(count_expected_wifi)"
    if (( wifi_n >= MIN_DEVICES )); then
      ok "ensure OK — ${wifi_n} appareil(s) en Wi‑Fi"
      cmd_doctor || true
      return 0
    fi
    warn "Aucun appareil Wi‑Fi attendu (${wifi_n}/${MIN_DEVICES}) — branche USB 2s ou make adb-wifi-pair…"
    sleep 5
  done
  err "Timeout ensure — besoin ≥${MIN_DEVICES} en Wi‑Fi"
  cmd_doctor || true
  exit 1
}

cmd_wait_unplug() {
  local deadline=$((SECONDS + ${ADB_UNPLUG_WAIT:-120}))
  log "==> Attente hors charge USB/AC (appareils présents uniquement)"
  while (( SECONDS < deadline )); do
    refresh_hw_map
    local wifi_n entry hw t all_ok=1 any=0
    wifi_n="$(count_expected_wifi)"
    if (( wifi_n < MIN_DEVICES )); then
      err "Pas assez d’appareils Wi‑Fi (${wifi_n}<${MIN_DEVICES})"
      exit 1
    fi
    for entry in "${EXPECTED_SERIALS[@]}"; do
      hw="${entry%%:*}"
      t="${HW_TO_TRANSPORT[$hw]:-}"
      [[ "$t" == *:* ]] || continue
      any=1
      if ! is_unplugged "$t"; then
        all_ok=0
        warn "$hw ($t) encore en charge — débranche"
      else
        ok "$hw débranché"
      fi
    done
    if [[ "$all_ok" == 1 && "$any" == 1 ]]; then
      ok "Hors charge — prêt pour battery-test"
      return 0
    fi
    sleep 3
  done
  err "Timeout wait-unplug"
  exit 1
}

cmd_go() {
  log "═══ battery-go : ensure (≥${MIN_DEVICES}) → unplug → test → report ═══"
  cmd_ensure
  cmd_wait_unplug
  local duration="${DURATION:-1800}"
  local sample="${SAMPLE_SECS:-15}"
  local usage="${USAGE:-0}"
  local list=()
  mapfile -t list < <(list_expected_wifi_transports)
  if (( ${#list[@]} < MIN_DEVICES )); then
    err "Pas assez de transports Wi‑Fi"
    exit 1
  fi
  # Écran OFF pour mesure calme (si USAGE=0)
  if [[ "$usage" == "0" ]]; then
    local t
    for t in "${list[@]}"; do
      log "==> écran OFF $t"
      "$ADB" -s "$t" shell input keyevent 26 >/dev/null 2>&1 || true
    done
  fi
  local joined
  joined="$(IFS=,; echo "${list[*]}")"
  log "==> DEVICES=$joined DURATION=$duration USAGE=$usage (${#list[@]} appareil(s))"
  DURATION="$duration" SAMPLE_SECS="$sample" DEVICES="$joined" REQUIRE_UNPLUGGED=1 USAGE="$usage" \
    bash "$ROOT/scripts/battery-session.sh"
  if [[ -f "$ROOT/logs/battery-session/latest/REPORT.md" ]]; then
    echo ""
    cat "$ROOT/logs/battery-session/latest/REPORT.md"
  fi
}

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \?//'
}

main() {
  local cmd="${1:-doctor}"
  shift || true
  case "$cmd" in
    doctor|status|ls) cmd_doctor "$@" ;;
    enable|pair-usb) cmd_enable "$@" ;;
    connect) cmd_connect "$@" ;;
    connect-ip) cmd_connect_ip "$@" ;;
    pair) cmd_pair "$@" ;;
    ensure) cmd_ensure "$@" ;;
    wait-unplug|wait) cmd_wait_unplug "$@" ;;
    disconnect) cmd_disconnect "$@" ;;
    go) cmd_go "$@" ;;
    -h|--help|help) usage ;;
    *) err "Commande inconnue: $cmd"; usage; exit 1 ;;
  esac
}

main "$@"
