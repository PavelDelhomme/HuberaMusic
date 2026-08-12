#!/usr/bin/env bash
# Copie les épingles d’une API source → cible (même compte email).
# Usage :
#   bash scripts/test/sync-pins-between-apis.sh              # local → prod
#   bash scripts/test/sync-pins-between-apis.sh prod local   # prod → local
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env" 2>/dev/null || true
  set +a
fi

FROM_NAME="${1:-local}"
TO_NAME="${2:-prod}"

resolve() {
  case "$1" in
    local|dev) echo "${LOCAL_API:-http://127.0.0.1:8787}" ;;
    prod|*) echo "${DEPLOY_URL:-${APP_URL_PROD:-https://ytmusic.delhomme.ovh}}" ;;
  esac
}

FROM="$(resolve "$FROM_NAME")"
TO="$(resolve "$TO_NAME")"
FROM="${FROM%/}"
TO="${TO%/}"
if [[ -z "${SEED_EMAIL:-}" || -z "${SEED_PASSWORD:-}" ]]; then
  echo "SEED_EMAIL / SEED_PASSWORD manquants" >&2
  exit 2
fi

login() {
  local base="$1"
  curl -fsS -X POST "$base/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,os; print(json.dumps({"email":os.environ["SEED_EMAIL"],"password":os.environ["SEED_PASSWORD"]}))')" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])'
}

echo "==> Pins $FROM_NAME ($FROM) → $TO_NAME ($TO)"
FROM_TOK="$(login "$FROM")"
TO_TOK="$(login "$TO")"

PINS_JSON="$(curl -fsS -H "Authorization: Bearer $FROM_TOK" "$FROM/api/pins")"
export PINS_JSON TO TO_TOK
COUNT="$(python3 -c 'import json,os; print(len(json.loads(os.environ["PINS_JSON"]).get("pins") or []))')"
echo "    source: $COUNT pin(s)"

BODY="$(python3 - <<'PY'
import json, os
data = json.loads(os.environ["PINS_JSON"])
out = []
for p in data.get("pins") or []:
    payload = p.get("payload") or {}
    tid = str(p.get("targetId") or payload.get("id") or "").strip()
    if not tid:
        continue
    out.append({
        "kind": p.get("kind") or payload.get("type") or "song",
        "targetId": tid,
        "id": tid,
        "payload": payload if isinstance(payload, dict) else {"id": tid, "title": tid},
    })
print(json.dumps({"pins": out}))
PY
)"
export BODY

set +e
RES="$(curl -fsS -X POST -H "Authorization: Bearer $TO_TOK" -H 'Content-Type: application/json' \
  -d "$BODY" "$TO/api/pins/sync" 2>/tmp/pins-sync.err)"
RC=$?
set -e
if [[ $RC -ne 0 ]]; then
  echo "    /sync indisponible — fallback POST /api/pins…"
  python3 - <<'PY'
import json, os, urllib.request
body = json.loads(os.environ["BODY"])
tok = os.environ["TO_TOK"]
base = os.environ["TO"]
n = 0
for p in body.get("pins") or []:
    req = urllib.request.Request(
        base + "/api/pins",
        data=json.dumps(p).encode(),
        headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=30).read()
    n += 1
print(f"    upserted={n}")
PY
else
  python3 -c 'import json,sys; d=json.load(sys.stdin); print(f"    cible: upserted={d.get(\"upserted\")} total={len(d.get(\"pins\") or [])}")' <<<"$RES"
fi
echo "==> OK"
