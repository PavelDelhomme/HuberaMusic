import { db } from './db.js';
import type { Track } from '../youtube/types.js';

export const MIX_TARGET = 200;
export const MIX_PREVIEW = 12;
/** TTL cache serveur mix précalculé (12 h). */
export const MIX_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

db.exec(`
  CREATE TABLE IF NOT EXISTS user_mix_cache (
    user_id TEXT NOT NULL,
    mix_key TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    track_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, mix_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_user_mix_cache_gen ON user_mix_cache(generated_at);
`);

export type MixCachePayload = {
  tracks: Track[];
  seed?: Track | null;
  category?: { id: string; title: string; query?: string; mode?: string };
  generatedAt: number;
  target: number;
};

export function mixKeyCategory(categoryId: string, genresKey = '') {
  return genresKey ? `cat:${categoryId}:g:${genresKey}` : `cat:${categoryId}`;
}

export function genresCacheKey(genres: string[]) {
  return [...genres]
    .map((g) => g.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',')
    .slice(0, 80);
}

export function mixKeyRadio(kind: 'track' | 'album' | 'artist', id: string) {
  return `radio:${kind}:${id}`;
}

export function getMixCache(
  userId: string,
  mixKey: string,
  opts?: { minTracks?: number },
): MixCachePayload | null {
  const row = db
    .prepare(
      `SELECT payload_json, generated_at, track_count FROM user_mix_cache
       WHERE user_id = ? AND mix_key = ?`,
    )
    .get(userId, mixKey) as
    | { payload_json: string; generated_at: number; track_count: number }
    | undefined;
  if (!row) return null;
  if (Date.now() - row.generated_at > MIX_CACHE_TTL_MS) return null;
  const minTracks = opts?.minTracks ?? 50;
  if (row.track_count < minTracks) return null;
  try {
    const parsed = JSON.parse(row.payload_json) as MixCachePayload;
    if (!Array.isArray(parsed?.tracks) || !parsed.tracks.length) return null;
    if (parsed.tracks.length < minTracks) return null;
    return {
      ...parsed,
      generatedAt: row.generated_at,
      target: parsed.target || MIX_TARGET,
    };
  } catch {
    return null;
  }
}

export function setMixCache(userId: string, mixKey: string, payload: MixCachePayload) {
  const tracks = (payload.tracks || []).slice(0, MIX_TARGET);
  const body: MixCachePayload = {
    ...payload,
    tracks,
    generatedAt: payload.generatedAt || Date.now(),
    target: MIX_TARGET,
  };
  db.prepare(
    `INSERT INTO user_mix_cache (user_id, mix_key, payload_json, generated_at, track_count)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, mix_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       generated_at = excluded.generated_at,
       track_count = excluded.track_count`,
  ).run(userId, mixKey, JSON.stringify(body), body.generatedAt, tracks.length);
  return body;
}
