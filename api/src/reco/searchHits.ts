import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../library/db.js';
import { foldText } from './searchRank.js';
import type { Track } from '../youtube/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_PATH = join(__dirname, '..', '..', 'data', 'search-hits.json');

export type SearchHit = {
  videoId: string;
  title: string;
  artist: string;
  aliases?: string[];
};

type HitRow = {
  query_fold: string;
  video_id: string;
  title: string;
  artist: string;
  source: string;
  score: number;
};

let schemaReady = false;
let seedLoaded = false;

export function ensureSearchHitsSchema() {
  if (schemaReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_canonical_hits (
      query_fold TEXT NOT NULL,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'seed',
      score INTEGER NOT NULL DEFAULT 100,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (query_fold, video_id)
    );
    CREATE INDEX IF NOT EXISTS idx_search_hits_fold ON search_canonical_hits(query_fold);
    CREATE INDEX IF NOT EXISTS idx_search_hits_video ON search_canonical_hits(video_id);

    CREATE TABLE IF NOT EXISTS track_duration_cache (
      video_id TEXT PRIMARY KEY,
      duration_seconds INTEGER NOT NULL,
      duration_text TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  schemaReady = true;
}

function upsertHit(
  queryFold: string,
  videoId: string,
  title: string,
  artist: string,
  source: string,
  score: number,
) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO search_canonical_hits (query_fold, video_id, title, artist, source, score, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(query_fold, video_id) DO UPDATE SET
       title = excluded.title,
       artist = excluded.artist,
       source = CASE
         WHEN search_canonical_hits.source = 'seed' AND excluded.source = 'click' THEN 'seed'
         ELSE excluded.source
       END,
       score = MAX(search_canonical_hits.score, excluded.score),
       updated_at = excluded.updated_at`,
  ).run(queryFold, videoId, title, artist, source, score, now);
}

/** Charge le seed JSON une fois (idempotent). */
export function loadSearchHitsSeed() {
  ensureSearchHitsSchema();
  if (seedLoaded) return;
  seedLoaded = true;
  if (!existsSync(SEED_PATH)) return;
  try {
    const raw = JSON.parse(readFileSync(SEED_PATH, 'utf8')) as SearchHit[];
    if (!Array.isArray(raw)) return;
    const insert = db.transaction((hits: SearchHit[]) => {
      for (const h of hits) {
        if (!h?.videoId || !h.title) continue;
        const aliases = new Set<string>();
        aliases.add(foldText(h.title));
        aliases.add(foldText(`${h.artist} ${h.title}`));
        aliases.add(foldText(`${h.title} ${h.artist}`));
        for (const a of h.aliases || []) aliases.add(foldText(a));
        for (const key of aliases) {
          if (!key || key.length < 2) continue;
          upsertHit(key, h.videoId, h.title, h.artist || '', 'seed', 1000);
        }
      }
    });
    insert(raw);
  } catch (err) {
    console.warn('[searchHits] seed load failed', err);
  }
}

/**
 * Apprentissage clics : renforce (query → videoId).
 * Seuil bas pour self-host (3) → hit effectif.
 */
export function recordSearchHitClick(query: string, videoId: string, meta?: { title?: string; artist?: string }) {
  ensureSearchHitsSchema();
  loadSearchHitsSeed();
  const fold = foldText(query);
  const id = String(videoId || '').trim();
  if (!fold || fold.length < 2 || !id || id.length < 6) return;

  const now = Date.now();
  const existing = db
    .prepare(`SELECT score, title, artist, source FROM search_canonical_hits WHERE query_fold = ? AND video_id = ?`)
    .get(fold, id) as { score: number; title: string; artist: string; source: string } | undefined;

  const nextScore = (existing?.score || 0) + 40;
  const title = meta?.title || existing?.title || id;
  const artist = meta?.artist || existing?.artist || '';
  const source = existing?.source === 'seed' ? 'seed' : 'click';

  db.prepare(
    `INSERT INTO search_canonical_hits (query_fold, video_id, title, artist, source, score, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(query_fold, video_id) DO UPDATE SET
       score = excluded.score,
       title = CASE WHEN length(excluded.title) > 2 THEN excluded.title ELSE search_canonical_hits.title END,
       artist = CASE WHEN length(excluded.artist) > 0 THEN excluded.artist ELSE search_canonical_hits.artist END,
       updated_at = excluded.updated_at`,
  ).run(fold, id, title, artist, source, nextScore, now);
}

export type ResolvedHit = {
  videoId: string;
  title: string;
  artist: string;
  score: number;
  source: string;
};

/** Meilleur hit pour une query (seed ou clics). */
export function resolveSearchHit(query: string): ResolvedHit | null {
  ensureSearchHitsSchema();
  loadSearchHitsSeed();
  const fold = foldText(query);
  if (!fold || fold.length < 2) return null;

  // Exact fold
  let row = db
    .prepare(
      `SELECT query_fold, video_id, title, artist, source, score
       FROM search_canonical_hits WHERE query_fold = ? ORDER BY score DESC LIMIT 1`,
    )
    .get(fold) as HitRow | undefined;

  // Préfixe / containment léger (ex. « waka waka this time »)
  if (!row && fold.length >= 6) {
    row = db
      .prepare(
        `SELECT query_fold, video_id, title, artist, source, score
         FROM search_canonical_hits
         WHERE ? LIKE query_fold || '%' OR query_fold LIKE ? || '%'
         ORDER BY score DESC, length(query_fold) ASC
         LIMIT 1`,
      )
      .get(fold, fold) as HitRow | undefined;
    // Évite matches trop courts (« life » → tout)
    if (row && String(row.query_fold).length < 5 && fold.length > String(row.query_fold).length + 4) {
      row = undefined;
    }
  }

  if (!row) return null;
  // Clics : exiger un minimum sauf seed
  if (row.source === 'click' && row.score < 100) return null;

  return {
    videoId: row.video_id,
    title: row.title,
    artist: row.artist,
    score: row.score,
    source: row.source,
  };
}

/** Construit un Track minimal pour injection (enrichi ensuite via getTrack si besoin). */
export function hitToTrack(hit: ResolvedHit): Track {
  return {
    id: hit.videoId,
    title: hit.title,
    artists: hit.artist ? [{ name: hit.artist }] : [],
    thumbnails: [
      { url: `https://i.ytimg.com/vi/${hit.videoId}/hqdefault.jpg`, width: 480, height: 360 },
    ],
    type: 'song',
  };
}

export function cacheTrackDuration(videoId: string, seconds: number, text?: string) {
  ensureSearchHitsSchema();
  if (!videoId || !(seconds > 0)) return;
  db.prepare(
    `INSERT INTO track_duration_cache (video_id, duration_seconds, duration_text, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(video_id) DO UPDATE SET
       duration_seconds = excluded.duration_seconds,
       duration_text = excluded.duration_text,
       updated_at = excluded.updated_at`,
  ).run(videoId, Math.floor(seconds), text || null, Date.now());
}

export function getCachedTrackDuration(videoId: string): { seconds: number; text?: string } | null {
  ensureSearchHitsSchema();
  const row = db
    .prepare(`SELECT duration_seconds, duration_text FROM track_duration_cache WHERE video_id = ?`)
    .get(videoId) as { duration_seconds: number; duration_text: string | null } | undefined;
  if (!row || !(row.duration_seconds > 0)) return null;
  return { seconds: row.duration_seconds, text: row.duration_text || undefined };
}

/** Applique les durées cachées sur une liste de pistes. */
export function applyCachedDurations<T extends Track>(tracks: T[]): T[] {
  ensureSearchHitsSchema();
  return tracks.map((t) => {
    if (t.durationSeconds && t.durationSeconds > 0 && t.duration) return t;
    const cached = getCachedTrackDuration(t.id);
    if (!cached) return t;
    return {
      ...t,
      durationSeconds: t.durationSeconds || cached.seconds,
      duration: t.duration || cached.text || undefined,
    };
  });
}

// Bootstrap au chargement du module
try {
  loadSearchHitsSeed();
} catch {
  /* DB pas prête */
}
