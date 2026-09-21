/**
 * Catalogue partagé (tous les comptes) :
 * - paroles gzip (1 copie / titre)
 * - index des .m4a complets déjà sur disque
 * Évite de re-scraper Genius / re-télécharger le même son.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { db } from './db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CACHE_DIR = join(ROOT, 'data', 'cache');
const MIN_AUDIO = 512 * 1024;

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_lyrics (
      video_id TEXT PRIMARY KEY,
      title TEXT,
      artist TEXT,
      lyrics_gz BLOB,
      timed_gz BLOB,
      source TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shared_ready (
      video_id TEXT PRIMARY KEY,
      audio_bytes INTEGER NOT NULL,
      has_lyrics INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shared_ready_lyrics ON shared_ready(has_lyrics);
  `);
} catch (err) {
  console.warn('[sharedCatalog] init', String((err as Error).message || err).slice(0, 120));
}

export type SharedLyrics = {
  lyrics: string | null;
  timed: { startMs: number; text: string }[] | null;
  source?: string | null;
};

function zipText(s: string | null | undefined): Buffer | null {
  const t = String(s || '').trim();
  if (!t) return null;
  return gzipSync(Buffer.from(t, 'utf8'), { level: 9 });
}

function unzipText(buf: unknown): string | null {
  if (!buf) return null;
  try {
    const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf as ArrayBuffer);
    if (!raw.length) return null;
    return gunzipSync(raw).toString('utf8');
  } catch {
    return null;
  }
}

export function getSharedLyrics(videoId: string): SharedLyrics | null {
  if (!videoId) return null;
  try {
    const row = db
      .prepare(
        `SELECT lyrics_gz, timed_gz, source FROM shared_lyrics WHERE video_id = ?`,
      )
      .get(videoId) as
      | { lyrics_gz?: Buffer; timed_gz?: Buffer; source?: string }
      | undefined;
    if (!row) return null;
    const lyrics = unzipText(row.lyrics_gz);
    if (!lyrics || lyrics.length < 40) return null;
    let timed: SharedLyrics['timed'] = null;
    const timedJson = unzipText(row.timed_gz);
    if (timedJson) {
      try {
        const parsed = JSON.parse(timedJson) as SharedLyrics['timed'];
        if (Array.isArray(parsed) && parsed.length >= 2) timed = parsed;
      } catch {
        /* ignore */
      }
    }
    return { lyrics, timed, source: row.source || 'shared' };
  } catch {
    return null;
  }
}

