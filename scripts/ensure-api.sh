#!/usr/bin/env bash
# Assure que l’API PLM écoute sur :8787
# - Si /api/health répond → OK (réutilise l’instance existante)
# - Si le port est pris sans health → tue le process sur le port puis relance
# - Si libre → démarre en arrière-plan
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8787}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
FORCE="${FORCE_RESTART:-0}"
LOG="$ROOT/logs/ytmusic-server.log"
PIDFILE="$ROOT/logs/ytmusic-server.pid"

mkdir -p "$ROOT/logs"

is_up() {
  curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1
}

pids_on_port() {
  local out=""
  if command -v lsof >/dev/null 2>&1; then
    out="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  fi
  if [[ -z "$out" ]] && command -v fuser >/dev/null 2>&1; then
    out="$(fuser "${PORT}/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true)"
  fi
  if [[ -z "$out" ]] && command -v ss >/dev/null 2>&1; then
    out="$(ss -tlnp 2>/dev/null | grep -E ":${PORT}\\b" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"
  fi
  echo "$out" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u || true
}

free_port() {
  local pids
  pids="$(pids_on_port | tr '\n' ' ')"
  if [[ -z "${pids// }" ]]; then
    echo "  (rien à tuer sur :$PORT)"
    return 0
  fi
  echo "  Libération du port :$PORT (PIDs: $pids)"
  for pid in $pids; do
    if [[ -r "/proc/$pid/cmdline" ]]; then
      cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline" | cut -c1-140)"
      echo "    → kill $pid  $cmd"
    fi
    kill "$pid" 2>/dev/null || true
  done
  sleep 0.7
  pids="$(pids_on_port | tr '\n' ' ')"
  if [[ -n "${pids// }" ]]; then
    echo "  Force kill -9 : $pids"
    for pid in $pids; do
      kill -9 "$pid" 2>/dev/null || true
    done
    sleep 0.4
  fi
  fuser -k "${PORT}/tcp" 2>/dev/null || true
  sleep 0.3
}

start_server() {
  echo "  Démarrage API (tsx, détaché) → $LOG"
  cd "$ROOT"
  # Charge .env dans l’environnement process (JWT_SECRET stable → évite 401 après restart)
  if [[ -f "$ROOT/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$ROOT/.env"
    set +a
  fi
  {
    echo ""
    echo "==== api start $(date '+%Y-%m-%d %H:%M:%S %z') ===="
  } >>"$LOG"
  # Nouvelle session : survit à la fermeture du shell parent (Cursor / make)
  # Évite que $! pointe seulement sur un wrapper npx tué avec le groupe.
  setsid nohup "$ROOT/node_modules/.bin/tsx" api/src/index.ts >>"$LOG" 2>&1 </dev/null &
  echo $! >"$PIDFILE"
  disown $! 2>/dev/null || true
  sleep 1.8
  echo "  PID api: $(cat "$PIDFILE" 2>/dev/null || echo '?')"
}

warn_cookies() {
  local try_auto="${1:-0}"
  local header="$ROOT/data/youtube-cookies.header"
  local netscape="$ROOT/data/youtube-cookies.txt"
  if [[ -s "$header" || -s "$netscape" ]]; then
    return 0
  fi
  echo "ℹ️  Pas de session navigateur locale (optionnel)"
  echo "   Les streams marchent souvent sans. Stabiliser / VPS : bash scripts/push-youtube-cookies.sh local"
  # Auto-export seulement au démarrage (pas à chaque ensure-api si déjà UP)
  # Défaut OFF : Chrome ouvert verrouille souvent la DB → hang. Force avec AUTO_YT_COOKIES=1
  if [[ "$try_auto" == "1" && "${AUTO_YT_COOKIES:-0}" == "1" ]]; then
    echo "   Tentative export auto depuis le navigateur (max 45s)…"
    if timeout 45 bash "$ROOT/scripts/push-youtube-cookies.sh" local >>"$LOG" 2>&1; then
      echo "   ✅ Cookies importés — redémarrage API pour les prendre en compte…"
      free_port
      start_server
      wait_health || true
    else
      echo "   (export auto échoué — Chrome ouvert ? relance push-youtube-cookies.sh local)"
    fi
  fi
}

wait_health() {
  local i
  for i in $(seq 1 80); do
    if is_up; then
      echo "✅ API UP sur :$PORT"
      curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null | head -c 220 || true
      echo ""
      return 0
    fi
    sleep 0.4
  done
  echo "❌ API ne répond pas sur $HEALTH_URL"
  echo "   tail -n 60 $LOG :"
  tail -n 60 "$LOG" 2>/dev/null || true
  return 1
}

echo "==> ensure-api (:$PORT)"

if [[ "$FORCE" == "1" ]]; then
  echo "  FORCE_RESTART=1 → redémarrage forcé"
  free_port
  start_server
  wait_health
  ec=$?
  warn_cookies 1
  exit "$ec"
fi

if is_up; then
  echo "✅ API déjà UP — on réutilise (pas de conflit de port)"
  curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null | head -c 220 || true
  echo ""
  warn_cookies 0
  exit 0
fi

if [[ -n "$(pids_on_port)" ]]; then
  echo "⚠️  Port :$PORT occupé mais /api/health KO → libération"
  free_port
fi

start_server
wait_health
ec=$?
warn_cookies 1
exit "$ec"
