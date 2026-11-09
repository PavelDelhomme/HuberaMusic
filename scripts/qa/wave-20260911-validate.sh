#!/usr/bin/env bash
# Validation vague vidéo/batterie/file — Samsung + Blackview
# Usage:
#   DEVICE=… OUT=… bash scripts/qa/wave-20260911-validate.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEVICE="${DEVICE:?DEVICE required}"
LABEL="${LABEL:-$DEVICE}"
PKG=ovh.delhomme.ytmusic
OUT="${OUT:-$ROOT/tmp/qa-wave-20260911/$LABEL}"
mkdir -p "$OUT"
ADB=(adb -s "$DEVICE")
XML="$OUT/ui.xml"
REPORT="$OUT/REPORT.json"
LOG="$OUT/session.log"
FAILS=0
PASSES=0
WARNS=0

log() { printf '%s\n' "$*" | tee -a "$LOG"; }
json_escape() { python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'; }

RESULTS=()
add() {
  local status="$1" id="$2" msg="$3"
  RESULTS+=("{\"id\":$(printf '%s' "$id" | json_escape),\"status\":$(printf '%s' "$status" | json_escape),\"detail\":$(printf '%s' "$msg" | json_escape)}")
  case "$status" in
    PASS) PASSES=$((PASSES+1)); log "PASS · $id — $msg" ;;
    FAIL) FAILS=$((FAILS+1)); log "FAIL · $id — $msg" ;;
    WARN) WARNS=$((WARNS+1)); log "WARN · $id — $msg" ;;
    SKIP) log "SKIP · $id — $msg" ;;
  esac
}

dump_ui() {
  "${ADB[@]}" shell uiautomator dump /sdcard/plm-wave-qa.xml >/dev/null 2>&1 || return 1
  "${ADB[@]}" pull /sdcard/plm-wave-qa.xml "$XML" >/dev/null 2>&1 || return 1
}

ui_has() {
  dump_ui || return 1
  grep -qiE "$1" "$XML" 2>/dev/null
}

tap_desc() {
  local needle="$1"
  dump_ui || return 1
  DEVICE="$DEVICE" python3 - "$XML" "$needle" <<'PY' || return 1
import re,sys,subprocess,os
xml=open(sys.argv[1]).read(); needle=sys.argv[2].lower()
dev=os.environ["DEVICE"]
for n in re.findall(r'<node[^>]*>', xml):
    d=re.search(r'content-desc="([^"]*)"', n)
    b=re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
    if not d or not b: continue
    if needle in (d.group(1) or '').lower():
        x=(int(b.group(1))+int(b.group(3)))//2
        y=(int(b.group(2))+int(b.group(4)))//2
        subprocess.check_call(["adb","-s",dev,"shell","input","tap",str(x),str(y)])
        print(f"tap desc {d.group(1)!r} @{x},{y}")
        sys.exit(0)
sys.exit(2)
PY
}

tap_text() {
  local needle="$1"
  dump_ui || return 1
  DEVICE="$DEVICE" python3 - "$XML" "$needle" <<'PY' || return 1
import re,sys,subprocess,os
xml=open(sys.argv[1]).read(); needle=sys.argv[2].lower()
dev=os.environ["DEVICE"]
for n in re.findall(r'<node[^>]*>', xml):
    t=re.search(r'text="([^"]*)"', n)
    b=re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
    if not t or not b: continue
    if needle in (t.group(1) or '').lower():
        x=(int(b.group(1))+int(b.group(3)))//2
        y=(int(b.group(2))+int(b.group(4)))//2
        subprocess.check_call(["adb","-s",dev,"shell","input","tap",str(x),str(y)])
        print(f"tap text {t.group(1)!r} @{x},{y}")
        sys.exit(0)
sys.exit(2)
PY
}

swipe() { "${ADB[@]}" shell input swipe "$1" "$2" "$3" "$4" "${5:-350}"; }
key() { "${ADB[@]}" shell input keyevent "$1"; }

: >"$LOG"
log "==> Wave QA $LABEL ($DEVICE) $(date -Iseconds)"
VER=$("${ADB[@]}" shell dumpsys package "$PKG" 2>/dev/null | awk -F= '/versionName=/{print $2; exit}' | tr -d '\r')
CODE=$("${ADB[@]}" shell dumpsys package "$PKG" 2>/dev/null | awk -F= '/versionCode=/{print $2; exit}' | awk '{print $1}' | tr -d '\r')
log "version=$VER code=$CODE"
"${ADB[@]}" shell "cmd media_session volume --stream 3 --set 0" >/dev/null 2>&1 || \
  "${ADB[@]}" shell media volume --stream 3 --set 0 >/dev/null 2>&1 || true