/** Réutilise des paroles déjà stockées pour le même titre + artiste. */
export function findSharedLyricsByMeta(title: string, artist: string): SharedLyrics | null {
  const t = String(title || '').trim();
  const a = String(artist || '').trim();
  if (t.length < 2) return null;
  try {
    const rows = db
      .prepare(
        `SELECT video_id, title, artist FROM shared_lyrics
         ORDER BY updated_at DESC LIMIT 800`,
      )
      .all() as { video_id: string; title?: string; artist?: string }[];
    const wantT = t.toLowerCase();
    const wantA = a.toLowerCase().replace(/\s+/g, '');
    for (const row of rows) {
      const gotT = String(row.title || '').toLowerCase();
      const gotA = String(row.artist || '').toLowerCase().replace(/\s+/g, '');
      if (!gotT) continue;
      const titleOk = gotT === wantT || (gotT.includes(wantT) && wantT.length >= 8);
      const artistOk = !wantA || !gotA || gotA === wantA || gotA.includes(wantA) || wantA.includes(gotA);
      if (titleOk && artistOk) {
        const hit = getSharedLyrics(row.video_id);
        if (hit?.lyrics) return hit;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function hasSharedLyrics(videoId: string): boolean {
  try {
    const row = db
      .prepare(`SELECT 1 FROM shared_lyrics WHERE video_id = ?`)
      .get(videoId);
    return Boolean(row);
  } catch {
    return false;
  }
}

export function putSharedLyrics(
  videoId: string,
  result: SharedLyrics,
  title = '',
  artist = '',
): void {
  if (!videoId || !result?.lyrics || result.lyrics.trim().length < 40) return;
  const lyricsGz = zipText(result.lyrics);
  if (!lyricsGz) return;
  const timedGz = result.timed?.length
    ? zipText(JSON.stringify(result.timed))
    : null;
  const now = Date.now();
  try {
    db.prepare(
      `INSERT INTO shared_lyrics (video_id, title, artist, lyrics_gz, timed_gz, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(video_id) DO UPDATE SET
         title = excluded.title,
         artist = excluded.artist,
         lyrics_gz = excluded.lyrics_gz,
         timed_gz = excluded.timed_gz,
         source = excluded.source,
         updated_at = excluded.updated_at`,
    ).run(
      videoId,
      title.slice(0, 200),
      artist.slice(0, 200),
      lyricsGz,
      timedGz,
      result.source || 'genius',
      now,
    );
    db.prepare(
      `INSERT INTO shared_ready (video_id, audio_bytes, has_lyrics, updated_at)
       VALUES (?, 0, 1, ?)
       ON CONFLICT(video_id) DO UPDATE SET has_lyrics = 1, updated_at = excluded.updated_at`,
    ).run(videoId, now);
  } catch (err) {
    console.warn('[sharedCatalog] putLyrics', videoId, String((err as Error).message || err).slice(0, 80));
  }
}

export function rememberReadyAudio(videoId: string, bytes: number): void {
  if (!videoId || bytes < MIN_AUDIO) return;
  try {
    const now = Date.now();
    const prev = db
      .prepare(`SELECT audio_bytes, has_lyrics FROM shared_ready WHERE video_id = ?`)
      .get(videoId) as { audio_bytes?: number; has_lyrics?: number } | undefined;
    const audioBytes = Math.max(bytes, Number(prev?.audio_bytes) || 0);
    const hasLyrics = prev?.has_lyrics ? 1 : 0;
    db.prepare(
      `INSERT INTO shared_ready (video_id, audio_bytes, has_lyrics, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(video_id) DO UPDATE SET
         audio_bytes = excluded.audio_bytes,
         updated_at = excluded.updated_at`,
    ).run(videoId, audioBytes, hasLyrics, now);
  } catch {
    /* ignore */
  }
}

export function listReadyAudioMissingLyrics(limit = 40): string[] {
  try {
    const rows = db
      .prepare(
        `SELECT video_id FROM shared_ready
         WHERE audio_bytes >= ? AND has_lyrics = 0
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(MIN_AUDIO, limit) as { video_id: string }[];
    return rows.map((r) => r.video_id).filter((id) => /^[a-zA-Z0-9_-]{11}$/.test(id));
  } catch {
    return [];
  }
}

/** Indexe les .m4a complets déjà sur disque (une copie pour tous les users). */
export function scanReadyAudioFromDisk(max = 8_000): { scanned: number; ready: number } {
  let scanned = 0;
  let ready = 0;
  try {
    if (!existsSync(CACHE_DIR)) return { scanned: 0, ready: 0 };
    const names = readdirSync(CACHE_DIR);
    for (const name of names) {
      if (!name.endsWith('.m4a')) continue;
      const id = name.slice(0, -4);
      if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) continue;
      scanned += 1;
      if (scanned > max) break;
      try {
        const size = statSync(join(CACHE_DIR, name)).size;
        if (size >= MIN_AUDIO) {
          rememberReadyAudio(id, size);
          ready += 1;
        }
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    console.warn('[sharedCatalog] scan', String((err as Error).message || err).slice(0, 100));
  }
  return { scanned, ready };
}

export function sharedCatalogStats() {
  try {
    const lyrics = (
      db.prepare(`SELECT COUNT(*) AS n FROM shared_lyrics`).get() as { n: number }
    ).n;
    const audio = (
      db.prepare(`SELECT COUNT(*) AS n FROM shared_ready WHERE audio_bytes >= ?`).get(MIN_AUDIO) as {
        n: number;
      }
    ).n;
    const both = (
      db.prepare(
        `SELECT COUNT(*) AS n FROM shared_ready WHERE audio_bytes >= ? AND has_lyrics = 1`,
      ).get(MIN_AUDIO) as { n: number }
    ).n;
    const bytes = (
      db.prepare(`SELECT COALESCE(SUM(audio_bytes), 0) AS n FROM shared_ready`).get() as {
        n: number;
      }
    ).n;
    return { lyrics, audioReady: audio, both, audioBytes: bytes };
  } catch {
    return { lyrics: 0, audioReady: 0, both: 0, audioBytes: 0 };
  }
}
