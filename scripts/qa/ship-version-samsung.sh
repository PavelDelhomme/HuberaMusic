#!/usr/bin/env bash
# Livre une version depuis une branche feat déjà mergée dans le workspace courant (prod checkout).
# Usage: bash scripts/qa/ship-version-samsung.sh 1.3.187 "Titre" notes.txt
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
VER="${1:?version}"
TITLE="${2:?title}"
NOTES_FILE="${3:?notes file}"

python3 - <<PY
import json
from pathlib import Path
ver = "$VER"
title = """$TITLE"""
notes = [l.strip().lstrip("-•* ").strip() for l in Path("$NOTES_FILE").read_text().splitlines() if l.strip()]
p = Path("VERSION_NOTES.json")
data = json.loads(p.read_text())
entry = {"version": ver, "date": "2026-09-09", "title": title, "notes": notes}
data["updatedAt"] = "2026-09-09"
data["versions"] = [entry] + [v for v in data["versions"] if v.get("version") != ver]
text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
p.write_text(text)
Path("web/public/version-notes.json").write_text(text)
Path("mobile-android/app/src/main/assets/version-notes.json").write_text(text)
print("notes ok", ver, len(notes))
PY

# Align VERSION file if bump script not used
echo "$VER" > VERSION
# Sync package.json versions lightly
python3 - <<'PY'
from pathlib import Path
import re, json
ver = Path("VERSION").read_text().strip()
for p in ["package.json", "web/package.json", "api/package.json", "desktop/package.json"]:
    path = Path(p)
    if not path.exists():
        continue
    data = json.loads(path.read_text())
    data["version"] = ver
    path.write_text(json.dumps(data, indent=2) + "\n")
# versionCode in build.gradle if present
gradle = Path("mobile-android/app/build.gradle.kts")
if gradle.exists():
    t = gradle.read_text()
    # versionName often from VERSION file via script — leave gradle alone if dynamic
print("packages", ver)
PY

git add -u VERSION VERSION_NOTES.json web/public/version-notes.json \
  mobile-android/app/src/main/assets/version-notes.json \
  package.json web/package.json api/package.json desktop/package.json \
  mobile-android/ scripts/qa/ || true

echo "==> Commit notes $VER"
git status -sb