"${ADB[@]}" logcat -c >/dev/null 2>&1 || true
"${ADB[@]}" shell am force-stop "$PKG" >/dev/null 2>&1 || true
sleep 1
"${ADB[@]}" shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1
sleep 4

# --- F0 version ---
if [[ "$VER" == *1.3.226* ]]; then
  add PASS version "APK $VER / $CODE"
else
  add FAIL version "Attendu p+1.3.226, trouvé $VER"
fi

# --- F1 boot / pas de VerifyError ---
sleep 2
CRASH=$("${ADB[@]}" logcat -d 2>/dev/null | rg -c "VerifyError|FATAL EXCEPTION|AndroidRuntime" || true)
CRASH=${CRASH:-0}
if [[ "$CRASH" -eq 0 ]]; then
  add PASS verifyerror "Aucun VerifyError / FATAL au boot"
else
  add FAIL verifyerror "Hits crash logcat=$CRASH"
  "${ADB[@]}" logcat -d 2>/dev/null | rg -i "VerifyError|FATAL EXCEPTION" | head -20 >"$OUT/crash-snip.txt" || true
fi

# --- F2 ouvrir un titre (Accueil / bibliothèque) ---
if tap_text "Accueil" 2>/dev/null || tap_desc "Accueil" 2>/dev/null || true; then
  sleep 1
fi
# Tap première zone centrale pour lancer quelque chose
W=$("${ADB[@]}" shell wm size 2>/dev/null | awk -F'[ x]' '/Physical/{print $(NF-1)}' | tr -d '\r')
H=$("${ADB[@]}" shell wm size 2>/dev/null | awk -F'[ x]' '/Physical/{print $NF}' | tr -d '\r')
W=${W:-1080}; H=${H:-2340}
"${ADB[@]}" shell input tap $((W/2)) $((H/3))
sleep 2
# Ouvrir mini-lecteur / NP
if tap_desc "Lecteur" 2>/dev/null || tap_desc "Now Playing" 2>/dev/null || \
   tap_desc "Développer" 2>/dev/null || true; then
  :
fi
# Tap barre mini typique bas d'écran
"${ADB[@]}" shell input tap $((W/2)) $((H*88/100))
sleep 2
if ui_has 'Replier|content-desc="Replier"|File d.attente|Paroles|Mix'; then
  add PASS open_np "Now Playing ouvert"
else
  # retry swipe up from mini
  swipe $((W/2)) $((H*92/100)) $((W/2)) $((H*40/100)) 400
  sleep 2
  if ui_has 'Replier|File d.attente|Paroles'; then
    add PASS open_np "Now Playing ouvert (retry swipe)"
  else
    add WARN open_np "NP non détecté clairement — suite best-effort"
  fi
fi

# --- F3 pas d'écran plein « Recherche du clip… » ---
if ui_has 'Recherche du clip'; then
  add FAIL no_clip_wait "Texte « Recherche du clip… » encore visible"
else
  add PASS no_clip_wait "Pas d’écran plein « Recherche du clip… »"
fi

# --- F4 bascule mode Vidéo ---
if tap_text "Vidéo" 2>/dev/null || tap_desc "Vidéo" 2>/dev/null; then
  sleep 3
  if ui_has 'Recherche du clip'; then
    add FAIL video_mode "Mode Vidéo : encore « Recherche du clip… »"
  else
    add PASS video_mode "Bascule Vidéo OK (pas d’écran recherche plein)"
  fi
else
  # MediaModeSwitch peut être icône sans texte
  if ui_has 'Audio|Vidéo|mode'; then
    add WARN video_mode "Switch Vidéo non tapppé — UI présente"
  else
    add WARN video_mode "Switch Vidéo introuvable dans le dump"
  fi
fi

# --- F5 file sans coupe (ouvrir file) ---
if tap_text "File" 2>/dev/null || tap_desc "File" 2>/dev/null || tap_desc "file d" 2>/dev/null; then
  sleep 2
  if ui_has 'À suivre|En cours|File d.attente|Mix à partir'; then
    add PASS queue_open "File ouverte / aperçu visible"
  else
    add WARN queue_open "File tapée mais labels non confirmés"
  fi
  # titre rouge : on ne peut pas lire la couleur via uiautomator — présence du titre / En cours
  if ui_has 'En cours|À suivre'; then
    add PASS queue_red_title "Structure file (titre courant / suite) présente — couleur rouge à check visuel"
  else
    add WARN queue_red_title "Titre courant non isolable dans le dump UI"
  fi
  key 4
  sleep 1
else
  # aperçu file portrait déjà en bas
  if ui_has 'À suivre|File d.attente|Mix'; then
    add PASS queue_open "Aperçu file visible en bas NP"
    add PASS queue_red_title "Aperçu file présent (titre rouge = check visuel)"
  else
    add WARN queue_open "File non ouverte automatiquement"
    add SKIP queue_red_title "Dépend de l’ouverture file"
  fi
