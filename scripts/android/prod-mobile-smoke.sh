#!/usr/bin/env bash
# Smoke test prod via téléphone ADB + API https://ytmusic.delhomme.ovh
# Prérequis : app installée (make android-prod), utilisateur connecté sur le device.
# Usage: DEVICE=00145153K001434 bash scripts/android/prod-mobile-smoke.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
API="${API_BASE_URL:-https://ytmusic.delhomme.ovh}"
PKG=ovh.delhomme.ytmusic
ADB_BIN="${ADB_BIN:-adb}"
DEVICE="${DEVICE:-${ANDROID_SERIAL:-$($ADB_BIN devices | awk '/\tdevice$/{print $1; exit}')}}"
REPORT=/tmp/ytmusic-prod-smoke.txt

: >"$REPORT"
log() { echo "$*" | tee -a "$REPORT"; }

if [[ -z "${DEVICE:-}" ]]; then
  log "FAIL aucun device ADB"
  exit 1
fi
adb() { command "$ADB_BIN" -s "$DEVICE" "$@"; }

log "==> API=$API device=$DEVICE"
HEALTH="$(adb shell "curl -sS '$API/api/health'" 2>/dev/null || curl -sS "$API/api/health")"
log "health: $HEALTH"

VER="$(echo "$HEALTH" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("version","?")[:12])' 2>/dev/null || echo '?')"
log "version: $VER"

# Couper reverse local
adb reverse --remove-all >/dev/null 2>&1 || true

adb shell am force-stop "$PKG" || true
adb logcat -c
adb shell am start -n "$PKG/.MainActivity" >/dev/null
sleep 3

BOOT="$(adb logcat -d 2>/dev/null | grep -F 'YtMusic : boot' | tail -1 || true)"
log "boot: $BOOT"
if echo "$BOOT" | grep -q 'api=https://ytmusic.delhomme.ovh'; then
  log "OK  API prod dans l’app"
else
  log "FAIL API pas prod — rebuild make android-prod"
fi

# Attente session (max 90s) : login, inject debug, ou home/auth/me déjà OK
log "==> Attente session sur le téléphone (90s)…"
OK_LOGIN=0
for i in $(seq 1 45); do
  LC="$(adb logcat -d 2>/dev/null || true)"
  if echo "$LC" | grep -qE 'auth/login \(.*\).*200|←-- 200 https://ytmusic.delhomme.ovh/api/auth/login|←-- 200 https://ytmusic.delhomme.ovh/api/auth/me|←-- 200 https://ytmusic.delhomme.ovh/api/home|←-- 200 https://ytmusic.delhomme.ovh/api/library'; then
    OK_LOGIN=1
    break
  fi
  sleep 2
done

if [[ "$OK_LOGIN" != 1 ]]; then
  # Fallback UI : session injectée / already logged without matching log lines
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || true
  adb pull /sdcard/ui.xml /tmp/ytmusic-prod-ui.xml >/dev/null 2>&1 || true
  if python3 - <<'PY'
import re
try:
  xml=open('/tmp/ytmusic-prod-ui.xml',encoding='utf-8',errors='ignore').read()
except Exception:
  raise SystemExit(1)
texts=[t for t in re.findall(r'text="([^"]*)"', xml) if t]
raise SystemExit(0 if any(t in ('Accueil','Recherche','Biblio') for t in texts) else 1)
PY
  then
    OK_LOGIN=1
    log "OK  session via UI (Accueil/Recherche/Biblio)"
  fi
fi

if [[ "$OK_LOGIN" != 1 ]]; then
  log "FAIL pas de login détecté — connecte-toi (email/mdp prod) puis relance ce script"
  log "Rapport: $REPORT"
  exit 2
fi
log "OK  session détectée"

adb logcat -c
log "==> Lance une piste dans l’app (30s d’écoute logcat)…"
sleep 30

LOG="$(adb logcat -d 2>/dev/null || true)"
echo "$LOG" | grep -E 'okhttp.OkHttpClient|PlaybackException|ExoPlayer|Source error|YtMusic' | tail -80 >>"$REPORT" || true

stream_codes="$(echo "$LOG" | grep -oE 'stream/[^ ]+|←-- [0-9]+ https://ytmusic.delhomme.ovh/api/stream[^ ]*' | tail -20 || true)"
log "stream lines:"
log "$stream_codes"

if echo "$LOG" | grep -qE '←-- 502 https://ytmusic.delhomme.ovh/api/stream|Sign in to confirm|PlaybackException'; then
  log "FAIL lecture — stream 502 / anti-bot / ExoPlayer error (relais maison ou image récente)"
else
  if echo "$LOG" | grep -qE '←-- 200 https://ytmusic.delhomme.ovh/api/stream|isPlaying|STATE_READY'; then
    log "OK  indices de lecture OK"
  else
    log "WARN pas de preuve claire de lecture — retape une piste"
  fi
fi

if echo "$VER" | grep -qE '^(8dbab0e|c30e637)'; then
  log "FAIL image serveur trop ancienne ($VER) — Pull Portainer (attendu fa73bdc / 194a805+)"
fi

log "Rapport complet: $REPORT"
cat "$REPORT"
