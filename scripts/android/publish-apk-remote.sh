#!/usr/bin/env bash
# Compile (optionnel) + upload l’APK vers l’API prod (Portainer).
# Usage :
#   make android-upload-apk
#   API_BASE_URL=https://ytmusic.delhomme.ovh DEPLOY_URL=https://ytmusic.delhomme.ovh \
#     ADMIN_EMAIL=… ADMIN_PASSWORD=… bash scripts/android/publish-apk-remote.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT_DIR="$ROOT/data/public/android"
APK="$OUT_DIR/ytmusic.apk"

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

TOKEN="${ADMIN_TOKEN:-${YTM_TOKEN:-}}"
if [[ -z "$TOKEN" ]]; then
  EMAIL="${ADMIN_EMAIL:-}"
  if [[ -z "$EMAIL" && -n "${ADMIN_EMAILS:-}" ]]; then
    EMAIL="${ADMIN_EMAILS%%,*}"
  fi
  PASS="${ADMIN_PASSWORD:-${SEED_PASSWORD:-}}"
  if [[ -z "$EMAIL" || -z "$PASS" ]]; then
    echo "Définis ADMIN_TOKEN (Bearer) ou ADMIN_EMAIL + ADMIN_PASSWORD" >&2
    exit 1
  fi
  echo "==> Login admin $EMAIL @ $DEPLOY_URL"
  TOKEN="$(
    curl -fsS -X POST "$DEPLOY_URL/api/auth/login" \
      -H 'Content-Type: application/json' \
      -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
      | python3 -c 'import sys,json; print(json.load(sys.stdin).get("token") or "")'
  )"
fi

if [[ -z "$TOKEN" ]]; then
  echo "Login échoué — pas de token" >&2
  exit 1
fi

VERSION_NAME="upload"
if [[ -f "$OUT_DIR/manifest.json" ]]; then
  VERSION_NAME="$(python3 -c "import json; print(json.load(open('$OUT_DIR/manifest.json')).get('versionName','upload'))")"
fi

echo "==> Upload → $DEPLOY_URL/api/admin/apk/upload"
echo "    apiBaseUrl annoncée : $API_BASE_URL"
echo "    fichier : $APK ($(du -h "$APK" | cut -f1))"

curl -fsS -X POST "$DEPLOY_URL/api/admin/apk/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/vnd.android.package-archive" \
  -H "X-Apk-Api-Base-Url: $API_BASE_URL" \
  -H "X-Apk-Version-Name: $VERSION_NAME" \
  --data-binary @"$APK" \
  | python3 -m json.tool

echo ""
echo "==> OK — téléchargement / QR Admin :"
echo "    $DEPLOY_URL/api/deploy/apk"
