#!/usr/bin/env bash
# Compile (optionnel) + publie l’APK sur le VPS (volume ytmusic_data).
#
# Ordre d’auth / publication :
#   1) ADMIN_TOKEN / YTM_TOKEN → POST /api/admin/apk/upload
#   2) ADMIN_EMAIL + ADMIN_PASSWORD (+ ADMIN_TOTP si 2FA) → login puis upload
#   3) Fallback SSH (DEPLOY_SSH) → docker cp dans /app/data/public/android/
#
# Usage :
#   make android-upload-apk
#   API_BASE_URL=https://ytmusic.delhomme.ovh DEPLOY_URL=https://ytmusic.delhomme.ovh \
#     bash scripts/android/publish-apk-remote.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$ROOT/data/public/android"
APK="$OUT_DIR/ytmusic.apk"
MANIFEST="$OUT_DIR/manifest.json"

DEPLOY_URL="${DEPLOY_URL:-${APP_URL:-https://ytmusic.delhomme.ovh}}"
DEPLOY_URL="${DEPLOY_URL%/}"
API_BASE_URL="${API_BASE_URL:-$DEPLOY_URL}"
API_BASE_URL="${API_BASE_URL%/}"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env" 2>/dev/null || true
  set +a
fi

BUILD_FIRST="${BUILD_FIRST:-1}"
if [[ "$BUILD_FIRST" == "1" ]]; then
  echo "==> Build APK figée pour $API_BASE_URL"
  API_BASE_URL="$API_BASE_URL" bash "$ROOT/scripts/android/android-publish-apk.sh"
fi

if [[ ! -f "$APK" ]]; then
  echo "APK manquante : $APK" >&2
  echo "Lance d’abord : API_BASE_URL=$API_BASE_URL make android-publish" >&2
  exit 1
fi

# Normalise le manifeste local (appEnv production si URL prod)
if [[ -f "$MANIFEST" ]]; then
  python3 - "$MANIFEST" "$API_BASE_URL" "$APK" <<'PY'
import json, os, sys
path, api, apk = sys.argv[1], sys.argv[2], sys.argv[3]
m = json.loads(open(path, encoding='utf-8').read())
m['apiBaseUrl'] = api.rstrip('/')
m['sizeBytes'] = os.path.getsize(apk)
if 'ytmusic.delhomme.ovh' in api or 'plm.delhomme.ovh' in api:
  m['appEnv'] = 'production'
open(path, 'w', encoding='utf-8').write(json.dumps(m, indent=2) + '\n')
print(f"    manifest {m.get('versionName')} code={m.get('versionCode')} env={m.get('appEnv')}")
PY
fi

VERSION_NAME="upload"
VERSION_CODE=""
if [[ -f "$MANIFEST" ]]; then
  read -r VERSION_NAME VERSION_CODE < <(
    python3 -c "import json; m=json.load(open('$MANIFEST')); print(m.get('versionName','upload'), m.get('versionCode',''))"
  )
fi

upload_via_http() {
  local token="$1"
  echo "==> Upload HTTP → $DEPLOY_URL/api/admin/apk/upload"
  echo "    apiBaseUrl : $API_BASE_URL"
  echo "    fichier    : $APK ($(du -h "$APK" | cut -f1)) · $VERSION_NAME"
  local headers=(
    -H "Authorization: Bearer $token"
    -H "Content-Type: application/vnd.android.package-archive"
    -H "X-Apk-Api-Base-Url: $API_BASE_URL"
    -H "X-Apk-Version-Name: $VERSION_NAME"
  )
  if [[ -n "$VERSION_CODE" ]]; then
    headers+=(-H "X-Apk-Version-Code: $VERSION_CODE")
  fi
  curl -fsS -X POST "$DEPLOY_URL/api/admin/apk/upload" \
    "${headers[@]}" \
    --data-binary @"$APK" \
    | python3 -m json.tool
}

