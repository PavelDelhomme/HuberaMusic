#!/usr/bin/env bash
# Installe / ouvre PLM PWA sur appareil Android USB (ADB).
# Usage : DEVICE=R5CT7263YJL ./scripts/android/mobile-install-adb.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEVICE="${DEVICE:-R5CT7263YJL}"
MODE="${1:-install}" # open | install

red() { printf '\033[1;31m%s\033[0m\n' "$*"; }
grn() { printf '\033[1;32m%s\033[0m\n' "$*"; }
cyn() { printf '\033[0;36m%s\033[0m\n' "$*"; }

if ! command -v adb >/dev/null; then
  red "adb introuvable — pacman -S android-tools"
  exit 1
fi

if ! adb devices | awk 'NR>1 && $2=="device"{print $1}' | grep -qx "$DEVICE"; then
  red "Device $DEVICE pas en mode « device » :"
  adb devices -l
  exit 1
fi

# Santé locale
API_OK=0
WEB_OK=0
curl -fsS --max-time 2 http://127.0.0.1:8787/api/health >/dev/null 2>&1 && API_OK=1 || true
curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:5173/ >/dev/null 2>&1 && WEB_OK=1 || true

if [[ "$WEB_OK" != "1" ]]; then
  red "Vite (:5173) down — lance d’abord : make dev"
  exit 1
fi
if [[ "$API_OK" != "1" ]]; then
  red "API (:8787) down — lance d’abord : make dev"
  exit 1
fi

# Reverse USB : le téléphone voit localhost:5173 → ton PC (PWA installable en HTTP localhost)
cyn "→ adb reverse tcp:5173 / tcp:8787 sur $DEVICE"
adb -s "$DEVICE" reverse --remove-all 2>/dev/null || true
adb -s "$DEVICE" reverse tcp:5173 tcp:5173
adb -s "$DEVICE" reverse tcp:8787 tcp:8787

# localhost = contexte sécurisé Chrome → install PWA possible
URL="${MOBILE_URL:-http://127.0.0.1:5173/}"
if [[ "$MODE" == "install" ]]; then
  URL="${MOBILE_URL:-http://127.0.0.1:5173/?install=1}"
fi

grn "→ Chrome : $URL"
# Force Chrome (pas le navigateur Samsung parfois)
adb -s "$DEVICE" shell am force-stop com.android.chrome 2>/dev/null || true
adb -s "$DEVICE" shell am start \
  -a android.intent.action.VIEW \
  -d "$URL" \
  -n com.android.chrome/com.google.android.apps.chrome.Main \
  >/dev/null 2>&1 || \
adb -s "$DEVICE" shell am start -a android.intent.action.VIEW -d "$URL" >/dev/null

echo ""
grn "✅ Tunnel USB prêt (localhost via adb reverse)"
echo "  Device : $DEVICE"
echo "  URL    : $URL"
echo ""
if [[ "$MODE" == "install" ]]; then
  echo "  Sur le téléphone :"
  echo "  1. Attends le chargement de PLM"
  echo "  2. Bannière « Installer l’app » → Installer maintenant"
  echo "     (ou Chrome ⋮ → Installer l’application)"
  echo "  3. Connecte-toi avec ton compte (SEED_EMAIL / .env)"
  echo ""
  echo "  Astuce : si la bannière n’apparaît pas, ⋮ → « Installer l’application »."
else
  echo "  Mode open — pour installer la PWA : make mobile-install-adb"
fi
echo ""
adb -s "$DEVICE" reverse --list 2>/dev/null || true
