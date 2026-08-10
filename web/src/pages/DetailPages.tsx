import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Track } from '../api';
import { TrackRow } from '../components/TrackRow';
import { ShelfRow } from '../components/MediaCard';
import { CoverImage } from '../components/CoverImage';
import { usePlayer } from '../store/player';
import { useLibrary } from '../store/library';
import { usePins } from '../store/pins';
import { downloadTracksToDevice, listCachedIds } from '../lib/offlineCache';
import {
  Play,
  Download,
  Library,
  Heart,
  Radio,
  Check,
  UserPlus,
  UserMinus,
  Shuffle,
  ChevronRight,
  ArrowLeft,
  MoreVertical,
  Pin,
} from 'lucide-react';
import { BackButton } from '../components/BackButton';
import { HomeShelfSkeleton } from '../components/HomeShelfSkeleton';
import { warmFormats } from '../lib/streamPrefetch';
import { PlayingCoverOverlay } from '../components/PlayingBars';
import { useNowPlayingMatch } from '../lib/nowPlaying';
import { formatTotalDuration, sumTracksDurationSeconds } from '../lib/time';
import { useItemActions } from '../store/itemActions';

function DetailLoading() {
  return (
    <div>
      <BackButton />
      <div className="mb-6 flex gap-4">
        <div className="h-40 w-40 shrink-0 animate-pulse rounded-lg bg-yt-border/50 sm:h-48 sm:w-48" />
        <div className="flex min-w-0 flex-1 flex-col justify-end gap-3 pb-1">
          <div className="h-8 w-2/3 max-w-md animate-pulse rounded bg-yt-border/45" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-yt-border/30" />
          <div className="mt-2 flex gap-2">
            <div className="h-9 w-28 animate-pulse rounded-full bg-yt-border/40" />
            <div className="h-9 w-28 animate-pulse rounded-full bg-yt-border/30" />
          </div>
        </div>
      </div>
      <HomeShelfSkeleton rows={1} />
      <div className="mt-6 space-y-2" aria-hidden>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 py-2">
            <div className="h-12 w-12 shrink-0 animate-pulse rounded bg-yt-border/55" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-3 w-2/3 animate-pulse rounded bg-yt-border/45" />
              <div className="h-2.5 w-2/5 animate-pulse rounded bg-yt-border/30" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ArtistPage() {
  const { id = '' } = useParams();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.artist>> | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [radio, setRadio] = useState<Track[]>([]);
  const playQueue = usePlayer((s) => s.playQueue);
  const startRadio = usePlayer((s) => s.startRadio);
  const { hasArtist, applyLibrary, liked, albums } = useLibrary();
  const [busy, setBusy] = useState(false);
  const [radioBusy, setRadioBusy] = useState(false);
  const [radioToast, setRadioToast] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [showBio, setShowBio] = useState(false);

  const loadArtist = useCallback(() => {
    if (!id) return;
    setLoading(true);
    setError('');
    setData(null);
    setFollowing(false);
    setShowBio(false);
    api
      .artist(id)
      .then(setData)
      .catch((e) => setError(String(e?.message || e || 'Artiste introuvable')))
      .finally(() => setLoading(false));
    api.artistRadio(id).then((r) => setRadio(r.tracks)).catch(() => setRadio([]));
    api
      .prefs()
      .then((r) => {
        const follows = r.follows || [];
        setFollowing(
          follows.some(
            (f: { artist_id?: string; id?: string }) => f.artist_id === id || f.id === id,
          ),
        );
      })
      .catch(() => undefined);
  }, [id]);

  useEffect(() => {
    loadArtist();
  }, [loadArtist]);

  if (loading && !data) {
    return <DetailLoading />;
  }

  if (error || !data) {
    return (
      <div>
        <BackButton />
        <p className="mb-3 text-red-400">{error || 'Artiste introuvable'}</p>
        <button
          type="button"
          className="rounded-full bg-yt-elevated px-4 py-2 text-sm"
          onClick={() => loadArtist()}
        >
          Réessayer
        </button>
      </div>
    );
  }
  const inLib = hasArtist(data.artist.id);
  const artistName = data.artist.name.toLowerCase();
  const matchesArtist = (t: Track) =>
    (t.artists || []).some(
      (a) => a.id === data.artist.id || a.name?.toLowerCase() === artistName,
    );
  const libTracks = liked.filter((t) => matchesArtist(t)).slice(0, 12);
  const libAlbums = albums.filter((t) => matchesArtist(t) || t.id === data.artist.id).slice(0, 12);
  const bio = typeof data.artist.description === 'string' ? data.artist.description.trim() : '';
  // API may still return TextRuns objects if a mapper regresses — never render objects as React children.
  const subscribersLabel =
    typeof data.artist.subscribers === 'string'
      ? data.artist.subscribers
      : data.artist.subscribers &&
          typeof data.artist.subscribers === 'object' &&
          'text' in (data.artist.subscribers as object)
        ? String((data.artist.subscribers as { text?: string }).text || '')
        : '';
  const topSongs = data.songs.slice(0, 10);

  return (
    <div className="animate-fade-up">
      <BackButton />
      <div className="mb-8 flex flex-col items-start gap-6 sm:flex-row sm:items-end">
        <div className="h-40 w-40 shrink-0 shadow-2xl sm:h-52 sm:w-52">
          <CoverImage item={data.artist} size={800} rounded="full" />
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest text-yt-muted">Artiste</p>
          <h1 className="font-display text-4xl font-semibold tracking-tight sm:text-5xl">{data.artist.name}</h1>
          {subscribersLabel ? <p className="mt-2 text-sm text-yt-muted">{subscribersLabel}</p> : null}
          {bio && (
            <div className="mt-3 max-w-2xl">
              <p className="text-sm leading-relaxed text-yt-muted">
                {showBio || bio.length <= 220 ? bio : `${bio.slice(0, 220).trimEnd()}…`}
              </p>
              {bio.length > 220 && (
                <button
                  type="button"
                  className="mt-1 text-xs font-medium text-white hover:underline"
                  onClick={() => setShowBio((v) => !v)}
                >
                  {showBio ? 'Réduire' : 'À propos'}
                </button>
              )}
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {data.songs[0] && (
              <button
                type="button"
                onClick={() => {
                  void useLibrary.getState().recordEntityPlay({
                    id: data.artist.id,
                    kind: 'artist',
                    title: data.artist.name,
                    thumbnails: data.artist.thumbnails,
                  });
                  void playQueue(data.songs, 0);
                }}
                className="inline-flex items-center gap-2 rounded-full bg-yt-red px-5 py-2.5 text-sm font-medium"
              >
                <Play className="h-4 w-4 fill-white" /> Lecture
              </button>
            )}
            <button
              type="button"
              disabled={radioBusy}
              onClick={() => {
                setRadioBusy(true);
                void startRadio({
                  kind: 'artist',
                  id: data.artist.id,
                  seed: data.songs[0],
                })
                  .then((r) => {
                    const n = r?.added ?? 0;
                    setRadioToast(
                      n > 0
                        ? `${n} titre${n > 1 ? 's' : ''} en lien avec ${data.artist.name} — file mise à jour`
                        : 'Radio artiste démarrée',
                    );
                    window.setTimeout(() => setRadioToast(null), 3200);
                  })
                  .finally(() => setRadioBusy(false));
              }}
              className="inline-flex items-center gap-2 rounded-full bg-yt-elevated px-4 py-2.5 text-sm text-yt-muted hover:text-white disabled:opacity-60"
              title="Radio artiste — titres similaires liés à cet artiste"
            >
              <Radio className="h-4 w-4" />
              {radioBusy ? 'Radio…' : 'Radio'}
            </button>
            <button
              type="button"
              disabled={followBusy}
              onClick={() => {
                void (async () => {
                  setFollowBusy(true);
                  try {
                    if (following) {
                      await api.unfollowArtist(data.artist.id);
                      setFollowing(false);
                    } else {
                      await api.followArtist(data.artist.id, data.artist.name);
                      setFollowing(true);
                    }
                  } finally {
                    setFollowBusy(false);
                  }
                })();
              }}
              className={`inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-sm ${
                following
                  ? 'bg-white/10 text-white'
                  : 'bg-yt-elevated text-yt-muted hover:text-white'
              } disabled:opacity-60`}
              title="Suivre pour alimenter les rayons Accueil"
            >
              {following ? <UserMinus className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />}
              {following ? 'Abonné' : 'Suivre'}
            </button>
            <button
              type="button"
              disabled={busy || inLib}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  try {
                    const r = await api.saveArtist({
                      id: data.artist.id,
                      name: data.artist.name,
                      title: data.artist.name,
                      subscribers: subscribersLabel || undefined,
                      thumbnails: data.artist.thumbnails,
                      description: bio || undefined,
                      type: 'artist',
                    });
                    applyLibrary(r.library);
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
              className="inline-flex items-center gap-2 rounded-full bg-yt-elevated px-4 py-2.5 text-sm text-yt-muted hover:text-white disabled:opacity-60"
            >
              <Library className="h-4 w-4" />
              {inLib ? 'Dans la bibliothèque' : 'Ajouter artiste'}
            </button>
            <button
              type="button"
              onClick={() => {
                void (async () => {
                  const songs = topSongs.length ? topSongs : data.songs;
                  if (songs?.length) {
                    await downloadTracksToDevice(songs);
                  }
                  void api.offlineStart('artist', data.artist.id).catch(() => undefined);
                })();
              }}
              className="inline-flex items-center gap-2 rounded-full bg-yt-elevated px-4 py-2.5 text-sm text-yt-muted hover:text-white"
            >
              <Download className="h-4 w-4" /> Hors ligne
            </button>
          </div>
          {radioToast && (
            <p
              className="mt-3 rounded-lg bg-white/10 px-3 py-2 text-sm text-white"
              role="status"
            >
              {radioToast}
            </p>
          )}
        </div>
      </div>

      {topSongs.length > 0 && (
        <section className="mb-8">
          <div className="mb-3 flex items-end justify-between gap-3">
            <h2 className="font-display text-xl font-semibold">Titres les plus écoutés</h2>
            <Link
              to={`/artist/${data.artist.id}/songs`}
              className="inline-flex items-center gap-1 text-sm font-medium text-yt-muted transition hover:text-white"
            >
              Plus
              <ChevronRight className="h-4 w-4" />
            </Link>
          </div>
          {topSongs.map((t, i) => (
            <TrackRow key={t.id} track={t} index={i} queue={data.songs} />
          ))}
        </section>
      )}

      {(libTracks.length > 0 || libAlbums.length > 0) && (
        <section className="mb-8">
          <h2 className="mb-3 font-display text-xl font-semibold">Dans ma bibliothèque</h2>
          {libAlbums.length > 0 && (
            <ShelfRow
              title="Albums enregistrés"
              items={libAlbums.map((a) => ({ ...a, type: 'album' as const }))}
            />
          )}
          {libTracks.map((t, i) => (
            <TrackRow key={`lib-${t.id}`} track={t} index={i} queue={libTracks} />
          ))}
        </section>
      )}

      <ShelfRow title="Albums" items={data.albums.map((a) => ({ ...a, type: 'album' as const }))} />
      <ShelfRow
        title="Singles & EP"
        items={(data.singles || []).map((a) => ({ ...a, type: a.type === 'unknown' ? ('album' as const) : a.type }))}
      />
      <ShelfRow
        title="Apparitions"
        items={(data.featured || []).map((a) => ({
          ...a,
          type: a.type === 'unknown' ? ('album' as const) : a.type,
        }))}
      />
      <ShelfRow title="Vidéos" items={data.videos || []} />
      <ShelfRow title="Playlists" items={(data.playlists || []).map((p) => ({ ...p, type: 'playlist' as const }))} />
      <ShelfRow
        title="Les fans aiment aussi"
        items={(data.similar || []).map((a) => ({ ...a, type: 'artist' as const }))}
      />

      {radio.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 font-display text-xl font-semibold">Radio artiste</h2>
          {radio.slice(0, 12).map((t, i) => (
            <TrackRow key={t.id} track={t} index={i} queue={radio} />
          ))}
        </section>
      )}
    </div>
  );
}

/** Page dédiée : tous les titres de l’artiste (pas seulement le top 10). */
export function ArtistSongsPage() {
  const { id = '' } = useParams();
  const [artistName, setArtistName] = useState('Artiste');
  const [cover, setCover] = useState<{ thumbnails?: Track['thumbnails']; name?: string; title?: string } | null>(
    null,
  );
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const playQueue = usePlayer((s) => s.playQueue);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    setTracks([]);
    api
      .artistSongs(id)
      .then((r) => {
        setArtistName(r.artist?.name || 'Artiste');
        setCover(r.artist || null);
        setTracks(r.tracks || []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <div className="animate-fade-up">
      <BackButton fallback={id ? `/artist/${id}` : '/'} />
      <div className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-end">
        {cover && (
          <div className="h-36 w-36 shrink-0 shadow-2xl sm:h-44 sm:w-44">
            <CoverImage item={{ ...cover, title: artistName }} size={800} rounded="full" />
          </div>
        )}
        <div>
          <p className="text-xs uppercase tracking-widest text-yt-muted">Discographie</p>
          <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            Tous les titres
          </h1>
          <p className="mt-2 text-sm text-yt-muted">
            <Link to={`/artist/${id}`} className="hover:text-white hover:underline">
              {artistName}
            </Link>
            {tracks.length > 0 ? ` · ${tracks.length} titre${tracks.length > 1 ? 's' : ''}` : null}
          </p>
          {tracks.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void playQueue(tracks, 0)}
                className="inline-flex items-center gap-2 rounded-full bg-yt-red px-5 py-2.5 text-sm font-medium"
              >
                <Play className="h-4 w-4 fill-white" /> Lecture
              </button>
              <button
                type="button"
                onClick={() => {
                  const shuffled = [...tracks].sort(() => Math.random() - 0.5);
                  void playQueue(shuffled, 0);
                }}
                className="inline-flex items-center gap-2 rounded-full bg-yt-elevated px-4 py-2.5 text-sm text-yt-muted hover:text-white"
              >
                <Shuffle className="h-4 w-4" /> Aléatoire
              </button>
            </div>
          )}
        </div>
      </div>

      {loading && (
        <div className="space-y-2" aria-hidden>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 py-2">
              <div className="h-12 w-12 shrink-0 animate-pulse rounded bg-yt-border/55" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-3 w-2/3 animate-pulse rounded bg-yt-border/45" />
                <div className="h-2.5 w-2/5 animate-pulse rounded bg-yt-border/30" />
              </div>
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!loading && !error && tracks.length === 0 && (
        <p className="text-yt-muted">Aucun titre trouvé pour cet artiste.</p>
      )}
      {tracks.map((t, i) => (
        <TrackRow key={`${t.id}-${i}`} track={t} index={i} queue={tracks} showAlbum />
      ))}
    </div>
  );
}

export function AlbumPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.album>> | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [radio, setRadio] = useState<Track[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const playQueue = usePlayer((s) => s.playQueue);
  const addNext = usePlayer((s) => s.addNext);
  const addToQueue = usePlayer((s) => s.addToQueue);
  const startRadio = usePlayer((s) => s.startRadio);
  const { hasAlbum, applyLibrary } = useLibrary();
  const togglePin = usePins((s) => s.togglePin);
  const isPinned = usePins((s) => s.pins.some((p) => p.targetId === id));
  const openItemActions = useItemActions((s) => s.open);
  const [radioBusy, setRadioBusy] = useState(false);
  const [radioToast, setRadioToast] = useState<string | null>(null);
  const [libBusy, setLibBusy] = useState(false);
  const [offlinePct, setOfflinePct] = useState<number | null>(null);
  const [offlineDone, setOfflineDone] = useState(false);
  const albumNow = useNowPlayingMatch({
    id,
    type: 'album',
    tracks: data?.tracks,
  });

  const startAlbumOffline = () => {
    if (offlineDone || offlinePct != null || !data?.tracks?.length) return;
    void (async () => {
      setOfflinePct(0.05);
      try {
        // Vrai hors-ligne navigateur (= mobile) : IndexedDB sur cet appareil
        await downloadTracksToDevice(data.tracks, (done, total) => {
          setOfflinePct(total > 0 ? Math.min(0.99, done / total) : 0.5);
        });
        // Optionnel : warm serveur (sync compte) — n’empêche pas le hors-ligne local
        void api.offlineStart('album', id).catch(() => undefined);
        setOfflinePct(1);
        setOfflineDone(true);
      } catch {
        /* ignore */
      } finally {
        setTimeout(() => setOfflinePct(null), 400);
      }
    })();
  };

  useEffect(() => {
    if (!data?.tracks?.length) return;
    void listCachedIds().then((ids) => {
      const set = new Set(ids);
      const allLocal = data.tracks
        .filter((t) => /^[a-zA-Z0-9_-]{11}$/.test(t.id))
        .every((t) => set.has(t.id));
      if (allLocal) setOfflineDone(true);
    });
  }, [data?.tracks]);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError('');
    setData(null);
    setRadio([]);
    api
      .album(id)
      .then((album) => {
        setData(album);
        void warmFormats((album.tracks || []).slice(0, 4).map((t) => t.id));
      })
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setLoading(false));
    const radioTimer = window.setTimeout(() => {
      api.albumRadio(id).then((r) => setRadio(r.tracks)).catch(() => setRadio([]));
    }, 1_200);
    return () => window.clearTimeout(radioTimer);
  }, [id]);

  if (loading && !data) {
    return <DetailLoading />;
  }

  if (error || !data) {
    return (
      <div>
        <BackButton />
        <p className="mb-3 text-red-400">{error || 'Album introuvable'}</p>
        <button
          type="button"
          className="rounded-full bg-yt-elevated px-4 py-2 text-sm"
          onClick={() => {
            setLoading(true);
            setError('');
            void api
              .album(id)
              .then(setData)
              .catch((e) => setError(String(e.message || e)))
              .finally(() => setLoading(false));
          }}
        >
          Réessayer
        </button>
      </div>
    );
  }

  const junkArtist = (n: string) =>
    !n || /^(artiste|artist|inconnu|unknown|n\/a)$/i.test(n.trim());
  const artists = (data.album.artists || [])
    .filter((a) => a.name && !junkArtist(a.name))
    .concat(
      (data.tracks || [])
        .flatMap((t) => t.artists || [])
        .filter((a) => a.name && !junkArtist(a.name)),
    )
    .filter((a, i, arr) => arr.findIndex((x) => x.name === a.name && x.id === a.id) === i);
  const albumArtists = (data.album.artists || []).filter((a) => a.name && !junkArtist(a.name));
  const resolvedArtists = albumArtists.length ? albumArtists : artists;
  const artistLabel =
    resolvedArtists.map((a) => a.name).filter(Boolean).join(', ') || 'Artiste';
  const releaseType =
    data.album.releaseType ||
    (data.tracks.length <= 1 ? 'Single' : data.tracks.length <= 6 ? 'EP' : 'Album');
  const totalDur = formatTotalDuration(sumTracksDurationSeconds(data.tracks));
  const metaLine = [
    releaseType,
    data.album.year,
    `${data.tracks.length} titre${data.tracks.length !== 1 ? 's' : ''}`,
    totalDur,
  ]
    .filter(Boolean)
    .join(' · ');
  const inLib = hasAlbum(data.album.id);
  const primaryArtist = resolvedArtists.find((a) => a.id) || resolvedArtists[0];

  const recordPlay = () => {
    void useLibrary.getState().recordEntityPlay({
      id: data.album.id,
      kind: 'album',
      title: data.album.title,
      thumbnails: data.album.thumbnails,
      artists: resolvedArtists.length ? resolvedArtists : data.album.artists,
    });
  };

  const playAlbum = () => {
    recordPlay();
    void playQueue(data.tracks, 0, { sourceId: data.album.id, sourceKind: 'album' });
  };

  return (
    <div className="animate-fade-up">
      {/* Top : retour + artiste / type-année */}
      <div className="mb-5 flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            if (window.history.length > 1) window.history.back();
            else navigate('/');
          }}
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-white transition hover:bg-yt-elevated"
          aria-label="Retour"
        >
          <ArrowLeft className="h-9 w-9" strokeWidth={2.25} />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <button
            type="button"
            className="block w-full truncate font-display text-xl font-bold tracking-tight text-white hover:underline sm:text-2xl"
            onClick={() => {
              if (primaryArtist?.id) navigate(`/artist/${primaryArtist.id}`);
            }}
          >
            {artistLabel}
          </button>
          <p className="mt-0.5 truncate text-base font-medium text-yt-muted sm:text-lg">{metaLine}</p>
        </div>
        <div className="h-14 w-14 shrink-0" aria-hidden />
      </div>

      {/* Vignette centrée */}
      <div className="relative mx-auto mb-6 w-[min(72vw,20rem)] max-w-sm shadow-2xl sm:w-[min(50vw,22rem)]">
        <CoverImage item={data.album} size={800} rounded="lg" />
        <PlayingCoverOverlay
          active={albumNow.active}
          playing={albumNow.playing}
          size="lg"
        />
        {isPinned && (
          <button
            type="button"
            title="Retirer de l'accès rapide"
            aria-label="Retirer de l'accès rapide"
            onClick={() => {
              void togglePin({
                id: data.album.id,
                title: data.album.title,
                type: 'album',
                artists: resolvedArtists.length ? resolvedArtists : data.album.artists,
                thumbnails: data.album.thumbnails,
              });
            }}
            className="absolute left-3 top-3 z-[2] flex h-9 w-9 items-center justify-center rounded-full bg-yt-red text-white shadow-lg"
          >
            <Pin className="h-4 w-4 fill-current" />
          </button>
        )}
      </div>

      {/* Titre */}
      <h1 className="mb-6 px-2 text-center font-display text-3xl font-bold tracking-tight sm:text-4xl">
        {data.album.title}
      </h1>

      {/* 5 boutons ronds — libellés + title (survol / appui long) */}
      <div className="mb-8 flex items-start justify-evenly gap-1 px-1 sm:justify-center sm:gap-5">
        <AlbumHeroAction
          title={
            offlineDone
              ? 'Album téléchargé'
              : offlinePct != null
                ? `Téléchargement ${Math.round(offlinePct * 100)} %`
                : "Télécharger l'album hors ligne"
          }
          label={
            offlineDone
              ? 'OK'
              : offlinePct != null
                ? `${Math.round(offlinePct * 100)}%`
                : 'Télécharger'
          }
          disabled={offlineDone || offlinePct != null}
          onClick={startAlbumOffline}
        >
          {offlineDone ? (
            <Check className="h-6 w-6 text-yt-red" />
          ) : offlinePct != null ? (
            <span className="text-xs font-semibold tabular-nums text-yt-red">
              {Math.round(offlinePct * 100)}
            </span>
          ) : (
            <Download className="h-6 w-6" />
          )}
        </AlbumHeroAction>
        <AlbumHeroAction
          title={
            inLib
              ? 'Déjà dans ta bibliothèque — cliquer pour retirer'
              : "Enregistrer l'album dans ta bibliothèque"
          }
          label={inLib ? 'Bibliothèque' : 'Enregistrer'}
          disabled={libBusy}
          onClick={() => {
            void (async () => {
              setLibBusy(true);
              try {
                if (inLib) {
                  const r = await api.removeAlbum(data.album.id);
                  applyLibrary(r.library);
                } else {
                  const r = await api.saveAlbum({
                    id: data.album.id,
                    title: data.album.title,
                    year: data.album.year,
                    artists: resolvedArtists.length ? resolvedArtists : data.album.artists,
                    thumbnails: data.album.thumbnails,
                    type: 'album',
                  });
                  applyLibrary(r.library);
                }
              } finally {
                setLibBusy(false);
              }
            })();
          }}
        >
          {inLib ? (
            <Library className="h-6 w-6 fill-current text-yt-red" />
          ) : (
            <Library className="h-6 w-6" />
          )}
        </AlbumHeroAction>
        <AlbumHeroAction title="Tout lire" label="Lecture" large onClick={playAlbum}>
          <Play className="h-9 w-9 fill-black" />
        </AlbumHeroAction>
        <AlbumHeroAction
          title="Lancer un mix radio à partir de cet album"
          label=""
          disabled={radioBusy}
          onClick={() => {
            setRadioBusy(true);
            void startRadio({
              kind: 'album',
              id: data.album.id,
              seed: data.tracks.find((t) => t.id?.length === 11) || data.tracks[0],
            })
              .then((r) => {
                const n = r?.added ?? 0;
                setRadioToast(
                  n > 0
                    ? `${n} titre${n > 1 ? 's' : ''} similaires ajoutés à la file`
                    : 'Radio album démarrée',
                );
                window.setTimeout(() => setRadioToast(null), 3200);
              })
              .finally(() => setRadioBusy(false));
          }}
        >
          <Radio className="h-7 w-7 text-yt-red" />
        </AlbumHeroAction>
        <div className="relative flex flex-col items-center">
          <button
            type="button"
            title="Plus d'options"
            aria-label="Plus d'options"
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-12 w-12 items-center justify-center rounded-full text-white/90 transition hover:bg-yt-elevated"
          >
            <MoreVertical className="h-6 w-6" />
          </button>
          <span className="mt-1 max-w-[4.5rem] truncate text-center text-[10px] text-yt-muted">Plus</span>
          {menuOpen && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-40 cursor-default"
                aria-label="Fermer le menu"
                onClick={() => setMenuOpen(false)}
              />
              <div className="absolute right-0 z-50 mt-2 w-64 overflow-hidden rounded-xl border border-yt-border bg-yt-elevated py-1 shadow-xl">
                <AlbumMenuItem
                  label="Lire ensuite"
                  onClick={() => {
                    [...data.tracks].reverse().forEach((t) => addNext(t));
                    setMenuOpen(false);
                  }}
                />
                <AlbumMenuItem
                  label="Ajouter à la file d'attente"
                  onClick={() => {
                    data.tracks.forEach((t) => addToQueue(t));
                    setMenuOpen(false);
                  }}
                />
                <AlbumMenuItem
                  label="Enregistrer dans une playlist"
                  onClick={() => {
                    const seed = data.tracks[0];
                    if (seed) openItemActions(seed);
                    setMenuOpen(false);
                  }}
                />
                <AlbumMenuItem
                  label="Accéder à la page de l'artiste"
                  onClick={() => {
                    if (primaryArtist?.id) navigate(`/artist/${primaryArtist.id}`);
                    setMenuOpen(false);
                  }}
                />
                <AlbumMenuItem
                  label={isPinned ? "Retirer de l'accès rapide" : "Ajouter à l'accès rapide"}
                  onClick={() => {
                    void togglePin({
                      id: data.album.id,
                      title: data.album.title,
                      type: 'album',
                      artists: resolvedArtists.length ? resolvedArtists : data.album.artists,
                      thumbnails: data.album.thumbnails,
                    });
                    setMenuOpen(false);
                  }}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {radioToast && (
        <p
          className="mb-6 rounded-lg bg-white/10 px-3 py-2 text-center text-sm text-white"
          role="status"
        >
          {radioToast}
        </p>
      )}

      {data.tracks.map((t, i) => (
        <TrackRow key={`${t.id}-${i}`} track={t} index={i} queue={data.tracks} showAlbum={false} />
      ))}

      {radio.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 font-display text-xl font-semibold">Similaires à cet album</h2>
          {radio.slice(0, 15).map((t, i) => (
            <TrackRow key={t.id} track={t} index={i} queue={radio} />
          ))}
        </section>
      )}
    </div>
  );
}


