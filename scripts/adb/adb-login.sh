#!/usr/bin/env bash
# Login mobile sans taper email/mdp (évite caractères fantômes ADB).
# Usage:
#   bash scripts/adb/adb-login.sh
#   API_BASE_URL=http://192.168.1.134:8787 bash scripts/adb/adb-login.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env" 2>/dev/null || true
  set +a
fi

API="${API_BASE_URL:-${DEPLOY_URL:-https://ytmusic.delhomme.ovh}}"
API="${API%/}"
EMAIL="${SEED_EMAIL:-${VITE_DEV_EMAIL:-}}"
PASS="${SEED_PASSWORD:-${VITE_DEV_PASSWORD:-}}"
# prod = ovh.delhomme.ytmusic · dev (LAN) = ovh.delhomme.ytmusic.dev
if [[ -z "${PKG:-}" ]]; then
  if [[ "$API" == https://* ]] && [[ "$API" != *127.0.0.1* ]] && [[ "$API" != *localhost* ]]; then
    PKG=ovh.delhomme.ytmusic
  else
    PKG=ovh.delhomme.ytmusic.dev
  fi
fi
ADB="${ADB_BIN:-adb}"
DEVICE="${DEVICE:-$($ADB devices | awk '/\tdevice$/{print $1; exit}')}"

if [[ -z "${DEVICE:-}" ]]; then
  echo "FAIL aucun device ADB" >&2
  exit 1
fi
if [[ -z "$EMAIL" || -z "$PASS" ]]; then
  echo "FAIL SEED_EMAIL / SEED_PASSWORD manquants dans .env" >&2
  exit 1
fi

echo "==> API=$API device=$DEVICE pkg=$PKG"

eval "$(
  EMAIL="$EMAIL" PASS="$PASS" API="$API" node <<'NODE'
const email = process.env.EMAIL;
const password = process.env.PASS;
const api = process.env.API;
const r = await fetch(`${api}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const j = await r.json();
if (!r.ok) {
  console.error('login_fail', r.status, JSON.stringify(j));
  process.exit(2);
}
const esc = (s) => String(s || '').replace(/'/g, "'\\''");
console.log(`TOKEN='${esc(j.token)}'`);
console.log(`REFRESH='${esc(j.refreshToken || '')}'`);
console.log(`USER_EMAIL='${esc(j.user?.email || email)}'`);
NODE
)"

if [[ -z "${TOKEN:-}" ]]; then
  echo "FAIL token vide" >&2
  exit 2
fi
echo "==> token_len=${#TOKEN} — injection session (debug extras)"

$ADB -s "$DEVICE" shell am force-stop "$PKG" || true
$ADB -s "$DEVICE" shell am start -n "$PKG/ovh.delhomme.ytmusic.MainActivity" \
  --es ytm_access_token "$TOKEN" \
  --es ytm_refresh_token "$REFRESH" \
  --es ytm_user_email "$USER_EMAIL" >/dev/null

sleep 2
echo "OK  session injectée — pas de saisie clavier ADB"
