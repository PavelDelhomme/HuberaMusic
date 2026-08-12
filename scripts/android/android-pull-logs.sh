#!/usr/bin/env bash
# Récupère les logs / crashes de l’APK Kotlin (debug) via adb run-as.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PKG="${ANDROID_PACKAGE:-ovh.delhomme.ytmusic}"
OUT="${ANDROID_LOGS_OUT:-$ROOT/logs/android}"
DEVICE="${DEVICE:-}"

ADB=(adb)
if [[ -n "$DEVICE" ]]; then
  ADB=(adb -s "$DEVICE")
fi

if ! "${ADB[@]}" get-state >/dev/null 2>&1; then
  echo "Aucun device ADB. Branche le téléphone ou DEVICE=serial make android-logs"
  exit 1
fi

mkdir -p "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$OUT/pull-$STAMP"
mkdir -p "$DEST"

echo "→ Pull logs $PKG → $DEST"

mapfile -t FILES < <("${ADB[@]}" shell "run-as $PKG ls -1 files/ytm-logs 2>/dev/null" | tr -d '\r' || true)

if [[ ${#FILES[@]} -eq 0 || -z "${FILES[0]:-}" ]]; then
  echo "Aucun fichier dans files/ytm-logs (ouvre l’app une fois)."
  echo "Astuce : Compte → Logs debug (build debug)."
  exit 0
fi

for f in "${FILES[@]}"; do
  [[ -z "$f" ]] && continue
  echo "  · $f"
  "${ADB[@]}" exec-out run-as "$PKG" cat "files/ytm-logs/$f" > "$DEST/$f" || true
  # Repli si exec-out échoue
  if [[ ! -s "$DEST/$f" ]]; then
    "${ADB[@]}" shell "run-as $PKG cat files/ytm-logs/$f" | tr -d '\r' > "$DEST/$f" || true
  fi
done

ln -sfn "pull-$STAMP" "$OUT/latest"
if [[ -f "$DEST/last-crash.txt" ]]; then
  cp -f "$DEST/last-crash.txt" "$OUT/last-crash.txt"
  echo ""
  echo "=== last-crash.txt ==="
  head -n 40 "$DEST/last-crash.txt"
fi

echo ""
echo "OK → $DEST"
echo "    $OUT/latest"
