#!/usr/bin/env node
/**
 * One-shot : clone les données utilisateur (biblio, pins, YTM, prefs…) d’un email vers un autre.
 *
 *   FROM_EMAIL=dev@delhomme.ovh TO_EMAIL=pavel@delhomme.ovh node scripts/admin/clone-user-data.mjs
 *
 * Prérequis : les deux users existent déjà (make seed-users).
 * Ne loggue jamais oauth_enc / cookie_enc / password_hash.
 * Remplace les lignes du destinataire pour chaque table clonée (pas de merge).
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const dbPath = process.env.DB_PATH || join(ROOT, 'data', 'ytmusic.db');

const fromEmail = (process.env.FROM_EMAIL || process.argv[2] || '').trim().toLowerCase();
const toEmail = (process.env.TO_EMAIL || process.argv[3] || '').trim().toLowerCase();
if (!fromEmail || !toEmail) {
  console.error('Usage: FROM_EMAIL=… TO_EMAIL=… node scripts/admin/clone-user-data.mjs');
  process.exit(1);
}
if (fromEmail === toEmail) {
  console.error('FROM_EMAIL et TO_EMAIL doivent être distincts');
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('foreign_keys = OFF');

const from = db.prepare('SELECT id, email FROM users WHERE email = ?').get(fromEmail);
const to = db.prepare('SELECT id, email FROM users WHERE email = ?').get(toEmail);
if (!from?.id) {
  console.error(`Source introuvable: ${fromEmail}`);
  process.exit(1);
}
if (!to?.id) {
  console.error(`Cible introuvable: ${toEmail} — lance d’abord seed-users`);
  process.exit(1);
}

const fromId = from.id;
const toId = to.id;

function tableExists(name) {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name),
  );
}

function columnsOf(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

/** Copie lignes user_id, régénère id si présent. */
function copyUserTable(table, { regenId = false } = {}) {
  if (!tableExists(table)) return 0;
  const cols = columnsOf(table);
  if (!cols.includes('user_id')) return 0;
  db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(toId);
  const rows = db.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).all(fromId);
  if (!rows.length) return 0;
  const placeholders = cols.map(() => '?').join(',');
  const ins = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`);
  for (const r of rows) {
    ins.run(
      ...cols.map((c) => {
        if (c === 'user_id') return toId;
        if (regenId && c === 'id') return randomUUID();
        return r[c];
      }),
    );
  }
  return rows.length;
}

const stats = {};

const tx = db.transaction(() => {
  for (const table of [
    'liked_tracks',
    'library_tracks',
    'liked_playlists',
    'library_albums',
    'library_artists',
    'library_mixes',
    'library_album_tracks',
    'history',
    'entity_history',
    'downloads',
    'artist_follows',
    'user_prefs',
    'playback_state',
    'ytm_accounts',
  ]) {
    stats[table] = copyUserTable(table);
  }

  for (const table of [
    'listen_events',
    'reco_feedback',
    'search_history',
    'offline_jobs',
    'user_lyric_offsets',
    'user_lyric_segment_offsets',
    'pins',
  ]) {
    stats[table] = copyUserTable(table, { regenId: true });
  }

  if (tableExists('playlists')) {
    db.prepare(
      `DELETE FROM playlist_tracks WHERE playlist_id IN (SELECT id FROM playlists WHERE user_id = ?)`,
    ).run(toId);
    db.prepare('DELETE FROM playlists WHERE user_id = ?').run(toId);
    const plCols = columnsOf('playlists');
    const pls = db.prepare('SELECT * FROM playlists WHERE user_id = ?').all(fromId);
    const idMap = new Map();
    const insPl = db.prepare(
      `INSERT INTO playlists (${plCols.join(',')}) VALUES (${plCols.map(() => '?').join(',')})`,
    );
    for (const p of pls) {
      const newId = randomUUID();
      idMap.set(p.id, newId);
      insPl.run(
        ...plCols.map((c) => {
          if (c === 'id') return newId;
          if (c === 'user_id') return toId;
          return p[c];
        }),
      );
    }
    stats.playlists = pls.length;
    if (tableExists('playlist_tracks') && idMap.size) {
      const ptCols = columnsOf('playlist_tracks');
      const insPt = db.prepare(
        `INSERT INTO playlist_tracks (${ptCols.join(',')}) VALUES (${ptCols.map(() => '?').join(',')})`,
      );
      let n = 0;
      for (const [oldId, newId] of idMap) {
        const tracks = db.prepare('SELECT * FROM playlist_tracks WHERE playlist_id = ?').all(oldId);
        for (const t of tracks) {
          insPt.run(
            ...ptCols.map((c) => {
              if (c === 'playlist_id') return newId;
              if (c === 'id') return randomUUID();
              return t[c];
            }),
          );
          n += 1;
        }
      }
      stats.playlist_tracks = n;
    }
  }
});

tx();
db.pragma('foreign_keys = ON');
db.close();

console.log(`OK — cloné ${fromEmail} → ${toEmail}`);
console.log('Tables:', stats);
console.log('(ytm_accounts copié chiffré — ne jamais logger oauth_enc / cookie_enc)');
