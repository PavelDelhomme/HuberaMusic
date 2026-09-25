/**
 * Débuts de liste « Tout lire » (A–Z, récents, aimés, file affichée).
 * L’aléatoire a déjà shuffle-heads. Ici on garde 10–20 préfixes .m4a (256 Ko+)
 * sur le VPS, mis à jour régulièrement par compte.
 */
import { db } from './db.js';
import { enqueueListHeadWarm } from '../media/stream.js';

const HEAD_N = Math.max(10, Math.min(24, Number(process.env.LIST_HEAD_N || 20) || 20));
const TTL_MS = 12 * 60_000;

type CacheEntry = { ids: string[]; at: number };
const mem = new Map<string, CacheEntry>();

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

function titleOf(payload: string | null): string {
  if (!payload) return '';
  try {
    const j = JSON.parse(payload) as { title?: string };
    return String(j.title || '');
  } catch {
    return '';
  }
}

function recentLibraryIds(userId: string, n: number): string[] {
  try {
    const rows = db
      .prepare(
        `SELECT track_id FROM library_tracks
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(userId, n) as { track_id: string }[];
    return rows.map((r) => r.track_id).filter(validId);
  } catch {
    return [];
  }
}

function likedIds(userId: string, n: number): string[] {
  try {
    const rows = db
      .prepare(
        `SELECT track_id FROM liked_tracks
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(userId, n) as { track_id: string }[];
    return rows.map((r) => r.track_id).filter(validId);
  } catch {
    return [];
  }
}

function azLibraryIds(userId: string, n: number): string[] {
  try {
    const rows = db
      .prepare(
        `SELECT l.track_id AS id, t.payload AS payload
         FROM library_tracks l
         LEFT JOIN tracks_cache t ON t.id = l.track_id
         WHERE l.user_id = ?`,
      )
      .all(userId) as { id: string; payload: string | null }[];
    return rows
      .filter((r) => validId(r.id))
      .sort((a, b) => titleOf(a.payload).localeCompare(titleOf(b.payload), 'fr', { sensitivity: 'base', numeric: true }))
      .slice(0, n)
      .map((r) => r.id);
  } catch {
    return [];
  }
}

export type ListHeadsResult = {
  ids: string[];
  scope: string;
  headN: number;
};

function cached(key: string, compute: () => string[]): string[] {
  const now = Date.now();
  const hit = mem.get(key);
  if (hit && now - hit.at < TTL_MS && hit.ids.length) return hit.ids;
  const ids = compute();
  mem.set(key, { ids, at: now });
  if (mem.size > 800) {
    const oldest = [...mem.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) mem.delete(oldest[0]);
  }
  return ids;
}

export function getListHeads(
  userId: string,
  scope: 'az' | 'recent' | 'liked' = 'az',
  opts?: { warm?: boolean },
): ListHeadsResult {
  const key = `${userId}:${scope}`;
  const ids =
    scope === 'recent'
      ? cached(key, () => recentLibraryIds(userId, HEAD_N))
      : scope === 'liked'
        ? cached(key, () => likedIds(userId, HEAD_N))
        : cached(key, () => azLibraryIds(userId, HEAD_N));
  if (opts?.warm !== false) enqueueListHeadWarm(ids);
  return { ids, scope, headN: HEAD_N };
}

/** File affichée (album / artiste / playlist / Tout lire). */
export function rememberVisibleListHeads(userId: string, ids: string[]): ListHeadsResult {
  const clean = [...new Set(ids.filter(validId))].slice(0, HEAD_N);
  mem.set(`${userId}:visible`, { ids: clean, at: Date.now() });
  enqueueListHeadWarm(clean, { front: true });
  return { ids: clean, scope: 'visible', headN: HEAD_N };
}

/** Au GET biblio : A–Z (Tout lire Titres) + récents (Tout lire Ajouts). */
export function warmUserListHeads(userId: string): void {
  setTimeout(() => {
    try {
      getListHeads(userId, 'az', { warm: true });
      getListHeads(userId, 'recent', { warm: true });
      getListHeads(userId, 'liked', { warm: true });
    } catch {
      /* ignore */
    }
  }, 0);
}
