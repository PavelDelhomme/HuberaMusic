/**
 * Couche PostgreSQL sync (compatible better-sqlite3) via make-synchronous.
 * Activée si DATABASE_URL est défini — sinon db.ts garde SQLite.
 *
 * Note: le callback make-synchronous tourne dans un worker — pas de closures ;
 * tout passe par arguments + globalThis dans le worker.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import makeSynchronous from 'make-synchronous';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

export function databaseUrl(): string | undefined {
  const u = (process.env.DATABASE_URL || '').trim();
  return u || undefined;
}

export function usingPostgres(): boolean {
  return Boolean(databaseUrl());
}

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number | null };

/** Query sync isolée (worker) — pool caché via globalThis. */
const querySync = makeSynchronous(
  async (connectionString: string, text: string, params: unknown[] = []): Promise<QueryResult> => {
    const pg = (await import('pg')).default;
    const g = globalThis as typeof globalThis & { __ytmPgPool?: import('pg').Pool };
    if (!g.__ytmPgPool) {
      g.__ytmPgPool = new pg.Pool({
        connectionString,
        max: 8,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
      });
    }
    const res = await g.__ytmPgPool.query(text, params);
    return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount };
  },
);

function requireUrl(): string {
  const u = databaseUrl();
  if (!u) throw new Error('DATABASE_URL manquant');
  return u;
}

/** Convertit placeholders SQLite `?` → `$1..$n`. */
export function adaptSql(sql: string): string {
  let s = sql;
  s = s.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT INTO');
  s = s.replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, 'INSERT INTO');
  let i = 0;
  s = s.replace(/\?/g, () => `$${++i}`);
  return s;
}

function isPragma(sql: string): boolean {
  return /^\s*PRAGMA\b/i.test(sql);
}

class PgStatement {
  constructor(private readonly text: string) {}

  get(...params: unknown[]): Record<string, unknown> | undefined {
    if (isPragma(this.text)) return undefined;
    const { rows } = querySync(requireUrl(), adaptSql(this.text), params);
    return rows[0];
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    if (isPragma(this.text)) {
      const m = /PRAGMA\s+table_info\((\w+)\)/i.exec(this.text);
      if (m) {
        const { rows } = querySync(
          requireUrl(),
          `SELECT column_name AS name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1`,
          [m[1]],
        );
        return rows;
      }
      return [];
    }
    const { rows } = querySync(requireUrl(), adaptSql(this.text), params);
    return rows;
  }

  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    if (isPragma(this.text)) return { changes: 0, lastInsertRowid: 0 };
    let sql = adaptSql(this.text);
    if (/\bINSERT\s+INTO\b/i.test(this.text) && /\bOR\s+IGNORE\b/i.test(this.text) && !/ON CONFLICT/i.test(sql)) {
      sql = `${sql.replace(/;?\s*$/, '')} ON CONFLICT DO NOTHING`;
    }
    const { rowCount } = querySync(requireUrl(), sql, params);
    return { changes: rowCount ?? 0, lastInsertRowid: 0 };
  }
}

export class PgDatabase {
  prepare(sql: string): PgStatement {
    return new PgStatement(sql);
  }

  exec(sql: string): void {
    if (isPragma(sql)) return;
    const parts = sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    const url = requireUrl();
    for (const part of parts) {
      if (isPragma(part)) continue;
      querySync(url, adaptSql(part), []);
    }
  }

  pragma(_src: string): void {
    /* no-op */
  }

  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    const url = requireUrl();
    const wrapped = ((...args: never[]) => {
      querySync(url, 'BEGIN', []);
      try {
        const result = fn(...args);
        querySync(url, 'COMMIT', []);
        return result;
      } catch (err) {
        try {
          querySync(url, 'ROLLBACK', []);
        } catch {
          /* ignore */
        }
        throw err;
      }
    }) as T;
    return wrapped;
  }

  close(): void {
    /* pool vit dans le worker — process exit le nettoie */
  }
}

/** Applique api/migrations/*.sql dans l’ordre. */
export function applyPgMigrations(db: PgDatabase): void {
  const init = join(MIGRATIONS_DIR, '001_init.sql');
  if (!existsSync(init)) {
    console.warn('[pg] migrations/001_init.sql introuvable');
    return;
  }
  const raw = readFileSync(init, 'utf8');
  // Retire commentaires ligne (évite split sur `;` dans les commentaires)
  const sql = raw
    .split('\n')
    .map((line) => {
      const i = line.indexOf('--');
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join('\n');
  db.exec(sql);
  querySync(
    requireUrl(),
    `INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)
     ON CONFLICT (version) DO NOTHING`,
    ['001_init', Date.now()],
  );
  console.info('[pg] migrations appliquées (001_init)');
}

export async function pingPostgres(): Promise<boolean> {
  const url = databaseUrl();
  if (!url) return false;
  const r = querySync(url, 'SELECT 1 AS ok', []);
  return r.rows[0]?.ok === 1;
}
