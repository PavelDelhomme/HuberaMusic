import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2, Radio, RefreshCw } from 'lucide-react';
import { api, type Track } from '../api';
import { ShelfRow } from '../components/MediaCard';
import { MixCollageCard } from '../components/MixCollageCard';
import { usePlayer } from '../store/player';
import { useLibrary } from '../store/library';
import { useItemActions } from '../store/itemActions';
import { useExplore } from '../store/explore';
import { perfStart } from '../lib/perf';
import { warmFormats } from '../lib/streamPrefetch';
import { getCachedMix, mixCacheKey, setCachedMix } from '../lib/mixCache';

export function ExplorePage() {
  const navigate = useNavigate();
  const ytShelves = useExplore((s) => s.ytShelves);
  const radios = useExplore((s) => s.radios);
  const radioShelves = useExplore((s) => s.radioShelves);
  const radioPreviews = useExplore((s) => s.radioPreviews);
  const pendingRadios = useExplore((s) => s.pendingRadios);
  const loading = useExplore((s) => s.loading);
  const loadingRadios = useExplore((s) => s.loadingRadios);
  const refreshing = useExplore((s) => s.refreshing);
  const error = useExplore((s) => s.error);
  const ensureLoaded = useExplore((s) => s.ensureLoaded);
  const refresh = useExplore((s) => s.refresh);

  const [startingId, setStartingId] = useState<string | null>(null);
  const playQueue = usePlayer((s) => s.playQueue);
  const isPlaying = usePlayer((s) => s.isPlaying);
  const currentId = usePlayer((s) => s.current?.id);
  const hasMix = useLibrary((s) => s.hasMix);
  const saveMix = useLibrary((s) => s.saveMix);
  const openActions = useItemActions((s) => s.open);

  const pullRef = useRef<{ y: number; atTop: boolean } | null>(null);
  const [pullDy, setPullDy] = useState(0);

  useEffect(() => {
    const end = perfStart('explore.ensure');
    void ensureLoaded().finally(() => end());
  }, [ensureLoaded]);

  const playRadioFast = async (id: string, title: string) => {
    setStartingId(id);
    const end = perfStart('mix.play');
    const cKey = mixCacheKey('cat', id);
    try {
      const preview = (radioPreviews[id] || []).filter((t) =>
        /^[a-zA-Z0-9_-]{11}$/.test(t.id),
      );
      // Toujours repartir de zéro (remplace la file en cours)
      if (preview.length) {
        void playQueue(preview, 0, { sourceId: id, sourceKind: 'mix' });
        void warmFormats([preview[0]!.id, preview[1]?.id].filter(Boolean) as string[]);
      }
      const cached = getCachedMix(cKey);
      if (cached?.length) {
        void playQueue(cached, 0, { sourceId: id, sourceKind: 'mix' });
        void warmFormats(cached.slice(0, 3).map((t) => t.id));
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
      } else if (!preview.length) {
        useExplore.setState({ error: 'Aucun titre pour cette radio.' });
      }
    } catch (e) {
      useExplore.setState({ error: String((e as Error).message || e) });
    } finally {
      setStartingId(null);
      end(title);
    }
  };

  const playShelf = (items: Track[]) => {
    const playable = items.filter((t) => /^[a-zA-Z0-9_-]{11}$/.test(t.id));
    if (playable.length) void playQueue(playable, 0);
  };

  return (
    <div
      className="animate-fade-up"
      onTouchStart={(e) => {
        const scrollTop =
          (e.currentTarget.closest('main') as HTMLElement | null)?.scrollTop ??
          document.documentElement.scrollTop;
        pullRef.current = { y: e.touches[0]?.clientY ?? 0, atTop: scrollTop <= 2 };
      }}
      onTouchMove={(e) => {
        const p = pullRef.current;
        if (!p?.atTop) return;
        const dy = (e.touches[0]?.clientY ?? 0) - p.y;
        if (dy > 0) setPullDy(Math.min(72, dy));
      }}
      onTouchEnd={() => {
        if (pullDy > 56) void refresh();
        setPullDy(0);
        pullRef.current = null;
      }}
    >
      {pullDy > 8 && (
        <div
          className="mb-2 flex items-center justify-center gap-2 text-xs text-yt-muted transition"
          style={{ height: pullDy }}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${pullDy > 56 ? 'animate-spin' : ''}`} />
          {pullDy > 56 ? 'Relâche pour actualiser' : 'Tirer pour actualiser'}
        </div>
      )}

      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Explorer</h1>
          <p className="mt-1 text-sm text-yt-muted">
            Radios + nouveautés — mise à jour auto ~45 min, ou tire vers le bas.
          </p>
        </div>
        <button
          type="button"
          title="Actualiser"
          disabled={refreshing || loading}
          onClick={() => void refresh()}
          className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-yt-muted hover:bg-white/10 hover:text-white disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {radios.length > 0 && (
        <section className="mb-8 mt-4">
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
                busy={startingId === r.id}
                subtitle="Mix radio"
                saved={hasMix(r.id)}
                playing={
                  isPlaying &&
                  Boolean(currentId) &&
                  (radioPreviews[r.id] || []).some((t) => t.id === currentId)
                }
                onOpen={() => navigate(`/mix/${encodeURIComponent(r.id)}`)}
                onPlay={() => void playRadioFast(r.id, r.title)}
                onSave={() => {
                  const covers = radioPreviews[r.id] || [];
                  void saveMix({ id: r.id, title: r.title, covers, tracks: covers });
                }}
                onMore={() => {
                  const covers = radioPreviews[r.id] || [];
                  openActions({
                    id: r.id,
                    title: r.title,
                    type: 'mix',
                    artists: [{ name: 'Mix radio' }],
                    thumbnails: covers.flatMap((t) => t.thumbnails || []).slice(0, 4),
                    covers,
                    tracks: covers,
                  } as Track);
                }}
              />
            ))}
          </div>
        </section>
      )}

      {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

      {loading && (
        <div className="flex items-center gap-2 py-12 text-sm text-yt-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Chargement d’Explorer…
        </div>
      )}

      {!loading &&
        radioShelves.map((shelf) => (
          <div key={shelf.id} className="relative">
            <div className="mb-[-0.5rem] flex items-center justify-between gap-2 px-1">
              <Link
                to={`/mix/${encodeURIComponent(shelf.id)}`}
                className="text-xs text-yt-muted hover:text-white"
              >
                Voir le mix
              </Link>
              <button
                type="button"
                onClick={() => playShelf(shelf.items)}
                className="text-xs text-yt-muted hover:text-white"
              >
                Tout lire
              </button>
            </div>
            <ShelfRow title={shelf.title} items={shelf.items} />
          </div>
        ))}

      {!loading && pendingRadios.length > 0 && (
        <div className="mb-8 space-y-4">
          {pendingRadios.slice(0, 2).map((id) => {
            const title = radios.find((r) => r.id === id)?.title || id;
            return (
              <div key={id} className="rounded-xl bg-yt-elevated/40 px-4 py-6">
                <div className="mb-3 flex items-center gap-2 text-sm text-yt-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Radio · {title}
                </div>
                <div className="flex gap-3 overflow-hidden">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-28 w-28 shrink-0 animate-pulse rounded-lg bg-yt-border/60"
                    />
                  ))}
                </div>
              </div>
            );
          })}
          {loadingRadios && pendingRadios.length > 2 && (
            <p className="text-xs text-yt-muted">
              +{pendingRadios.length - 2} radio{pendingRadios.length - 2 > 1 ? 's' : ''} en
              cours…
            </p>
          )}
        </div>
      )}

      {!loading &&
        ytShelves.map((shelf, i) => (
          <ShelfRow key={`yt-${i}-${shelf.title}`} title={shelf.title} items={shelf.items} />
        ))}

      {!loading && !ytShelves.length && !radioShelves.length && !pendingRadios.length && !error && (
        <p className="text-sm text-yt-muted">Rien à afficher pour le moment.</p>
      )}
    </div>
  );
}
