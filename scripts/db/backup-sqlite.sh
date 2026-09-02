#!/usr/bin/env bash
# Backup froid SQLite (WAL checkpoint + .backup).
# Usage: bash scripts/db/backup-sqlite.sh [dest.db]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${YTMUSIC_SQLITE:-$ROOT/data/ytmusic.db}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${1:-$ROOT/data/backups/ytmusic-$STAMP.db}"

if [[ ! -f "$SRC" ]]; then
  echo "❌ SQLite introuvable: $SRC" >&2
  exit 1
fi
mkdir -p "$(dirname "$DEST")"
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "❌ sqlite3 CLI requis" >&2
  exit 1
fi

echo "==> Checkpoint WAL…"
sqlite3 "$SRC" "PRAGMA wal_checkpoint(TRUNCATE);"
echo "==> Backup → $DEST"
sqlite3 "$SRC" ".backup '$DEST'"
# Copie manifeste counts
COUNTS="$DEST.counts.txt"
{
  echo "source=$SRC"
  echo "backup=$DEST"
  echo "at=$STAMP"
  sqlite3 "$SRC" <<'SQL'
SELECT 'users', COUNT(*) FROM users
UNION ALL SELECT 'liked_tracks', COUNT(*) FROM liked_tracks
UNION ALL SELECT 'library_tracks', COUNT(*) FROM library_tracks
UNION ALL SELECT 'playlists', COUNT(*) FROM playlists
UNION ALL SELECT 'playlist_tracks', COUNT(*) FROM playlist_tracks
UNION ALL SELECT 'history', COUNT(*) FROM history
UNION ALL SELECT 'ytm_accounts', COUNT(*) FROM ytm_accounts
UNION ALL SELECT 'tracks_cache', COUNT(*) FROM tracks_cache;
SQL
} >"$COUNTS"
echo "==> OK ($(du -h "$DEST" | awk '{print $1}'))"
echo "    Counts: $COUNTS"
ls -la "$DEST"
