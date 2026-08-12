#!/usr/bin/env bash
# Redeploy le conteneur ytmusic sur le VPS — SANS webhook Portainer (réservé Pro).
# Stratégies (ordre) :
#   1) SSH          → DEPLOY_SSH (+ DEPLOY_SSH_CMD optionnel)
#   2) Portainer CE → PORTAINER_URL + PORTAINER_API_KEY (Access Token gratuit)
#   3) Watchtower   → rien à faire ici (poll auto) — message d’aide
#
# Appelé par admin-deploy-prod.sh après push prod.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env" 2>/dev/null || true
  set +a
fi

IMAGE="${YTMUSIC_IMAGE:-ghcr.io/paveldelhomme/ytmusic:latest}"
STACK_NAME="${PORTAINER_STACK_NAME:-ytmusic}"
WAIT_BUILD="${DEPLOY_WAIT_BUILD:-1}"
WAIT_SECS="${DEPLOY_IMAGE_WAIT_SECS:-120}"

wait_for_ghcr_build() {
  if [[ "$WAIT_BUILD" != "1" ]]; then
    echo "==> Skip attente CI (DEPLOY_WAIT_BUILD=$WAIT_BUILD)"
    return 0
  fi
  if command -v gh >/dev/null 2>&1; then
    echo "==> Attente GitHub Actions (Docker / branche prod)…"
    local run_id
    run_id="$(
      gh run list --repo PavelDelhomme/YTMusic --branch prod --limit 3 --json databaseId,name,status,headBranch \
        --jq '[.[] | select(.name|test("ocker";"i"))][0].databaseId // empty' 2>/dev/null || true
    )"
    if [[ -z "$run_id" ]]; then
      run_id="$(
        gh run list --branch prod --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true
      )"
    fi
    if [[ -n "$run_id" ]]; then
      gh run watch "$run_id" --exit-status
      echo "==> Image GHCR à jour (run $run_id)"
      return 0
    fi
    echo "==> Pas de run GH trouvé — attente fixe ${WAIT_SECS}s"
  else
    echo "==> gh CLI absent — attente fixe ${WAIT_SECS}s (build GHCR)"
  fi
  sleep "$WAIT_SECS"
}

redeploy_ssh() {
  local target="${DEPLOY_SSH:-}"
  [[ -n "$target" ]] || return 1
  local cmd="${DEPLOY_SSH_CMD:-docker pull ${IMAGE} && docker restart ytmusic}"
  echo "==> Redeploy SSH → $target"
  echo "    $cmd"
  # shellcheck disable=SC2029
  ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new "$target" "$cmd"
}

