import { db } from './db.js';

/**
 * Cache partagé entre tous les comptes : home YouTube + mosaïques radio.
 * Un utilisateur qui a déjà chargé une carte la met à disposition des autres.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS global_card_cache (
    cache_key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    generated_at INTEGER NOT NULL
  );
`);

export function getGlobalCard<T>(key: string, maxAgeMs: number): T | null {
  const row = db
    .prepare(`SELECT payload_json, generated_at FROM global_card_cache WHERE cache_key = ?`)
    .get(key) as { payload_json: string; generated_at: number } | undefined;
  if (!row) return null;
  if (Date.now() - Number(row.generated_at) > maxAgeMs) return null;
  try {
    return JSON.parse(row.payload_json) as T;
  } catch {
    return null;
  }
}

export function setGlobalCard(key: string, payload: unknown): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO global_card_cache (cache_key, payload_json, generated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       generated_at = excluded.generated_at`,
  ).run(key, JSON.stringify(payload), now);
}
