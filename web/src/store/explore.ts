import { create } from 'zustand';
import { api, type Shelf, type Track } from '../api';

const EXPLORE_CACHE_KEY = 'ytm_explore_v1';
const STALE_MS = 45 * 60_1000;

export type RadioCat = { id: string; title: string };
export type RadioShelf = Shelf & { id: string };

type ExploreCache = {
  ytShelves: Shelf[];
  radios: RadioCat[];
  radioShelves: RadioShelf[];
  radioPreviews: Record<string, Track[]>;
  at: number;
};

function readCache(): ExploreCache | null {
  try {
    const raw = sessionStorage.getItem(EXPLORE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ExploreCache;
    if (!parsed?.at) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(payload: Omit<ExploreCache, 'at'>) {
  try {
    sessionStorage.setItem(
      EXPLORE_CACHE_KEY,
      JSON.stringify({ ...payload, at: Date.now() } satisfies ExploreCache),
    );
  } catch {
    /* quota */
  }
}

type ExploreState = {
  ytShelves: Shelf[];
  radios: RadioCat[];
  radioShelves: RadioShelf[];
  radioPreviews: Record<string, Track[]>;
  pendingRadios: string[];
  loading: boolean;
  loadingRadios: boolean;
  refreshing: boolean;
  error: string;
  fetchedAt: number | null;
  ensureLoaded: (opts?: { force?: boolean }) => Promise<void>;
  refresh: () => Promise<void>;
};

let loadGen = 0;

export const useExplore = create<ExploreState>((set, get) => ({
  ytShelves: [],
  radios: [],
  radioShelves: [],
  radioPreviews: {},
  pendingRadios: [],
  loading: false,
  loadingRadios: false,
  refreshing: false,
  error: '',
  fetchedAt: null,

  refresh: async () => {
    await get().ensureLoaded({ force: true });
  },

  ensureLoaded: async (opts) => {
    const force = Boolean(opts?.force);
    const cached = readCache();
    const now = Date.now();
    const hasMem =
      get().fetchedAt != null &&
      (get().ytShelves.length > 0 || get().radios.length > 0 || get().radioShelves.length > 0);
    const hasCache = Boolean(cached && (cached.ytShelves?.length || cached.radios?.length));
    const freshMem =
      get().fetchedAt != null && now - (get().fetchedAt || 0) < STALE_MS && hasMem;
    const freshCache = cached && now - cached.at < STALE_MS;

    if (!force && freshMem) return;

    // Affiche le cache immédiatement (pas de skeleton plein écran)
    if (!force && !hasMem && hasCache && cached) {
      set({
        ytShelves: cached.ytShelves || [],
        radios: cached.radios || [],
        radioShelves: cached.radioShelves || [],
        radioPreviews: cached.radioPreviews || {},
        fetchedAt: cached.at,
        loading: false,
        error: '',
      });
      if (freshCache) return;
      // stale → refetch derrière
    }

    const my = ++loadGen;
    const showBlocking = !get().ytShelves.length && !get().radios.length && !get().radioShelves.length;
    set({
      loading: showBlocking,
      refreshing: force || !showBlocking,
      error: '',
      ...(force
        ? { radioShelves: [], pendingRadios: [], radioPreviews: {} }
        : {}),
    });

    try {
      const r = await api.explore();
      if (my !== loadGen) return;
      const cats = r.radios?.length
        ? r.radios
        : (await api.recoRadios().catch(() => ({ radios: [] as RadioCat[] }))).radios || [];

      // Radios déjà préchargées côté API → affiche immédiatement
      const seededShelves: RadioShelf[] = [];
      const seededPreviews: Record<string, Track[]> = {};
      for (const cat of cats) {
        const items = (cat as RadioCat & { items?: Track[] }).items;
        if (items?.length) {
          seededShelves.push({ id: cat.id, title: `Radio · ${cat.title}`, items: items.slice(0, 12) });
          seededPreviews[cat.id] = items.slice(0, 4);
        }
      }

      set({
        ytShelves: r.shelves || [],
        radios: cats,
        radioShelves: seededShelves.length ? seededShelves : get().radioShelves,
        radioPreviews: Object.keys(seededPreviews).length ? seededPreviews : get().radioPreviews,
        loading: false,
        fetchedAt: Date.now(),
      });

      if (!cats.length) {
        set({ loadingRadios: false, refreshing: false, pendingRadios: [] });
        writeCache({
          ytShelves: r.shelves || [],
          radios: cats,
          radioShelves: get().radioShelves,
          radioPreviews: get().radioPreviews,
        });
        return;
      }

      // Complète les radios sans preview (reste + refresh)
      const needFetch = cats.filter((c) => !seededPreviews[c.id]?.length);
      set({ loadingRadios: needFetch.length > 0, pendingRadios: needFetch.map((c) => c.id) });
      const nextShelves: RadioShelf[] = force
        ? [...seededShelves]
        : [...seededShelves, ...get().radioShelves.filter((s) => !seededShelves.some((x) => x.id === s.id))];
      const nextPreviews: Record<string, Track[]> = force
        ? { ...seededPreviews }
        : { ...get().radioPreviews, ...seededPreviews };

      for (const cat of needFetch) {
        if (my !== loadGen) return;
        try {
          const mix = await api.recoRadio(cat.id, { preview: true });
          if (my !== loadGen) return;
          const items = (mix.tracks || []).slice(0, 12);
          if (items.length) {
            if (!nextShelves.some((s) => s.id === cat.id)) {
              nextShelves.push({ id: cat.id, title: `Radio · ${cat.title}`, items });
            } else {
              const i = nextShelves.findIndex((s) => s.id === cat.id);
              if (i >= 0) nextShelves[i] = { id: cat.id, title: `Radio · ${cat.title}`, items };
            }
            nextPreviews[cat.id] = items.slice(0, 4);
            set({
              radioShelves: [...nextShelves],
              radioPreviews: { ...nextPreviews },
            });
          }
        } catch {
          /* continue */
        } finally {
          if (my === loadGen) {
            set((s) => ({ pendingRadios: s.pendingRadios.filter((id) => id !== cat.id) }));
          }
        }
      }

      if (my !== loadGen) return;
      set({ loadingRadios: false, refreshing: false, fetchedAt: Date.now() });
      writeCache({
        ytShelves: get().ytShelves,
        radios: get().radios,
        radioShelves: get().radioShelves,
        radioPreviews: get().radioPreviews,
      });
    } catch (e) {
      if (my !== loadGen) return;
      set({
        error: String((e as Error).message || e),
        loading: false,
        loadingRadios: false,
        refreshing: false,
      });
    }
  },
}));
