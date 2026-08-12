#!/usr/bin/env bash
# Incrémente la version sémantique (source unique : ./VERSION).
# Usage:
#   bash scripts/deploy/bump-version.sh patch   # 1.2.0 → 1.2.1  (correctif)
#   bash scripts/deploy/bump-version.sh minor   # 1.2.0 → 1.3.0  (fonctionnalité)
#   bash scripts/deploy/bump-version.sh major   # 1.2.0 → 2.0.0  (breaking)
# Affichage runtime : d+X.Y.Z (dev/local) ou p+X.Y.Z (prod).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PART="${1:-patch}"
FILE="$ROOT/VERSION"

if [[ ! -f "$FILE" ]]; then
  echo "1.0.0" >"$FILE"
fi
CUR="$(tr -d '[:space:]' <"$FILE")"
IFS=. read -r MA MI PA <<<"$CUR"
MA=${MA:-0}; MI=${MI:-0}; PA=${PA:-0}

case "$PART" in
  major) MA=$((MA + 1)); MI=0; PA=0 ;;
  minor) MI=$((MI + 1)); PA=0 ;;
  patch) PA=$((PA + 1)) ;;
  *)
    echo "Usage: $0 major|minor|patch" >&2
    exit 2
    ;;
esac

NEXT="${MA}.${MI}.${PA}"
echo "$NEXT" >"$FILE"

# Aligne les package.json du monorepo
for pkg in "$ROOT/package.json" "$ROOT/web/package.json" "$ROOT/api/package.json" "$ROOT/desktop/package.json"; do
  if [[ -f "$pkg" ]]; then
    node -e "
      const fs=require('fs');
      const p=process.argv[1];
      const j=JSON.parse(fs.readFileSync(p,'utf8'));
      j.version=process.argv[2];
      fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
    " "$pkg" "$NEXT"
  fi
done

# versionCode Android = major*10000 + minor*100 + patch
CODE=$((MA * 10000 + MI * 100 + PA))
echo "==> VERSION $CUR → $NEXT (versionCode=$CODE)"
echo "    Affichage : d+$NEXT (local/dev) · p+$NEXT (prod)"
echo "    Pense à rebuild web / make android(-prod) pour propager."
