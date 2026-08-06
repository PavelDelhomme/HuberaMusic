#!/usr/bin/env bash
# Smoke test prod via téléphone ADB + API https://ytmusic.delhomme.ovh
# Prérequis : app installée (make android-prod), utilisateur connecté sur le device.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API="${API_BASE_URL:-https://ytmusic.delhomme.ovh}"
PKG=ovh.delhomme.ytmusic
ADB="${ADB_BIN:-adb}"
REPORT=/tmp/ytmusic-prod-smoke.txt

: >"$REPORT"
log() { echo "$*" | tee -a "$REPORT"; }

log "==> API=$API"
HEALTH="$($ADB shell "curl -sS '$API/api/health'" 2>/dev/null || curl -sS "$API/api/health")"
log "health: $HEALTH"

VER="$(echo "$HEALTH" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("version","?")[:12])' 2>/dev/null || echo '?')"
log "version: $VER"

# Couper reverse local
$ADB reverse --remove-all >/dev/null 2>&1 || true

$ADB shell am force-stop "$PKG" || true
$ADB logcat -c
$ADB shell am start -n "$PKG/.MainActivity" >/dev/null
sleep 3

BOOT="$($ADB logcat -d 2>/dev/null | grep -F 'YtMusic : boot' | tail -1 || true)"
log "boot: $BOOT"
if echo "$BOOT" | grep -q 'api=https://ytmusic.delhomme.ovh'; then
  log "OK  API prod dans l’app"
else
  log "FAIL API pas prod — rebuild make android-prod"
fi

# Attente login (max 90s) : POST /api/auth/login → 200
log "==> Attente login sur le téléphone (90s)…"
OK_LOGIN=0
for i in $(seq 1 45); do
  if $ADB logcat -d 2>/dev/null | grep -qE 'auth/login \(.*\).*200|←-- 200 https://ytmusic.delhomme.ovh/api/auth/login'; then
    OK_LOGIN=1
    break
  fi
  if $ADB logcat -d 2>/dev/null | grep -qE '←-- 200 https://ytmusic.delhomme.ovh/api/home|→ GET https://ytmusic.delhomme.ovh/api/home'; then
    # déjà session
    if $ADB logcat -d 2>/dev/null | grep -qE '←-- 200 https://ytmusic.delhomme.ovh/api/home'; then
      OK_LOGIN=1
      break
    fi
  fi
  sleep 2
done

if [[ "$OK_LOGIN" != 1 ]]; then
  log "FAIL pas de login détecté — connecte-toi (email/mdp prod) puis relance ce script"
  log "Rapport: $REPORT"
  exit 2
fi
log "OK  session détectée"

$ADB logcat -c
log "==> Lance une piste dans l’app (30s d’écoute logcat)…"
sleep 30

LOG="$($ADB logcat -d 2>/dev/null || true)"
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
