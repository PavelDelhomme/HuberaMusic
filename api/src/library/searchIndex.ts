/**
 * Index FTS5 des titres musique (YouTube Music / biblio Hubera).
 * Recherche locale < 50 ms ; pas un dump de tout YouTube.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Track } from '../youtube/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', '..', 'data');
const DEFAULT_PATH = join(DATA_DIR, 'search-fts.db');

let fts: Database.Database | null = null;

function dbPath() {
  return process.env.SEARCH_FTS_PATH || DEFAULT_PATH;
}

export function openSearchIndex(): Database.Database {
  if (fts) return fts;
  const p = dbPath();
  if (p !== ':memory:' && !existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  fts = new Database(p);
  fts.pragma('journal_mode = WAL');
  fts.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS music_fts USING fts5(
      video_id UNINDEXED,
      title,
      artist,
      album,
      tokenize = 'unicode61'
    );
    CREATE TABLE IF NOT EXISTS music_meta (
      video_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      duration TEXT,
      thumb TEXT,
      type TEXT NOT NULL DEFAULT 'song',
      updated_at INTEGER NOT NULL
    );
  `);
  return fts;
}

function isMusicVideoId(id: string): boolean {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(id);
}

export function upsertIndexedTrack(t: Track): void {
  if (!t?.id || !isMusicVideoId(t.id)) return;
  if (t.type === 'album' || t.type === 'playlist' || t.type === 'artist') return;
  const title = String(t.title || '').trim();
  if (!title || title === 'Sans titre') return;
  const artist = (t.artists || []).map((a) => a.name).filter(Boolean).join(', ');
  const album = t.album?.name || '';
  const thumb = t.thumbnails?.[0]?.url || '';
  const type = t.type === 'video' ? 'video' : 'song';
  const db = openSearchIndex();
  const now = Date.now();
  db.prepare(
    `INSERT INTO music_meta (video_id, title, artist, album, duration, thumb, type, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(video_id) DO UPDATE SET
       title = excluded.title,
       artist = excluded.artist,
       album = excluded.album,
       duration = excluded.duration,
       thumb = excluded.thumb,
       type = excluded.type,
       updated_at = excluded.updated_at`,
  ).run(t.id, title, artist, album, t.duration || '', thumb, type, now);
  db.prepare(`DELETE FROM music_fts WHERE video_id = ?`).run(t.id);
  db.prepare(`INSERT INTO music_fts (video_id, title, artist, album) VALUES (?, ?, ?, ?)`).run(
    t.id,
    title,
    artist,
    album,
  );
}

export function upsertIndexedTracks(tracks: Track[]): void {
  const db = openSearchIndex();
  const tx = db.transaction((rows: Track[]) => {
    for (const t of rows) upsertIndexedTrack(t);
  });
  tx(tracks);
}

function ftsQuery(raw: string): string {
  const tokens = String(raw || '')
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, ''))
    .filter((t) => t.length >= 1)
    .slice(0, 8);
  if (!tokens.length) return '';
  return tokens.map((t) => `"${t}"*`).join(' AND ');
}

export function searchIndexed(q: string, limit = 24): Track[] {
  const match = ftsQuery(q);
  if (!match) return [];
  const t0 = Date.now();
  const db = openSearchIndex();
  let rows: Array<{
    video_id: string;
    title: string;
    artist: string;
    album: string;
    duration: string;
    thumb: string;
    type: string;
  }> = [];
  try {
    rows = db
      .prepare(
        `SELECT m.video_id, m.title, m.artist, m.album, m.duration, m.thumb, m.type
         FROM music_fts f
         JOIN music_meta m ON m.video_id = f.video_id
         WHERE music_fts MATCH ?
         LIMIT ?`,
      )
      .all(match, limit) as typeof rows;
  } catch {
    return [];
  }
  const ms = Date.now() - t0;
  if (ms > 80) console.warn('[search-fts] slow', ms, 'ms', q);
  return rows.map((r) => ({
    id: r.video_id,
    title: r.title,
    artists: r.artist ? r.artist.split(', ').map((name) => ({ name })) : [],
    album: r.album ? { name: r.album } : undefined,
    duration: r.duration || undefined,
    thumbnails: r.thumb ? [{ url: r.thumb }] : [],
    type: r.type === 'video' ? 'video' : 'song',
    source: 'youtube' as const,
  }));
}

export function indexedCount(): number {
  try {
    const row = openSearchIndex().prepare(`SELECT COUNT(*) AS n FROM music_meta`).get() as { n: number };
    return row?.n || 0;
  } catch {
    return 0;
  }
}

/** Assez de hits locaux pour répondre sans attendre Innertube. */
export function localSearchSufficient(q: string, hits: Track[]): boolean {
  return String(q).trim().length >= 2 && hits.length >= 5;
}
