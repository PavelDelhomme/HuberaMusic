#!/usr/bin/env bash
# Relie le stream du VPS à ton API locale (IP maison = YouTube OK).
#
# ⚠ DÉCONSEILLÉ EN PROD — préférer OAuth TV VPS + YOUTUBE_HTTP_PROXY_FREE.
# Le fichier stream-upstream.url seul NE suffit plus : il faut aussi
#   ALLOW_STREAM_UPSTREAM=1
# dans l’env du conteneur (Portainer), sinon le VPS ignore le relais.
#
# Prérequis : API locale UP + SSH pavel-server + socat sur le VPS (recommandé).
#
# Usage :
#   bash scripts/deploy/link-home-stream.sh          # tunnel + active le relais
#   bash scripts/deploy/link-home-stream.sh status
#   bash scripts/deploy/link-home-stream.sh stop
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env" 2>/dev/null || true
  set +a
fi

SSH_HOST="${DEPLOY_SSH:-pavel-server}"
LOCAL_API="${HOME_STREAM_LOCAL:-http://127.0.0.1:8787}"
REMOTE_PORT="${HOME_STREAM_PORT:-18787}"
BRIDGE_PORT="${HOME_STREAM_BRIDGE_PORT:-18788}"
PID_FILE="${XDG_RUNTIME_DIR:-/tmp}/ytmusic-home-stream.ssh.pid"
CMD="${1:-start}"

case "$CMD" in
  status)
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "tunnel UP pid=$(cat "$PID_FILE") → ${SSH_HOST}:${REMOTE_PORT}"
    else
      echo "tunnel DOWN"
    fi
    curl -fsS --max-time 3 "${LOCAL_API}/api/health" >/dev/null && echo "API locale OK" || echo "API locale KO"
    ssh -o BatchMode=yes -o ConnectTimeout=8 "$SSH_HOST" \
      "docker exec ytmusic cat /app/data/stream-upstream.url 2>/dev/null || echo '(pas de stream-upstream.url)'"
    exit 0
    ;;
  stop)
    if [[ -f "$PID_FILE" ]]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null || true
      rm -f "$PID_FILE"
    fi
    pkill -f "ssh.*-R ${REMOTE_PORT}:127.0.0.1:8787" 2>/dev/null || true
    ssh -o BatchMode=yes "$SSH_HOST" "docker rm -f ytm-stream-bridge 2>/dev/null || true; docker exec ytmusic rm -f /app/data/stream-upstream.url 2>/dev/null || true; docker restart ytmusic >/dev/null" || true
    echo "tunnel stoppé"
    exit 0
    ;;
esac

echo "==> ensure-api local…"
FORCE_RESTART=0 bash "$ROOT/scripts/dev/ensure-api.sh" >/dev/null

if ! curl -fsS --max-time 3 "${LOCAL_API}/api/health" >/dev/null; then
  echo "API locale injoignable sur ${LOCAL_API}" >&2
  exit 1
fi

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "==> tunnel déjà actif pid=$(cat "$PID_FILE")"
else
  echo "==> tunnel SSH -R ${REMOTE_PORT}:127.0.0.1:8787 → $SSH_HOST"
  ssh -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -R "${REMOTE_PORT}:127.0.0.1:8787" "$SSH_HOST"
  pgrep -n -f "ssh.*-R ${REMOTE_PORT}:127.0.0.1:8787" >"$PID_FILE" || true
  echo "    pid=$(cat "$PID_FILE" 2>/dev/null || echo '?')"
fi

echo "==> bridge Docker socat + STREAM_UPSTREAM sur le VPS…"
ssh -o BatchMode=yes "$SSH_HOST" bash -s <<REMOTE
set -euo pipefail
if ! curl -fsS --max-time 3 "http://127.0.0.1:${REMOTE_PORT}/api/health" >/dev/null; then
  echo "Tunnel SSH injoignable sur 127.0.0.1:${REMOTE_PORT}" >&2
  exit 1
fi
docker rm -f ytm-stream-bridge 2>/dev/null || true
docker run -d --name ytm-stream-bridge --restart unless-stopped --network host \
  alpine/socat \
  TCP-LISTEN:${BRIDGE_PORT},fork,reuseaddr TCP:127.0.0.1:${REMOTE_PORT} >/dev/null
sleep 1
UP="http://172.17.0.1:${BRIDGE_PORT}"
if ! docker exec ytmusic curl -fsS --max-time 4 "\${UP}/api/health" >/dev/null; then
  echo "Docker n’atteint pas \${UP}" >&2
  exit 1
fi
echo "\$UP" | docker exec -i ytmusic sh -c 'cat > /app/data/stream-upstream.url'
docker restart ytmusic >/dev/null
echo "OK STREAM_UPSTREAM=\$UP"
REMOTE

echo ""
echo "✅ Tunnel maison actif — laisse ce PC allumé."
echo "   Stop : bash scripts/deploy/link-home-stream.sh stop"
echo "   Test lecture sur https://ytmusic.delhomme.ovh"
