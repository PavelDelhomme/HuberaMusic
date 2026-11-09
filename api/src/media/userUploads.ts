import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../library/db.js';
import type { Track } from '../youtube/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', '..', 'data');
const UPLOAD_ROOT = join(DATA_DIR, 'uploads');
const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
export const MIN_UPLOAD_BYTES = 8 * 1024;
export const MAX_UPLOADS_PER_USER = 200;

export type UserUploadRow = {
  user_id: string;
  id: string;
  file_name: string;
  mime: string;
  original_name: string | null;
  source_query: string | null;
  youtube_id: string | null;
  size_bytes: number;
  created_at: number;
};

export function ensureUserUploadsTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_uploads (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT 'audio/mpeg',
      original_name TEXT,
      source_query TEXT,
      youtube_id TEXT,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (user_id, id)
    )
  `);
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_user_uploads_user ON user_uploads(user_id, created_at)');
  } catch {
    /* déjà là */
  }
}

ensureUserUploadsTable();

export function newLocalTrackId(): string {
  const buf = randomBytes(11);
  let id = '';
  for (let i = 0; i < 11; i++) id += ALPH[buf[i] % 64];
  return id;
}

export function uploadAbsPath(userId: string, trackId: string): string {
  const safeUser = String(userId).replace(/[^a-zA-Z0-9_-]/g, '');
  const safeId = String(trackId).replace(/[^a-zA-Z0-9_-]/g, '');
  return join(UPLOAD_ROOT, safeUser, `${safeId}.mp3`);
}

export function countUserUploads(userId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM user_uploads WHERE user_id = ?').get(userId) as
    | { n: number }
    | undefined;
  return Number(row?.n || 0);
}

export function getOwnedUpload(userId: string, trackId: string): UserUploadRow | null {
  if (!userId || !trackId) return null;
  const row = db
    .prepare(
      `SELECT user_id, id, file_name, mime, original_name, source_query, youtube_id, size_bytes, created_at
       FROM user_uploads WHERE user_id = ? AND id = ?`,
    )
    .get(userId, trackId) as UserUploadRow | undefined;
  return row || null;
}

export function hasUploadFile(userId: string, trackId: string): boolean {
  const row = getOwnedUpload(userId, trackId);
  if (!row) return false;
  const abs = join(DATA_DIR, row.file_name);
  return existsSync(abs);
}

export function resolveUploadAbs(row: UserUploadRow): string {
  if (row.file_name.startsWith('/')) return row.file_name;
  return join(DATA_DIR, row.file_name);
}

export function saveUserUploadFile(opts: {
  userId: string;
  trackId: string;
  buffer: Buffer;
  mime?: string;
  originalName?: string;
  sourceQuery?: string;
  youtubeId?: string | null;
}): { relPath: string; absPath: string; size: number } {
  const abs = uploadAbsPath(opts.userId, opts.trackId);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, opts.buffer);
  const size = statSync(abs).size;
  const rel = join('uploads', String(opts.userId).replace(/[^a-zA-Z0-9_-]/g, ''), `${opts.trackId}.mp3`);
  db.prepare(
    `INSERT INTO user_uploads
      (user_id, id, file_name, mime, original_name, source_query, youtube_id, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET
       file_name = excluded.file_name,
       mime = excluded.mime,
       original_name = excluded.original_name,
       source_query = excluded.source_query,
       youtube_id = excluded.youtube_id,
       size_bytes = excluded.size_bytes,
       created_at = excluded.created_at`,
  ).run(
    opts.userId,
    opts.trackId,
    rel,
    opts.mime || 'audio/mpeg',
    (opts.originalName || '').slice(0, 240) || null,
    (opts.sourceQuery || '').slice(0, 240) || null,
    opts.youtubeId || null,
    size,
    Date.now(),
  );
  return { relPath: rel, absPath: abs, size };
}

export function removeUserUpload(userId: string, trackId: string): void {
  const row = getOwnedUpload(userId, trackId);
  db.prepare('DELETE FROM user_uploads WHERE user_id = ? AND id = ?').run(userId, trackId);
  if (!row) return;
  try {
    const abs = resolveUploadAbs(row);
    if (existsSync(abs)) unlinkSync(abs);
  } catch {
    /* best-effort */
  }
}

export function isUploadTrack(track: Track | { source?: string } | null | undefined): boolean {
  return Boolean(track && (track as { source?: string }).source === 'upload');
}
