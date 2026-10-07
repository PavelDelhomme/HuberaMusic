#!/usr/bin/env bash
# Compile l’APK Kotlin avec une API_BASE_URL figée, puis la publie pour
# téléchargement (admin QR / GET /api/deploy/apk).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ "${SKIP_NREG:-0}" != "1" ]]; then
  echo "==> Non-régression avant publication APK"
  bash "$ROOT/scripts/qa/preprod-nreg.sh"
fi
APP="$ROOT/mobile-android"
OUT_DIR="$ROOT/data/public/android"

export ANDROID_HOME="${ANDROID_HOME:-/home/pactivisme/Android/Sdk}"
if [[ "$ANDROID_HOME" == /opt/android-sdk* ]] || [[ ! -d "$ANDROID_HOME/platforms" ]]; then
  if [[ -d /home/pactivisme/Android/Sdk/platforms ]]; then
    export ANDROID_HOME=/home/pactivisme/Android/Sdk
  fi
fi
export ANDROID_SDK_ROOT="$ANDROID_HOME"
if [[ -x /usr/lib/jvm/java-21-openjdk/bin/javac ]]; then
  export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
elif [[ -z "${JAVA_HOME:-}" || ! -x "${JAVA_HOME}/bin/javac" ]]; then
  if [[ -x /usr/lib/jvm/java-17-openjdk/bin/javac ]]; then
    export JAVA_HOME=/usr/lib/jvm/java-17-openjdk
  fi
fi
export PATH="${JAVA_HOME:-}/bin:$ANDROID_HOME/platform-tools:$PATH"

# Charge .env (sans écraser l’env déjà exporté)
if [[ -f "$ROOT/.env" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    case "$line" in
      APP_ENV=*|APP_URL=*|ANDROID_API_BASE_URL=*|API_BASE_URL=*|PORT=*)
        key="${line%%=*}"
        val="${line#*=}"
        val="${val%\"}" ; val="${val#\"}"
        val="${val%\'}" ; val="${val#\'}"
        if [[ -z "${!key:-}" ]]; then
          export "$key=$val"
        fi
        ;;
    esac
  done <"$ROOT/.env"
fi

detect_lan_ip() {
  ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}'
}

# Priorité : API_BASE_URL (explicite) > ANDROID_API_BASE_URL > DEPLOY_URL / APP_URL publics > LAN
if [[ -z "${API_BASE_URL:-}" ]]; then
  if [[ -n "${ANDROID_API_BASE_URL:-}" ]]; then
    API_BASE_URL="$ANDROID_API_BASE_URL"
  elif [[ -n "${DEPLOY_URL:-}" && "$DEPLOY_URL" != *"127.0.0.1"* && "$DEPLOY_URL" != *"localhost"* && "$DEPLOY_URL" != *"172."* ]]; then
    API_BASE_URL="$DEPLOY_URL"
  elif [[ -n "${APP_URL:-}" && "$APP_URL" != *"127.0.0.1"* && "$APP_URL" != *"localhost"* && "$APP_URL" != *"172."* && "$APP_URL" != *"192.168."* ]]; then
    API_BASE_URL="$APP_URL"
  elif [[ "${APP_ENV:-}" == "production" || "${APP_ENV:-}" == "prod" ]]; then
    API_BASE_URL="https://music.hubera.cloud"
  else
    LAN="$(detect_lan_ip || true)"
    PORT_NUM="${PORT:-8787}"
    if [[ -n "${LAN:-}" ]]; then
      API_BASE_URL="http://${LAN}:${PORT_NUM}"
    else
      echo "❌ IP LAN introuvable — définis API_BASE_URL=http://IP:8787 (jamais 127.0.0.1 sur téléphone)" >&2
      exit 1
    fi
  fi
fi
# Garde-fou : ne jamais publier une APK 127.0.0.1 pour device physique
if [[ "$API_BASE_URL" == *"127.0.0.1"* || "$API_BASE_URL" == *"localhost"* ]]; then
  LAN="$(detect_lan_ip || true)"
  if [[ -n "${LAN:-}" ]]; then
    API_BASE_URL="http://${LAN}:${PORT:-8787}"
    echo "==> Rewrite 127.0.0.1 → $API_BASE_URL"
  else
    echo "❌ Refus de publier une APK avec API 127.0.0.1" >&2
    exit 1
  fi
