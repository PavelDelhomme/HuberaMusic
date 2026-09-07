import { create } from 'zustand';
import { api, type Track } from '../api';
import { useAuth } from './auth';
import { useLibrary } from './library';

export type PinRow = {
  id: string;
  kind: string;
  targetId: string;
  payload?: unknown;
};

const PINS_CACHE_PREFIX = 'ytm_pins_cache_v2:';
/** Ancienne clé globale (fuite inter-comptes) — à purger. */
const LEGACY_PINS_CACHE_KEY = 'ytm_pins_cache_v1';
const PINS_BOUND_USER_KEY = 'ytm_pins_bound_user_v1';

function cacheKeyFor(userId: string) {
  return `${PINS_CACHE_PREFIX}${userId}`;
}

function readBoundUserId(): string {
  try {
    return String(localStorage.getItem(PINS_BOUND_USER_KEY) || '').trim();
  } catch {
    return '';
  }
}

function writeBoundUserId(userId: string) {
  try {
    if (userId) localStorage.setItem(PINS_BOUND_USER_KEY, userId);
    else localStorage.removeItem(PINS_BOUND_USER_KEY);
  } catch {
    /* quota */
  }
}

function readPinsCache(userId: string): PinRow[] {
  if (!userId) return [];
  try {
    const raw = localStorage.getItem(cacheKeyFor(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PinRow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePinsCache(userId: string, pins: PinRow[]) {
  if (!userId) return;
  try {
    localStorage.setItem(cacheKeyFor(userId), JSON.stringify(pins.slice(0, 64)));
    writeBoundUserId(userId);
  } catch {
    /* quota */
  }
}

/** Vide tous les caches pins (legacy + v2) — à appeler au logout. */
export function clearPinsLocalCache() {
  try {
    localStorage.removeItem(LEGACY_PINS_CACHE_KEY);
    localStorage.removeItem(PINS_BOUND_USER_KEY);
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PINS_CACHE_PREFIX)) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
  usePins.setState({ pins: [], loaded: false });
}

type PinsState = {
  pins: PinRow[];
  loaded: boolean;
  boundUserId: string | null;
  /** @param userId id compte courant — obligatoire pour isoler le cache */
  refresh: (userId?: string | null) => Promise<void>;
  isPinned: (targetId: string) => boolean;
  pinIdFor: (targetId: string) => string | null;
  togglePin: (item: {
    id: string;
    type?: string;
    title?: string;
    [k: string]: unknown;
  }) => Promise<'pinned' | 'unpinned'>;
  /** Réordonne gauche → droite (premier épinglé = index 0). */
  reorderPins: (orderedTargetIds: string[]) => Promise<void>;
  clearLocal: () => void;
};

function currentUserId(): string {
  const u = useAuth.getState().user;
  if (!u || u.isGuest || u.email?.includes('@local.ytmusic')) return '';
  return String(u.id || '').trim();
}

export const usePins = create<PinsState>((set, get) => ({
  pins: [],
  loaded: false,
  boundUserId: null,
  clearLocal: () => {
    clearPinsLocalCache();
  },
  refresh: async (userIdArg) => {
    const userId = String(userIdArg || currentUserId() || '').trim();
    // Purge legacy globale dès qu’on peut (évite re-contamination)
    try {
      localStorage.removeItem(LEGACY_PINS_CACHE_KEY);
    } catch {
      /* ignore */
    }
    if (!userId) {
      set({ pins: [], loaded: true, boundUserId: null });
      return;
    }
    const bound = readBoundUserId();
    const sameUser = !bound || bound === userId;
    try {
      // Pull only — serveur = vérité multi-appareils.
      // Ne plus syncPins(cache) avant le GET : ça réécrivait les pins
      // retirés sur l’autre appareil / navigateur.
      const r = await api.pins();
      const pins = dedupePinRows((r.pins || []) as PinRow[]);
      writePinsCache(userId, pins);
      set({ pins, loaded: true, boundUserId: userId });
    } catch {
      const cached = sameUser ? dedupePinRows(readPinsCache(userId)) : [];
      set({ pins: cached, loaded: true, boundUserId: sameUser ? userId : null });
    }
  },
  isPinned: (targetId) => get().pins.some((p) => p.targetId === targetId || p.id === targetId),
  pinIdFor: (targetId) =>
    get().pins.find((p) => p.targetId === targetId || p.id === targetId)?.id || null,
  togglePin: async (item) => {
    const userId = currentUserId();
    // Unpin par targetId (pas UUID) → purge song+video du même id côté API
    if (get().isPinned(item.id)) {
      const r = await api.removePin(item.id);
      const pins = dedupePinRows((r.pins || []) as PinRow[]);
      if (userId) writePinsCache(userId, pins);
      set({ pins, loaded: true, boundUserId: userId || null });
      return 'unpinned';
    }
    const pinType =
      item.type === 'video' || item.type === 'song' || !item.type ? 'song' : item.type;
    const payload = {
      ...item,
      id: item.id,
      type: pinType,
      title: item.title || (item as { name?: string }).name || item.id,
      artists: Array.isArray(item.artists) ? item.artists : [],
      thumbnails: Array.isArray(item.thumbnails) ? item.thumbnails : [],
    };
    const r = await api.addPin({
      kind: pinType,
      targetId: item.id,
      payload,
      id: item.id,
    });
    const pins = dedupePinRows((r.pins || []) as PinRow[]);
    if (userId) writePinsCache(userId, pins);
    set({ pins, loaded: true, boundUserId: userId || null });
    // Épingler ⇒ aussi en bibliothèque (cohérent accès rapide ↔ biblio)
    try {
      if (pinType === 'album') {
        if (!useLibrary.getState().hasAlbum(item.id)) {
          const saved = await api.saveAlbum(payload as Record<string, unknown>);
          if (saved.library) useLibrary.getState().applyLibrary(saved.library);
        }
      } else if (pinType === 'song' || pinType === 'video' || !item.type) {
        if (!useLibrary.getState().isInLibrary(item.id)) {
          await useLibrary.getState().toggleLibrarySong(payload as Track);
        }
      } else if (pinType === 'artist') {
        if (!useLibrary.getState().hasArtist(item.id)) {
          const saved = await api.saveArtist(payload as Record<string, unknown>);
          if (saved.library) useLibrary.getState().applyLibrary(saved.library);
        }
      }
    } catch {
      /* pin OK même si biblio échoue */
    }
    return 'pinned';
  },
  reorderPins: async (orderedTargetIds) => {
    const userId = currentUserId();
    const ids = orderedTargetIds.map((x) => String(x || '').trim()).filter(Boolean);
    if (!ids.length) return;
    // Optimistic local order
    const byTid = new Map(
      get().pins.map((p) => [String(p.targetId || p.id || ''), p] as const),
    );
    const next: PinRow[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const row = byTid.get(id);
      if (!row || seen.has(id)) continue;
      seen.add(id);
      next.push(row);
    }
    for (const p of get().pins) {
      const tid = String(p.targetId || p.id || '');
      if (!tid || seen.has(tid)) continue;
      next.push(p);
    }
    if (userId) writePinsCache(userId, next);
    set({ pins: next, loaded: true, boundUserId: userId || null });
    try {
      const r = await api.reorderPins(ids);
      const pins = dedupePinRows((r.pins || []) as PinRow[]);
      if (userId) writePinsCache(userId, pins);
      set({ pins, loaded: true, boundUserId: userId || null });
    } catch {
      /* garde l’ordre optimistic ; refresh ultérieur */
    }
  },
}));

function dedupePinRows(pins: PinRow[]): PinRow[] {
  const seen = new Set<string>();
  return pins.filter((p) => {
    const tid = String(p.targetId || p.id || '');
    if (!tid || seen.has(tid)) return false;
    seen.add(tid);
    return true;
  });
}
