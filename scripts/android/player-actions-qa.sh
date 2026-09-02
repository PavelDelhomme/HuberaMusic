#!/usr/bin/env bash
# QA ultra poussée — actions lecteur / file (sans suppression destructive).
# Usage: DEVICE=192.168.1.184:35357 bash scripts/android/player-actions-qa.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEVICE="${DEVICE:-192.168.1.184:35357}"
PKG=ovh.delhomme.ytmusic
OUT="${OUT:-$ROOT/logs/player-qa-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"
ADB=(adb -s "$DEVICE")
XML=/tmp/plm-qa-ui.xml
REPORT="$OUT/REPORT.md"
LOGCAT="$OUT/logcat.txt"

log() { printf '%s\n' "$*" | tee -a "$OUT/session.log"; }
pass() { log "PASS · $*"; echo "- PASS: $*" >>"$REPORT"; }
fail() { log "FAIL · $*"; echo "- FAIL: $*" >>"$REPORT"; FAILS=$((FAILS+1)); }
warn() { log "WARN · $*"; echo "- WARN: $*" >>"$REPORT"; }
skip() { log "SKIP · $*"; echo "- SKIP: $*" >>"$REPORT"; }

FAILS=0
{
  echo "# QA lecteur multimédia — $(date -Iseconds)"
  echo
  echo "- Device: \`$DEVICE\`"
  echo "- Package: \`$PKG\`"
  echo
  echo "## Résultats"
  echo
} >"$REPORT"

"${ADB[@]}" shell media volume --stream 3 --set 0 >/dev/null 2>&1 || true
"${ADB[@]}" logcat -c >/dev/null 2>&1 || true

dump_ui() {
  "${ADB[@]}" shell uiautomator dump /sdcard/plm-qa.xml >/dev/null
  "${ADB[@]}" pull /sdcard/plm-qa.xml "$XML" >/dev/null
}

has_text() {
  dump_ui
  grep -q "text=\"$1\"" "$XML" 2>/dev/null
}

tap_text() {
  local needle="$1"
  dump_ui
  python3 - "$XML" "$needle" <<'PY'
import re,sys,subprocess,os
xml=open(sys.argv[1]).read(); needle=sys.argv[2]
dev=os.environ.get("DEVICE","")
for n in re.findall(r'<node[^>]*>', xml):
    t=re.search(r'(?:text|content-desc)="([^"]*)"', n)
    b=re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
    if not t or not b: continue
    if needle.lower() in (t.group(1) or '').lower():
        x=(int(b.group(1))+int(b.group(3)))//2
        y=(int(b.group(2))+int(b.group(4)))//2
        subprocess.check_call(["adb","-s",dev,"shell","input","tap",str(x),str(y)])
        print(f"tapped {t.group(1)!r} @ {x},{y}")
        sys.exit(0)
sys.exit(2)
PY
}

tap_desc() {
  local needle="$1"
  dump_ui
  python3 - "$XML" "$needle" <<'PY'
import re,sys,subprocess,os
xml=open(sys.argv[1]).read(); needle=sys.argv[2].lower()
dev=os.environ.get("DEVICE","")
for n in re.findall(r'<node[^>]*>', xml):
    d=re.search(r'content-desc="([^"]*)"', n)
    b=re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
    if not d or not b: continue
    if needle in (d.group(1) or '').lower():
        x=(int(b.group(1))+int(b.group(3)))//2
        y=(int(b.group(2))+int(b.group(4)))//2
        subprocess.check_call(["adb","-s",dev,"shell","input","tap",str(x),str(y)])
        print(f"tapped desc={d.group(1)!r} @ {x},{y}")
        sys.exit(0)
sys.exit(2)
PY
}

tap_xy() { "${ADB[@]}" shell input tap "$1" "$2"; }
swipe() { "${ADB[@]}" shell input swipe "$1" "$2" "$3" "$4" "${5:-300}"; }
times_remaining() {
  dump_ui
  python3 - "$XML" <<'PY'
import re,sys
xml=open(sys.argv[1]).read()
ms=[]
for t in re.findall(r'text="(-?\d+:\d{2}(?::\d{2})?)"', xml):
    if t.startswith('-'):
        parts=list(map(int,t[1:].split(':')))
        sec=parts[0]*60+parts[1] if len(parts)==2 else parts[0]*3600+parts[1]*60+parts[2]
        ms.append(sec)
print(ms[0] if ms else -1)
PY
}

export DEVICE

log "==> launch app"
"${ADB[@]}" shell am force-stop "$PKG" || true
"${ADB[@]}" shell am start -n "$PKG/.MainActivity"
sleep 6

VER=$("${ADB[@]}" shell dumpsys package "$PKG" | awk -F= '/versionName=/{print $2; exit}')
log "version=$VER"
echo "- Version installée: \`$VER\`" >>"$REPORT"
echo >>"$REPORT"

# Open Now Playing via mini-player title area
log "==> open Now Playing"
tap_xy 350 1835 || true
sleep 1.5
if has_text "Titre" || has_text "Vidéo"; then
  pass "Ouverture Now Playing"
else
  # try Accueil then mini player again
  tap_text "Accueil" 2>/dev/null || true
  sleep 1
  tap_xy 350 1835 || true
  sleep 1.5
  if has_text "Titre" || has_text "Vidéo"; then pass "Ouverture Now Playing (retry)"
  else fail "Ouverture Now Playing"; fi
fi

