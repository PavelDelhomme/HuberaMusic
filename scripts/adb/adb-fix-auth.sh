#!/usr/bin/env bash
# Répare ADB « unauthorized » SANS popup (Samsung / clé RSA désync).
# Usage :
#   bash scripts/adb-fix-auth.sh              # diagnostic + reset soft
#   bash scripts/adb-fix-auth.sh --new-keys   # après avoir révoqué sur le téléphone
set -euo pipefail

ADB_BIN="${ADB_BIN:-adb}"
NEW_KEYS=0
for a in "$@"; do
  case "$a" in
    --new-keys|-n) NEW_KEYS=1 ;;
    -h|--help)
      cat <<EOF
Usage: $0 [--new-keys]

Sans flag : redémarre ADB, reset USB Samsung, affiche l’état.
--new-keys : régénère ~/.android/adbkey* (UNIQUEMENT après
  Paramètres → Options pour les développeurs →
  « Révoquer les autorisations de débogage USB » sur le téléphone).
EOF
      exit 0
      ;;
  esac
done

echo "==> Diagnostic ADB / USB"
"$ADB_BIN" version | head -1 || true
echo ""
echo "Devices :"
"$ADB_BIN" devices -l || true
echo ""
lsusb -d 04e8: 2>/dev/null || lsusb | head -10
echo ""

# Groupe / udev
me="$(id -un 2>/dev/null || whoami)"
if getent group adbusers >/dev/null 2>&1; then
  if getent group adbusers | grep -Eq "(^|,)${me}(,|$)"; then
    if id -nG 2>/dev/null | tr ' ' '\n' | grep -qx adbusers; then
      echo "✓ groupe adbusers OK (session courante)"
    else
      echo "✓ adbusers configuré — ouvre un nouveau terminal (ou : newgrp adbusers)"
    fi
  else
    echo "⚠ ajoute-toi à adbusers :"
    echo "    sudo usermod -aG adbusers $me && newgrp adbusers"
  fi
else
  echo "⚠ paquet android-udev recommandé : sudo pacman -S android-udev"
fi
echo ""

if (( NEW_KEYS == 1 )); then
  mkdir -p "$HOME/.android"
  ts="$(date +%Y%m%d-%H%M%S)"
  if [[ -f "$HOME/.android/adbkey" ]]; then
    mv "$HOME/.android/adbkey" "$HOME/.android/adbkey.bak.$ts"
    mv "$HOME/.android/adbkey.pub" "$HOME/.android/adbkey.pub.bak.$ts" 2>/dev/null || true
    echo "==> Anciennes clés → adbkey.bak.$ts"
  fi
  "$ADB_BIN" kill-server >/dev/null 2>&1 || true
  sleep 1
  # start-server régénère adbkey si absent
  "$ADB_BIN" start-server >/dev/null 2>&1 || true
  sleep 1
  if [[ ! -f "$HOME/.android/adbkey" ]]; then
    echo "❌ Impossible de régénérer adbkey"
    exit 1
  fi
  echo "✓ Nouvelles clés générées — accepte la popup sur le téléphone"
else
  "$ADB_BIN" kill-server >/dev/null 2>&1 || true
  sleep 1
  "$ADB_BIN" start-server >/dev/null 2>&1 || true
  sleep 1
fi

# Reset autorisation USB sysfs (Samsung 04e8)
for sys in /sys/bus/usb/devices/*; do
  [[ -f "$sys/idVendor" ]] || continue
  vend="$(cat "$sys/idVendor" 2>/dev/null || true)"
  [[ "$vend" == "04e8" ]] || continue
  prod="$(cat "$sys/idProduct" 2>/dev/null || true)"
  # Ignore disques Samsung externes (ex. 61b6)
  [[ "$prod" == "61b6" ]] && continue
  name="$(basename "$sys")"
  if [[ -w "$sys/authorized" ]] || sudo -n true 2>/dev/null; then
    echo "==> Reset USB $name (04e8:$prod)"
    echo 0 | sudo tee "$sys/authorized" >/dev/null 2>&1 || true
    sleep 1
    echo 1 | sudo tee "$sys/authorized" >/dev/null 2>&1 || true
  fi
done

sleep 2
"$ADB_BIN" reconnect >/dev/null 2>&1 || true
sleep 1

echo ""
echo "État après reset :"
"$ADB_BIN" devices -l || true
state="$("$ADB_BIN" devices | awk 'NR>1 && $2!=""{print $2; exit}')"

if [[ "$state" == "device" ]]; then
  echo ""
  echo "✅ ADB autorisé — tu peux lancer : make android"
  exit 0
fi

cat <<'EOF'

╔══════════════════════════════════════════════════════════════════╗
║  Pas de popup + « unauthorized » = clé RSA PC ≠ téléphone       ║
║  (le câble / MTP / réveil écran sont OK — ce n’est PAS ça)      ║
╚══════════════════════════════════════════════════════════════════╝

Sur le téléphone (écran déverrouillé) :
  1. Paramètres → Options pour les développeurs
  2. « Révoquer les autorisations de débogage USB »
  3. Désactive puis réactive « Débogage USB »
  4. Débranche / rebranche le câble (mode Transfert de fichiers)
  5. La popup « Autoriser le débogage USB ? » DOIT apparaître
     → coche « Toujours autoriser depuis cet ordinateur » → OK

Puis sur le PC :
  bash scripts/adb-fix-auth.sh --new-keys
  adb devices    # doit afficher « device »

Sans popup après révocation : change brièvement le mode USB
(MIDI ↔ Transfert de fichiers), ou redémarre le téléphone.

EOF
exit 1