function AlbumHeroAction({
  title,
  label,
  onClick,
  disabled,
  large,
  children,
}: {
  title: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  large?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center">
      <button
        type="button"
        title={title}
        aria-label={title}
        disabled={disabled}
        onClick={onClick}
        className={
          large
            ? 'flex h-[4.25rem] w-[4.25rem] items-center justify-center rounded-full bg-white text-black shadow-lg transition hover:scale-[1.03] disabled:opacity-50'
            : 'flex h-12 w-12 items-center justify-center rounded-full text-white/90 transition hover:bg-yt-elevated disabled:opacity-50'
        }
      >
        {children}
      </button>
      {label ? (
        <span className="mt-1 max-w-[4.75rem] truncate text-center text-[10px] text-yt-muted">{label}</span>
      ) : (
        <span className="mt-1 h-[1.125rem]" aria-hidden />
      )}
    </div>
  );
}

function AlbumMenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full px-4 py-2.5 text-left text-sm text-white/90 transition hover:bg-white/10"
    >
      {label}
    </button>
  );
}

export function PlaylistPage() {
  const { id = '' } = useParams();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.playlist>> | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const playQueue = usePlayer((s) => s.playQueue);
  const { isPlaylistLiked, applyLibrary } = useLibrary();

  const loadPlaylist = useCallback(() => {
    if (!id) return;
    setLoading(true);
    setError('');
    setData(null);
    api
      .playlist(id)
      .then((pl) => {
        setData(pl);
        void warmFormats((pl.tracks || []).slice(0, 4).map((t) => t.id));
      })
      .catch((e) => setError(String(e?.message || e || 'Playlist introuvable')))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    loadPlaylist();
  }, [loadPlaylist]);

  if (loading && !data) {
    return <DetailLoading />;
  }

  if (error || !data) {
    return (
      <div>
        <BackButton />
        <p className="mb-3 text-red-400">{error || 'Playlist introuvable'}</p>
        <button
          type="button"
          className="rounded-full bg-yt-elevated px-4 py-2 text-sm"
          onClick={() => loadPlaylist()}
        >
          Réessayer
        </button>
      </div>
    );
  }

  return (
    <CollectionHeader
      kind="Playlist"
      title={data.playlist.title}
      subtitle={
        [
          data.playlist.author,
          data.playlist.trackCount
            ? `${data.playlist.trackCount} titre${Number(data.playlist.trackCount) !== 1 ? 's' : ''}`
            : `${data.tracks.length} titre${data.tracks.length !== 1 ? 's' : ''}`,
          formatTotalDuration(sumTracksDurationSeconds(data.tracks)),
        ]
          .filter(Boolean)
          .join(' · ') || 'Playlist'
      }
      cover={data.playlist}
      tracks={data.tracks}
      liked={isPlaylistLiked(data.playlist.id)}
      onPlay={() => {
        void useLibrary.getState().recordEntityPlay({
          id: data.playlist.id,
          kind: 'playlist',
          title: data.playlist.title,
          thumbnails: data.playlist.thumbnails,
        });
        void playQueue(data.tracks, 0, { sourceId: data.playlist.id, sourceKind: 'playlist' });
      }}
      onShuffle={() => {
        void useLibrary.getState().recordEntityPlay({
          id: data.playlist.id,
          kind: 'playlist',
          title: data.playlist.title,
          thumbnails: data.playlist.thumbnails,
        });
        const shuffled = [...data.tracks].sort(() => Math.random() - 0.5);
        void playQueue(shuffled, 0, { sourceId: data.playlist.id, sourceKind: 'playlist' });
      }}
      onLike={async () => {
        const r = await api.likePlaylist({
          id: data.playlist.id,
          title: data.playlist.title,
          author: data.playlist.author,
          thumbnails: data.playlist.thumbnails,
          type: 'playlist',
        });
        applyLibrary(r.library);
      }}
      onAddLibrary={async () => {
        // Aimer la playlist seulement — ne pas copier tous les titres en biblio
        const r = await api.likePlaylist({
          id: data.playlist.id,
          title: data.playlist.title,
          author: data.playlist.author,
          thumbnails: data.playlist.thumbnails,
          type: 'playlist',
        });
        applyLibrary(r.library);
      }}
      onOffline={async () => {
        await downloadTracksToDevice(data.tracks);
        void api.offlineStart('playlist', data.playlist.id).catch(() => undefined);
      }}
    />
  );
}

