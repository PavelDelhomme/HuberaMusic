#!/usr/bin/env node
/**
 * Import SQLite → PostgreSQL (one-shot, batches).
 *
 * Usage:
 *   DATABASE_URL=postgres://ytmusic:ytmusic@127.0.0.1:5433/ytmusic \
 *     node scripts/db/sqlite-to-pg.mjs [--sqlite path] [--dry-run]
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const BATCH = 200;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sqliteIdx = args.indexOf('--sqlite');
const sqlitePath =
  (sqliteIdx >= 0 && args[sqliteIdx + 1]) ||
  process.env.YTMUSIC_SQLITE ||
  join(ROOT, 'data/ytmusic.db');
const databaseUrl = (process.env.DATABASE_URL || '').trim();

if (!databaseUrl) {
  console.error('❌ DATABASE_URL requis');
  process.exit(1);
}
if (!existsSync(sqlitePath)) {
  console.error('❌ SQLite introuvable:', sqlitePath);
  process.exit(1);
}

const skipTables = new Set(['sqlite_sequence', 'schema_migrations']);
const sqlite = new Database(sqlitePath, { readonly: true });
try {
  sqlite.pragma('wal_checkpoint(TRUNCATE)');
} catch {
  /* readonly ok */
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

function quoteIdent(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`identifiant invalide: ${name}`);
  return `"${name}"`;
}

async function ensureSchema(client) {
  const mig = join(ROOT, 'api/migrations/001_init.sql');
  if (!existsSync(mig)) throw new Error('migrations/001_init.sql manquant');
  await client.query(readFileSync(mig, 'utf8'));
  await client.query(
    `INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)
     ON CONFLICT (version) DO NOTHING`,
    ['001_init', Date.now()],
  );
}

function listTables() {
  return sqlite
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all()
    .map((r) => r.name)
    .filter((n) => !skipTables.has(n));
}

function tableColumns(table) {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

async function pgHasTable(client, table) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return r.rowCount > 0;
}

async function importTable(client, table, { truncate = false } = {}) {
  if (!(await pgHasTable(client, table))) {
    console.warn(`  skip ${table} (absente PG)`);
    return { table, rows: 0, skipped: true };
  }
  const cols = tableColumns(table);
  if (!cols.length) return { table, rows: 0 };
  const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
  if (dryRun) {
    console.log(`  [dry] ${table}: ${rows.length} rows`);
    return { table, rows: rows.length, dry: true };
  }
  if (truncate) {
    await client.query(`TRUNCATE TABLE ${quoteIdent(table)} CASCADE`);
  }
  if (!rows.length) {
    console.log(`  ok ${table}: 0`);
    return { table, rows: 0 };
  }

  const colList = cols.map(quoteIdent).join(', ');
  let n = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const params = [];
    const valuesSql = chunk
      .map((row, ri) => {
        const placeholders = cols.map((_, ci) => {
          params.push(row[cols[ci]] === undefined ? null : row[cols[ci]]);
          return `$${ri * cols.length + ci + 1}`;
        });
        return `(${placeholders.join(',')})`;
      })
      .join(',');
    const sql = `INSERT INTO ${quoteIdent(table)} (${colList}) VALUES ${valuesSql} ON CONFLICT DO NOTHING`;
    await client.query(sql, params);
    n += chunk.length;
  }
  console.log(`  ok ${table}: ${n}`);
  return { table, rows: n };
}

async function countPg(client, table) {
  if (!(await pgHasTable(client, table))) return null;
  const r = await client.query(`SELECT COUNT(*)::int AS c FROM ${quoteIdent(table)}`);
  return r.rows[0].c;
}

async function main() {
  console.log(`==> SQLite → PG`);
  console.log(`    sqlite: ${sqlitePath}`);
  console.log(`    pg:     ${databaseUrl.replace(/:[^:@/]+@/, ':***@')}`);
  console.log(`    dry:    ${dryRun}`);

  const client = await pool.connect();
  try {
    await ensureSchema(client);
    const tables = listTables();
    // Parents avant enfants ; un seul TRUNCATE global (évite CASCADE qui vide les enfants déjà importés).
    const parentsFirst = [
      'users',
      'tracks_cache',
      'playlists',
      'reco_weights',
    ];
    const ordered = [
      ...parentsFirst.filter((t) => tables.includes(t)),
      ...tables.filter((t) => !parentsFirst.includes(t)),
    ];
    await client.query('SET session_replication_role = replica');
    const existing = [];
    for (const t of ordered) {
      if (await pgHasTable(client, t)) existing.push(quoteIdent(t));
    }
    if (existing.length) {
      await client.query(`TRUNCATE TABLE ${existing.join(', ')} CASCADE`);
      console.log(`  truncated ${existing.length} tables`);
    }
    for (const t of ordered) {
      await importTable(client, t, { truncate: false });
    }
    await client.query('SET session_replication_role = DEFAULT');

    console.log('\n==> Vérif counts SQLite vs PG');
    const check = [
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
    ];
    let mismatch = 0;
    for (const t of check) {
      if (!tables.includes(t)) continue;
      const sq = sqlite.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
      const pgC = await countPg(client, t);
      const ok = sq === pgC;
      if (!ok) mismatch += 1;
      console.log(`  ${ok ? '✓' : '✗'} ${t}: sqlite=${sq} pg=${pgC}`);
    }
    if (mismatch) {
      console.error(`\n❌ ${mismatch} table(s) en écart — ne pas cutover`);
      process.exit(2);
    }
    console.log('\n✅ Import OK — counts alignés');
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
