import { db } from './db.js';

/** Décalage paroles appris par titre (comme YTM) — suit le compte, pas l’appareil. */
db.exec(`
  CREATE TABLE IF NOT EXISTS user_lyric_offsets (
    user_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    offset_ms INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_lyric_offsets_user ON user_lyric_offsets(user_id);
`);

const CLAMP = 15_000;

export function clampLyricOffsetMs(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(-CLAMP, Math.min(CLAMP, Math.round(n)));
}

export function getLyricOffset(userId: string, trackId: string): number {
  if (!userId || !trackId) return 0;
  const row = db
    .prepare(`SELECT offset_ms FROM user_lyric_offsets WHERE user_id = ? AND track_id = ?`)
    .get(userId, trackId) as { offset_ms: number } | undefined;
  return clampLyricOffsetMs(Number(row?.offset_ms || 0));
}

export function listLyricOffsets(userId: string): Record<string, number> {
  const rows = db
    .prepare(`SELECT track_id, offset_ms FROM user_lyric_offsets WHERE user_id = ?`)
    .all(userId) as { track_id: string; offset_ms: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) {
    const v = clampLyricOffsetMs(Number(r.offset_ms || 0));
    if (v !== 0) out[r.track_id] = v;
  }
  return out;
}

export function saveLyricOffset(userId: string, trackId: string, offsetMs: number): number {
  const clamped = clampLyricOffsetMs(offsetMs);
  const now = Date.now();
  if (clamped === 0) {
    db.prepare(`DELETE FROM user_lyric_offsets WHERE user_id = ? AND track_id = ?`).run(
      userId,
      trackId,
    );
    return 0;
  }
  db.prepare(
    `INSERT INTO user_lyric_offsets (user_id, track_id, offset_ms, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, track_id) DO UPDATE SET
       offset_ms = excluded.offset_ms,
       updated_at = excluded.updated_at`,
  ).run(userId, trackId, clamped, now);
  return clamped;
}
