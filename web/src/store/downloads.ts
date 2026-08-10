import { create } from 'zustand';
import type { Track } from '../api';
import { downloadAndCache, listCachedIds } from '../lib/offlineCache';

type DownloadsState = {
  /** 0–1 pendant un DL ; absent = idle */
  progress: Record<string, number>;
  done: Record<string, true>;
  errors: Record<string, string>;
  refreshDone: () => Promise<void>;
  start: (track: Track) => Promise<void>;
  progressOf: (id: string) => number | null;
};

export const useDownloads = create<DownloadsState>((set, get) => ({
  progress: {},
  done: {},
  errors: {},

  refreshDone: async () => {
    try {
      const ids = await listCachedIds();
      const done: Record<string, true> = {};
      for (const id of ids) done[id] = true;
      set({ done });
    } catch {
      /* ignore */
    }
  },

  progressOf: (id) => {
    const p = get().progress[id];
    return typeof p === 'number' ? p : null;
  },

  start: async (track) => {
    const id = track.id;
    if (!id || get().progress[id] != null) return;
    if (get().done[id]) return;
    set((s) => {
      const errors = { ...s.errors };
      delete errors[id];
      return { progress: { ...s.progress, [id]: 0.02 }, errors };
    });
    try {
      await downloadAndCache(track, (p) => {
        set((s) => ({ progress: { ...s.progress, [id]: Math.max(0.02, Math.min(0.99, p)) } }));
      });
      set((s) => {
        const progress = { ...s.progress };
        delete progress[id];
        return { progress, done: { ...s.done, [id]: true } };
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e || 'Échec téléchargement');
      set((s) => {
        const progress = { ...s.progress };
        delete progress[id];
        return { progress, errors: { ...s.errors, [id]: msg } };
      });
      throw e;
    }
  },
}));