# --- Seek tap court ---
log "==> seek short tap"
R0=$(times_remaining)
tap_xy 750 1670
sleep 0.9
R1=$(times_remaining)
if [[ "$R1" -ge 0 && "$R0" -ge 0 && "$R1" -lt $((R0 - 3)) ]]; then
  pass "Seek tap court (remaining ${R0}s → ${R1}s)"
elif [[ "$R1" -ge 0 && "$R0" -ge 0 && "$R1" -gt $((R0 + 20)) ]]; then
  fail "Seek tap court a rebobiné vers le début (${R0}→${R1})"
else
  warn "Seek tap court ambigu (${R0}→${R1})"
fi

# --- Transport play/pause ---
log "==> play/pause"
if tap_desc "Lecture" 2>/dev/null || tap_desc "Pause" 2>/dev/null; then
  sleep 0.6
  if tap_desc "Lecture" 2>/dev/null || tap_desc "Pause" 2>/dev/null; then
    pass "Play / Pause"
  else
    warn "Play/Pause 2e tap non trouvé"
  fi
else
  fail "Bouton Lecture/Pause introuvable"
fi

# --- Previous x3 / Next ---
log "==> previous x3 + next"
for i in 1 2 3; do
  tap_desc "Précédent" 2>/dev/null || tap_xy 200 1900
  sleep 0.7
done
pass "Previous ×3 (geste exécuté)"
tap_desc "Suivant" 2>/dev/null || tap_xy 880 1900
sleep 1
pass "Next (geste exécuté)"

# --- Shuffle toggle twice ---
log "==> shuffle"
if tap_desc "Aléatoire" 2>/dev/null; then
  sleep 0.4
  tap_desc "Aléatoire" 2>/dev/null || true
  pass "Aléatoire on/off"
else
  warn "Aléatoire introuvable"
fi

# --- Repeat cycle (off → one → all → off) ---
log "==> repeat"
if tap_desc "Boucle" 2>/dev/null; then
  sleep 0.35
  tap_desc "Boucle" 2>/dev/null || true
  sleep 0.35
  tap_desc "Boucle" 2>/dev/null || true
  pass "Boucle cycle (3 taps)"
else
  warn "Boucle introuvable"
fi

# --- Secondary chips ---
log "==> secondary actions"
for label in "J'aime" "Paroles" "Playlist" "Télécharger" "Mix" "Égaliseur" "Vitesse"; do
  if tap_desc "$label" 2>/dev/null || tap_text "$label" 2>/dev/null; then
    sleep 0.8
    # dismiss sheets / dialogs with back if opened
    if has_text "Annuler" || has_text "Fermer" || has_text "OK"; then
      tap_text "Annuler" 2>/dev/null || tap_text "Fermer" 2>/dev/null || tap_text "OK" 2>/dev/null || "${ADB[@]}" shell input keyevent 4
    else
      # possible bottom sheet / speed menu — back
      "${ADB[@]}" shell input keyevent 4
    fi
    sleep 0.4
    # ensure still in NP
    if ! has_text "Titre" && ! has_text "File d'attente"; then
      tap_xy 350 1835 2>/dev/null || true
      sleep 0.8
    fi
    pass "Action secondaire: $label"
  else
    warn "Action secondaire absente/non cliquable: $label"
  fi
done

# --- Queue panel ---
log "==> queue"
if tap_text "File d'attente" 2>/dev/null || swipe 540 2100 540 900 400; then
  sleep 1
  if has_text "File d'attente" || has_text "En cours" || has_text "À suivre"; then
    pass "Ouverture file d'attente"
  else
    warn "File d'attente — UI incertaine"
  fi
  # radio / save icons in queue header if present
  tap_desc "Mix" 2>/dev/null || tap_desc "Radio" 2>/dev/null || true
  sleep 0.5
  "${ADB[@]}" shell input keyevent 4
  sleep 0.5
  pass "Gestes file d'attente (ouverts + back)"
else
  fail "File d'attente"
fi

# --- Ensure NP still usable ---
if has_text "Titre" || has_text "File d'attente" || has_text "Playlist"; then
  pass "Lecteur encore utilisable en fin de suite"
else
  warn "UI finale hors Now Playing"
fi

# Logcat errors
PID=$("${ADB[@]}" shell pidof -s "$PKG" 2>/dev/null || true)
if [[ -n "${PID:-}" ]]; then
  "${ADB[@]}" logcat -d -t 2000 --pid="$PID" >"$LOGCAT" 2>/dev/null || true
else
  "${ADB[@]}" logcat -d -t 1500 >"$LOGCAT" 2>/dev/null || true
fi
ERR_N=$(rg -c "AndroidRuntime|FATAL|PlaybackService|early_end|seek ignore" "$LOGCAT" 2>/dev/null || echo 0)
{
  echo
  echo "## Logcat (extraits)"
  echo
  echo "Matches erreurs/warn cibbles: \`$ERR_N\`"
  echo
  echo '```text'
  rg -i "PlaybackService|PlayerController|early_end|stall|seek|AndroidRuntime|FATAL" "$LOGCAT" 2>/dev/null | tail -80 || true
  echo '```'
  echo
  echo "## Synthese"
  echo
  echo "- Echecs: **$FAILS**"
} >>"$REPORT"

log "==> done fails=$FAILS report=$REPORT"
echo "$FAILS" >"$OUT/fails.txt"
echo "$REPORT"
exit 0
