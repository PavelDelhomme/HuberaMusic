#!/usr/bin/env bash
# Session batterie réelle (ADB Wi‑Fi, téléphones débranchés).
#
# Prérequis :
#   make adb-wifi && make adb-wifi-connect
#   → débranche les câbles
#   make adb-wifi-wait-unplug
#   make battery-test                 # 30 min par défaut
#
# Variables :
#   DURATION=1800          # secondes (défaut 30 min)
#   SAMPLE_SECS=15         # échantillonnage batterie
#   DEVICES=serial1,ip:5555  # sinon tous les ADB « device »
#   REQUIRE_UNPLUGGED=1    # refuse si USB/AC powered
#   USAGE=1                # stimule un peu l’app (skips, home)
#   PKG=ovh.delhomme.ytmusic
#
# Sortie : logs/battery-session/<stamp>/
#   devices/<id>/{battery.csv,logcat.txt,batterystats.txt,meta.txt}
#   server/{ytmusic-server.log,ytmusic-dev.log,api-health.json}
#   REPORT.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ADB="${ADB_BIN:-adb}"
PKG="${PKG:-ovh.delhomme.ytmusic}"
DURATION="${DURATION:-1800}"
SAMPLE_SECS="${SAMPLE_SECS:-15}"
REQUIRE_UNPLUGGED="${REQUIRE_UNPLUGGED:-1}"
USAGE="${USAGE:-1}"
STAMP="${BATTERY_STAMP:-$(date +%Y%m%d-%H%M%S)}"
OUT="${BATTERY_OUT:-$ROOT/logs/battery-session/$STAMP}"
API_HEALTH_URL="${API_HEALTH_URL:-http://127.0.0.1:8787/api/health}"

mkdir -p "$OUT/devices" "$OUT/server" "$OUT/bin"
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$OUT/session.log"; }

resolve_devices() {
  if [[ -n "${DEVICES:-}" ]]; then
    echo "$DEVICES" | tr ',' '\n' | sed '/^$/d'
    return
  fi
  # Préfère ADB Wi‑Fi ; ignore le serial USB si le même téléphone a déjà host:port
  local wifi usb
  mapfile -t wifi < <("$ADB" devices | awk 'NR>1 && $2=="device" && $1 ~ /:/{print $1}')
  mapfile -t usb < <("$ADB" devices | awk 'NR>1 && $2=="device" && $1 !~ /:/{print $1}')
  if [[ ${#wifi[@]} -gt 0 ]]; then
    printf '%s\n' "${wifi[@]}"
    return
  fi
  printf '%s\n' "${usb[@]}"
}

safe_id() {
  echo "$1" | tr ':/' '__'
}

battery_snapshot() {
  local serial="$1"
  "$ADB" -s "$serial" shell dumpsys battery 2>/dev/null | tr -d '\r'
}

parse_battery_line() {
  # stdin: dumpsys battery → stdout CSV fields
  awk -F': ' '
    /USB powered:/{usb=$2}
    /AC powered:/{ac=$2}
    /Wireless powered:/{wl=$2}
    /^  level:/{lvl=$2}
    /temperature:/{temp=$2}
    /Charge counter:/{cc=$2}
    /voltage:/{volt=$2}
    /status:/{st=$2}
    END {
      gsub(/^[ \t]+|[ \t]+$/, "", usb)
      gsub(/^[ \t]+|[ \t]+$/, "", ac)
      gsub(/^[ \t]+|[ \t]+$/, "", wl)
      gsub(/^[ \t]+|[ \t]+$/, "", lvl)
      gsub(/^[ \t]+|[ \t]+$/, "", temp)
      gsub(/^[ \t]+|[ \t]+$/, "", cc)
      gsub(/^[ \t]+|[ \t]+$/, "", volt)
      gsub(/^[ \t]+|[ \t]+$/, "", st)
      printf "%s,%s,%s,%s,%s,%s,%s,%s", lvl+0, temp+0, cc+0, volt+0, st, usb, ac, wl
    }
  '
}

current_now_ua() {
  local serial="$1"
  local v
  for path in \
    /sys/class/power_supply/battery/current_now \
    /sys/class/power_supply/Battery/current_now \
    /sys/class/power_supply/usb/current_now; do
    v="$("$ADB" -s "$serial" shell "cat $path 2>/dev/null" | tr -d '\r' | head -1)"
    if [[ "$v" =~ ^-?[0-9]+$ ]]; then
      echo "$v"
      return
    fi
  done
  echo ""
}

is_unplugged() {
  local serial="$1"
  local dump usb ac
  dump="$(battery_snapshot "$serial")"
  usb="$(echo "$dump" | awk -F': ' '/USB powered:/{print $2; exit}' | tr -d ' \r')"
  ac="$(echo "$dump" | awk -F': ' '/AC powered:/{print $2; exit}' | tr -d ' \r')"
  [[ "$usb" == "false" && "$ac" == "false" ]]
}

start_logcat() {
  local serial="$1" dir="$2"
  "$ADB" -s "$serial" logcat -c >/dev/null 2>&1 || true
  # shellcheck disable=SC2086
# Widen logcat for battery sessions (catch playback / related errors)
  nohup "$ADB" -s "$serial" logcat -v threadtime \
    "*:W" "$PKG:V" "ExoPlayerImpl:W" "MediaCodec:W" "okhttp.OkHttpClient:I" \
    >"$dir/logcat.txt" 2>/dev/null &
  echo $! >"$dir/logcat.pid"
}

stop_pidfile() {
  local f="$1"
  if [[ -f "$f" ]]; then
    kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  fi
}

usage_tick() {
  local serial="$1" tick="$2"
  # Toutes les ~2 min : un peu d’usage app
  if (( tick % 8 != 0 )); then return 0; fi
  "$ADB" -s "$serial" shell input keyevent 126 >/dev/null 2>&1 || true # PLAY
  case $((tick % 32)) in
    0)
      "$ADB" -s "$serial" shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1 || true
      ;;
    8)
      "$ADB" -s "$serial" shell input keyevent 87 >/dev/null 2>&1 || true # NEXT
      ;;
    16)
      "$ADB" -s "$serial" shell input keyevent 85 >/dev/null 2>&1 || true # PLAY_PAUSE
      sleep 1
      "$ADB" -s "$serial" shell input keyevent 85 >/dev/null 2>&1 || true
      ;;
    24)
      "$ADB" -s "$serial" shell input keyevent 87 >/dev/null 2>&1 || true
      "$ADB" -s "$serial" shell input keyevent 87 >/dev/null 2>&1 || true
      ;;
  esac
}