fi
API_BASE_URL="${API_BASE_URL%/}"
export API_BASE_URL

echo "==> Publish APK"
echo "    API_BASE_URL=$API_BASE_URL"
echo "    APP_ENV=${APP_ENV:-local}"
echo "    ANDROID_HOME=$ANDROID_HOME"

mkdir -p "$APP" "$OUT_DIR"
printf 'sdk.dir=%s\n' "$ANDROID_HOME" >"$APP/local.properties"

cd "$APP"
chmod +x ./gradlew
# Dual slots OTA : Hubera (cloud.hubera.music) + legacy (ovh.delhomme.ytmusic)
APK_SRC="$APP/app/build/outputs/apk/prod/debug/app-prod-debug.apk"
write_manifest() {
  local file="$1" pkg="$2" apk="$3"
  OUT_DIR="$OUT_DIR" API_BASE_URL="$API_BASE_URL" APP_ENV="${APP_ENV:-local}" \
  VERSION_NAME="$VERSION_NAME" VERSION_CODE="$VERSION_CODE" BUILT_AT="$BUILT_AT" \
  FILE="$file" PKG="$pkg" APK="$apk" python3 - <<'PY'
import json, os
from pathlib import Path
out = Path(os.environ["OUT_DIR"])
apk = Path(os.environ["APK"])
manifest = {
  "file": os.environ["FILE"],
  "apiBaseUrl": os.environ["API_BASE_URL"].rstrip("/"),
  "appEnv": os.environ.get("APP_ENV", "local"),
  "versionName": os.environ.get("VERSION_NAME", "unknown"),
  "versionCode": int(os.environ.get("VERSION_CODE") or 0),
  "sizeBytes": apk.stat().st_size if apk.is_file() else 0,
  "builtAt": os.environ.get("BUILT_AT"),
  "package": os.environ["PKG"],
}
name = "hubera-manifest.json" if os.environ["FILE"] == "hubera-music.apk" else "manifest.json"
(out / name).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
print(json.dumps(manifest, indent=2))
PY
}

echo "==> Gradle Hubera Music (cloud.hubera.music)"
./gradlew :app:assembleProdDebug -PAPI_BASE_URL="$API_BASE_URL" --no-daemon
if [[ ! -f "$APK_SRC" ]]; then
  echo "APK introuvable: $APK_SRC" >&2
  exit 1
fi
cp -f "$APK_SRC" "$OUT_DIR/hubera-music.apk"

echo "==> Gradle legacy (ovh.delhomme.ytmusic)"
./gradlew :app:assembleProdDebug -PAPI_BASE_URL="$API_BASE_URL" -PlegacyAppId=true --no-daemon
if [[ ! -f "$APK_SRC" ]]; then
  echo "APK introuvable: $APK_SRC" >&2
  exit 1
fi
cp -f "$APK_SRC" "$OUT_DIR/ytmusic.apk"

BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SEMVER="$(tr -d '[:space:]' <"$ROOT/VERSION" 2>/dev/null || echo 0.0.0)"
IFS=. read -r MA MI PA <<<"$SEMVER"
MA=${MA:-0}; MI=${MI:-0}; PA=${PA:-0}
VERSION_CODE=$((MA * 10000 + MI * 100 + PA))
API_NORM="${API_BASE_URL%/}"
if [[ "$API_NORM" == https://* ]] && [[ "$API_NORM" != *127.0.0.1* ]] && [[ "$API_NORM" != *localhost* ]]; then
  CHANNEL=p
else
  CHANNEL=d
fi
VERSION_NAME="${CHANNEL}+${SEMVER}"

write_manifest "hubera-music.apk" "cloud.hubera.music" "$OUT_DIR/hubera-music.apk"
write_manifest "ytmusic.apk" "ovh.delhomme.ytmusic" "$OUT_DIR/ytmusic.apk"

echo "==> Publié Hubera : $OUT_DIR/hubera-music.apk ($(du -h "$OUT_DIR/hubera-music.apk" | cut -f1))"
echo "    Manifest Hubera : $OUT_DIR/hubera-manifest.json"
echo "==> Publié legacy : $OUT_DIR/ytmusic.apk ($(du -h "$OUT_DIR/ytmusic.apk" | cut -f1))"
echo "    Manifest legacy : $OUT_DIR/manifest.json"
echo "    Téléchargement : /api/deploy/apk?package=cloud.hubera.music"
