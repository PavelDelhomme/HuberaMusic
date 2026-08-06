#!/usr/bin/env bash
# Exporte une session navigateur (Chrome/Firefox) et la pousse vers l’API
# (prod ou local) — outil ops optionnel pour anti-bot.
#
# Prérequis : être connecté à youtube.com dans Chrome (ou Firefox).
#
# Usage :
#   bash scripts/push-youtube-cookies.sh              # → https://ytmusic.delhomme.ovh
#   bash scripts/push-youtube-cookies.sh local         # → http://127.0.0.1:8787
#   TARGET=https://ytmusic.delhomme.ovh BROWSER=chrome bash scripts/push-youtube-cookies.sh
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env" 2>/dev/null || true
  set +a
fi

MODE="${1:-prod}"
BROWSER="${BROWSER:-chrome}"
YTD="${YTDLP:-$ROOT/bin/yt-dlp}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

case "$MODE" in
  local|dev)
    TARGET="${TARGET:-http://127.0.0.1:8787}"
    ;;
  prod|*)
    TARGET="${TARGET:-${DEPLOY_URL:-${APP_URL_PROD:-https://ytmusic.delhomme.ovh}}}"
    TARGET="${TARGET%/}"
    if [[ "$TARGET" == http://127.0.0.1* || "$TARGET" == http://localhost* ]]; then
      TARGET="https://ytmusic.delhomme.ovh"
    fi
    ;;
esac

EMAIL="${SEED_EMAIL:-${VITE_DEV_EMAIL:-}}"
PASS="${SEED_PASSWORD:-${VITE_DEV_PASSWORD:-}}"
if [[ -z "$EMAIL" || -z "$PASS" ]]; then
  echo "SEED_EMAIL / SEED_PASSWORD manquants dans .env" >&2
  exit 2
fi

if [[ ! -x "$YTD" ]]; then
  echo "yt-dlp introuvable : $YTD" >&2
  exit 2
fi

COOKIE_FILE="$TMP/cookies.netscape"
echo "==> Export cookies depuis navigateur « $BROWSER » (ferme Chrome si le DB est verrouillé)…"
set +e
# ignore-no-formats : on veut seulement écrire le Netscape, pas streamer
"$YTD" --cookies-from-browser "$BROWSER" --cookies "$COOKIE_FILE" \
  --skip-download --ignore-no-formats-error --no-warnings -q \
  "https://www.youtube.com/" 2>"$TMP/ytd.err"
RC=$?
set -e
# Le fichier cookies est souvent écrit même si yt-dlp exit ≠ 0 (formats KO)
if [[ ! -s "$COOKIE_FILE" ]]; then
  echo "Échec export $BROWSER — essai firefox…" >&2
  cat "$TMP/ytd.err" >&2 || true
  BROWSER=firefox
  set +e
  "$YTD" --cookies-from-browser "$BROWSER" --cookies "$COOKIE_FILE" \
    --skip-download --ignore-no-formats-error --no-warnings -q \
    "https://www.youtube.com/" 2>"$TMP/ytd.err"
  set -e
fi
if [[ ! -s "$COOKIE_FILE" ]]; then
  echo "Impossible d’exporter les cookies navigateur (DB verrouillée ? ferme Chrome/Firefox)." >&2
  cat "$TMP/ytd.err" >&2 || true
  exit 1
fi

HEADER="$TMP/cookie.header"
python3 - <<PY
from pathlib import Path
raw = Path("$COOKIE_FILE").read_text(errors="ignore")
seen = {}
for line in raw.splitlines():
    if not line or line.startswith("#"):
        continue
    cols = line.split("\t")
    if len(cols) < 7:
        continue
    domain, name, value = cols[0], cols[5], cols[6]
    if "youtube.com" not in domain and "google.com" not in domain:
        continue
    seen[name] = f"{name}={value}"
header = "; ".join(seen.values())
if len(header) < 40:
    raise SystemExit("Aucune session navigateur utile — connecte-toi sur youtube.com puis réessaie")
Path("$HEADER").write_text(header)
print(f"    {len(seen)} cookies · {len(header)} octets")
PY

echo "==> Login admin → $TARGET"
TOKEN="$(
  curl -fsS -X POST "$TARGET/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "$(python3 -c "import json;print(json.dumps({'email':'''$EMAIL''','password':'''$PASS'''}))")" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('token') or d.get('accessToken') or '')"
)"
if [[ -z "$TOKEN" ]]; then
  echo "Login KO — vérifie SEED_EMAIL / SEED_PASSWORD (compte admin)" >&2
  exit 1
fi

echo "==> Push cookies Admin…"
BODY="$(python3 -c "import json;print(json.dumps({'cookie':open('$HEADER').read()}))")"
RESP="$(
  curl -fsS -X POST "$TARGET/api/admin/youtube-cookies" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$BODY"
)"
echo "$RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);print('    configured=',d.get('configured'),'source=',d.get('source'))"

echo "==> Test stream…"
CODE="$(
  curl -sS -o "$TMP/stream.bin" -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Range: bytes=0-2047' \
    "$TARGET/api/stream/jNQXAC9IVRw"
)"
SIZE="$(wc -c <"$TMP/stream.bin" | tr -d ' ')"
if [[ "$CODE" == "200" || "$CODE" == "206" ]] && [[ "$SIZE" -gt 500 ]]; then
  echo "✅ Stream OK ($CODE, ${SIZE}o) — prod/local débloqué"
else
  echo "⚠️  HTTP $CODE size=$SIZE — cookies poussés mais stream encore KO."
  echo "    Attends 10s / redéploie l’image (fix Netscape), ou reconnecte-toi sur youtube.com et relance."
  head -c 240 "$TMP/stream.bin"; echo
  exit 1
fi
