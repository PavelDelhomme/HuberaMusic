#!/usr/bin/env bash
# Suite batterie multi-scénarios (~45 min total) — Nothing / Samsung Wi‑Fi.
#
# Phases (DURATION_PHASE chacune, défaut 900s = 15 min → ~45 min) :
#   1) screen_off   — lecture + écran OFF (vérifie isPlaying)
#   2) screen_on    — lecture + écran ON
#   3) mixed        — lecture + bascules écran + légers taps
#
# Usage :
#   bash scripts/battery-suite.sh
#   DURATION_PHASE=900 bash scripts/battery-suite.sh
#   make battery-suite
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADB="${ADB_BIN:-adb}"
PKG=ovh.delhomme.ytmusic
DURATION_PHASE="${DURATION_PHASE:-900}"
SAMPLE_SECS="${SAMPLE_SECS:-15}"
STAMP="${BATTERY_SUITE_STAMP:-$(date +%Y%m%d-%H%M%S)}"
OUT="${BATTERY_SUITE_OUT:-$ROOT/logs/battery-suite/$STAMP}"
mkdir -p "$OUT"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$OUT/suite.log"; }
trap 'ec=$?; log "❌ ERR exit=$ec line=$LINENO cmd=$BASH_COMMAND"; exit $ec' ERR

resolve_device() {
  if [[ -n "${DEVICES:-}" ]]; then
    echo "$DEVICES" | tr ',' '\n' | head -1
    return
  fi
  # Préfère Wi‑Fi Nothing / Samsung
  local t
  t="$("$ADB" devices -l | awk '/model:A059|Asteroids/{print $1; exit}')"
  [[ -n "$t" ]] && { echo "$t"; return; }
  t="$("$ADB" devices | awk 'NR>1 && $2=="device" && $1 ~ /:/{print $1; exit}')"
  [[ -n "$t" ]] && { echo "$t"; return; }
  t="$("$ADB" devices | awk 'NR>1 && $2=="device"{print $1; exit}')"
  echo "$t"
}

DEVICE="$(resolve_device)"
if [[ -z "$DEVICE" ]]; then
  log "❌ Aucun device ADB"
  exit 1
fi
log "device=$DEVICE out=$OUT phase=${DURATION_PHASE}s × 3"

is_unplugged() {
  local usb ac
  usb="$("$ADB" -s "$DEVICE" shell dumpsys battery 2>/dev/null | awk -F': ' '/USB powered:/{print $2; exit}' | tr -d ' \r')"
  ac="$("$ADB" -s "$DEVICE" shell dumpsys battery 2>/dev/null | awk -F': ' '/AC powered:/{print $2; exit}' | tr -d ' \r')"
  [[ "$usb" == "false" && "$ac" == "false" ]]
}

media_playing() {
  local dump line hit=0 block=""
  dump="$("$ADB" -s "$DEVICE" shell dumpsys media_session 2>/dev/null || true)"
  dump="${dump//$'\r'/}"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == *'package=ovh.delhomme.ytmusic'* ]]; then
      hit=1
      block=""
      continue
    fi
    if (( hit )); then
      if [[ "$line" =~ ^[[:space:]]*package= ]]; then
        break
      fi
      block+="$line"$'\n'
    fi
  done <<< "$dump"
  [[ "$block" == *'state=PLAYING'* ]]
}

media_paused() {
  local dump line hit=0 block=""
  dump="$("$ADB" -s "$DEVICE" shell dumpsys media_session 2>/dev/null || true)"
  dump="${dump//$'\r'/}"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == *'package=ovh.delhomme.ytmusic'* ]]; then
      hit=1
      block=""
      continue
    fi
    if (( hit )); then
      if [[ "$line" =~ ^[[:space:]]*package= ]]; then
        break
      fi
      block+="$line"$'\n'
    fi
  done <<< "$dump"
  [[ "$block" == *'state=PAUSED'* ]]
}