upload_via_ssh() {
  local target="${DEPLOY_SSH:-}"
  if [[ -z "$target" ]]; then
    return 1
  fi
  if [[ ! -f "$MANIFEST" ]]; then
    echo "manifest.json manquant pour le fallback SSH" >&2
    return 1
  fi
  echo "==> Fallback SSH → $target (docker cp volume android)"
  echo "    $VERSION_NAME → /app/data/public/android/"
  ssh -o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new "$target" \
    'mkdir -p /tmp/ytmusic-apk-upload'
  scp -o BatchMode=yes -o ConnectTimeout=20 "$APK" "$target:/tmp/ytmusic-apk-upload/ytmusic.apk"
  scp -o BatchMode=yes -o ConnectTimeout=20 "$MANIFEST" "$target:/tmp/ytmusic-apk-upload/manifest.json"
  ssh -o BatchMode=yes -o ConnectTimeout=20 "$target" 'bash -s' <<'REMOTE'
set -euo pipefail
docker cp /tmp/ytmusic-apk-upload/ytmusic.apk ytmusic:/app/data/public/android/ytmusic.apk
docker cp /tmp/ytmusic-apk-upload/manifest.json ytmusic:/app/data/public/android/manifest.json
docker exec -u root ytmusic chown ytmusic:ytmusic \
  /app/data/public/android/ytmusic.apk /app/data/public/android/manifest.json
docker exec ytmusic cat /app/data/public/android/manifest.json
rm -rf /tmp/ytmusic-apk-upload
REMOTE
}

login_admin_token() {
  local email="$1"
  local pass="$2"
  local totp="${3:-}"
  local payload
  payload="$(
    EMAIL="$email" PASS="$pass" TOTP="$totp" python3 - <<'PY'
import json, os
d = {"email": os.environ["EMAIL"], "password": os.environ["PASS"]}
t = (os.environ.get("TOTP") or "").strip()
if t:
    d["totp"] = t
print(json.dumps(d))
PY
  )"
  local raw http body
  raw="$(curl -sS -w '\n%{http_code}' -X POST "$DEPLOY_URL/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "$payload" || true)"
  http="$(printf '%s' "$raw" | tail -n1)"
  body="$(printf '%s' "$raw" | sed '$d')"
  if [[ "$http" != "200" ]]; then
    echo "    login HTTP $http : $(printf '%s' "$body" | head -c 240)" >&2
    return 1
  fi
  TOKEN_OUT="$(python3 -c 'import sys,json; print(json.load(sys.stdin).get("token") or "")' <<<"$body")"
  [[ -n "$TOKEN_OUT" ]] || return 1
  printf '%s' "$TOKEN_OUT"
}

TOKEN="${ADMIN_TOKEN:-${YTM_TOKEN:-}}"
UPLOADED=0

if [[ -z "$TOKEN" ]]; then
  EMAIL="${ADMIN_EMAIL:-}"
  if [[ -z "$EMAIL" && -n "${ADMIN_EMAILS:-}" ]]; then
    EMAIL="${ADMIN_EMAILS%%,*}"
  fi
  PASS="${ADMIN_PASSWORD:-${SEED_PASSWORD:-}}"
  TOTP="${ADMIN_TOTP:-}"
  if [[ -n "$EMAIL" && -n "$PASS" ]]; then
    echo "==> Login admin $EMAIL @ $DEPLOY_URL"
    if TOKEN="$(login_admin_token "$EMAIL" "$PASS" "$TOTP")"; then
      :
    else
      TOKEN=""
      echo "    (login admin échoué — tentative fallback SSH si DEPLOY_SSH)" >&2
    fi
  fi
fi

if [[ -n "${TOKEN:-}" ]]; then
  if upload_via_http "$TOKEN"; then
    UPLOADED=1
  else
    echo "    upload HTTP échoué — tentative fallback SSH" >&2
  fi
fi

if [[ "$UPLOADED" != "1" ]]; then
  if upload_via_ssh; then
    UPLOADED=1
  else
    echo "Échec publication APK : ni HTTP admin ni SSH (DEPLOY_SSH)." >&2
    echo "  - ADMIN_TOKEN / ADMIN_EMAIL+ADMIN_PASSWORD(+ADMIN_TOTP)" >&2
    echo "  - ou DEPLOY_SSH=user@host avec docker ytmusic" >&2
    exit 1
  fi
fi

echo ""
echo "==> OK — APK $VERSION_NAME sur le VPS"
echo "    Téléchargement / QR Admin : $DEPLOY_URL/api/deploy/apk"
echo "    Info (auth)               : $DEPLOY_URL/api/deploy/apk/info"
