#!/usr/bin/env bash
# Test régression stream — titres variés (home + recherche), head + mid-range.
# Usage: bash scripts/test/stream-regression.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
# shellcheck disable=SC1091
[[ -f .env ]] && set -a && source .env && set +a

API="${API_BASE_URL:-https://ytmusic.delhomme.ovh}"
EMAIL="${TEST_EMAIL:-dev@delhomme.ovh}"
PASS="${ADMIN_PASSWORD:-${SEED_PASSWORD:-}}"
REPORT="${REPORT:-/tmp/ytmusic-stream-regression-$(date +%Y%m%d-%H%M%S).txt}"

: >"$REPORT"
log() { echo "$*" | tee -a "$REPORT"; }

log "==> Stream regression $API"
log "==> $(date -Iseconds)"

TOKEN="$(curl -fsS -X POST "$API/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')"

HEALTH="$(curl -fsS "$API/api/health")"
log "health: $(echo "$HEALTH" | python3 -c 'import sys,json; h=json.load(sys.stdin); print(h.get("appVersion"), h.get("version","")[:8], "upstream=", h.get("streamUpstream"))')"

# Collecte IDs variés : home + recherches génériques
export API TOKEN
IDS="$(python3 - <<'PY'
import json, urllib.request, os
api = os.environ["API"].rstrip("/")
token = os.environ["TOKEN"]
hdr = {"Authorization": f"Bearer {token}"}

def get(path):
    r = urllib.request.Request(api + path, headers=hdr)
    with urllib.request.urlopen(r, timeout=30) as res:
        return json.loads(res.read())

ids = []
try:
    home = get("/api/home")
    for sec in home.get("shelves") or home.get("sections") or []:
        for it in sec.get("items") or []:
            tid = (it.get("id") or it.get("videoId") or "").strip()
            if len(tid) == 11:
                ids.append(tid)
except Exception as e:
    print(f"# home err {e}", file=__import__("sys").stderr)

for q in ["pop", "rock", "workout", "french", "remix", "2024"]:
    try:
        import urllib.parse
        r = get("/api/search?q=" + urllib.parse.quote(q) + "&limit=8")
        for it in (r.get("tracks") or r.get("results") or []):
            tid = (it.get("id") or it.get("videoId") or "").strip()
            if len(tid) == 11:
                ids.append(tid)
    except Exception:
        pass

# Dédup, cap 24
seen = set()
out = []
for i in ids:
    if i in seen:
        continue
    seen.add(i)
    out.append(i)
    if len(out) >= 24:
        break
print(" ".join(out))
PY
)"

if [[ -z "${IDS// }" ]]; then
  log "FAIL aucun ID collecté"
  exit 2
fi

log "==> $(echo $IDS | wc -w) IDs à tester"

HEAD_OK=0 HEAD_FAIL=0 MID_OK=0 MID_FAIL=0 MID_503=0
FAIL_IDS=""

for id in $IDS; do
  code_head="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 25 \
    -H "Authorization: Bearer $TOKEN" -H "Range: bytes=0-1" \
    "$API/api/stream/$id")"
  code_mid="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 130 \
    -H "Authorization: Bearer $TOKEN" -H "Range: bytes=1048576-2097151" \
    "$API/api/stream/$id")"

  if [[ "$code_head" == "206" || "$code_head" == "200" ]]; then
    HEAD_OK=$((HEAD_OK + 1))
  else
    HEAD_FAIL=$((HEAD_FAIL + 1))
    FAIL_IDS="$FAIL_IDS $id(head=$code_head)"
  fi

  case "$code_mid" in
    206|200) MID_OK=$((MID_OK + 1)) ;;
    503) MID_503=$((MID_503 + 1)) ;;
    *) MID_FAIL=$((MID_FAIL + 1)); FAIL_IDS="$FAIL_IDS $id(mid=$code_mid)" ;;
  esac

  log "  $id  head=$code_head  mid=$code_mid"
done

TOTAL="$(echo "$IDS" | wc -w)"
log ""
log "==> Résultat ($TOTAL titres)"
log "  head OK: $HEAD_OK / $TOTAL"
log "  mid  OK: $MID_OK / $TOTAL (206/200)"
log "  mid  503 (chargement): $MID_503 / $TOTAL"
log "  mid  FAIL: $MID_FAIL / $TOTAL"
[[ -n "${FAIL_IDS// }" ]] && log "  échecs:$FAIL_IDS"

if [[ "$HEAD_FAIL" -gt 0 ]] || [[ "$MID_FAIL" -gt $((TOTAL / 4)) ]]; then
  log "FAIL seuil dépassé"
  exit 1
fi
log "OK régression stream"
exit 0
