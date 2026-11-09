#!/usr/bin/env bash
# Login mobile sans taper email/mdp (évite caractères fantômes ADB).
# UNIQUEMENT smartphones de TEST : Samsung R5CT7263YJL, Blackview EEA9700PRO0014587.
# Jamais Nothing, jamais un appareil d’un autre utilisateur.
# Usage:
#   bash scripts/adb/adb-login.sh
#   API_BASE_URL=http://192.168.1.134:8787 bash scripts/adb/adb-login.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# .env force SEED_EMAIL=dev@ (compte admin, biblio vide). Un caller qui
# exporte SEED_EMAIL=paul@… doit gagner, sinon on reconnecte le mauvais compte.
_EMAIL_OVERRIDE="${SEED_EMAIL:-}"
_PASS_OVERRIDE="${LOGIN_PASSWORD:-}"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env" 2>/dev/null || true
  set +a
fi

API="${API_BASE_URL:-${DEPLOY_URL:-https://ytmusic.delhomme.ovh}}"
API="${API%/}"
EMAIL="${_EMAIL_OVERRIDE:-${SEED_EMAIL:-${VITE_DEV_EMAIL:-}}}"
# SEED_PASSWORD court (« okay ») est souvent invalide en prod — tenter VITE_DEV_PASSWORD ensuite.
PASS_PRIMARY="${_PASS_OVERRIDE:-${LOGIN_PASSWORD:-${SEED_PASSWORD:-}}}"
PASS_FALLBACK="${VITE_DEV_PASSWORD:-}"
# prod = ovh.delhomme.ytmusic · dev (LAN) = ovh.delhomme.ytmusic.dev
if [[ -z "${PKG:-}" ]]; then
  if [[ "$API" == https://* ]] && [[ "$API" != *127.0.0.1* ]] && [[ "$API" != *localhost* ]]; then
    PKG=ovh.delhomme.ytmusic
  else
    PKG=ovh.delhomme.ytmusic.dev
  fi
fi
ADB="${ADB_BIN:-adb}"
# Injection session perso = UNIQUEMENT les téléphones de TEST du porteur.
# Jamais Nothing, jamais un appareil d’un autre utilisateur.
TEST_HW="${ADB_TEST_SERIALS:-R5CT7263YJL EEA9700PRO0014587}"

hw_of() {
  "$ADB" -s "$1" shell getprop ro.serialno 2>/dev/null | tr -d '\r' | head -1
}

is_test_phone() {
  local t="$1" hw
  hw="$(hw_of "$t")"
  [[ -n "$hw" ]] || hw="${t%%:*}"
  case " $TEST_HW " in
    *" $hw "*) return 0 ;;
  esac
  return 1
}

pick_test_device() {
  local t
  while read -r t _; do
    [[ -n "$t" ]] || continue
    is_test_phone "$t" && { echo "$t"; return 0; }
  done < <("$ADB" devices | awk 'NR>1 && $2=="device"{print $1, $2}')
  return 1
}

if [[ -z "${DEVICE:-}" ]]; then
  DEVICE="$(pick_test_device || true)"
fi
if [[ -z "${DEVICE:-}" ]]; then
  echo "FAIL aucun téléphone de test ADB (Samsung R5CT7263YJL / Blackview EEA9700PRO0014587)" >&2
  exit 1
fi
if ! is_test_phone "$DEVICE"; then
  echo "REFUS injection paul@ : $DEVICE ($(hw_of "$DEVICE")) n'est pas un smartphone de test." >&2
  echo "Autorisés : $TEST_HW — jamais Nothing, jamais un appareil tiers." >&2
  exit 3
fi
if [[ -z "$EMAIL" || ( -z "$PASS_PRIMARY" && -z "$PASS_FALLBACK" ) ]]; then
  echo "FAIL SEED_EMAIL / mots de passe manquants dans .env" >&2
  exit 1
fi

echo "==> API=$API device=$DEVICE pkg=$PKG email=$EMAIL"

eval "$(
  EMAIL="$EMAIL" PASS_PRIMARY="$PASS_PRIMARY" PASS_FALLBACK="$PASS_FALLBACK" API="$API" node <<'NODE'
const email = process.env.EMAIL;
const api = process.env.API;
const passwords = [...new Set([process.env.PASS_PRIMARY, process.env.PASS_FALLBACK].filter(Boolean))];
let last = null;
for (const password of passwords) {
  const r = await fetch(`${api}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = await r.json();
  if (r.ok && j.token) {
    const esc = (s) => String(s || '').replace(/'/g, "'\\''");
    console.log(`TOKEN='${esc(j.token)}'`);
    console.log(`REFRESH='${esc(j.refreshToken || '')}'`);
    console.log(`USER_EMAIL='${esc(j.user?.email || email)}'`);
    console.log(`USER_ID='${esc(j.user?.id || "")}'`);
    process.exit(0);
  }
  last = { status: r.status, j };
}
console.error('login_fail', last?.status, JSON.stringify(last?.j));
process.exit(2);
NODE
)"

if [[ -z "${TOKEN:-}" ]]; then
  echo "FAIL token vide" >&2
  exit 2
fi
echo "==> token_len=${#TOKEN} inject_email=${USER_EMAIL} user_id=${USER_ID:-?} — injection session (debug extras)"

$ADB -s "$DEVICE" shell am force-stop "$PKG" || true
$ADB -s "$DEVICE" shell am start -n "$PKG/ovh.delhomme.ytmusic.MainActivity" \
  --es ytm_access_token "$TOKEN" \
  --es ytm_refresh_token "$REFRESH" \
  --es ytm_user_email "$USER_EMAIL" >/dev/null

sleep 3
echo "OK  session injectée — pas de saisie clavier ADB"