redeploy_portainer_api() {
  local base="${PORTAINER_URL:-}"
  local key="${PORTAINER_API_KEY:-}"
  [[ -n "$base" && -n "$key" ]] || return 1
  base="${base%/}"

  echo "==> Redeploy via Portainer API CE → $base (stack=$STACK_NAME)"

  export PORTAINER_URL="$base" PORTAINER_API_KEY="$key" PORTAINER_STACK_NAME="$STACK_NAME"
  export PORTAINER_STACK_ID="${PORTAINER_STACK_ID:-}" PORTAINER_ENDPOINT_ID="${PORTAINER_ENDPOINT_ID:-}"
  export YTMUSIC_IMAGE="$IMAGE"

  python3 <<'PY'
import json, os, sys, urllib.error, urllib.parse, urllib.request

base = os.environ["PORTAINER_URL"].rstrip("/")
key = os.environ["PORTAINER_API_KEY"]
name = os.environ["PORTAINER_STACK_NAME"]
image = os.environ["YTMUSIC_IMAGE"]
force_id = os.environ.get("PORTAINER_STACK_ID") or ""
force_ep = os.environ.get("PORTAINER_ENDPOINT_ID") or ""

def req(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(
        base + path,
        data=data,
        method=method,
        headers={"X-API-Key": key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(r, timeout=180) as res:
            raw = res.read().decode() or "{}"
            return res.status, json.loads(raw) if raw.strip() else {}
    except urllib.error.HTTPError as e:
        err = e.read().decode(errors="replace")
        raise SystemExit(f"HTTP {e.code} {path}: {err[:500]}") from e

status, stacks = req("GET", "/api/stacks")
if not isinstance(stacks, list):
    raise SystemExit(f"Réponse stacks inattendue: {stacks!r}")

stack = next((s for s in stacks if s.get("Name") == name), None)
if not stack and force_id:
    stack = next((s for s in stacks if str(s.get("Id")) == str(force_id)), None)
if not stack:
    names = [s.get("Name") for s in stacks]
    raise SystemExit(f"Stack « {name} » introuvable. Dispo: {names}")

sid = int(force_id or stack["Id"])
ep = int(force_ep or stack.get("EndpointId") or 1)
is_git = bool(stack.get("GitConfig"))
print(f"    stackId={sid} endpointId={ep} type={'git' if is_git else 'file'}")

if is_git:
    code, out = req(
        "PUT",
        f"/api/stacks/{sid}/git/redeploy?endpointId={ep}",
        {"pullImage": True, "RepullImageAndRedeploy": True},
    )
    print(f"    git/redeploy → HTTP {code}")
else:
    # Pull image via Docker proxy Portainer
    if ":" in image:
        repo, tag = image.rsplit(":", 1)
    else:
        repo, tag = image, "latest"
    q = urllib.parse.urlencode({"fromImage": repo, "tag": tag})
    try:
        code, _ = req("POST", f"/api/endpoints/{ep}/docker/images/create?{q}", None)
        print(f"    docker pull → HTTP {code}")
    except SystemExit as e:
        print(f"    docker pull (info): {e}")

    _, file_info = req("GET", f"/api/stacks/{sid}/file")
    content = file_info.get("StackFileContent") or ""
    if not content:
        raise SystemExit("StackFileContent vide — impossible de redeploy")
    code, out = req(
        "PUT",
        f"/api/stacks/{sid}?endpointId={ep}",
        {
            "StackFileContent": content,
            "Prune": False,
            "pullImage": True,
            "RepullImageAndRedeploy": True,
        },
    )
    print(f"    stack update + repull → HTTP {code}")

print("==> Portainer API : redeploy OK")
PY
}

print_help() {
  echo "==> Aucun SSH / Portainer API configuré"
  echo ""
  echo "    Portainer CE n’a PAS les webhooks (Pro). Contournements :"
  echo ""
  echo "    A) Watchtower (recommandé) — pull auto de :latest"
  echo "       Colle deploy/watchtower-compose.yml comme stack Portainer « watchtower »"
  echo "       Le label est déjà sur ytmusic → plus rien à faire après push prod."
  echo ""
  echo "    B) Access Token Portainer (gratuit CE)"
  echo "       Portainer → ton profil → Access tokens → Add"
  echo "       Dans .env local :"
  echo "         PORTAINER_URL=https://portainer.ton-domaine"
  echo "         PORTAINER_API_KEY=ptr_…"
  echo "         PORTAINER_STACK_NAME=ytmusic"
  echo ""
  echo "    C) SSH"
  echo "         DEPLOY_SSH=user@ip-vps"
  echo "         DEPLOY_SSH_CMD='docker pull $IMAGE && docker restart ytmusic'"
  echo ""
  echo "    Sinon : Portainer UI → stack ytmusic → Editor → Pull and redeploy"
}

main() {
  echo "==> Redeploy VPS (image $IMAGE)"
  wait_for_ghcr_build

  if [[ -n "${DEPLOY_SSH:-}" ]]; then
    redeploy_ssh
    echo "==> OK (SSH)"
    return 0
  fi
  if [[ -n "${PORTAINER_URL:-}" && -n "${PORTAINER_API_KEY:-}" ]]; then
    redeploy_portainer_api
    echo "==> OK (Portainer API CE)"
    return 0
  fi
  print_help
  return 0
}

main "$@"
