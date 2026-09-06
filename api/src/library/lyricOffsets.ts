import { db } from './db.js';

/**
 * Sync paroles apprise :
 * - offset perso par (user, titre) — déjà là
 * - votes positionnés → segments (quartiles) pour les changements de rythme mid-song
 * - agrégat « crowd » médian par titre (tous les comptes) pour les nouveaux / sans réglage
 */

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

  CREATE TABLE IF NOT EXISTS user_lyric_segment_votes (
    user_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    offset_ms INTEGER NOT NULL,
    at_ms INTEGER,
    duration_ms INTEGER,
    source TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id, bucket),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_lyric_seg_votes_track
    ON user_lyric_segment_votes(track_id, bucket);

  CREATE TABLE IF NOT EXISTS track_lyric_crowd (
    track_id TEXT PRIMARY KEY,
    offset_ms INTEGER NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    mad_ms INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS track_lyric_crowd_segments (
    track_id TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    offset_ms INTEGER NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    mad_ms INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (track_id, bucket)
  );
`);

const CLAMP = 15_000;
const BUCKETS = 4;
const MIN_CROWD_N = 2;
const MIN_SEG_N = 2;

export type LyricSegment = {
  bucket: number;
  /** Début du segment en ratio 0…1 de la durée */
  startRatio: number;
  endRatio: number;
  offsetMs: number;
  n?: number;
};

export type LyricSyncProfile = {
  userOffsetMs: number;
  crowdOffsetMs: number;
  /** Segments perso si assez de calibrations, sinon crowd */
  segments: LyricSegment[];
  /** true si les segments viennent du compte user */
  segmentsFromUser: boolean;
};

export function clampLyricOffsetMs(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(-CLAMP, Math.min(CLAMP, Math.round(n)));
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1]! + s[mid]!) / 2) : s[mid]!;
}

function mad(nums: number[], med: number): number {
  if (!nums.length) return 0;
  return median(nums.map((n) => Math.abs(n - med)));
}

/** Bucket 0…3 selon position / durée (fallback : tranches de 45 s). */
export function lyricBucket(atMs: number, durationMs?: number | null): number {
  const at = Math.max(0, Math.round(atMs));
  if (durationMs && durationMs >= 20_000) {
    const r = Math.min(0.999, at / durationMs);
    return Math.min(BUCKETS - 1, Math.floor(r * BUCKETS));
  }
  return Math.min(BUCKETS - 1, Math.floor(at / 45_000));
}

export function getLyricOffset(userId: string, trackId: string): number {
  if (!userId || !trackId) return 0;
  const row = db
    .prepare(`SELECT offset_ms FROM user_lyric_offsets WHERE user_id = ? AND track_id = ?`)
    .get(userId, trackId) as { offset_ms: number } | undefined;
  return clampLyricOffsetMs(Number(row?.offset_ms || 0));
}

export function getCrowdOffset(trackId: string): number {
  if (!trackId) return 0;
  const row = db
    .prepare(`SELECT offset_ms, n FROM track_lyric_crowd WHERE track_id = ?`)
    .get(trackId) as { offset_ms: number; n: number } | undefined;
  if (!row || Number(row.n) < MIN_CROWD_N) return 0;
  return clampLyricOffsetMs(Number(row.offset_ms || 0));
}

function loadSegments(
  trackId: string,
  fromUser?: string,
): { segments: LyricSegment[]; fromUser: boolean } {
  if (fromUser) {
    const rows = db
      .prepare(
        `SELECT bucket, offset_ms FROM user_lyric_segment_votes
         WHERE user_id = ? AND track_id = ? ORDER BY bucket`,
      )
      .all(fromUser, trackId) as { bucket: number; offset_ms: number }[];
    if (rows.length >= 2) {
      return {
        fromUser: true,
        segments: rows.map((r) => ({
          bucket: r.bucket,
          startRatio: r.bucket / BUCKETS,
          endRatio: (r.bucket + 1) / BUCKETS,
          offsetMs: clampLyricOffsetMs(r.offset_ms),
        })),
      };
    }
  }
  const crowd = db
    .prepare(
      `SELECT bucket, offset_ms, n FROM track_lyric_crowd_segments
       WHERE track_id = ? AND n >= ? ORDER BY bucket`,
    )
    .all(trackId, MIN_SEG_N) as { bucket: number; offset_ms: number; n: number }[];
  if (crowd.length >= 2) {
    return {
      fromUser: false,
      segments: crowd.map((r) => ({
        bucket: r.bucket,
        startRatio: r.bucket / BUCKETS,
        endRatio: (r.bucket + 1) / BUCKETS,
        offsetMs: clampLyricOffsetMs(r.offset_ms),
        n: r.n,
      })),
    };
  }
  return { segments: [], fromUser: false };
}

/**
 * Offset effectif à l’instant `atMs` (interpolation linéaire entre segments).
 * Priorité : segments perso → offset perso constant → segments crowd → crowd global.
 */
export function offsetAtMs(profile: LyricSyncProfile, atMs: number, durationMs?: number | null): number {
  const segs = profile.segments;
  if (segs.length >= 2 && durationMs && durationMs > 0) {
    const r = Math.max(0, Math.min(1, atMs / durationMs));
    // Points de contrôle au centre de chaque bucket
    const pts = segs
      .map((s) => ({
        r: (s.startRatio + s.endRatio) / 2,
        o: s.offsetMs,
      }))
      .sort((a, b) => a.r - b.r);
    if (r <= pts[0]!.r) return pts[0]!.o;
    if (r >= pts[pts.length - 1]!.r) return pts[pts.length - 1]!.o;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      if (r >= a.r && r <= b.r) {
        const t = (r - a.r) / Math.max(1e-6, b.r - a.r);
        return Math.round(a.o + (b.o - a.o) * t);
      }
    }
  }
  if (profile.segmentsFromUser && profile.userOffsetMs !== 0) return profile.userOffsetMs;
  if (profile.userOffsetMs !== 0) return profile.userOffsetMs;
  return profile.crowdOffsetMs;
}

export function resolveLyricSync(userId: string, trackId: string): LyricSyncProfile {
  const userOffsetMs = getLyricOffset(userId, trackId);
  const crowdOffsetMs = getCrowdOffset(trackId);
  const { segments, fromUser } = loadSegments(trackId, userId);
  return {
    userOffsetMs,
    crowdOffsetMs,
    segments,
    segmentsFromUser: fromUser,
  };
}

/** Offset à exposer aux clients « simples » (sans segments) : perso sinon crowd. */
export function effectiveLyricOffsetMs(userId: string, trackId: string): number {
  const u = getLyricOffset(userId, trackId);
  if (u !== 0) return u;
  return getCrowdOffset(trackId);
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
  // Complète avec crowd pour les titres non réglés perso
  const crowd = db
    .prepare(`SELECT track_id, offset_ms, n FROM track_lyric_crowd WHERE n >= ?`)
    .all(MIN_CROWD_N) as { track_id: string; offset_ms: number; n: number }[];
  for (const c of crowd) {
    if (out[c.track_id] != null) continue;
    const v = clampLyricOffsetMs(c.offset_ms);
    if (v !== 0) out[c.track_id] = v;
  }
  return out;
}

function recomputeCrowd(trackId: string) {
  const now = Date.now();
  const globals = db
    .prepare(`SELECT offset_ms FROM user_lyric_offsets WHERE track_id = ? AND offset_ms != 0`)
    .all(trackId) as { offset_ms: number }[];
  const vals = globals.map((g) => clampLyricOffsetMs(g.offset_ms)).filter((v) => Math.abs(v) >= 40);
  if (vals.length >= MIN_CROWD_N) {
    const med = median(vals);
    const m = mad(vals, med);
    db.prepare(
      `INSERT INTO track_lyric_crowd (track_id, offset_ms, n, mad_ms, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(track_id) DO UPDATE SET
         offset_ms = excluded.offset_ms,
         n = excluded.n,
         mad_ms = excluded.mad_ms,
         updated_at = excluded.updated_at`,
    ).run(trackId, med, vals.length, m, now);
  } else {
    db.prepare(`DELETE FROM track_lyric_crowd WHERE track_id = ?`).run(trackId);
  }

  for (let b = 0; b < BUCKETS; b++) {
    const segs = db
      .prepare(
        `SELECT offset_ms FROM user_lyric_segment_votes
         WHERE track_id = ? AND bucket = ?`,
      )
      .all(trackId, b) as { offset_ms: number }[];
    const svals = segs.map((s) => clampLyricOffsetMs(s.offset_ms)).filter((v) => Math.abs(v) >= 40);
    if (svals.length >= MIN_SEG_N) {
      const med = median(svals);
      const m = mad(svals, med);
      db.prepare(
        `INSERT INTO track_lyric_crowd_segments
           (track_id, bucket, offset_ms, n, mad_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(track_id, bucket) DO UPDATE SET
           offset_ms = excluded.offset_ms,
           n = excluded.n,
           mad_ms = excluded.mad_ms,
           updated_at = excluded.updated_at`,
      ).run(trackId, b, med, svals.length, m, now);
    } else {
      db.prepare(
        `DELETE FROM track_lyric_crowd_segments WHERE track_id = ? AND bucket = ?`,
      ).run(trackId, b);
    }
  }
}

export type SaveLyricOffsetOpts = {
  offsetMs: number;
  /** Position audio au moment de la correction (pour apprendre le rythme mid-song) */
  atMs?: number | null;
  durationMs?: number | null;
  source?: 'nudge' | 'calibrate' | 'reset' | string;
};

/**
 * Enregistre la correction perso + vote segmenté, puis recalcule le crowd.
 */
export function saveLyricOffset(
  userId: string,
  trackId: string,
  offsetMsOrOpts: number | SaveLyricOffsetOpts,
): { offsetMs: number; profile: LyricSyncProfile } {
  const opts: SaveLyricOffsetOpts =
    typeof offsetMsOrOpts === 'number' ? { offsetMs: offsetMsOrOpts } : offsetMsOrOpts;
  const clamped = clampLyricOffsetMs(opts.offsetMs);
  const now = Date.now();

  if (clamped === 0) {
    db.prepare(`DELETE FROM user_lyric_offsets WHERE user_id = ? AND track_id = ?`).run(
      userId,
      trackId,
    );
    // Reset global : on garde les segments (calibrations locales) sauf source=reset total
    if (opts.source === 'reset') {
      db.prepare(
        `DELETE FROM user_lyric_segment_votes WHERE user_id = ? AND track_id = ?`,
      ).run(userId, trackId);
    }
  } else {
    db.prepare(
      `INSERT INTO user_lyric_offsets (user_id, track_id, offset_ms, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, track_id) DO UPDATE SET
         offset_ms = excluded.offset_ms,
         updated_at = excluded.updated_at`,
    ).run(userId, trackId, clamped, now);
  }

  const atMs = opts.atMs != null && Number.isFinite(opts.atMs) ? Math.max(0, Math.round(opts.atMs)) : null;
  const durationMs =
    opts.durationMs != null && Number.isFinite(opts.durationMs)
      ? Math.max(0, Math.round(opts.durationMs))
      : null;

  if (atMs != null && clamped !== 0) {
    const bucket = lyricBucket(atMs, durationMs);
    db.prepare(
      `INSERT INTO user_lyric_segment_votes
         (user_id, track_id, bucket, offset_ms, at_ms, duration_ms, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, track_id, bucket) DO UPDATE SET
         offset_ms = excluded.offset_ms,
         at_ms = excluded.at_ms,
         duration_ms = COALESCE(excluded.duration_ms, user_lyric_segment_votes.duration_ms),
         source = excluded.source,
         updated_at = excluded.updated_at`,
    ).run(
      userId,
      trackId,
      bucket,
      clamped,
      atMs,
      durationMs,
      opts.source || 'nudge',
      now,
    );
  }

  recomputeCrowd(trackId);
  return { offsetMs: clamped, profile: resolveLyricSync(userId, trackId) };
}