copy_server_logs() {
  local phase="$1"
  mkdir -p "$OUT/server/$phase"
  for f in ytmusic-server.log ytmusic-dev.log ytmusic-web.log ytmusic-client.log; do
    if [[ -f "$ROOT/logs/$f" ]]; then
      # Copie snapshot (tail pour fichiers énormes)
      tail -c 8M "$ROOT/logs/$f" >"$OUT/server/$phase/$f" 2>/dev/null || \
        cp -f "$ROOT/logs/$f" "$OUT/server/$phase/$f" 2>/dev/null || true
    fi
  done
  curl -sS -m 5 "$API_HEALTH_URL" >"$OUT/server/$phase/api-health.json" 2>/dev/null || \
    echo '{"ok":false}' >"$OUT/server/$phase/api-health.json"
}

write_report() {
  local report="$OUT/REPORT.md"
  {
    echo "# Rapport batterie PLM — $STAMP"
    echo ""
    echo "- Durée demandée : ${DURATION}s (~$((DURATION / 60)) min)"
    echo "- Échantillon : ${SAMPLE_SECS}s"
    echo "- USAGE stim : ${USAGE:-1} (0 = lecture calme)"
    echo "- Sortie : \`$OUT\`"
    echo "- API health start : \`$(cat "$OUT/server/start/api-health.json" 2>/dev/null | tr -d '\n' | head -c 200)\`"
    echo ""
    echo "## Appareils"
    echo ""
    local serial id dir
    for serial in $DEVICES_RESOLVED; do
      id="$(safe_id "$serial")"
      dir="$OUT/devices/$id"
      [[ -f "$dir/battery.csv" ]] || continue
      local first last n
      first="$(sed -n '2p' "$dir/battery.csv")"
      last="$(tail -n1 "$dir/battery.csv")"
      n=$(($(wc -l <"$dir/battery.csv") - 1))
      local l0 l1 t0 t1 c0 c1 ts0 ts1
      l0="$(echo "$first" | cut -d, -f2)"
      t0="$(echo "$first" | cut -d, -f3)"
      c0="$(echo "$first" | cut -d, -f4)"
      ts0="$(echo "$first" | cut -d, -f1)"
      l1="$(echo "$last" | cut -d, -f2)"
      t1="$(echo "$last" | cut -d, -f3)"
      c1="$(echo "$last" | cut -d, -f4)"
      ts1="$(echo "$last" | cut -d, -f1)"
      local d_level=$((l0 - l1))
      local d_cc=$((c0 - c1))
      local mah mins rate_mah rate_pct
      mins="$(awk -v a="$ts0" -v b="$ts1" 'BEGIN{printf "%.1f", (b-a)/60}')"
      if [[ "$c0" =~ ^[0-9]+$ && "$c1" =~ ^[0-9]+$ && "$c0" -gt 0 ]]; then
        mah="$(awk -v a="$c0" -v b="$c1" 'BEGIN{printf "%.1f", (a-b)/1000}')"
        rate_mah="$(awk -v m="$mah" -v min="$mins" 'BEGIN{if(min>0) printf "%.0f", m/(min/60); else print "?"}')"
        rate_pct="$(awk -v d="$d_level" -v min="$mins" 'BEGIN{if(min>0) printf "%.1f", d/(min/60); else print "?"}')"
      else
        mah="?"; rate_mah="?"; rate_pct="?"
      fi
      echo "### \`$serial\`"
      echo ""
      echo "| Métrique | Début | Fin | Δ |"
      echo "|---|---:|---:|---:|"
      echo "| level % | $l0 | $l1 | $d_level |"
      echo "| temp (×0.1°C) | $t0 | $t1 | $((t1 - t0)) |"
      echo "| charge_counter | $c0 | $c1 | $d_cc (~${mah} mAh) |"
      echo "| samples | | | $n |"
      echo ""
      echo "- Durée mesurée : **${mins} min**"
      echo "- Rythme : **~${rate_mah} mAh/h** · **~${rate_pct} %/h**"
      # Extraits batterystats utiles
      if [[ -f "$dir/batterystats.txt" ]]; then
        local wifi_rx exo_wl fg
        wifi_rx="$(grep -E 'Wifi data received:' "$dir/batterystats.txt" | head -1 | sed 's/^[[:space:]]*//')"
        exo_wl="$(grep -E 'Wake lock ExoPlayer' "$dir/batterystats.txt" | head -1 | sed 's/^[[:space:]]*//' | cut -c1-160)"
        fg="$(grep -E 'Foreground (activities|services):' "$dir/batterystats.txt" | head -3 | sed 's/^[[:space:]]*/  - /')"
        echo ""
        echo "#### Batterystats (extrait)"
        [[ -n "$wifi_rx" ]] && echo "- $wifi_rx"
        [[ -n "$exo_wl" ]] && echo "- $exo_wl"
        [[ -n "$fg" ]] && echo -e "Foreground:\n$fg"
      fi
      echo ""
      if [[ -f "$dir/meta.txt" ]]; then
        echo '```'
        cat "$dir/meta.txt"
        echo '```'
        echo ""
      fi
      local plugged
      plugged="$(awk -F, 'NR>1 && ($7=="true" || $8=="true"){c++} END{print c+0}' "$dir/battery.csv")"
      if [[ "$plugged" != "0" ]]; then
        echo "⚠️ **$plugged** échantillons encore en charge USB/AC → conso **non fiable**."
        echo ""
      else
        echo "✅ Aucun échantillon en charge USB/AC."
        echo ""
      fi
      # Errors logcat
      if [[ -f "$dir/logcat.txt" ]]; then
        local fatals plays errs
        fatals="$(grep -cE 'FATAL EXCEPTION|AndroidRuntime' "$dir/logcat.txt" 2>/dev/null || echo 0)"
        plays="$(grep -cE 'PlaybackException|Source error' "$dir/logcat.txt" 2>/dev/null || echo 0)"
        errs="$(grep -cE '←-- 502 |timeout|E/ovh' "$dir/logcat.txt" 2>/dev/null || echo 0)"
        echo "#### Logcat"
        echo "- FATAL/Runtime : $fatals · PlaybackException : $plays · 502/timeout/E : $errs"
        echo ""
      fi
    done
    echo "## Fichiers"
    echo ""
    echo "- \`devices/*/battery.csv\` — timeline"
    echo "- \`devices/*/logcat.txt\` — logs app"
    echo "- \`devices/*/batterystats.txt\` — dump fin de session"
    echo "- \`server/start|end/*\` — logs serveur DEV + health"
    echo "- \`session.log\` — journal du runner"
    echo ""
    echo "## Suite"
    echo ""
    echo '```bash'
    echo "make battery-report"
    echo "make battery-report-mail   # → BATTERY_REPORT_TO / SEED_EMAIL"
    echo '```'
  } >"$report"
  log "Rapport → $report"
}

