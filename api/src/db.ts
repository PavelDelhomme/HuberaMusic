import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sanitizeTrack, isWeakTitle } from './mappers.js';
import type { Track } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const DB_PATH = join(DATA_DIR, 'ytmusic.db');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    picture TEXT,
    google_id TEXT UNIQUE,
    password_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tracks_cache (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS liked_tracks (
    user_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS library_tracks (
    user_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS liked_playlists (
    user_id TEXT NOT NULL,
    playlist_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, playlist_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS library_albums (
    user_id TEXT NOT NULL,
    album_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, album_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS library_artists (
    user_id TEXT NOT NULL,
    artist_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, artist_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS library_mixes (
    user_id TEXT NOT NULL,
    mix_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, mix_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    cover_url TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id),
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS history (
    user_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    played_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS entity_history (
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    played_at INTEGER NOT NULL,
    play_count INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, kind, entity_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS downloads (
    user_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    path TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS offline_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS library_album_tracks (
    user_id TEXT NOT NULL,
    album_id TEXT NOT NULL,
    track_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, album_id, track_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Indexes pour biblio (idempotents)
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_liked_tracks_user ON liked_tracks(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_liked_tracks_track ON liked_tracks(track_id);
  CREATE INDEX IF NOT EXISTS idx_library_tracks_user ON library_tracks(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_history_user_played ON history(user_id, played_at DESC);
  CREATE INDEX IF NOT EXISTS idx_entity_history_user ON entity_history(user_id, played_at DESC);
  CREATE INDEX IF NOT EXISTS idx_playlist_tracks_pl ON playlist_tracks(playlist_id, position);
  CREATE INDEX IF NOT EXISTS idx_library_album_tracks_user_track ON library_album_tracks(user_id, track_id);
`);

// Colonne provenance : titre ajouté manuellement (1) vs uniquement via album (0)
try {
  db.exec(`ALTER TABLE library_tracks ADD COLUMN manual INTEGER NOT NULL DEFAULT 1`);
} catch {
  /* déjà migrée */
}

// Migration one-shot : anciens « titres biblio » = likes → aussi en library_tracks
try {
  db.exec(`
    INSERT OR IGNORE INTO library_tracks (user_id, track_id, created_at, manual)
    SELECT user_id, track_id, created_at, 1 FROM liked_tracks
  `);
} catch {
  /* ok */
}

export function upsertTrack(track: Track) {
  const clean = sanitizeTrack(track);
  const prev = getTrackPayload(clean.id);
  const merged = prev
    ? sanitizeTrack({
        ...prev,
        ...clean,
        title: isWeakTitle(clean.title, clean.id)
          ? prev.title || clean.title
          : clean.title || prev.title,
        artists: clean.artists?.length ? clean.artists : prev.artists,
        thumbnails: clean.thumbnails?.length ? clean.thumbnails : prev.thumbnails,
        album: clean.album || prev.album,
        duration: clean.duration || prev.duration,
        durationSeconds:
          typeof clean.durationSeconds === 'number' && clean.durationSeconds > 0
            ? clean.durationSeconds
            : prev.durationSeconds,
        type:
          clean.type && clean.type !== 'unknown'
            ? clean.type === 'video' && prev.type === 'song'
              ? 'song'
              : clean.type
            : prev.type,
      })
    : clean;
  db.prepare(
    `INSERT INTO tracks_cache (id, payload, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  ).run(merged.id, JSON.stringify(merged), Date.now());
}

export function getTrackPayload(id: string): Track | null {
  const row = db.prepare('SELECT payload FROM tracks_cache WHERE id = ?').get(id) as
    | { payload: string }
    | undefined;
  if (!row) return null;
  try {
    return sanitizeTrack(JSON.parse(row.payload) as Track);
  } catch {
    return null;
  }
}

export type UserRow = {
  id: string;
  email: string;
  name: string;
  picture: string | null;
  google_id: string | null;
  password_hash: string | null;
  created_at: number;
  updated_at: number;
};

export function findUserByEmail(email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
}

export function findUserById(id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function findUserByGoogleId(googleId: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId) as UserRow | undefined;
}

export function createUser(input: {
  email: string;
  name: string;
  picture?: string;
  googleId?: string;
  passwordHash?: string;
}): UserRow {
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, email, name, picture, google_id, password_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.email.toLowerCase(),
    input.name,
    input.picture || null,
    input.googleId || null,
    input.passwordHash || null,
    now,
    now,
  );
  return findUserById(id)!;
}

/** Met à jour le hash mot de passe (seed sync / reset admin). */
export function updateUserPasswordHash(userId: string, passwordHash: string) {
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    passwordHash,
    Date.now(),
    userId,
  );
}

export function publicUser(u: UserRow) {
  const row = u as UserRow & {
    email_verified?: number;
    totp_enabled?: number;
  };
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    picture: u.picture,
    hasGoogle: Boolean(u.google_id),
    isGuest: u.email.includes('@local.ytmusic'),
    isAdmin: isAdminUser(u),
    emailVerified: Boolean(row.email_verified) || Boolean(u.google_id) || u.email.includes('@local.ytmusic'),
    totpEnabled: Boolean(row.totp_enabled),
  };
}

function ensureAdminColumn() {
  const cols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'is_admin')) {
    db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
  }
}
ensureAdminColumn();

db.exec(`
  CREATE TABLE IF NOT EXISTS playback_state (
    user_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

export function isAdminUser(u: UserRow) {
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (adminEmails.includes(u.email.toLowerCase())) return true;
  const row = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(u.id) as
    | { is_admin: number }
    | undefined;
  return Boolean(row?.is_admin);
}

export function updateUserProfile(
  userId: string,
  patch: { name?: string; email?: string; picture?: string | null },
) {
  const user = findUserById(userId);
  if (!user) throw new Error('Utilisateur introuvable');
  if (patch.email && patch.email.toLowerCase() !== user.email) {
    if (user.email.includes('@local.ytmusic')) {
      throw new Error('Crée un compte pour définir un email');
    }
    if (findUserByEmail(patch.email)) throw new Error('Email déjà utilisé');
  }
  const name = patch.name?.trim() || user.name;
  const email = patch.email ? patch.email.toLowerCase() : user.email;
  const picture = patch.picture === undefined ? user.picture : patch.picture;
  db.prepare(
    `UPDATE users SET name = ?, email = ?, picture = ?, updated_at = ? WHERE id = ?`,
  ).run(name, email, picture, Date.now(), userId);
  return findUserById(userId)!;
}

export function promoteAdminIfNeeded(email: string) {
  const admins = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (admins.includes(email.toLowerCase())) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE email = ?').run(email.toLowerCase());
  }
  // First real user becomes admin
  const realCount = (
    db.prepare(`SELECT COUNT(*) as c FROM users WHERE email NOT LIKE '%@local.ytmusic'`).get() as {
      c: number;
    }
  ).c;
  if (realCount <= 1) {
    db.prepare(`UPDATE users SET is_admin = 1 WHERE email = ?`).run(email.toLowerCase());
  }
}
