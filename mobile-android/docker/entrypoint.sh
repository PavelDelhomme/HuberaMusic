#!/usr/bin/env bash
# Entrypoint conteneur : compile l’APK PLM et la copie dans /out.
set -euo pipefail

SRC_ROOT="${SRC_ROOT:-/src}"
OUT_DIR="${OUT_DIR:-/out}"
FLAVOR="${FLAVOR:-prod}"          # prod | dev
BUILD_TYPE="${BUILD_TYPE:-debug}" # debug | release
API_BASE_URL="${API_BASE_URL:-https://ytmusic.delhomme.ovh}"
API_BASE_URL="${API_BASE_URL%/}"
APP_ENV="${APP_ENV:-docker}"

if [[ ! -x "${SRC_ROOT}/mobile-android/gradlew" ]]; then
  echo "❌ ${SRC_ROOT}/mobile-android/gradlew introuvable — monte le repo sur /src" >&2
  exit 1
fi

if [[ -z "${ANDROID_HOME:-}" || ! -d "${ANDROID_HOME}/platforms" ]]; then
  echo "❌ ANDROID_HOME invalide dans l’image" >&2
  exit 1
fi

# Copie writable (le mount hôte peut être :ro)
WORK="${WORK_DIR:-/tmp/plm-build}"
rm -rf "${WORK}"
mkdir -p "${WORK}/mobile-android"
echo "==> Copie sources → ${WORK}"
[[ -f "${SRC_ROOT}/VERSION" ]] && cp -a "${SRC_ROOT}/VERSION" "${WORK}/VERSION"
[[ -f "${SRC_ROOT}/.env" ]] && cp -a "${SRC_ROOT}/.env" "${WORK}/.env" || true
if command -v rsync >/dev/null 2>&1; then
  rsync -a \
    --exclude '.gradle/' \
    --exclude 'app/build/' \
    --exclude '*/build/' \
    "${SRC_ROOT}/mobile-android/" "${WORK}/mobile-android/"
else
  cp -a "${SRC_ROOT}/mobile-android/." "${WORK}/mobile-android/"
fi

APP="${WORK}/mobile-android"
mkdir -p "${OUT_DIR}"
printf 'sdk.dir=%s\n' "${ANDROID_HOME}" >"${APP}/local.properties"

cap() { echo "$1" | awk '{print toupper(substr($0,1,1)) substr($0,2)}'; }
TASK="assemble$(cap "${FLAVOR}")$(cap "${BUILD_TYPE}")"

echo "==> Docker APK builder"
echo "    API_BASE_URL=${API_BASE_URL}"
echo "    FLAVOR=${FLAVOR} BUILD_TYPE=${BUILD_TYPE} → :app:${TASK}"
echo "    OUT=${OUT_DIR}"

cd "${APP}"
chmod +x ./gradlew
./gradlew ":app:${TASK}" \
  -PAPI_BASE_URL="${API_BASE_URL}" \
  --no-daemon \
  --stacktrace

APK_SRC="${APP}/app/build/outputs/apk/${FLAVOR}/${BUILD_TYPE}/app-${FLAVOR}-${BUILD_TYPE}.apk"
if [[ ! -f "${APK_SRC}" ]]; then
  echo "❌ APK introuvable: ${APK_SRC}" >&2
  find "${APP}/app/build/outputs/apk" -name '*.apk' 2>/dev/null || true
  exit 1
fi

APK_DST="${OUT_DIR}/ytmusic.apk"
cp -f "${APK_SRC}" "${APK_DST}"
SIZE="$(stat -c%s "${APK_DST}" 2>/dev/null || wc -c <"${APK_DST}")"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

SEMVER="$(tr -d '[:space:]' <"${WORK}/VERSION" 2>/dev/null || echo 0.0.0)"
IFS=. read -r MA MI PA <<<"${SEMVER}"
MA=${MA:-0}; MI=${MI:-0}; PA=${PA:-0}
VERSION_CODE=$((MA * 10000 + MI * 100 + PA))
if [[ "${API_BASE_URL}" == https://* ]] && [[ "${FLAVOR}" == "prod" ]]; then
  CHANNEL=p
else
  CHANNEL=d
fi
VERSION_NAME="${CHANNEL}+${SEMVER}"
PKG="ovh.delhomme.ytmusic"
[[ "${FLAVOR}" == "dev" ]] && PKG="${PKG}.dev"

export OUT_DIR API_BASE_URL APP_ENV VERSION_NAME VERSION_CODE SIZE BUILT_AT PKG FLAVOR BUILD_TYPE

python3 - <<'PY'
import json, os
from pathlib import Path
out = Path(os.environ["OUT_DIR"])
manifest = {
  "file": "ytmusic.apk",
  "apiBaseUrl": os.environ["API_BASE_URL"].rstrip("/"),
  "appEnv": os.environ.get("APP_ENV", "docker"),
  "versionName": os.environ["VERSION_NAME"],
  "versionCode": int(os.environ["VERSION_CODE"]),
  "sizeBytes": int(os.environ["SIZE"]),
  "builtAt": os.environ["BUILT_AT"],
  "package": os.environ["PKG"],
  "flavor": os.environ["FLAVOR"],
  "buildType": os.environ["BUILD_TYPE"],
  "builder": "docker",
}
(out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print(json.dumps(manifest, indent=2))
PY

echo "==> OK ${APK_DST} ($(du -h "${APK_DST}" | cut -f1)) ${VERSION_NAME}"