ensure_playing() {
  local tries=0
  set +e
  # Déverrouille avant de forcer la lecture (lock soft / swipe)
  "$ADB" -s "$DEVICE" shell input keyevent 224 >/dev/null 2>&1 || true
  sleep 0.3
  "$ADB" -s "$DEVICE" shell input keyevent 82 >/dev/null 2>&1 || true
  "$ADB" -s "$DEVICE" shell input swipe 540 1800 540 600 300 >/dev/null 2>&1 || true
  sleep 0.5
  while (( tries < 12 )); do
    if media_playing; then
      log "✅ lecture PLAYING"
      set -e
      return 0
    fi
    log "… pas de lecture — MEDIA_PLAY (try $((tries+1)))"
    # Ne relance l’Activity qu’au 1er essai (sinon ça coupe Exo)
    if (( tries == 0 )); then
      "$ADB" -s "$DEVICE" shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1 || true
      sleep 1
      "$ADB" -s "$DEVICE" shell input swipe 540 1800 540 600 300 >/dev/null 2>&1 || true
    fi
    "$ADB" -s "$DEVICE" shell input keyevent 126 >/dev/null 2>&1 || true
    sleep 4
    tries=$((tries + 1))
  done
  log "⚠️  Impossible de confirmer PLAYING — on continue quand même"
  set -e
  return 0
}

screen_is_off() {
  local dump
  dump="$("$ADB" -s "$DEVICE" shell dumpsys power 2>/dev/null || true)"
  dump="${dump//$'\r'/}"
  [[ "$dump" == *'mWakefulness=Asleep'* || "$dump" == *'mWakefulness=Dozing'* ]]
}

screen_off() {
  # Ne jamais taper POWER si déjà éteint : keyevent 26 TOGGLE → rallume + lock.
  "$ADB" -s "$DEVICE" shell svc power stayon false >/dev/null 2>&1 || true
  if screen_is_off; then
    return 0
  fi
  # HOME d’abord : Activity hors foreground, FGS média continue → moins de drain UI
  "$ADB" -s "$DEVICE" shell input keyevent 3 >/dev/null 2>&1 || true # HOME
  sleep 0.4
  # SLEEP d’abord (pas de toggle) ; POWER seulement si encore allumé
  "$ADB" -s "$DEVICE" shell input keyevent 223 >/dev/null 2>&1 || true # SLEEP
  sleep 0.5
  if screen_is_off; then
    return 0
  fi
  "$ADB" -s "$DEVICE" shell input keyevent 26 >/dev/null 2>&1 || true
  sleep 0.5
  if ! screen_is_off; then
    "$ADB" -s "$DEVICE" shell input keyevent 223 >/dev/null 2>&1 || true
    sleep 0.3
  fi
}

screen_on() {
  if ! screen_is_off; then
    "$ADB" -s "$DEVICE" shell svc power stayon true >/dev/null 2>&1 || true
    return 0
  fi
  "$ADB" -s "$DEVICE" shell input keyevent 224 >/dev/null 2>&1 || true # WAKEUP
  sleep 0.4
  # Swipe / menu pour déverrouiller si lock soft (timeout utilisateur ≈ 30 min)
  "$ADB" -s "$DEVICE" shell input keyevent 82 >/dev/null 2>&1 || true
  "$ADB" -s "$DEVICE" shell input swipe 540 1800 540 600 300 >/dev/null 2>&1 || true
  "$ADB" -s "$DEVICE" shell svc power stayon true >/dev/null 2>&1 || true
}

