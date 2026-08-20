import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { isJunkArtistName } from '../youtube/mappers.js';
import { recordSearchHitClick } from '../reco/searchHits.js';

export function ensureRecoSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_prefs (
      user_id TEXT PRIMARY KEY,
      genres TEXT DEFAULT '[]',
      moods TEXT DEFAULT '[]',
      moments TEXT DEFAULT '[]',
      onboarding_done INTEGER DEFAULT 0,
      discovery_bias REAL DEFAULT 0.1,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS artist_follows (
      user_id TEXT NOT NULL,
      artist_id TEXT NOT NULL,
      artist_name TEXT,
      payload TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, artist_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS listen_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      event TEXT NOT NULL,
      progress_pct REAL DEFAULT 0,
      duration_ms INTEGER,
      seed_id TEXT,
      hour INTEGER,
      is_weekend INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS search_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      query TEXT NOT NULL,
      clicked_id TEXT,
      clicked_kind TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pins (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      position INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, kind, target_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reco_feedback (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      seed_id TEXT,
      verdict TEXT NOT NULL,
      context TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reco_weights (
      mode TEXT PRIMARY KEY,
      w_content REAL NOT NULL,
      w_seq REAL NOT NULL,
      w_ctx REAL NOT NULL,
      w_bandit REAL NOT NULL,
      w_satisf REAL NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_listen_user_time ON listen_events(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_search_user_time ON search_history(user_id, created_at DESC);
  `);

  const defaults: Array<[string, number, number, number, number, number]> = [
    ['radio', 0.28, 0.32, 0.18, 0.14, 0.08],
    ['style', 0.2, 0.38, 0.14, 0.2, 0.08],
    ['discover', 0.18, 0.2, 0.12, 0.38, 0.12],
    ['focus', 0.4, 0.3, 0.2, 0.05, 0.05],
  ];
  const now = Date.now();
  for (const [mode, w1, w2, w3, w4, w5] of defaults) {
    db.prepare(
      `INSERT INTO reco_weights (mode, w_content, w_seq, w_ctx, w_bandit, w_satisf, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mode) DO UPDATE SET
         w_content = excluded.w_content,
         w_seq = excluded.w_seq,
         w_ctx = excluded.w_ctx,
         w_bandit = excluded.w_bandit,
         w_satisf = excluded.w_satisf,
         updated_at = excluded.updated_at`,
    ).run(mode, w1, w2, w3, w4, w5, now);
  }
}

ensureRecoSchema();

/** Colonne player sync multi-appareils (ajoutée au fil de l’eau). */
function ensurePlayerPrefsColumns() {
  try {
    db.exec(`ALTER TABLE user_prefs ADD COLUMN autoplay_suggestions INTEGER DEFAULT 1`);
  } catch {
    /* already exists */
  }
}
ensurePlayerPrefsColumns();

export type Prefs = {
  genres: string[];
  moods: string[];
  moments: string[];
  onboardingDone: boolean;
  discoveryBias: number;
  /** Lecture auto « À suivre » (sync multi-appareils). */
  autoplaySuggestions: boolean;
};

export function getPrefs(userId: string): Prefs {
  const row = db.prepare('SELECT * FROM user_prefs WHERE user_id = ?').get(userId) as
    | {
        genres: string;
        moods: string;
        moments: string;
        onboarding_done: number;
        discovery_bias: number;
        autoplay_suggestions?: number | null;
      }
    | undefined;
  if (!row) {
    return {
      genres: [],
      moods: [],
      moments: [],
      onboardingDone: false,
      discoveryBias: 0.1,
      autoplaySuggestions: true,
    };
  }
  return {
    genres: JSON.parse(row.genres || '[]'),
    moods: JSON.parse(row.moods || '[]'),
    moments: JSON.parse(row.moments || '[]'),
    onboardingDone: Boolean(row.onboarding_done),
    discoveryBias: row.discovery_bias ?? 0.1,
    autoplaySuggestions: row.autoplay_suggestions == null ? true : Boolean(row.autoplay_suggestions),
  };
}

export function savePrefs(
  userId: string,
  patch: Partial<Prefs> & { onboardingDone?: boolean },
): Prefs {
  const cur = getPrefs(userId);
  const next: Prefs = {
    genres: patch.genres ?? cur.genres,
    moods: patch.moods ?? cur.moods,
    moments: patch.moments ?? cur.moments,
    onboardingDone: patch.onboardingDone ?? cur.onboardingDone,
    discoveryBias: patch.discoveryBias ?? cur.discoveryBias,
    autoplaySuggestions:
      patch.autoplaySuggestions != null ? Boolean(patch.autoplaySuggestions) : cur.autoplaySuggestions,
  };
  db.prepare(
    `INSERT INTO user_prefs (user_id, genres, moods, moments, onboarding_done, discovery_bias, autoplay_suggestions, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       genres = excluded.genres,
       moods = excluded.moods,
       moments = excluded.moments,
       onboarding_done = excluded.onboarding_done,
       discovery_bias = excluded.discovery_bias,
       autoplay_suggestions = excluded.autoplay_suggestions,
       updated_at = excluded.updated_at`,
  ).run(
    userId,
    JSON.stringify(next.genres),
    JSON.stringify(next.moods),
    JSON.stringify(next.moments),
    next.onboardingDone ? 1 : 0,
    next.discoveryBias,
    next.autoplaySuggestions ? 1 : 0,
    Date.now(),
  );
  return next;
}

export function followArtist(
  userId: string,
  artist: { id: string; name?: string; payload?: unknown },
) {
  db.prepare(
    `INSERT INTO artist_follows (user_id, artist_id, artist_name, payload, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, artist_id) DO UPDATE SET artist_name = excluded.artist_name, payload = excluded.payload`,
  ).run(
    userId,
    artist.id,
    artist.name || null,
    JSON.stringify(artist.payload || artist),
    Date.now(),
  );
}

export function unfollowArtist(userId: string, artistId: string) {
  db.prepare('DELETE FROM artist_follows WHERE user_id = ? AND artist_id = ?').run(userId, artistId);
}

export function listFollows(userId: string) {
  return db
    .prepare('SELECT * FROM artist_follows WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as any[];
}

export function recordListenEvent(opts: {
  userId: string;
  trackId: string;
  event: 'start' | 'progress' | 'complete' | 'skip';
  progressPct?: number;
  durationMs?: number;
  seedId?: string;
}) {
  const now = new Date();
  db.prepare(
    `INSERT INTO listen_events
     (id, user_id, track_id, event, progress_pct, duration_ms, seed_id, hour, is_weekend, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    opts.userId,
    opts.trackId,
    opts.event,
    opts.progressPct ?? 0,
    opts.durationMs ?? null,
    opts.seedId || null,
    now.getHours(),
    now.getDay() === 0 || now.getDay() === 6 ? 1 : 0,
    Date.now(),
  );
  if (Math.random() < 0.02) {
    try {
      db.prepare(`DELETE FROM listen_events WHERE created_at < ?`).run(
        Date.now() - 21 * 24 * 3600 * 1000,
      );
    } catch {
      /* ignore */
    }
  }
}

export function listListenEvents(userId: string, limit = 200) {
  return db
    .prepare(
      `SELECT * FROM listen_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, limit);
}

/** Événements d’écoute enrichis (titre / artiste) pour l’UI historique. */
export function listListenEventsDetailed(userId: string, limit = 500) {
  const rows = db
    .prepare(
      `SELECT e.*, t.payload AS payload
       FROM listen_events e
       LEFT JOIN tracks_cache t ON t.id = e.track_id
       WHERE e.user_id = ?
       ORDER BY e.created_at DESC
       LIMIT ?`,
    )
    .all(userId, limit) as Array<Record<string, unknown> & { payload?: string | null }>;

  return rows.map((row) => {
    let track: Record<string, unknown> | null = null;
    if (row.payload) {
      try {
        track = JSON.parse(String(row.payload));
      } catch {
        track = null;
      }
    }
    if (!track) {
      track = {
        id: row.track_id,
        title: String(row.track_id),
        artists: [],
        thumbnails: [],
        type: 'song',
      };
    }
    const event = String(row.event || 'start');
    const pct = Number(row.progress_pct || 0);
    let status: 'started' | 'partial' | 'complete' | 'skipped' = 'started';
    if (event === 'complete') status = 'complete';
    else if (event === 'skip') status = 'skipped';
    else if (event === 'progress' || (event === 'start' && pct >= 5)) {
      status = pct >= 85 ? 'complete' : 'partial';
    }
    return {
      id: row.id,
      trackId: row.track_id,
      event,
      status,
      progressPct: pct,
      durationMs: row.duration_ms ?? null,
      createdAt: Number(row.created_at || 0),
      track,
    };
  });
}

export function addSearchHistory(
  userId: string,
  query: string,
  clicked?: { id?: string; kind?: string },
) {
  const q = query.trim().replace(/\s+/g, ' ');
  // Ignore frappes trop courtes (pollution « K », « Ke », « Ken »)
  if (!q || (q.length < 3 && !clicked?.id)) return;

  const recent = listSearchHistory(userId, 8) as { id: string; query: string; created_at: number }[];
  const nq = q.toLowerCase();
  const now = Date.now();

  // Remplace les préfixes progressifs récents (« Keny » → « Keny Arkana »)
  for (const last of recent) {
    const lq = String(last.query || '').trim().toLowerCase();
    if (!lq) continue;
    const age = now - Number(last.created_at || 0);
    if (age > 90_000) continue;
    if (nq === lq && !clicked?.id) return; // doublon exact récent
    if (nq.startsWith(lq) || lq.startsWith(nq)) {
      db.prepare('DELETE FROM search_history WHERE id = ? AND user_id = ?').run(last.id, userId);
    }
  }

  db.prepare(
    `INSERT INTO search_history (id, user_id, query, clicked_id, clicked_kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), userId, q, clicked?.id || null, clicked?.kind || null, now);

  if (clicked?.id) {
    try {
      recordSearchHitClick(q, clicked.id);
    } catch {
      /* non-bloquant */
    }
  }
}

export function listSearchHistory(userId: string, limit = 30) {
  return db
    .prepare(
      `SELECT * FROM search_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, limit) as any[];
}

/** Même videoId en song+video → un seul kind pour éviter les doublons UNIQUE(kind,target). */
function normalizePinKind(kind: string, targetId: string): string {
  const k = String(kind || 'song').trim().toLowerCase() || 'song';
  if (/^[a-zA-Z0-9_-]{11}$/.test(targetId) && (k === 'song' || k === 'video' || k === 'unknown')) {
    return 'song';
  }
  return k;
}

/** Garde le premier pin par target_id (position puis created_at), purge les doublons. */
function purgeDuplicatePins(userId: string) {
  const dups = db
    .prepare(
      `SELECT target_id AS tid FROM pins WHERE user_id = ? GROUP BY target_id HAVING COUNT(*) > 1`,
    )
    .all(userId) as { tid: string }[];
  for (const { tid } of dups) {
    const keep = db
      .prepare(
        `SELECT id FROM pins WHERE user_id = ? AND target_id = ?
         ORDER BY position ASC, created_at ASC LIMIT 1`,
      )
      .get(userId, tid) as { id: string } | undefined;
    if (!keep?.id) continue;
    db.prepare(`DELETE FROM pins WHERE user_id = ? AND target_id = ? AND id != ?`).run(
      userId,
      tid,
      keep.id,
    );
  }
}

export function listPins(userId: string) {
  purgeDuplicatePins(userId);
  const rows = (
    db
      .prepare('SELECT * FROM pins WHERE user_id = ? ORDER BY position ASC, created_at ASC')
      .all(userId) as any[]
  ).map((p) => {
    const raw = JSON.parse(p.payload) as Record<string, unknown>;
    const enriched = enrichPinPayload(userId, String(p.kind || 'song'), String(p.target_id), raw);
    // Persiste un payload pauvre (ex. title « U ») pour les prochaines lectures
    if (pinPayloadWeak(raw) && !pinPayloadWeak(enriched)) {
      try {
        db.prepare('UPDATE pins SET payload = ? WHERE id = ? AND user_id = ?').run(
          JSON.stringify(enriched),
          p.id,
          userId,
        );
      } catch {
        /* ignore */
      }
    }
    return {
      id: p.id,
      kind: p.kind,
      targetId: p.target_id,
      payload: enriched,
      position: p.position,
      createdAt: p.created_at,
    };
  });
  // Filet : un seul pin par targetId (le premier épinglé)
  const seen = new Set<string>();
  return rows.filter((p) => {
    const tid = String(p.targetId || '');
    if (!tid || seen.has(tid)) return false;
    seen.add(tid);
    return true;
  });
}

function pinPayloadWeak(payload: Record<string, unknown> | null | undefined): boolean {
  if (!payload || typeof payload !== 'object') return true;
  const title = String(payload.title || payload.name || '').trim();
  const thumbs = payload.thumbnails;
  const hasThumbs = Array.isArray(thumbs) && thumbs.length > 0;
  return title.length <= 2 || !hasThumbs;
}

/** Complète titre / artistes / covers depuis la biblio ou le cache titres. */
export function enrichPinPayload(
  userId: string,
  kind: string,
  targetId: string,
  payload: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const base = { ...(payload && typeof payload === 'object' ? payload : {}) };
  const id = String(base.id || targetId || '').trim();
  const type = String(base.type || kind || 'song');
  let title = String(base.title || base.name || '').trim();
  let artists = Array.isArray(base.artists) ? (base.artists as unknown[]) : [];
  let thumbnails = Array.isArray(base.thumbnails) ? (base.thumbnails as unknown[]) : [];

  const tryMerge = (raw: Record<string, unknown> | null) => {
    if (!raw) return;
    if ((!title || title.length <= 2) && (raw.title || raw.name)) {
      title = String(raw.title || raw.name || title).trim();
    }
    if (!artists.length && Array.isArray(raw.artists) && raw.artists.length) {
      artists = raw.artists as unknown[];
    }
    if (!thumbnails.length && Array.isArray(raw.thumbnails) && raw.thumbnails.length) {
      thumbnails = raw.thumbnails as unknown[];
    }
  };

  if (id && (title.length <= 2 || !thumbnails.length || !artists.length)) {
    if (type === 'album' || kind === 'album') {
      const row = db
        .prepare('SELECT payload FROM library_albums WHERE user_id = ? AND album_id = ?')
        .get(userId, id) as { payload: string } | undefined;
      if (row?.payload) tryMerge(JSON.parse(row.payload) as Record<string, unknown>);
    } else if (type === 'artist' || kind === 'artist') {
      const row = db
        .prepare('SELECT payload FROM library_artists WHERE user_id = ? AND artist_id = ?')
        .get(userId, id) as { payload: string } | undefined;
      if (row?.payload) {
        const a = JSON.parse(row.payload) as Record<string, unknown>;
        tryMerge({ ...a, title: a.name || a.title });
      }
    } else if (type === 'playlist' || kind === 'playlist') {
      const row = db
        .prepare('SELECT payload FROM liked_playlists WHERE user_id = ? AND playlist_id = ?')
        .get(userId, id) as { payload: string } | undefined;
      if (row?.payload) tryMerge(JSON.parse(row.payload) as Record<string, unknown>);
    } else {
      const row = db.prepare('SELECT payload FROM tracks_cache WHERE id = ?').get(id) as
        | { payload: string }
        | undefined;
      if (row?.payload) tryMerge(JSON.parse(row.payload) as Record<string, unknown>);
    }
  }

  return {
    ...base,
    id: id || targetId,
    type,
    title: title || String(base.title || base.name || targetId),
    artists: (artists as { name?: string; id?: string }[]).filter(
      (a) => a?.name && !isJunkArtistName(String(a.name)),
    ),
    thumbnails,
  };
}

export function addPin(
  userId: string,
  kind: string,
  targetId: string,
  payload: unknown,
) {
  const tid = String(targetId || '').trim();
  if (!tid) return listPins(userId);
  const kindNorm = normalizePinKind(kind, tid);
  const enriched = enrichPinPayload(
    userId,
    kindNorm,
    tid,
    (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>,
  );

  // Déjà épinglé (n’importe quel kind) → garder le premier, enrichir payload, purger doublons
  const existing = db
    .prepare(
      `SELECT id, kind FROM pins WHERE user_id = ? AND target_id = ?
       ORDER BY position ASC, created_at ASC`,
    )
    .all(userId, tid) as { id: string; kind: string }[];
  if (existing.length) {
    const keep = existing[0]!;
    db.prepare(`UPDATE pins SET payload = ? WHERE id = ? AND user_id = ?`).run(
      JSON.stringify(enriched),
      keep.id,
      userId,
    );
    if (existing.length > 1) {
      db.prepare(`DELETE FROM pins WHERE user_id = ? AND target_id = ? AND id != ?`).run(
        userId,
        tid,
        keep.id,
      );
    }
    return listPins(userId);
  }

  const id = randomUUID();
  const max = (
    db.prepare('SELECT COALESCE(MAX(position), -1) as m FROM pins WHERE user_id = ?').get(userId) as {
      m: number;
    }
  ).m;
  db.prepare(
    `INSERT INTO pins (id, user_id, kind, target_id, payload, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, kind, target_id) DO UPDATE SET payload = excluded.payload`,
  ).run(id, userId, kindNorm, tid, JSON.stringify(enriched), max + 1, Date.now());
  return listPins(userId);
}

export type PinSyncItem = {
  kind?: string;
  targetId?: string;
  id?: string;
  payload?: unknown;
  position?: number;
};

/**
 * Fusionne une liste d’épingles (upsert par kind+target_id).
 * Sert la sync multi-appareils : chaque client pousse son cache, le serveur
 * conserve l’union (pas d’écrasement total).
 */
export function mergePins(userId: string, items: PinSyncItem[]) {
  let upserted = 0;
  const seen = new Set<string>();
  for (const item of items) {
    const payloadObj =
      item.payload && typeof item.payload === 'object'
        ? (item.payload as Record<string, unknown>)
        : item && typeof item === 'object'
          ? (item as Record<string, unknown>)
          : {};
    const targetId = String(
      item.targetId || item.id || payloadObj.id || payloadObj.targetId || '',
    ).trim();
    if (!targetId || seen.has(targetId)) continue;
    seen.add(targetId);
    const kind = String(
      item.kind || payloadObj.kind || payloadObj.type || 'song',
    ).trim() || 'song';
    addPin(userId, kind, targetId, payloadObj);
    upserted += 1;
  }
  return { pins: listPins(userId), upserted, total: listPins(userId).length };
}

export function removePin(userId: string, pinId: string) {
  db.prepare('DELETE FROM pins WHERE id = ? AND user_id = ?').run(pinId, userId);
  return listPins(userId);
}

export function removePinByTarget(userId: string, targetId: string) {
  db.prepare('DELETE FROM pins WHERE user_id = ? AND target_id = ?').run(userId, targetId);
  return listPins(userId);
}

export function addRecoFeedback(opts: {
  userId: string;
  trackId: string;
  seedId?: string;
  verdict: 'good' | 'bad';
  context?: string;
}) {
  db.prepare(
    `INSERT INTO reco_feedback (id, user_id, track_id, seed_id, verdict, context, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    opts.userId,
    opts.trackId,
    opts.seedId || null,
    opts.verdict,
    opts.context || null,
    Date.now(),
  );
}

export function getWeights(mode = 'radio') {
  const row = db.prepare('SELECT * FROM reco_weights WHERE mode = ?').get(mode) as
    | {
        mode: string;
        w_content: number;
        w_seq: number;
        w_ctx: number;
        w_bandit: number;
        w_satisf: number;
      }
    | undefined;
  if (!row) {
    if (mode === 'style' || mode === 'album-style') {
      return { mode, w_content: 0.42, w_seq: 0.28, w_ctx: 0.12, w_bandit: 0.1, w_satisf: 0.08 };
    }
    if (mode === 'artist-radio') {
      return { mode, w_content: 0.24, w_seq: 0.34, w_ctx: 0.16, w_bandit: 0.14, w_satisf: 0.12 };
    }
    return { mode, w_content: 0.28, w_seq: 0.32, w_ctx: 0.18, w_bandit: 0.14, w_satisf: 0.08 };
  }
  return row;
}

export function listWeights() {
  return db.prepare('SELECT * FROM reco_weights ORDER BY mode').all();
}

export function saveWeights(
  mode: string,
  w: { w_content: number; w_seq: number; w_ctx: number; w_bandit: number; w_satisf: number },
) {
  db.prepare(
    `INSERT INTO reco_weights (mode, w_content, w_seq, w_ctx, w_bandit, w_satisf, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(mode) DO UPDATE SET
       w_content = excluded.w_content,
       w_seq = excluded.w_seq,
       w_ctx = excluded.w_ctx,
       w_bandit = excluded.w_bandit,
       w_satisf = excluded.w_satisf,
       updated_at = excluded.updated_at`,
  ).run(mode, w.w_content, w.w_seq, w.w_ctx, w.w_bandit, w.w_satisf, Date.now());
  return getWeights(mode);
}

export function recoAdminStats() {
  const feedback = db
    .prepare(
      `SELECT verdict, COUNT(*) as c FROM reco_feedback
       WHERE created_at > ? GROUP BY verdict`,
    )
    .all(Date.now() - 7 * 24 * 3600 * 1000) as { verdict: string; c: number }[];
  const listens = (
    db
      .prepare(`SELECT COUNT(*) as c FROM listen_events WHERE created_at > ?`)
      .get(Date.now() - 24 * 3600 * 1000) as { c: number }
  ).c;
  const skips = (
    db
      .prepare(
        `SELECT COUNT(*) as c FROM listen_events WHERE event = 'skip' AND created_at > ?`,
      )
      .get(Date.now() - 24 * 3600 * 1000) as { c: number }
  ).c;
  return { feedback, listens24h: listens, skips24h: skips, weights: listWeights() };
}
