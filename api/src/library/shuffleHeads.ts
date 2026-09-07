/**
 * Têtes « Aléatoire biblio » par compte — faux-aléatoire rotatif.
 *
 * Créneaux ~30 min → ~48 rotations / jour (évite de figer les mêmes ~100 titres).
 * Le serveur warm ces ids (proxy/disk) ; le client Android ne tire que ce batch.
 */
import { db } from './db.js';
import { getHistory } from './library.js';
import { cachePath, enqueueStreamWarm, enqueueDiskWarm } from '../media/stream.js';
import { existsSync, statSync } from 'node:fs';

const SLOT_MS = Math.max(
  10 * 60_000,
  Math.min(60 * 60_000, Number(process.env.SHUFFLE_HEAD_SLOT_MS || 30 * 60_000) || 30 * 60_000),
);
const HEAD_N = Math.max(40, Math.min(160, Number(process.env.SHUFFLE_HEAD_N || 100) || 100));
const RECENT_EXCLUDE = 400;

type CacheEntry = { ids: string[]; slot: number; expiresAt: number; at: number };
const mem = new Map<string, CacheEntry>();

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

function slotIndex(now = Date.now()): number {
  return Math.floor(now / SLOT_MS);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(userId: string, slot: number): number {
  let h = 2166136261;
  const s = `${userId}:${slot}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function libraryTrackIds(userId: string, limit = 20_000): string[] {
  try {
    const rows = db
      .prepare(
        `SELECT track_id FROM library_tracks
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(userId, limit) as { track_id: string }[];
    return rows.map((r) => r.track_id).filter(validId);
  } catch {
    return [];
  }
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = arr.slice();
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

function needsDisk(id: string): boolean {
  try {
    const p = cachePath(id);
    if (!existsSync(p)) return true;
    return statSync(p).size < 1024 * 1024;
  } catch {
    return true;
  }
}

export type ShuffleHeadsResult = {
  ids: string[];
  slot: number;
  expiresAt: number;
  slotMs: number;
  headN: number;
  poolSize: number;
};

/**
 * ~HEAD_N ids pour démarrer un aléatoire « prêt » (warm serveur).
 * Exclut les titres trop récents pour varier.
 */
export function getShuffleHeads(userId: string, opts?: { warm?: boolean }): ShuffleHeadsResult {
  const now = Date.now();
  const slot = slotIndex(now);
  const cached = mem.get(userId);
  if (cached && cached.slot === slot && cached.ids.length) {
    if (opts?.warm !== false) scheduleWarmHeads(userId, cached.ids);
    return {
      ids: cached.ids,
      slot: cached.slot,
      expiresAt: cached.expiresAt,
      slotMs: SLOT_MS,
      headN: HEAD_N,
      poolSize: cached.ids.length,
    };
  }

  const all = libraryTrackIds(userId);
  const recent = new Set(
    getHistory(userId, RECENT_EXCLUDE)
      .map((t) => t.id)
      .filter(validId),
  );
  let pool = all.filter((id) => !recent.has(id));
  if (pool.length < Math.min(HEAD_N, Math.floor(all.length / 4))) {
    pool = all;
  }
  const seed = hashSeed(userId, slot);
  const ids = seededShuffle(pool, seed).slice(0, HEAD_N);
  const expiresAt = (slot + 1) * SLOT_MS;
  mem.set(userId, { ids, slot, expiresAt, at: now });
  // Cap mémoire : ~200 users
  if (mem.size > 220) {
    const oldest = [...mem.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) mem.delete(oldest[0]);
  }
  if (opts?.warm !== false) scheduleWarmHeads(userId, ids);
  return {
    ids,
    slot,
    expiresAt,
    slotMs: SLOT_MS,
    headN: HEAD_N,
    poolSize: all.length,
  };
}

function scheduleWarmHeads(userId: string, ids: string[]): void {
  if (!ids.length) return;
  setTimeout(() => {
    try {
      // Priorité : premiers de la file aléatoire
      enqueueStreamWarm(ids.slice(0, 48), userId);
      const disk = ids.filter(needsDisk).slice(0, 16);
      if (disk.length) enqueueDiskWarm(disk);
    } catch {
      /* ignore */
    }
  }, 0);
}

/** Invalide le cache mémoire (tests / après grosse sync biblio). */
export function invalidateShuffleHeads(userId: string): void {
  mem.delete(userId);
}