run_phase() {
  local name="$1"
  local mode="$2" # off | on | mixed
  local phase_out="$OUT/phases/$name"
  mkdir -p "$phase_out"

  log "═══ PHASE $name ($mode) ${DURATION_PHASE}s ═══"
  if ! is_unplugged; then
    log "❌ Encore en charge — débranche"
    exit 1
  fi
  ensure_playing || true

  case "$mode" in
    off) screen_off ;;
    on) screen_on ;;
    mixed) screen_on ;;
  esac

  # Sous-processus : échantillons + maintien lecture / scénario
  local csv="$phase_out/battery.csv"
  echo "ts,level,temp_raw,charge_counter,voltage,status,usb_powered,ac_powered,wireless_powered,playing,screen_hint" >"$csv"
  "$ADB" -s "$DEVICE" shell dumpsys batterystats --reset >/dev/null 2>&1 || true
  "$ADB" -s "$DEVICE" logcat -c >/dev/null 2>&1 || true
  nohup "$ADB" -s "$DEVICE" logcat -v threadtime "*:W" "$PKG:V" \
    >"$phase_out/logcat.txt" 2>/dev/null &
  echo $! >"$phase_out/logcat.pid"

  local end=$((SECONDS + DURATION_PHASE))
  local tick=0
  while (( SECONDS < end )); do
    # Maintenir lecture (MEDIA_PLAY peut réveiller l’écran → re-éteindre en mode off)
    if ! media_playing; then
      "$ADB" -s "$DEVICE" shell input keyevent 126 >/dev/null 2>&1 || true
      if [[ "$mode" == "off" ]]; then
        sleep 0.3
        screen_off
      fi
    fi
    case "$mode" in
      off)
        # Vérifie / ré-éteint sans toggle POWER si déjà Dozing
        if (( tick % 4 == 0 )); then screen_off; fi
        ;;
      on)
        if (( tick % 8 == 0 )); then screen_on; fi
        ;;
      mixed)
        # Alternance ~2 min ON / ~1 min OFF (OFF < lock 30 min)
        local cycle=$((tick % 12))
        if (( cycle < 8 )); then
          screen_on
          if (( tick % 3 == 0 )); then
            "$ADB" -s "$DEVICE" shell input tap 80 200 >/dev/null 2>&1 || true
          fi
        else
          screen_off
        fi
        ;;
    esac

    local dump playing screen_hint wake
    dump="$("$ADB" -s "$DEVICE" shell dumpsys battery 2>/dev/null | tr -d '\r')"
    playing=0
    media_playing && playing=1 || true
    wake="?"
    pwr="$("$ADB" -s "$DEVICE" shell dumpsys power 2>/dev/null || true)"
    pwr="${pwr//$'\r'/}"
    if [[ "$pwr" =~ mWakefulness=([A-Za-z]+) ]]; then
      wake="${BASH_REMATCH[1]}"
    fi
    screen_hint="${mode}:${wake}"
    local fields
    fields="$(echo "$dump" | awk -F': ' '
      /USB powered:/{usb=$2}
      /AC powered:/{ac=$2}
      /Wireless powered:/{wl=$2}
      /^  level:/{lvl=$2}
      /temperature:/{temp=$2}
      /Charge counter:/{cc=$2}
      /voltage:/{volt=$2}
      /status:/{st=$2}
      END {
        gsub(/[ \t]/,"",usb); gsub(/[ \t]/,"",ac); gsub(/[ \t]/,"",wl)
        gsub(/[ \t]/,"",lvl); gsub(/[ \t]/,"",temp); gsub(/[ \t]/,"",cc)
        gsub(/[ \t]/,"",volt); gsub(/[ \t]/,"",st)
        printf "%s,%s,%s,%s,%s,%s,%s,%s", lvl+0, temp+0, cc+0, volt+0, st, usb, ac, wl
      }')"
    echo "$(date +%s),$fields,$playing,$screen_hint" >>"$csv"

    if (( tick % 4 == 0 )); then
      local left=$((end - SECONDS))
      log "  [$name] t+$((DURATION_PHASE - left))s restant≈${left}s playing=$playing"
    fi
    tick=$((tick + 1))
    sleep "$SAMPLE_SECS"
  done

  if [[ -f "$phase_out/logcat.pid" ]]; then
    kill "$(cat "$phase_out/logcat.pid")" 2>/dev/null || true
    rm -f "$phase_out/logcat.pid"
  fi
  "$ADB" -s "$DEVICE" shell dumpsys batterystats "$PKG" >"$phase_out/batterystats.txt" 2>/dev/null || true
  {
    echo "phase=$name"
    echo "mode=$mode"
    echo "device=$DEVICE"
    echo "duration=$DURATION_PHASE"
    "$ADB" -s "$DEVICE" shell getprop ro.product.model | tr -d '\r' | sed 's/^/model=/'
    "$ADB" -s "$DEVICE" shell dumpsys package "$PKG" 2>/dev/null | awk '/versionName/{print; exit}' | tr -d '\r'
  } >"$phase_out/meta.txt"

  log "✅ phase $name terminée"
}

