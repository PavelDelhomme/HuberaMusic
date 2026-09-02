#!/usr/bin/env node
/**
 * Vérifie counts / spot-check après import PG.
 * Usage: DATABASE_URL=... node scripts/db/verify-pg.mjs [--sqlite path]
 */
import Database from 'better-sqlite3';
import pg from 'pg';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const sqliteIdx = args.indexOf('--sqlite');
const sqlitePath =
  (sqliteIdx >= 0 && args[sqliteIdx + 1]) ||
  process.env.YTMUSIC_SQLITE ||
  join(ROOT, 'data/ytmusic.db');
const databaseUrl = (process.env.DATABASE_URL || '').trim();
if (!databaseUrl) {
  console.error('DATABASE_URL requis');
  process.exit(1);
}

const tables = [
  'users',
  'liked_tracks',
  'library_tracks',
  'playlists',
  'playlist_tracks',
  'history',
  'ytm_accounts',
  'tracks_cache',
  'passkeys',
  'refresh_tokens',
  'listen_events',
  'telemetry_events',
];

const pool = new pg.Pool({ connectionString: databaseUrl });
const sqlite = existsSync(sqlitePath) ? new Database(sqlitePath, { readonly: true }) : null;

async function main() {
  const client = await pool.connect();
  try {
    let bad = 0;
    console.log('==> verify-pg');
    for (const t of tables) {
      const pgR = await client.query(`SELECT COUNT(*)::int AS c FROM "${t}"`).catch(() => null);
      const pgC = pgR?.rows[0]?.c ?? null;
      const sqC = sqlite
        ? sqlite.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get()?.c
        : null;
      const ok = sqC == null || sqC === pgC;
      if (!ok) bad += 1;
      console.log(`  ${ok ? '✓' : '✗'} ${t}: pg=${pgC}${sqC != null ? ` sqlite=${sqC}` : ''}`);
    }
    // Spot-check: 1 user avec likes
    const u = await client.query(
      `SELECT u.id, u.email, (SELECT COUNT(*) FROM liked_tracks l WHERE l.user_id=u.id) AS likes
       FROM users u ORDER BY likes DESC NULLS LAST LIMIT 3`,
    );
    console.log('\n==> spot users');
    for (const row of u.rows) {
      console.log(`  ${row.email} likes=${row.likes}`);
    }
    const ytm = await client.query(
      `SELECT COUNT(*)::int AS c FROM ytm_accounts WHERE oauth_enc IS NOT NULL OR cookie_enc IS NOT NULL`,
    );
    console.log(`\n==> ytm_accounts chiffrés: ${ytm.rows[0].c}`);
    if (bad) {
      console.error(`\n❌ ${bad} écart(s)`);
      process.exit(2);
    }
    console.log('\n✅ verify OK');
  } finally {
    client.release();
    await pool.end();
    sqlite?.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
