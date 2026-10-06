/**
 * Débuts de liste « Tout lire » (A–Z, récents, aimés, file affichée).
 * L’aléatoire a déjà shuffle-heads. Ici on garde 10–20 préfixes .m4a (256 Ko+)
 * sur le VPS, mis à jour régulièrement par compte.
 */
import { db } from './db.js';
import { listPins } from './prefs.js';
import { enqueueListHeadWarm } from '../media/stream.js';

const HEAD_N = Math.max(10, Math.min(24, Number(process.env.LIST_HEAD_N || 20) || 20));
const TTL_MS = 12 * 60_000;
const PLAYED_48H_MS = 48 * 60 * 60 * 1000;

type CacheEntry = { ids: string[]; at: number };
const mem = new Map<string, CacheEntry>();

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

/** Titres chanson de l’Accès rapide (pins song + ids dans le payload mix). */
export function pinSongIds(userId: string, n = 48): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    const id = String(raw || '');
    if (!validId(id) || seen.has(id) || out.length >= n) return;
    seen.add(id);
    out.push(id);
  };
  try {
    for (const p of listPins(userId)) {
      const kind = String(p.kind || 'song');
      push(p.targetId);
      const payload = (p.payload && typeof p.payload === 'object' ? p.payload : {}) as Record<
        string,
        unknown
      >;
      push(payload.id);
      push(payload.videoId);
      if (kind === 'song' || kind === 'video' || kind === 'track') continue;
      const nested = [payload.items, payload.tracks, payload.songs, payload.videos];
      for (const arr of nested) {
        if (!Array.isArray(arr)) continue;
        for (const it of arr.slice(0, 8)) {
          if (it && typeof it === 'object') {
            const row = it as Record<string, unknown>;
            push(row.id);
            push(row.videoId);
          } else {
            push(it);
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** Accès rapide + déjà écoutés : préfixe ~3 s seulement. Le fichier entier noie yt-dlp et tue les titres froids. */
export function warmUserPinnedAndHeard(userId: string): void {
  const front = [
    ...new Set([
      ...pinSongIds(userId, 48),
      ...played48hIds(userId, 48),
      ...recentLibraryIds(userId, 24),
      ...likedIds(userId, 24),
    ]),
  ];
  if (!front.length) return;
  enqueueListHeadWarm(front, { front: true });
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

/** Titres déjà écoutés (téléphone / autre) dans les 48 dernières heures. */
function played48hIds(userId: string, n: number): string[] {
  const since = Date.now() - PLAYED_48H_MS;
  try {
    const rows = db
      .prepare(
        `SELECT track_id FROM history
         WHERE user_id = ? AND played_at > ?
         ORDER BY played_at DESC
         LIMIT ?`,
      )
      .all(userId, since, n) as { track_id: string }[];
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

/** Au GET biblio : A–Z + récents + aimés + écoutés 48 h + Accès rapide sur disque. */
export function warmUserListHeads(userId: string): void {
  setTimeout(() => {
    try {
      getListHeads(userId, 'az', { warm: true });
      getListHeads(userId, 'recent', { warm: true });
      getListHeads(userId, 'liked', { warm: true });
      warmUserPinnedAndHeard(userId);
    } catch {
      /* ignore */
    }
  }, 0);
}
