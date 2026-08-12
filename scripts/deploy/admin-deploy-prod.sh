#!/usr/bin/env bash
# Déploiement depuis Admin local (APP_ENV=local uniquement).
# Usage :
#   bash scripts/deploy/admin-deploy-prod.sh web|apk|all
#
# Redeploy VPS : SSH | Portainer Access Token (CE) | Watchtower — PAS de webhook Pro.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

MODE="${1:-web}"
PROD_URL="${DEPLOY_URL:-${PROD_APP_URL:-https://ytmusic.delhomme.ovh}}"
PROD_URL="${PROD_URL%/}"
STASHED=0

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env" 2>/dev/null || true
  set +a
fi

APP_ENV_NOW="${APP_ENV:-local}"
if [[ "$APP_ENV_NOW" != "local" && "${ALLOW_REMOTE_ADMIN_DEPLOY:-0}" != "1" ]]; then
  echo "Refus : APP_ENV=$APP_ENV_NOW (déploiement Admin réservé au local)" >&2
  exit 2
fi

cleanup_stash() {
  if [[ "$STASHED" == "1" ]]; then
    echo "==> Restauration du stash local…"
    git stash pop || echo "    (stash pop conflictuel — vérifie git stash list)"
  fi
}
trap cleanup_stash EXIT

ensure_clean_or_stash() {
  if [[ -z "$(git status --porcelain)" ]]; then
    return 0
  fi
  echo "==> Working tree sale — stash automatique avant bascule de branche"
  git status --short
  git stash push -u -m "admin-deploy-auto $(date -Iseconds)"
  STASHED=1
}

# Pousse la branche courante + synchronise origin/dev avant de merger dans prod
sync_dev_from_current() {
  local current
  current="$(git branch --show-current)"
  echo "==> Push branche courante ($current)…"
  git push -u origin HEAD

  if [[ "$current" != "dev" && "$current" != "prod" ]]; then
    echo "==> Merge $current → origin/dev…"
    git fetch origin
    git checkout dev
    git pull origin dev
    git merge "origin/$current" -m "merge: $current → dev (admin-deploy)"
    git push origin dev
    git checkout "$current"
    if [[ "$STASHED" == "1" ]]; then
      # rester sur la branche de travail ; stash restauré en EXIT
      :
    fi
  elif [[ "$current" == "dev" ]]; then
    git push origin dev
  fi
}

deploy_web() {
  ensure_clean_or_stash
  sync_dev_from_current

  echo "==> Web : merge origin/dev → prod + push (image GHCR)"
  git fetch origin
  local current
  current="$(git branch --show-current)"
  git checkout prod
  git pull origin prod
  git merge origin/dev -m "merge: promu dev → prod (admin)"
  git push origin prod
  git checkout "$current"
  echo "==> Push prod OK — GitHub Actions build ghcr.io/…/ytmusic:latest"

  echo "==> Redeploy VPS (sans webhook Pro)…"
  bash "$ROOT/scripts/deploy/redeploy-vps.sh"
}

deploy_apk() {
  echo "==> APK : build + upload vers $PROD_URL"
  DEPLOY_URL="$PROD_URL" \
    API_BASE_URL="$PROD_URL" \
    BUILD_FIRST=1 \
    bash "$ROOT/scripts/android/publish-apk-remote.sh"
  echo "==> APK publiée : $PROD_URL/api/deploy/apk"
}

case "$MODE" in
  web) deploy_web ;;
  apk) deploy_apk ;;
  all)
    deploy_web
    deploy_apk
    ;;
  *)
    echo "Usage: $0 web|apk|all" >&2
    exit 1
    ;;
esac

echo ""
echo "==> Terminé ($MODE)"