function CollectionHeader({
  kind,
  title,
  subtitle,
  cover,
  tracks,
  onPlay,
  onShuffle,
  onRadio,
  radioBusy,
  onAddLibrary,
  onOffline,
  onLike,
  inLibrary,
  liked,
}: {
  kind: string;
  title: string;
  subtitle: ReactNode;
  cover: { thumbnails?: Track['thumbnails']; title?: string; name?: string };
  tracks: Track[];
  onPlay: () => void;
  onShuffle?: () => void;
  onRadio?: () => void;
  radioBusy?: boolean;
  onAddLibrary?: () => Promise<void>;
  onOffline?: () =>
    | void
    | Promise<void>
    | Promise<{ jobId?: string; total?: number } | void>;
  onLike?: () => Promise<void>;
  inLibrary?: boolean;
  liked?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [offlinePct, setOfflinePct] = useState<number | null>(null);
  const [offlineDone, setOfflineDone] = useState(false);

  const startOffline = () => {
    if (!onOffline || offlineDone || offlinePct != null) return;
    void (async () => {
      setOfflinePct(0.05);
      const tick = window.setInterval(() => {
        setOfflinePct((p) => (p == null ? 0.05 : Math.min(0.92, p + 0.04)));
      }, 600);
      try {
        const r = (await Promise.resolve(onOffline())) as
          | { jobId?: string; total?: number }
          | void
          | null;
        const jobId =
          r && typeof r === 'object' && 'jobId' in r
            ? String((r as { jobId?: string }).jobId || '')
            : '';
        if (jobId) {
          for (let i = 0; i < 120; i++) {
            await new Promise((res) => setTimeout(res, 700));
            const st = await api.offlineJobs();
            const job = (st.jobs || []).find((j: any) => j.id === jobId);
            if (!job) break;
            const total = Number(job.total || 0);
            const progress = Number(job.progress || 0);
            const pct = total > 0 ? progress / total : 0.5;
            setOfflinePct(Math.min(0.99, Math.max(0.05, pct)));
            if (job.status === 'done' || (total > 0 && progress >= total)) break;
          }
        }
        setOfflinePct(1);
        setOfflineDone(true);
      } catch {
        /* ignore */
      } finally {
        window.clearInterval(tick);
        setTimeout(() => setOfflinePct(null), 400);
      }
    })();
  };

  return (
    <div className="animate-fade-up">
      <BackButton />
      <div className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-end">
        <div className="h-44 w-44 shrink-0 shadow-2xl sm:h-56 sm:w-56">
          <CoverImage item={{ ...cover, title: cover.title || title }} size={800} rounded="lg" />
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest text-yt-muted">{kind}</p>
          <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-5xl">{title}</h1>
          <p className="mt-2 text-sm text-yt-muted">{subtitle}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onPlay}
              className="inline-flex items-center gap-2 rounded-full bg-yt-red px-5 py-2.5 text-sm font-medium"
            >
              <Play className="h-4 w-4 fill-white" /> Lecture
            </button>
            {onShuffle && tracks.length > 1 && (
              <button
                type="button"
                onClick={onShuffle}
                className="inline-flex items-center gap-2 rounded-full bg-yt-elevated px-4 py-2.5 text-sm text-yt-muted hover:text-white"
              >
                <Shuffle className="h-4 w-4" /> Aléatoire
              </button>
            )}
            {onRadio && (
              <button
                type="button"
                disabled={radioBusy}
                onClick={onRadio}
                className="inline-flex items-center gap-2 rounded-full bg-yt-elevated px-4 py-2.5 text-sm text-yt-muted hover:text-white disabled:opacity-60"
                title={`Radio ${kind.toLowerCase()} — enchaîne des titres similaires`}
              >
                <Radio className="h-4 w-4" />
                {radioBusy ? 'Radio…' : 'Radio'}
              </button>
            )}
            {onAddLibrary && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void (async () => {
                    setBusy(true);
                    try {
                      await onAddLibrary();
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
                className="inline-flex items-center gap-2 rounded-full bg-yt-elevated px-4 py-2.5 text-sm text-yt-muted hover:text-white disabled:opacity-60"
              >
                {inLibrary ? <Check className="h-4 w-4" /> : <Library className="h-4 w-4" />}
                {inLibrary ? 'Dans la bibliothèque' : 'Ajouter à la bibliothèque'}
              </button>
            )}
            {onLike && (
              <button
                type="button"
                onClick={() => void onLike()}
                className="inline-flex items-center gap-2 rounded-full bg-yt-elevated px-4 py-2.5 text-sm text-yt-muted hover:text-white"
              >
                <Heart
                  className={`h-4 w-4 ${liked ? 'fill-yt-red text-yt-red' : 'fill-none text-yt-muted'}`}
                />
                J'aime
              </button>
            )}
            {onOffline && (
              <button
                type="button"
                onClick={startOffline}
                disabled={offlineDone || offlinePct != null}
                className="inline-flex items-center gap-2 rounded-full bg-yt-elevated px-4 py-2.5 text-sm text-yt-muted hover:text-white disabled:opacity-70"
                title="Télécharger hors-ligne"
              >
                {offlineDone ? (
                  <Check className="h-4 w-4 text-yt-red" />
                ) : offlinePct != null ? (
                  <span className="tabular-nums text-yt-red">{Math.round(offlinePct * 100)}%</span>
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {offlineDone
                  ? 'Téléchargé'
                  : offlinePct != null
                    ? 'Téléchargement…'
                    : 'Offline'}
              </button>
            )}
          </div>
        </div>
      </div>
      {tracks.map((t, i) => (
        <TrackRow key={`${t.id}-${i}`} track={t} index={i} queue={tracks} showAlbum />
      ))}
    </div>
  );
}
