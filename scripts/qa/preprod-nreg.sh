#!/usr/bin/env bash
# Non-régression Music — à lancer AVANT tout déploiement prod (API / APK).
# Usage : bash scripts/qa/preprod-nreg.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "==> nreg API (node:test)"
npx --yes tsx --test \
  api/src/nreg/playbackPolicy.test.ts \
  api/src/youtube/lyricsTiming.test.ts \
  api/src/media/id3Meta.test.ts \
  api/src/library/searchIndex.test.ts

echo "==> nreg Android (unit tests)"
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk}"
export ANDROID_HOME="${ANDROID_HOME:-/home/pactivisme/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:${ANDROID_HOME}/platform-tools:$PATH"
if [[ -x "$ROOT/mobile-android/gradlew" ]]; then
  (cd "$ROOT/mobile-android" && ./gradlew :app:testProdDebugUnitTest --quiet --no-daemon)
else
  echo "!! gradlew manquant" >&2
  exit 2
fi

echo "==> nreg OTA (jamais forcé)"
python3 - <<'PY'
import json, urllib.request
raw = urllib.request.urlopen(
    "https://ytmusic.delhomme.ovh/api/version?clientVersion=1.3.0&clientVersionCode=1&clientPackage=cloud.hubera.music",
    timeout=12,
).read()
d = json.loads(raw)
assert d.get("forceUpdate") is False, d
print("    forceUpdate=false ok", d.get("version"))
PY

echo "==> nreg OK"
