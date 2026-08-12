#!/usr/bin/env bash
# Build + install APK Android Kotlin natif (Compose / Media3) — sans Capacitor / WebView
# Flavors :
#   prod → ovh.delhomme.ytmusic     (API HTTPS distante)
#   dev  → ovh.delhomme.ytmusic.dev (API LAN)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/mobile-android"
DEVICE="${DEVICE:-R5CT7263YJL}"
MODE="${1:-install}" # build | install

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
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

API_BASE_URL="${API_BASE_URL:-${VITE_API_ORIGIN:-}}"

detect_lan_ip() {
  ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}'
}

# Téléphone physique : 127.0.0.1 = le phone, JAMAIS le PC. Toujours IP LAN pour le local.
if [[ -z "$API_BASE_URL" || "$API_BASE_URL" == *"127.0.0.1"* || "$API_BASE_URL" == *"localhost"* ]]; then
  LAN="$(detect_lan_ip || true)"
  if [[ -n "${LAN:-}" ]]; then
    API_BASE_URL="http://${LAN}:8787"
    echo "==> API LAN auto : $API_BASE_URL (jamais 127.0.0.1 sur device physique)"
  else
    echo "❌ Impossible de détecter l’IP LAN du PC — définis API_BASE_URL=http://IP:8787" >&2
    exit 1
  fi
fi

API_NORM="${API_BASE_URL%/}"
if [[ -n "${FLAVOR:-}" ]]; then
  CHANNEL_FLAVOR="$FLAVOR"
elif [[ "$API_NORM" == https://* ]] && [[ "$API_NORM" != *127.0.0.1* ]] && [[ "$API_NORM" != *localhost* ]]; then
  CHANNEL_FLAVOR=prod
else
  CHANNEL_FLAVOR=dev
fi
case "$CHANNEL_FLAVOR" in
  prod) PKG=ovh.delhomme.ytmusic ;;
  dev) PKG=ovh.delhomme.ytmusic.dev ;;
  *) echo "❌ FLAVOR invalide: $CHANNEL_FLAVOR (prod|dev)" >&2; exit 1 ;;
esac

echo "==> MODE=$MODE"
echo "==> DEVICE=$DEVICE"
echo "==> FLAVOR=$CHANNEL_FLAVOR PKG=$PKG"
echo "==> API_BASE_URL=$API_BASE_URL"
echo "==> ANDROID_HOME=$ANDROID_HOME"
echo "==> JAVA_HOME=$JAVA_HOME"

mkdir -p "$APP"
printf 'sdk.dir=%s\n' "$ANDROID_HOME" >"$APP/local.properties"
echo "==> local.properties → sdk.dir=$ANDROID_HOME"

cd "$APP"
chmod +x ./gradlew

GRADLE_TASK=":app:assemble$(echo "${CHANNEL_FLAVOR:0:1}" | tr '[:lower:]' '[:upper:]')${CHANNEL_FLAVOR:1}Debug"

echo "==> Gradle $GRADLE_TASK…"
./gradlew "$GRADLE_TASK" -PAPI_BASE_URL="$API_BASE_URL" --no-daemon

APK="$APP/app/build/outputs/apk/${CHANNEL_FLAVOR}/debug/app-${CHANNEL_FLAVOR}-debug.apk"
if [[ ! -f "$APK" ]]; then
  echo "APK introuvable: $APK" >&2
  ls -la "$APP/app/build/outputs/apk/" 2>/dev/null || true
  exit 1
fi
echo "==> APK: $APK ($(du -h "$APK" | cut -f1))"

if [[ "$MODE" == "build" ]]; then
  exit 0
fi

# Attente / recovery ADB unauthorized (ne plus échouer en « non connecté »)
chmod +x "$ROOT/scripts/adb-ensure-device.sh"
RESOLVED="$(bash "$ROOT/scripts/adb-ensure-device.sh" "$DEVICE")" || {
  echo "" >&2
  echo "Build APK OK, mais install impossible sans device autorisé." >&2
  echo "APK prêt : $APK" >&2
  echo "Une fois la popup USB acceptée : make android" >&2
  exit 1
}
if [[ "$RESOLVED" != "$DEVICE" ]]; then
  echo "==> DEVICE résolu : $DEVICE → $RESOLVED"
fi
DEVICE="$RESOLVED"

# LAN / HTTPS : pas de adb reverse (127.0.0.1 sur le phone ≠ PC)
if [[ "$API_BASE_URL" == https://* ]] || [[ "$API_BASE_URL" == *"192.168."* ]] || [[ "$API_BASE_URL" == *"10."* ]]; then
  echo "==> API $API_BASE_URL — pas de adb reverse (réseau / distant)"
  adb -s "$DEVICE" reverse --remove-all >/dev/null 2>&1 || true
else
  echo "==> adb reverse tcp:8787 + tcp:5173 (émulateur / cas spécial)…"
  adb -s "$DEVICE" reverse tcp:8787 tcp:8787 || true
  adb -s "$DEVICE" reverse tcp:5173 tcp:5173 || true
fi

# Efface un éventuel override prefs 127.0.0.1 (ancienne UI debug)
adb -s "$DEVICE" shell "run-as $PKG sh -c 'rm -f shared_prefs/ytm_api.xml' 2>/dev/null" || true

echo "==> Install…"
adb -s "$DEVICE" install -r "$APK"
echo "==> Launch…"
adb -s "$DEVICE" shell am start -n "$PKG/ovh.delhomme.ytmusic.MainActivity"
echo "OK — app Kotlin native installée sur $DEVICE (PKG=$PKG API=$API_BASE_URL)"
