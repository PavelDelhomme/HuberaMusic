import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Shelf, type Track } from '../../api';
import { ShelfRow } from '../../components/media/MediaCard';
import { MixCollageCard } from '../../components/media/MixCollageCard';
import { HomeShelfSkeleton } from '../../components/media/HomeShelfSkeleton';
import { usePlayer } from '../../store/player';
import { usePins } from '../../store/pins';
import { useLibrary } from '../../store/library';
import { useItemActions } from '../../store/itemActions';
import { Pin, Play, Radio } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { warmFormats } from '../../lib/audio/streamPrefetch';
import { perfStart } from '../../lib/util/perf';
import { getCachedMix, mixCacheKey, setCachedMix } from '../../lib/util/mixCache';

const HOME_CACHE_KEY = 'ytm_home_v1';

type HomeCache = {
  shelves: Shelf[];
  radios: { id: string; title: string }[];
  /** Previews 4 titres pour mosaïque Mixés pour toi (évite lettres vides au boot). */
  radioPreviews?: Record<string, Track[]>;
  seeds: string[];
  hasMore: boolean;
  at: number;
};

function readHomeCache(): HomeCache | null {
  try {
    const raw = sessionStorage.getItem(HOME_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HomeCache;
    if (!parsed?.shelves?.length) return null;
    // Stale après 45 min → encore affiché, refetch derrière
    return parsed;
  } catch {
    return null;
  }
}

function writeHomeCache(payload: Omit<HomeCache, 'at'>) {
  try {
    sessionStorage.setItem(
      HOME_CACHE_KEY,
      JSON.stringify({ ...payload, at: Date.now() } satisfies HomeCache),
    );
  } catch {
    /* quota */
  }
}

export function HomePage() {
  const navigate = useNavigate();
  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [seeds, setSeeds] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [radios, setRadios] = useState<{ id: string; title: string }[]>([]);
  const [radioPreviews, setRadioPreviews] = useState<Record<string, Track[]>>({});
  const [startingRadio, setStartingRadio] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const playQueue = usePlayer((s) => s.playQueue);
  const isPlaying = usePlayer((s) => s.isPlaying);
  const currentId = usePlayer((s) => s.current?.id);
  const pinCount = usePins((s) => s.pins.length);
  const pinRows = usePins((s) => s.pins);
  const refreshPins = usePins((s) => s.refresh);
  const hasMix = useLibrary((s) => s.hasMix);
  const saveMix = useLibrary((s) => s.saveMix);
  const openActions = useItemActions((s) => s.open);
  const seenTitles = useRef(new Set<string>());

  const mergeShelves = useCallback((incoming: Shelf[]) => {
    setShelves((prev) => {
      const next = [...prev];
      for (const s of incoming) {
        let title = s.title;
        let n = 2;
        while (seenTitles.current.has(title)) {
          title = `${s.title} · ${n++}`;
        }
        seenTitles.current.add(title);
        next.push({ ...s, title });
      }
      return next;
    });
  }, []);

  const [homeReload, setHomeReload] = useState(0);
  const cacheBoot = useRef(false);

  useEffect(() => {
    void refreshPins();
  }, [refreshPins]);

  // Cache-first : affiche immédiatement le dernier home, puis rafraîchit
  useEffect(() => {
    if (cacheBoot.current) return;
    cacheBoot.current = true;
    const cached = readHomeCache();
    if (!cached) return;
    for (const s of cached.shelves) seenTitles.current.add(s.title);
    setShelves(cached.shelves);
    setRadios(cached.radios || []);
    if (cached.radioPreviews && Object.keys(cached.radioPreviews).length) {
      setRadioPreviews(cached.radioPreviews);
    }
    setSeeds(cached.seeds || []);
    setHasMore(cached.hasMore !== false);
    setLoading(false);
  }, []);

  useEffect(() => {
    const hadCache = shelves.length > 0;
    if (!hadCache) setLoading(true);
    setError('');
    if (!hadCache) {
      seenTitles.current = new Set();
      setRadioPreviews({});
    }
    api
      .home()
      .then(async (r) => {
        seenTitles.current = new Set();
        for (const s of r.shelves) seenTitles.current.add(s.title);
        setShelves(r.shelves);
        setSeeds(r.seeds || []);
        setHasMore(r.hasMore !== false);
        const cats = r.radios || [];
        setRadios(cats);
        setPage(0);
        setLoading(false);
        // Previews mix : d’abord les 2 premiers (visibles), puis le reste
        const loadPreview = async (cat: { id: string }) => {
          try {
            const mix = await api.recoRadio(cat.id, { preview: true });
            const tracks = (mix.tracks || []).slice(0, 4);
            if (tracks.length) {
              setRadioPreviews((prev) => {
                const next = { ...prev, [cat.id]: tracks };
                writeHomeCache({
                  shelves: r.shelves,
                  radios: cats,
                  radioPreviews: next,
                  seeds: r.seeds || [],
                  hasMore: r.hasMore !== false,
                });
                return next;
              });
            }
          } catch {
            /* ignore */
          }
        };
        // Préserver les previews déjà en cache / state pendant le refetch
        // (évite d’effacer la mosaïque si un 2ᵉ home() arrive avant la fin des reco).
        const keptPreviews = {
          ...(readHomeCache()?.radioPreviews || {}),
          ...radioPreviews,
        };
        writeHomeCache({
          shelves: r.shelves,
          radios: cats,
          ...(Object.keys(keptPreviews).length ? { radioPreviews: keptPreviews } : {}),
          seeds: r.seeds || [],
          hasMore: r.hasMore !== false,
        });
        for (const cat of cats.slice(0, 2)) {
          await loadPreview(cat);
        }
        await Promise.all(cats.slice(2, 8).map((cat) => loadPreview(cat)));
      })
      .catch((e) => {
        if (!shelves.length) setError(String(e.message || e));
        setLoading(false);
      });
    // shelves.length volontairement hors deps : boot cache une fois
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinCount, homeReload]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const nextPage = page + 1;
    try {
      const r = await api.homeMore(nextPage, seeds);
      mergeShelves(r.shelves || []);
      setPage(nextPage);
      setHasMore(Boolean(r.hasMore));
    } catch (e) {
      console.error(e);
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, page, seeds, mergeShelves]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  const quick = shelves.find((s) => /rapide|pour toi|plus écoutés/i.test(s.title));
  const quickTracks = (quick?.items || []).filter((t) => /^[a-zA-Z0-9_-]{11}$/.test(t.id));

  const startRadio = async (id: string) => {
    setStartingRadio(id);
    const end = perfStart('home.mix.play');
    const cKey = mixCacheKey('cat', id);
    try {
      const preview = (radioPreviews[id] || []).filter((t) =>
        /^[a-zA-Z0-9_-]{11}$/.test(t.id),
      );
      // Toujours repartir de zéro (remplace la file en cours), pas d’append soft
      if (preview.length) {
        void playQueue(preview, 0, { sourceId: id, sourceKind: 'mix' });
        void warmFormats(preview.slice(0, 2).map((t) => t.id));
      }
      const cached = getCachedMix(cKey);
      if (cached?.length) {
        void playQueue(cached, 0, { sourceId: id, sourceKind: 'mix' });
        void warmFormats(cached.slice(0, 3).map((t) => t.id));
        // Rafraîchit le cache en arrière-plan
        void api.recoRadio(id).then((r) => {
          if (r.tracks?.length) {
            setCachedMix(cKey, r.tracks, { generatedAt: r.generatedAt, target: r.target });
          }
        });
        return;
      }
      const r = await api.recoRadio(id);
      if (r.tracks?.length) {
        setCachedMix(cKey, r.tracks, { generatedAt: r.generatedAt, target: r.target });
        void playQueue(r.tracks, 0, { sourceId: id, sourceKind: 'mix' });
        void warmFormats(r.tracks.slice(0, 3).map((t) => t.id));
      }
    } catch (e) {
      console.error(e);
    } finally {
      setStartingRadio(null);
      end(id);
    }
  };

  const saveRadioMix = async (id: string, title: string) => {
    try {
      const covers = radioPreviews[id] || [];
      await saveMix({ id, title, covers, tracks: covers });
    } catch (e) {
      console.error(e);
    }
  };

  const openMixMenu = (id: string, title: string) => {
    const covers = radioPreviews[id] || [];
    openActions({
      id,
      title,
      type: 'mix',
      artists: [{ name: 'Mix radio' }],
      thumbnails: covers.flatMap((t) => t.thumbnails || []).slice(0, 4),
      covers,
      tracks: covers,
    } as Track);
  };

  const quickAccessItems: Track[] = pinRows
    .map((p) => {
      const payload =
        p.payload && typeof p.payload === 'object'
          ? (p.payload as Record<string, unknown>)
          : {};
      const id = String(payload.id || p.targetId || p.id || '');
      if (!id) return null;
      return {
        id,
        title: String(payload.title || payload.name || id),
        type: String(payload.type || p.kind || 'song'),
        artists: Array.isArray(payload.artists) ? (payload.artists as Track['artists']) : [],
        thumbnails: Array.isArray(payload.thumbnails)
          ? (payload.thumbnails as Track['thumbnails'])
          : [],
        album: payload.album as Track['album'],
      } as Track;
    })
    .filter(Boolean) as Track[];

  const orderedShelves = shelves
    .filter((s) => !/^épinglé$/i.test(s.title))
    .slice()
    .sort((a, b) => {
      const score = (t: string) =>
        /écouté récemment|recently played/i.test(t) ? 0 : /accès rapide|quick/i.test(t) ? 1 : 2;
      return score(a.title) - score(b.title);
    });

  return (
    <div className="animate-fade-up">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Accueil</h1>
          <p className="mt-1 text-sm text-yt-muted">
            Épingles, écoutes et recommandations hybrides — pour toi.
          </p>
        </div>
        {quickTracks.length > 0 && (
          <button
            type="button"
            onClick={() => {
              // Mélange préférentiel : départ aléatoire dans le pool « pour toi »
              const pool = [...quickTracks];
              for (let i = pool.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [pool[i], pool[j]] = [pool[j], pool[i]];
              }
              void playQueue(pool as Track[], 0);
            }}
            className="inline-flex items-center gap-2 rounded-full bg-yt-red px-5 py-2.5 text-sm font-medium"
          >
            <Play className="h-4 w-4 fill-white" /> Lecture rapide
          </button>
        )}
      </div>

      {quickAccessItems.length > 0 && (
        <section className="mb-8">
          <div className="mb-3 flex items-center gap-2">
            <Pin className="h-4 w-4 text-yt-muted" />
            <h2 className="font-display text-lg font-semibold">Accès rapide</h2>
          </div>
          <ShelfRow title="" items={quickAccessItems} />
        </section>
      )}

      {radios.length > 0 && (
        <section className="mb-8">
          <div className="mb-3 flex items-center gap-2">
            <Radio className="h-4 w-4 text-yt-muted" />
            <h2 className="font-display text-lg font-semibold">Mixés pour toi</h2>
          </div>
          <div className="shelf-scroll">
            {radios.map((r) => (
              <MixCollageCard
                key={r.id}
                id={r.id}
                title={r.title}
                tracks={radioPreviews[r.id] || []}
                busy={startingRadio === r.id}
                subtitle="Mix radio"
                saved={hasMix(r.id)}
                playing={
                  isPlaying &&
                  Boolean(currentId) &&
                  (radioPreviews[r.id] || []).some((t) => t.id === currentId)
                }
                onOpen={() => navigate(`/mix/${encodeURIComponent(r.id)}`)}
                onPlay={() => void startRadio(r.id)}
                onSave={() => void saveRadioMix(r.id, r.title)}
                onMore={() => openMixMenu(r.id, r.title)}
              />
            ))}
          </div>
        </section>
      )}

      {loading && shelves.length === 0 && <HomeShelfSkeleton rows={4} />}
      {error && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-yt-border bg-yt-elevated p-4 text-sm text-yt-muted">
          <span className="min-w-0 flex-1">Impossible de charger l&apos;accueil : {error}</span>
          <button
            type="button"
            className="shrink-0 rounded-full bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/16"
            onClick={() => setHomeReload((n) => n + 1)}
          >
            Réessayer
          </button>
        </div>
      )}
      {!loading && !error && shelves.length === 0 && quickAccessItems.length === 0 && (
        <p className="text-yt-muted">Aucun contenu pour le moment. Essaie la recherche.</p>
      )}
      {orderedShelves.map((shelf, i) => (
          <ShelfRow key={`${shelf.title}-${i}`} title={shelf.title} items={shelf.items} />
        ))}

      <div ref={sentinel} className="py-8 text-center text-sm text-yt-muted">
        {loadingMore
          ? 'Chargement…'
          : hasMore
            ? 'Fais défiler pour plus de recommandations'
            : 'Fin du fil — pour l’instant'}
      </div>
    </div>
  );
}
