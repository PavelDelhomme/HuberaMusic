#!/usr/bin/env bash
# Compile l’APK PLM entièrement dans Docker (pas besoin du SDK local).
#
# Usage :
#   bash scripts/android/docker-build-apk.sh
#   API_BASE_URL=https://ytmusic.delhomme.ovh make android-docker-apk
#   FLAVOR=dev API_BASE_URL=http://192.168.1.10:8787 make android-docker-apk
#
# Prérequis : Docker. Première fois : télécharge ~1–2 Go (SDK dans l’image).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${ANDROID_DOCKER_IMAGE:-plm-apk-builder:local}"
DOCKER_DIR="$ROOT/mobile-android/docker"
OUT_DIR="${OUT_DIR:-$ROOT/data/public/android}"
API_BASE_URL="${API_BASE_URL:-https://ytmusic.delhomme.ovh}"
API_BASE_URL="${API_BASE_URL%/}"
FLAVOR="${FLAVOR:-prod}"
BUILD_TYPE="${BUILD_TYPE:-debug}"
BUILD_IMAGE="${BUILD_IMAGE:-0}"

if ! command -v docker >/dev/null 2>&1; then
  echo "❌ Docker introuvable" >&2
  exit 1
fi

# Rebuild image si demandé ou absente
if [[ "${BUILD_IMAGE}" == "1" ]] || ! docker image inspect "${IMAGE}" >/dev/null 2>&1; then
  echo "==> Build image ${IMAGE}"
  docker build -t "${IMAGE}" -f "${DOCKER_DIR}/Dockerfile" "${DOCKER_DIR}"
fi

mkdir -p "${OUT_DIR}"
GRADLE_CACHE_VOL="${GRADLE_CACHE_VOL:-plm-apk-gradle-cache}"

echo "==> Run builder (flavor=${FLAVOR} type=${BUILD_TYPE})"
echo "    API=${API_BASE_URL}"
echo "    OUT=${OUT_DIR}"

docker run --rm \
  -e API_BASE_URL="${API_BASE_URL}" \
  -e FLAVOR="${FLAVOR}" \
  -e BUILD_TYPE="${BUILD_TYPE}" \
  -e APP_ENV="${APP_ENV:-docker}" \
  -e SRC_ROOT=/src \
  -e OUT_DIR=/out \
  -v "${ROOT}:/src:ro" \
  -v "${OUT_DIR}:/out" \
  -v "${GRADLE_CACHE_VOL}:/root/.gradle" \
  "${IMAGE}"

echo ""
echo "==> APK prête :"
echo "    ${OUT_DIR}/ytmusic.apk"
echo "    ${OUT_DIR}/manifest.json"
if [[ -f "${OUT_DIR}/manifest.json" ]]; then
  cat "${OUT_DIR}/manifest.json"
fi