summarize_csv() {
  local csv="$1"
  python3 - "$csv" <<'PY'
import csv, sys
from pathlib import Path
p=Path(sys.argv[1])
rows=list(csv.DictReader(p.open()))
if len(rows)<2:
  print("samples=0"); raise SystemExit
t0=int(rows[0]['ts']); t1=int(rows[-1]['ts'])
l0=int(float(rows[0]['level'])); l1=int(float(rows[-1]['level']))
c0=float(rows[0]['charge_counter']); c1=float(rows[-1]['charge_counter'])
mins=max((t1-t0)/60, 0.01)
mah=(c0-c1)/1000
play=sum(1 for r in rows if r.get('playing')=='1')
print(f"mins={mins:.1f}")
print(f"level_delta={l0-l1}")
print(f"mah={mah:.1f}")
print(f"mah_per_h={mah/(mins/60):.0f}")
print(f"pct_per_h={(l0-l1)/(mins/60):.1f}")
print(f"temp={float(rows[0]['temp_raw'])/10:.1f}->{float(rows[-1]['temp_raw'])/10:.1f}")
print(f"playing_samples={play}/{len(rows)}")
print(f"level={l0}->{l1}")
PY
}

write_suite_report() {
  local report="$OUT/SUITE_REPORT.md"
  {
    echo "# Suite batterie PLM — $STAMP"
    echo ""
    echo "- Device : \`$DEVICE\`"
    echo "- Phase : ${DURATION_PHASE}s × 3 (~$((DURATION_PHASE * 3 / 60)) min)"
    echo "- Sample : ${SAMPLE_SECS}s"
    echo ""
    echo "## Résultats par phase"
    echo ""
    echo "| Phase | Mode | Δ% | mAh | mAh/h | %/h | Playing | Temp |"
    echo "|---|---|---:|---:|---:|---:|---:|---|"
    local name
    for name in screen_off screen_on mixed; do
      local csv="$OUT/phases/$name/battery.csv"
      [[ -f "$csv" ]] || continue
      eval "$(summarize_csv "$csv" | sed 's/^/export /')"
      echo "| $name | $(head -1 "$OUT/phases/$name/meta.txt" 2>/dev/null | cut -d= -f2 || echo ?) | ${level_delta} | ${mah} | ${mah_per_h} | ${pct_per_h} | ${playing_samples} | ${temp} |"
      # batterystats snippets
    done
    echo ""
    echo "## Détails ExoPlayer / Wi‑Fi"
    echo ""
    for name in screen_off screen_on mixed; do
      local bs="$OUT/phases/$name/batterystats.txt"
      [[ -f "$bs" ]] || continue
      echo "### $name"
      grep -E 'Wifi data received:|Wake lock ExoPlayer|Wake lock AudioMix|Foreground services:|Foreground activities:' "$bs" 2>/dev/null | head -8 | sed 's/^/- /'
      echo ""
    done
    echo "## Comparaison sessions précédentes"
    echo ""
    echo "| Session | Type | Δ% | mAh | %/h | Notes |"
    echo "|---|---|---:|---:|---:|---|"
    echo "| 20260806-230322 | stress USAGE=1 | 4 | 198 | 8.0 | skips ADB + stream |"
    echo "| 20260806-235424 | « calm » raté | 6 | 286 | 12.0 | écran ON, presque pas de lecture |"
    echo "| $STAMP (cette suite) | off / on / mixed | voir tableau | | | lecture maintenue |"
    echo ""
    echo "## Fichiers"
    echo ""
    echo "- \`$OUT/phases/*/battery.csv\`"
    echo "- \`$OUT/phases/*/logcat.txt\`"
    echo "- \`$OUT/phases/*/batterystats.txt\`"
    echo "- \`$OUT/suite.log\`"
  } >"$report"
  ln -sfn "$OUT" "$ROOT/logs/battery-suite/latest" 2>/dev/null || true
  log "Rapport → $report"
  cat "$report"
}

