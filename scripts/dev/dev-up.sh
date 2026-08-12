#!/usr/bin/env bash
# Démarre API + Vite en fond (setsid) — survit à la fermeture du terminal agent
# Usage : scripts/dev/dev-up.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
mkdir -p logs

chmod +x scripts/dev/ensure-api.sh scripts/dev/kill-dev.sh scripts/dev/env-check.sh

bash scripts/dev/env-check.sh || true
FORCE_RESTART=0 bash scripts/dev/ensure-api.sh

# Vite : libère 5173/5174 puis démarre détaché
bash scripts/dev/kill-dev.sh vite-only
: >> logs/ytmusic-dev.log
echo "---- vite start $(date -Iseconds) ----" >> logs/ytmusic-dev.log

setsid -f bash -c "cd '$ROOT' && exec npm run dev:web" >>logs/ytmusic-dev.log 2>&1
sleep 1.5
pgrep -n -f "node_modules/.bin/vite" >logs/ytmusic-web.pid 2>/dev/null || true

ok=0
for i in $(seq 1 40); do
  if curl -fsS --max-time 1 -o /dev/null http://127.0.0.1:5173/ 2>/dev/null; then
    ok=1
    break
  fi
  sleep 0.35
done

echo ""
if [[ "$ok" == "1" ]]; then
  echo "✅ Web UP  → http://127.0.0.1:5173"
else
  echo "❌ Vite ne répond pas sur :5173 — voir logs/ytmusic-dev.log"
  tail -n 40 logs/ytmusic-dev.log || true
  exit 1
fi
echo "✅ API UP  → http://127.0.0.1:8787/api/health"
echo "📝 Logs    → make logs"
echo "📱 Mobile  → make android"
