#!/usr/bin/env bash
# Stats + backup SQLite data/ytmusic.db
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB="$ROOT/data/ytmusic.db"
MODE="${1:-status}"
BACKUP_DIR="$ROOT/data/backups"
KEEP="${KEEP_DB_BACKUPS:-14}"

if [[ ! -f "$DB" ]]; then
  echo "❌ DB absente : $DB"
  echo "   Lance make up puis utilise l’app une fois."
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "❌ sqlite3 CLI requis (pacman/apt install sqlite)"
  exit 1
fi

case "$MODE" in
  status)
    echo "📊 SQLite PLM"
    echo "================="
    echo "  path : $DB"
    echo "  size : $(du -h "$DB" | awk '{print $1}')"
    sqlite3 "$DB" <<'SQL'
.mode column
.headers on
SELECT 'users' AS table_name, COUNT(*) AS n FROM users
UNION ALL SELECT 'liked_tracks', COUNT(*) FROM liked_tracks
UNION ALL SELECT 'tracks_cache', COUNT(*) FROM tracks_cache
UNION ALL SELECT 'playlists', COUNT(*) FROM playlists
UNION ALL SELECT 'history', COUNT(*) FROM history
UNION ALL SELECT 'refresh_active', COUNT(*) FROM refresh_tokens WHERE revoked_at IS NULL
UNION ALL SELECT 'refresh_revoked', COUNT(*) FROM refresh_tokens WHERE revoked_at IS NOT NULL;
SQL
    orphans=$(sqlite3 "$DB" "SELECT COUNT(*) FROM liked_tracks l LEFT JOIN tracks_cache t ON t.id=l.track_id WHERE t.id IS NULL;")
    echo ""
    echo "  likes sans cache : $orphans"
    echo "  journal_mode     : $(sqlite3 "$DB" 'PRAGMA journal_mode;')"
    ;;
  backup)
    mkdir -p "$BACKUP_DIR"
    stamp=$(date +%Y%m%d-%H%M%S)
    dest="$BACKUP_DIR/ytmusic-$stamp.db"
    sqlite3 "$DB" ".backup '$dest'"
    echo "✅ Backup → $dest ($(du -h "$dest" | awk '{print $1}'))"
    mapfile -t old < <(ls -1t "$BACKUP_DIR"/ytmusic-*.db 2>/dev/null | tail -n +"$((KEEP + 1))" || true)
    for f in "${old[@]:-}"; do
      [[ -n "${f:-}" && -f "$f" ]] || continue
      rm -f "$f"
      echo "  🗑️  purge $(basename "$f")"
    done
    ;;
  *)
    echo "Usage: $0 status|backup"
    exit 2
    ;;
esac
