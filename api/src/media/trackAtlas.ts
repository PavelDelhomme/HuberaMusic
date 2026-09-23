/**
 * Cartographie compressée : empreinte titre+artiste → videoId réellement jouable
 * (fichier .m4a déjà sur le VPS). Évite de redemander YouTube à chaque titre mort.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getTrackPayload } from '../library/db.js';
import { artistLine, fingerprint, normalize } from './trackMatch.js';

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'cache');
const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;
const MIN_BYTES = 256 * 1024;

let schemaReady = false;
let builtAt = 0;
let building = false;

export function ensureTrackAtlasSchema() {
  if (schemaReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS track_atlas (
      fp TEXT PRIMARY KEY,
      video_id TEXT NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      artist TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_atlas_vid ON track_atlas(video_id);
  `);
  schemaReady = true;
}

export function fpKey(title: string, artist: string): string | null {
  const fp = fingerprint(title, artist);
  if (!fp || fp.length < 4) return null;
  return createHash('sha1').update(fp).digest('base64url').slice(0, 16);
}

function diskBytes(id: string): number {
  try {
    const p = join(CACHE_DIR, `${id}.m4a`);
    if (!existsSync(p)) return 0;
    const n = statSync(p).size;
    return n >= MIN_BYTES ? n : 0;
  } catch {
    return 0;
  }
}

export function rememberAtlasPlayable(
  videoId: string,
  title: string,
  artist: string,
  bytes?: number,
) {
  if (!VIDEO_ID.test(videoId)) return;
  const fp = fpKey(title, artist);
  if (!fp) return;
  const size = bytes && bytes >= MIN_BYTES ? bytes : diskBytes(videoId);
  if (size < MIN_BYTES) return;
  try {
    ensureTrackAtlasSchema();
    const now = Date.now();
    const prev = db
      .prepare('SELECT video_id, bytes FROM track_atlas WHERE fp = ?')
      .get(fp) as { video_id?: string; bytes?: number } | undefined;
    if (prev?.bytes && prev.bytes > size) return;
    db.prepare(
      `INSERT INTO track_atlas (fp, video_id, bytes, title, artist, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(fp) DO UPDATE SET
         video_id = excluded.video_id,
         bytes = excluded.bytes,
         title = excluded.title,
         artist = excluded.artist,
         updated_at = excluded.updated_at`,
    ).run(fp, videoId, size, title.slice(0, 120), artist.slice(0, 80), now);
  } catch (err) {
    console.warn('[atlas] persist KO', String((err as Error).message || err).slice(0, 120));
  }
}

/** Autre id déjà en cache disque pour le même morceau. */
export function findAtlasEquivalent(videoId: string): string | null {
  if (!VIDEO_ID.test(videoId)) return null;
  try {
    ensureTrackAtlasSchema();
    const own = diskBytes(videoId);
    if (own >= MIN_BYTES) return null;
    const meta = getTrackPayload(videoId);
    const title = meta?.title || '';
    const artist = meta ? artistLine(meta) : '';
    const fp = fpKey(title, artist);
    if (!fp) return null;
    const row = db
      .prepare('SELECT video_id, bytes FROM track_atlas WHERE fp = ?')
      .get(fp) as { video_id?: string; bytes?: number } | undefined;
    const id = row?.video_id;
    if (!id || id === videoId || !VIDEO_ID.test(id)) return null;
    if (diskBytes(id) < MIN_BYTES) return null;
    return id;
  } catch {
    return null;
  }
}

export function atlasStats(): { rows: number; builtAt: number } {
  try {
    ensureTrackAtlasSchema();
    const n = db.prepare('SELECT COUNT(*) AS c FROM track_atlas').get() as { c: number };
    return { rows: n.c || 0, builtAt };
  } catch {
    return { rows: 0, builtAt };
  }
}

/** Indexe les .m4a du VPS + métadonnées catalogue. À lancer au boot (fond). */
export function rebuildTrackAtlas(): { indexed: number; skipped: number } {
  if (building) return { indexed: 0, skipped: 0 };
  building = true;
  let indexed = 0;
  let skipped = 0;
  try {
    ensureTrackAtlasSchema();
    const files = existsSync(CACHE_DIR)
      ? readdirSync(CACHE_DIR).filter((f) => f.endsWith('.m4a'))
      : [];
    for (const f of files) {
      const id = f.slice(0, -4);
      if (!VIDEO_ID.test(id)) {
        skipped += 1;
        continue;
      }
      const bytes = diskBytes(id);
      if (!bytes) {
        skipped += 1;
        continue;
      }
      const meta = getTrackPayload(id);
      const title = meta?.title || '';
      const artist = meta ? artistLine(meta) : '';
      if (!normalize(title)) {
        skipped += 1;
        continue;
      }
      rememberAtlasPlayable(id, title, artist, bytes);
      indexed += 1;
    }
    builtAt = Date.now();
    console.log(`[atlas] ${indexed} empreintes (${skipped} ignorés)`);
  } catch (err) {
    console.warn('[atlas] rebuild KO', String((err as Error).message || err).slice(0, 160));
  } finally {
    building = false;
  }
  return { indexed, skipped };
}

export function startTrackAtlas(): void {
  setTimeout(() => {
    try {
      rebuildTrackAtlas();
    } catch (err) {
      console.warn('[atlas] start KO', String((err as Error).message || err).slice(0, 120));
    }
  }, 8_000);
}
