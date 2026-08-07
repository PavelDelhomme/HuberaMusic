import { create } from 'zustand';
import { api } from '../api';

export type PinRow = {
  id: string;
  kind: string;
  targetId: string;
  payload?: unknown;
};

const PINS_CACHE_KEY = 'ytm_pins_cache_v1';

function readPinsCache(): PinRow[] {
  try {
    const raw = localStorage.getItem(PINS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PinRow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writePinsCache(pins: PinRow[]) {
  try {
    localStorage.setItem(PINS_CACHE_KEY, JSON.stringify(pins.slice(0, 64)));
  } catch {
    /* quota */
  }
}

type PinsState = {
  pins: PinRow[];
  loaded: boolean;
  refresh: () => Promise<void>;
  isPinned: (targetId: string) => boolean;
  pinIdFor: (targetId: string) => string | null;
  togglePin: (item: {
    id: string;
    type?: string;
    title?: string;
    [k: string]: unknown;
  }) => Promise<'pinned' | 'unpinned'>;
};

function pinSyncPayload(p: PinRow) {
  const payload =
    p.payload && typeof p.payload === 'object'
      ? (p.payload as Record<string, unknown>)
      : {};
  return {
    kind: p.kind || String(payload.type || 'song'),
    targetId: p.targetId || String(payload.id || p.id || ''),
    id: p.targetId || String(payload.id || p.id || ''),
    payload: {
      ...payload,
      id: String(payload.id || p.targetId || p.id || ''),
      type: String(payload.type || p.kind || 'song'),
      title: String(payload.title || payload.name || p.targetId || ''),
    },
  };
}

export const usePins = create<PinsState>((set, get) => ({
  pins: [],
  loaded: false,
  refresh: async () => {
    try {
      // Pousse le cache local (même origine) puis tire l’union serveur.
      const cached = readPinsCache();
      if (cached.length) {
        await api.syncPins(cached.map(pinSyncPayload)).catch(() => null);
      }
      const r = await api.pins();
      const pins = dedupePinRows((r.pins || []) as PinRow[]);
      writePinsCache(pins);
      set({ pins, loaded: true });
    } catch {
      const cached = dedupePinRows(readPinsCache());
      set({ pins: cached, loaded: true });
    }
  },
  isPinned: (targetId) => get().pins.some((p) => p.targetId === targetId || p.id === targetId),
  pinIdFor: (targetId) =>
    get().pins.find((p) => p.targetId === targetId || p.id === targetId)?.id || null,
  togglePin: async (item) => {
    // Unpin par targetId (pas UUID) → purge song+video du même id côté API
    if (get().isPinned(item.id)) {
      const r = await api.removePin(item.id);
      const pins = dedupePinRows((r.pins || []) as PinRow[]);
      writePinsCache(pins);
      set({ pins, loaded: true });
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
    writePinsCache(pins);
    set({ pins, loaded: true });
    return 'pinned';
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
