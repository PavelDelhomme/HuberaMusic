#!/usr/bin/env bash
# Assure qu’un device ADB est « device » (autorisé), pas unauthorized/offline.
# Usage :
#   source scripts/adb/adb-ensure-device.sh
#   DEVICE="$(adb_ensure_device "${DEVICE:-}")" || exit 1
# Ou :
#   DEVICE="$(bash scripts/adb/adb-ensure-device.sh R5CT7263YJL)" || exit 1
set -euo pipefail

ADB_BIN="${ADB_BIN:-adb}"
ADB_WAIT_SECS="${ADB_WAIT_SECS:-90}"

adb_list() {
  "$ADB_BIN" devices -l 2>/dev/null || true
}

adb_state_of() {
  local serial="$1"
  adb_list | awk -v s="$serial" 'NR>1 && $1==s {print $2; exit}'
}

adb_first_authorized() {
  adb_list | awk 'NR>1 && $2=="device"{print $1; exit}'
}

adb_any_unauthorized() {
  adb_list | awk 'NR>1 && $2=="unauthorized"{print $1; exit}'
}

adb_restart_server() {
  echo "==> ADB : redémarrage du serveur…" >&2
  "$ADB_BIN" kill-server >/dev/null 2>&1 || true
  sleep 1
  "$ADB_BIN" start-server >/dev/null 2>&1 || true
  sleep 1
  "$ADB_BIN" reconnect >/dev/null 2>&1 || true
  sleep 1
}

adb_print_unauthorized_help() {
  local serial="${1:-}"
  cat >&2 <<EOF

╔══════════════════════════════════════════════════════════════════╗
║  ADB « unauthorized » — clé RSA PC ≠ téléphone (pas le câble)   ║
╚══════════════════════════════════════════════════════════════════╝

  Si le téléphone se réveille / MTP marche mais AUCUNE popup :
  c’est normal → l’ancienne autorisation est invalide, Samsung
  ne redemande pas tant que tu n’as pas révoqué.

  Sur le téléphone (écran déverrouillé) :
  1. Options pour les développeurs
  2. « Révoquer les autorisations de débogage USB »
  3. Coupe / rallume « Débogage USB »
  4. Débranche / rebranche (mode Transfert de fichiers)
  5. Accepte la popup + « Toujours autoriser… »

  Puis sur le PC :
     bash scripts/adb-fix-auth.sh --new-keys
     make android

EOF
  if [[ -n "$serial" ]]; then
    echo "  Serial attendu : $serial" >&2
  fi
  echo "" >&2
  echo "  Devices actuelles :" >&2
  adb_list >&2 || true
  echo "" >&2
}

# Attend qu’un device autorisé soit dispo. Echo le serial sur stdout.
# Retourne 0 si OK, 1 sinon.
adb_ensure_device() {
  local want="${1:-}"
  local waited=0
  local restarted=0
  local helped=0

  while (( waited <= ADB_WAIT_SECS )); do
    # 1) Serial demandé déjà OK
    if [[ -n "$want" ]]; then
      local st
      st="$(adb_state_of "$want" || true)"
      if [[ "$st" == "device" ]]; then
        echo "$want"
        return 0
      fi
      if [[ "$st" == "unauthorized" || "$st" == "offline" ]]; then
        if (( helped == 0 )); then
          adb_print_unauthorized_help "$want"
          helped=1
        fi
        if (( restarted == 0 && waited >= 3 )); then
          adb_restart_server
          restarted=1
        fi
      fi
    fi

    # 2) Autre appareil déjà autorisé → on bascule
    local other
    other="$(adb_first_authorized || true)"
    if [[ -n "$other" ]]; then
      if [[ -n "$want" && "$other" != "$want" ]]; then
        echo "==> ADB : $want indisponible → utilisation de $other" >&2
      fi
      echo "$other"
      return 0
    fi

    # 3) Unauthorized sans device OK → aide + attente
    local unauth
    unauth="$(adb_any_unauthorized || true)"
    if [[ -n "$unauth" ]]; then
      if (( helped == 0 )); then
        adb_print_unauthorized_help "${want:-$unauth}"
        helped=1
      fi
      if (( restarted == 0 && waited >= 3 )); then
        adb_restart_server
        restarted=1
      fi
      printf "\r==> ADB : en attente d’autorisation USB… %ds/%ds   " "$waited" "$ADB_WAIT_SECS" >&2
    elif [[ -z "$(adb_list | awk 'NR>1 && NF{print; exit}')" ]]; then
      if (( helped == 0 )); then
        echo "==> ADB : aucun appareil. Branche le téléphone (débogage USB ON)." >&2
        helped=1
      fi
      printf "\r==> ADB : en attente d’un appareil… %ds/%ds   " "$waited" "$ADB_WAIT_SECS" >&2
    fi

    sleep 2
    waited=$((waited + 2))
  done

  echo "" >&2
  echo "❌ ADB : timeout — aucun appareil autorisé après ${ADB_WAIT_SECS}s." >&2
  adb_list >&2 || true
  echo "" >&2
  echo "Astuce : ADB_WAIT_SECS=120 make android   # attendre plus longtemps" >&2
  echo "         DEVICE=<serial> make android     # forcer un autre téléphone" >&2
  return 1
}

# Exécution directe
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  adb_ensure_device "${1:-${DEVICE:-}}"
fi