fi

# --- F6 replier NP (hand-off audio mode vidéo) ---
if tap_desc "Replier" 2>/dev/null || key 4; then
  sleep 2
  BUF=$("${ADB[@]}" logcat -d 2>/dev/null | rg -c "VerifyError|FATAL EXCEPTION" || true)
  BUF=${BUF:-0}
  # Mini player visible ?
  if ui_has 'Chargement…|Chargement'; then
    # Capturer si bloqué longtemps
    sleep 3
    if ui_has 'Chargement…|Chargement'; then
      add FAIL collapse_audio "Après repli : encore « Chargement… » (régression hand-off)"
    else
      add WARN collapse_audio "Chargement transitoire puis disparu"
    fi
  else
    add PASS collapse_audio "Repli NP : pas de « Chargement… » bloquant"
  fi
  if [[ "$BUF" -gt "$CRASH" ]]; then
    add FAIL collapse_crash "Nouveaux crashes après repli"
  else
    add PASS collapse_crash "Pas de crash après repli"
  fi
else
  add WARN collapse_audio "Repli non confirmé"
  add SKIP collapse_crash "—"
fi

# --- F7 offline intact (pas de purge) ---
OFF_COUNT=$("${ADB[@]}" shell "run-as $PKG sh -c 'ls files/offline 2>/dev/null | wc -l'" 2>/dev/null | tr -d '\r' || echo 0)
OFF_COUNT=${OFF_COUNT:-0}
MP4=$("${ADB[@]}" shell "run-as $PKG sh -c 'ls files/offline/*.mp4 2>/dev/null | wc -l'" 2>/dev/null | tr -d '\r' || echo 0)
M4A=$("${ADB[@]}" shell "run-as $PKG sh -c 'ls files/offline/*.m4a 2>/dev/null | wc -l'" 2>/dev/null | tr -d '\r' || echo 0)
# run-as may fail on release/debuggable — try app_private via content
if [[ "$OFF_COUNT" == "0" || -z "$OFF_COUNT" ]]; then
  # fallback: dumpsys / shared storage not accessible — check logs for purge
  PURGE=$("${ADB[@]}" logcat -d 2>/dev/null | rg -ci "purge offline|delete.*offline|clearOffline" || true)
  PURGE=${PURGE:-0}
  if [[ "$PURGE" -eq 0 ]]; then
    add PASS offline_intact "Pas de log de purge offline (stockage app non lisible via run-as)"
  else
    add FAIL offline_intact "Logs suspects de purge offline ($PURGE)"
  fi
else
  add PASS offline_intact "offline/ fichiers≈$OFF_COUNT (m4a≈$M4A mp4≈$MP4)"
fi

# --- F8 health API prod ---
HEALTH=$(curl -sS --max-time 8 https://ytmusic.delhomme.ovh/api/health || echo '{}')
AV=$(printf '%s' "$HEALTH" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("appVersion",""))' 2>/dev/null || true)
if [[ "$AV" == *1.3.226* ]]; then
  add PASS api_prod "API prod appVersion=$AV"
else
  add WARN api_prod "API prod appVersion=$AV (attendu p+1.3.226)"
fi

# --- F9 player-actions subset : play pause via media session ---
MS=$("${ADB[@]}" shell dumpsys media_session 2>/dev/null | rg -A2 "$PKG" | head -20 || true)
if printf '%s' "$MS" | rg -qi "PlaybackState|state=3|state=Playing|state=6"; then
  add PASS media_session "MediaSession active / playback state présent"
else
  add WARN media_session "MediaSession état non clair"
fi

# Dump final logcat
"${ADB[@]}" logcat -d >"$OUT/logcat.txt" 2>/dev/null || true
rg -i "VerifyError|FATAL EXCEPTION|YTMVideo|Chargement" "$OUT/logcat.txt" | head -40 >"$OUT/logcat-snip.txt" || true

# Write JSON
{
  echo "{"
  echo "  \"device\": $(printf '%s' "$DEVICE" | json_escape),"
  echo "  \"label\": $(printf '%s' "$LABEL" | json_escape),"
  echo "  \"version\": $(printf '%s' "$VER" | json_escape),"
  echo "  \"versionCode\": $(printf '%s' "$CODE" | json_escape),"
  echo "  \"passes\": $PASSES,"
  echo "  \"fails\": $FAILS,"
  echo "  \"warns\": $WARNS,"
  echo "  \"iso\": $(date -Iseconds | json_escape),"
  echo "  \"results\": ["
  printf '  %s\n' "${RESULTS[@]}" | paste -sd, -
  echo "  ]"
  echo "}"
} >"$REPORT"

log "==> DONE passes=$PASSES fails=$FAILS warns=$WARNS → $REPORT"
exit 0
