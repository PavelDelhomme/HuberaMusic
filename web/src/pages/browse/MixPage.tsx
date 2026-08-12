import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Loader2, Radio } from 'lucide-react';
import { api, type Track } from '../../api';
import { TrackRow } from '../../components/media/TrackRow';
import { CoverImage } from '../../components/media/CoverImage';
import { usePlayer } from '../../store/player';
import { useLibrary } from '../../store/library';
import { useExplore } from '../../store/explore';
import { formatTotalDuration, sumTracksDurationSeconds } from '../../lib/util/time';
import { warmFormats } from '../../lib/audio/streamPrefetch';
import { perfStart } from '../../lib/util/perf';
import { getCachedMix, mixCacheKey, setCachedMix } from '../../lib/util/mixCache';
import { Play, Shuffle, Library, Plus } from 'lucide-react';
import { PlayingCoverOverlay } from '../../components/player/PlayingBars';
import { useNowPlayingMatch } from '../../lib/player/nowPlaying';

function BackButton() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate(-1)}
      className="mb-4 text-sm text-yt-muted hover:text-white"
    >
      ← Retour
    </button>
  );
}

/** Page détail d’un mix / radio catégorie — liste puis Lecture / Aléatoire. */
export function MixPage() {
  const { id: rawId = '' } = useParams();
  const id = decodeURIComponent(rawId);
  const navigate = useNavigate();
  const playQueue = usePlayer((s) => s.playQueue);
  const hasMix = useLibrary((s) => s.hasMix);
  const saveMix = useLibrary((s) => s.saveMix);
  const removeMix = useLibrary((s) => s.removeMix);
  const radios = useExplore((s) => s.radios);
  const radioPreviews = useExplore((s) => s.radioPreviews);

  const titleHint =
    radios.find((r) => r.id === id)?.title ||
    id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const [title, setTitle] = useState(titleHint);
  const [tracks, setTracks] = useState<Track[]>(() => radioPreviews[id] || []);
  const [loading, setLoading] = useState(() => !(radioPreviews[id]?.length));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const end = perfStart('mix.detail');
    const cKey = mixCacheKey('cat', id);
    const cached = getCachedMix(cKey);
    const preview = radioPreviews[id] || [];
    if (cached?.length) {
      setTracks(cached);
      setLoading(false);
      void warmFormats(cached.slice(0, 3).map((t) => t.id));
    } else if (preview.length) {
      setTracks(preview);
      setLoading(false);
      void warmFormats(preview.slice(0, 3).map((t) => t.id));
    } else {
      setLoading(true);
    }
    setError('');
    try {
      const r = await api.recoRadio(id);
      const list = (r.tracks || []).filter((t) => /^[a-zA-Z0-9_-]{11}$/.test(t.id));
      if (list.length) {
        setTracks(list);
        setCachedMix(cKey, list, { generatedAt: r.generatedAt, target: r.target });
        void warmFormats(list.slice(0, 4).map((t) => t.id));
      } else if (!preview.length && !cached?.length) {
        setError('Aucun titre dans ce mix.');
      }
      const catTitle = radios.find((x) => x.id === id)?.title;
      if (catTitle) setTitle(catTitle);
      else if (r.category?.title) setTitle(String(r.category.title));
    } catch (e) {
      if (!preview.length && !cached?.length) setError(String((e as Error).message || e));
    } finally {
      setLoading(false);
      end(id);
    }
  }, [id, radioPreviews, radios]);

  useEffect(() => {
    void load();
  }, [load]);

  const cover = tracks[0];
  const total = formatTotalDuration(sumTracksDurationSeconds(tracks));
  const nowPlaying = useNowPlayingMatch({ id, type: 'mix', tracks });

  const playAt = (index: number) => {
    if (!tracks.length) return;
    void playQueue(tracks, index, { sourceId: id, sourceKind: 'mix' });
  };

  const playAll = () => {
    if (!tracks.length) return;
    const end = perfStart('mix.playAll');
    void playQueue(tracks, 0, { sourceId: id, sourceKind: 'mix' });
    void warmFormats(tracks.slice(0, 3).map((t) => t.id));
    end(id);
  };

  const shuffleAll = () => {
    if (!tracks.length) return;
    const shuffled = [...tracks].sort(() => Math.random() - 0.5);
    void playQueue(shuffled, 0, { sourceId: id, sourceKind: 'mix' });
    void warmFormats(shuffled.slice(0, 3).map((t) => t.id));
  };

  return (
    <div className="animate-fade-up">
      <BackButton />
      <div className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-end">
        <div className="relative h-44 w-44 shrink-0 overflow-hidden rounded-lg shadow-2xl sm:h-56 sm:w-56">
          {cover ? (
            <CoverImage item={cover} size={800} rounded="lg" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-yt-elevated">
              <Radio className="h-12 w-12 text-yt-muted" />
            </div>
          )}
          <PlayingCoverOverlay
            active={nowPlaying.active}
            playing={nowPlaying.playing}
            size="lg"
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-widest text-yt-muted">Mix</p>
          <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-5xl">{title}</h1>
          <p className="mt-2 text-sm text-yt-muted">
            {[
              `${tracks.length} titre${tracks.length !== 1 ? 's' : ''}`,
              total,
              'Radio personnalisée',
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!tracks.length || busy}
              onClick={playAll}
              className="inline-flex items-center gap-2 rounded-full bg-yt-red px-5 py-2.5 text-sm font-medium disabled:opacity-50"
            >
              <Play className="h-4 w-4 fill-white" /> Lecture
            </button>
            {tracks.length > 1 && (
              <button
                type="button"
                disabled={busy}
                onClick={shuffleAll}
                className="inline-flex items-center gap-2 rounded-full bg-yt-elevated px-4 py-2.5 text-sm text-yt-muted hover:text-white disabled:opacity-50"
              >
                <Shuffle className="h-4 w-4" /> Aléatoire
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void (async () => {
                  try {
                    if (hasMix(id)) await removeMix(id);
                    else {
                      await saveMix({
                        id,
                        title,
                        covers: tracks.slice(0, 4),
                        tracks: tracks.slice(0, 40),
                      });
                    }
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
              className="inline-flex items-center gap-2 rounded-full bg-yt-elevated px-4 py-2.5 text-sm text-yt-muted hover:text-white disabled:opacity-50"
            >
              {hasMix(id) ? (
                <>
                  <Library className="h-4 w-4 text-yt-red" /> Enregistré
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" /> Enregistrer
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <p className="mb-4 text-sm text-red-400">
          {error}{' '}
          <button type="button" className="underline" onClick={() => void load()}>
            Réessayer
          </button>
        </p>
      )}

      {loading && !tracks.length && (
        <div className="flex items-center gap-2 py-8 text-sm text-yt-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          Chargement du mix…
        </div>
      )}

      {loading && tracks.length > 0 && (
        <p className="mb-3 text-xs text-yt-muted">Chargement de la suite…</p>
      )}

      <div className="space-y-0.5">
        {tracks.map((t, i) => (
          <TrackRow
            key={`${t.id}-${i}`}
            track={t}
            index={i + 1}
            queue={tracks}
            alwaysActions
            onPlay={() => playAt(i)}
          />
        ))}
      </div>

      {!loading && !tracks.length && !error && (
        <p className="text-sm text-yt-muted">
          Mix vide.{' '}
          <button type="button" className="underline" onClick={() => navigate('/explore')}>
            Retour Explorer
          </button>
        </p>
      )}
    </div>
  );
}
