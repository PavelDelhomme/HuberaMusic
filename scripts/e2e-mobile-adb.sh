#!/usr/bin/env bash
# Smoke UI Android (ADB) contre l’API déjà configurée dans l’APK.
# Usage: bash scripts/e2e-mobile-adb.sh
set -euo pipefail
PKG=ovh.delhomme.ytmusic
ADB="${ADB_BIN:-adb}"
REPORT=/tmp/ytmusic-e2e-mobile.txt
: >"$REPORT"
log() { echo "$*" | tee -a "$REPORT"; }

DEVICE="${DEVICE:-${ANDROID_SERIAL:-$($ADB devices | awk '/\tdevice$/{print $1; exit}')}}"
if [[ -z "${DEVICE:-}" ]]; then
  log "FAIL aucun device ADB"
  exit 1
fi
log "device=$DEVICE"

$ADB -s "$DEVICE" reverse --remove-all >/dev/null 2>&1 || true
$ADB -s "$DEVICE" shell am force-stop "$PKG" || true
$ADB -s "$DEVICE" logcat -c
$ADB -s "$DEVICE" shell am start -n "$PKG/.MainActivity" >/dev/null
sleep 3

BOOT="$($ADB -s "$DEVICE" logcat -d 2>/dev/null | grep -F 'YtMusic : boot' | tail -1 || true)"
log "boot: $BOOT"
API="$(echo "$BOOT" | sed -n 's/.*api=\([^ ]*\).*/\1/p')"
log "api=$API"
if [[ "$API" == https://ytmusic.delhomme.ovh ]]; then
  log "OK  API prod"
elif [[ "$API" == http://*8787* ]] || [[ "$API" == http://192.168.* ]]; then
  log "WARN API locale/LAN ($API) — pour prod: make android-prod"
else
  log "WARN API=$API"
fi

$ADB -s "$DEVICE" shell uiautomator dump /sdcard/ui.xml >/dev/null
$ADB -s "$DEVICE" pull /sdcard/ui.xml /tmp/e2e-ui.xml >/dev/null
python3 - <<'PY' | tee -a "$REPORT"
import re
xml=open('/tmp/e2e-ui.xml').read()
texts=[t for t in re.findall(r'text="([^"]*)"', xml) if t]
print('ui:', texts[:25])
has_login = any(t=='Se connecter' for t in texts)
has_passkey_btn = any(t.strip().endswith('Continuer avec une passkey') or 'Continuer avec une passkey' in t for t in texts)
has_home = any(t in ('Accueil','Bibliothèque','Recherche','Explorer') for t in texts)
print('HAS_LOGIN', has_login)
print('HAS_PASSKEY_BTN', has_passkey_btn)
print('HAS_HOME', has_home)
if has_login and has_passkey_btn:
    print('FAIL passkey login bouton visible avant enregistrement local')
elif has_login and not has_passkey_btn:
    print('OK  passkey login masqué (attendu tant que non enregistrée)')
if has_home:
    print('OK  session déjà ouverte — home visible')
if has_login and any('proposée après' in t for t in texts):
    print('OK  hint passkey post-login affiché')
PY

# Health depuis le host pour la même API
if [[ -n "$API" ]]; then
  H="$(curl -sS "$API/api/health" || true)"
  log "health: $H"
fi

log "Rapport: $REPORT"
log "Suite manuelle: connecte-toi → dialog passkey → Accueil / lecture / skip"