# ---- main ----
mapfile -t _devs < <(resolve_devices)
DEVICES_RESOLVED="${_devs[*]}"
if [[ ${#_devs[@]} -eq 0 ]]; then
  log "❌ Aucun device ADB. make adb-wifi && make adb-wifi-connect"
  exit 1
fi

log "Session $STAMP — devices: ${DEVICES_RESOLVED}"
log "Durée ${DURATION}s | sample ${SAMPLE_SECS}s | out $OUT"

wifi_count=0
for serial in "${_devs[@]}"; do
  [[ "$serial" == *:* ]] && wifi_count=$((wifi_count + 1))
done
if (( wifi_count == 0 )); then
  log "⚠️  Aucun serial Wi‑Fi (host:port). Sur USB la charge fausse la batterie."
  log "    → make adb-wifi && make adb-wifi-connect puis débranche."
fi

if [[ "$REQUIRE_UNPLUGGED" == "1" ]]; then
  for serial in "${_devs[@]}"; do
    if ! is_unplugged "$serial"; then
      log "❌ $serial encore en charge. Débranche, ou REQUIRE_UNPLUGGED=0 make battery-test"
      "$ADB" -s "$serial" shell dumpsys battery 2>/dev/null | grep -E 'powered|level' | head -8 | tee -a "$OUT/session.log" || true
      exit 1
    fi
  done
  log "✅ Tous débranchés (USB/AC false)"
fi

copy_server_logs start

PIDS=()
for serial in "${_devs[@]}"; do
  id="$(safe_id "$serial")"
  dir="$OUT/devices/$id"
  mkdir -p "$dir"
  {
    echo "serial=$serial"
    echo "model=$("$ADB" -s "$serial" shell getprop ro.product.model | tr -d '\r')"
    echo "android=$("$ADB" -s "$serial" shell getprop ro.build.version.release | tr -d '\r')"
    echo "wifi=$([[ "$serial" == *:* ]] && echo yes || echo no)"
    echo "pkg=$PKG"
    "$ADB" -s "$serial" shell dumpsys package "$PKG" 2>/dev/null | awk '/versionName|userId=/{print; if(++n>=3) exit}' | tr -d '\r'
  } >"$dir/meta.txt"

  "$ADB" -s "$serial" shell dumpsys batterystats --reset >/dev/null 2>&1 || true
  echo "ts,level,temp_raw,charge_counter,voltage,status,usb_powered,ac_powered,wireless_powered,current_now_ua" >"$dir/battery.csv"
  start_logcat "$serial" "$dir"
  # Lance l’app
  "$ADB" -s "$serial" shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1 || true
done

END_AT=$((SECONDS + DURATION))
tick=0
log "▶ Mesure en cours… (Ctrl+C pour couper → rapport partiel)"

cleanup() {
  log "Arrêt / finalisation…"
  for serial in "${_devs[@]}"; do
    id="$(safe_id "$serial")"
    dir="$OUT/devices/$id"
    stop_pidfile "$dir/logcat.pid"
    "$ADB" -s "$serial" shell dumpsys batterystats "$PKG" >"$dir/batterystats.txt" 2>/dev/null || \
      "$ADB" -s "$serial" shell dumpsys batterystats >"$dir/batterystats.txt" 2>/dev/null || true
  done
  copy_server_logs end
  write_report
  # Copie pratique à la racine logs/
  ln -sfn "$OUT" "$ROOT/logs/battery-session/latest" 2>/dev/null || true
  log "DONE → $OUT/REPORT.md"
}
trap cleanup EXIT

while (( SECONDS < END_AT )); do
  now="$(date +%s)"
  for serial in "${_devs[@]}"; do
    id="$(safe_id "$serial")"
    dir="$OUT/devices/$id"
    dump="$(battery_snapshot "$serial")"
    fields="$(echo "$dump" | parse_battery_line)"
    cur="$(current_now_ua "$serial")"
    echo "$now,$fields,${cur}" >>"$dir/battery.csv"
    if [[ "$USAGE" == "1" ]]; then
      usage_tick "$serial" "$tick" || true
    fi
  done
  # Progress chaque ~minute
  if (( tick % 4 == 0 )); then
    left=$((END_AT - SECONDS))
    log "… t+$((DURATION - left))s / ${DURATION}s restant≈${left}s"
  fi
  # Refresh serveur toutes ~5 min
  if (( tick > 0 && tick % 20 == 0 )); then
    copy_server_logs "t$(printf '%04d' "$tick")"
  fi
  tick=$((tick + 1))
  sleep "$SAMPLE_SECS"
done

log "✅ Durée écoulée"
