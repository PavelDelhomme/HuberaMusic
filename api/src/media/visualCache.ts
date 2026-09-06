/**
 * Cache SQLite audioId → visualId (comme tracks_cache pour les titres).
 * Évite probe+search à chaque ouverture du mode Vidéo.
 */
import { db } from '../library/db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS visual_cache (
    audio_id TEXT PRIMARY KEY,
    visual_id TEXT,
    source TEXT NOT NULL DEFAULT 'none',
    title TEXT,
    artist TEXT,
    updated_at INTEGER NOT NULL
  );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_visual_cache_updated ON visual_cache(updated_at);`);

export type VisualCacheRow = {
  audio_id: string;
  visual_id: string | null;
  source: string;
  title: string | null;
  artist: string | null;
  updated_at: number;
};

const PERSIST_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours

export function getVisualCache(audioId: string): VisualCacheRow | null {
  const id = String(audioId || '').trim();
  if (!id) return null;
  const row = db
    .prepare(
      `SELECT audio_id, visual_id, source, title, artist, updated_at
       FROM visual_cache WHERE audio_id = ?`,
    )
    .get(id) as VisualCacheRow | undefined;
  if (!row) return null;
  if (Date.now() - row.updated_at > PERSIST_TTL_MS) return null;
  return row;
}

export function deleteVisualCache(audioId: string) {
  const id = String(audioId || '').trim();
  if (!id) return;
  db.prepare(`DELETE FROM visual_cache WHERE audio_id = ?`).run(id);
}

export function putVisualCache(input: {
  audioId: string;
  visualId: string | null;
  source: string;
  title?: string;
  artist?: string;
}) {
  const id = String(input.audioId || '').trim();
  if (!id) return;
  if (!input.visualId) {
    deleteVisualCache(id);
    return;
  }
  db.prepare(
    `INSERT INTO visual_cache (audio_id, visual_id, source, title, artist, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(audio_id) DO UPDATE SET
       visual_id = excluded.visual_id,
       source = excluded.source,
       title = COALESCE(excluded.title, visual_cache.title),
       artist = COALESCE(excluded.artist, visual_cache.artist),
       updated_at = excluded.updated_at`,
  ).run(
    id,
    input.visualId,
    input.source,
    input.title || null,
    input.artist || null,
    Date.now(),
  );
}