# ---- main ----
if ! is_unplugged; then
  log "❌ Branche encore en charge — débranche le Nothing"
  exit 1
fi

run_phase screen_off off
run_phase screen_on on
run_phase mixed mixed
write_suite_report

# Mail optionnel
if [[ "${MAIL:-1}" == "1" ]]; then
  log "==> envoi email (si SMTP OK)"
  # Réutilise le mailer en pointant une « session » synthétique : on zip la suite
  (
    cd "$OUT"
    zip -qr "/tmp/plm-battery-suite-$STAMP.zip" SUITE_REPORT.md suite.log phases/*/battery.csv phases/*/meta.txt 2>/dev/null || true
    for d in phases/*/logcat.txt; do
      [[ -f "$d" ]] || continue
      tail -c 200000 "$d" >"/tmp/suite-$(basename $(dirname $d))-logcat.txt"
      zip -qj "/tmp/plm-battery-suite-$STAMP.zip" "/tmp/suite-$(basename $(dirname $d))-logcat.txt" 2>/dev/null || true
    done
  )
  # Construit un faux layout battery-session pour le mailer OU envoie via API directe
  SESSION_DIR="$ROOT/logs/battery-session/suite-$STAMP"
  mkdir -p "$SESSION_DIR/devices/suite" "$SESSION_DIR/server/start"
  cp -f "$OUT/SUITE_REPORT.md" "$SESSION_DIR/REPORT.md"
  # Fusionne les 3 CSV pour un résumé global
  python3 - "$OUT" "$SESSION_DIR/devices/suite/battery.csv" <<'PY'
import csv,sys
from pathlib import Path
root=Path(sys.argv[1]); out=Path(sys.argv[2])
rows=[]
for name in ['screen_off','screen_on','mixed']:
  p=root/'phases'/name/'battery.csv'
  if not p.exists(): continue
  for r in csv.DictReader(p.open()):
    rows.append(r)
if not rows:
  raise SystemExit(0)
# write minimal csv compatible with mailer
fields=['ts','level','temp_raw','charge_counter','voltage','status','usb_powered','ac_powered','wireless_powered','current_now_ua']
with out.open('w',newline='') as f:
  w=csv.DictWriter(f, fieldnames=fields)
  w.writeheader()
  for r in rows:
    w.writerow({k:r.get(k,'') for k in fields})
PY
  echo "serial=$DEVICE" >"$SESSION_DIR/devices/suite/meta.txt"
  echo "model=suite" >>"$SESSION_DIR/devices/suite/meta.txt"
  echo "wifi=yes" >>"$SESSION_DIR/devices/suite/meta.txt"
  echo '{"ok":true}' >"$SESSION_DIR/server/start/api-health.json"
  ln -sfn "$SESSION_DIR" "$ROOT/logs/battery-session/latest"
  cd "$ROOT" && node --env-file=.env scripts/battery-mail-report.mjs || log "mail soft-fail"
fi

log "DONE suite $STAMP"
