import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, type Track } from '../../api';
import { TrackRow } from '../../components/media/TrackRow';
import { MediaCard } from '../../components/media/MediaCard';
import { HomeShelfSkeleton } from '../../components/media/HomeShelfSkeleton';
import { listCachedTracks } from '../../lib/offline/offlineCache';

const tabs = [
  { id: 'all', label: 'Tout' },
  { id: 'song', label: 'Titres' },
  { id: 'album', label: 'Albums' },
  { id: 'artist', label: 'Artistes' },
  { id: 'playlist', label: 'Playlists' },
  { id: 'video', label: 'Vidéos' },
  { id: 'podcast', label: 'Podcasts' },
  { id: 'audiobook', label: 'Livres audio' },
] as const;

function SearchListSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 py-2">
          <div className="h-12 w-12 shrink-0 animate-pulse rounded bg-yt-border/55" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3 w-2/3 animate-pulse rounded bg-yt-border/45" />
            <div className="h-2.5 w-2/5 animate-pulse rounded bg-yt-border/30" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q') || '';
  const [filter, setFilter] = useState<(typeof tabs)[number]['id']>('all');
  const [data, setData] = useState<{
    topResult: Track | null;
    songs: Track[];
    videos: Track[];
    albums: Track[];
    artists: Track[];
    playlists: Track[];
  } | null>(null);
  const [offlineHits, setOfflineHits] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const searchSeq = useRef(0);

  useEffect(() => {
    if (q) return;
    void api
      .searchHistory()
      .then((r) => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const h of r.history || []) {
          const query = String(h.query || '').trim();
          if (!query || seen.has(query.toLowerCase())) continue;
          seen.add(query.toLowerCase());
          out.push(query);
          if (out.length >= 12) break;
        }
        setHistory(out);
      })
      .catch(() => setHistory([]));
  }, [q]);

  useEffect(() => {
    if (!q) {
      setData(null);
      setOfflineHits([]);
      setLoading(false);
      setError('');
      return;
    }
    const seq = ++searchSeq.current;
    setLoading(true);
    setError('');
    setData(null);
    const needle = q.trim().toLowerCase();
    const wantLocal = filter === 'all' || filter === 'song' || filter === 'video';
    void (wantLocal
      ? listCachedTracks().then((tracks) =>
          tracks.filter((t) => {
            const title = String(t.title || '').toLowerCase();
            const artists = (t.artists || []).map((a) => a.name || '').join(' ').toLowerCase();
            const album = String(t.album?.name || '').toLowerCase();
            return title.includes(needle) || artists.includes(needle) || album.includes(needle);
          }),
        )
      : Promise.resolve([] as Track[])
    ).then((local) => {
      if (searchSeq.current !== seq) return;
      setOfflineHits(local);
    });
    api
      .search(q, filter)
      .then((res) => {
        if (searchSeq.current !== seq) return;
        setData(res);
      })
      .catch((e) => {
        if (searchSeq.current !== seq) return;
        setError(String(e.message || e));
      })
      .finally(() => {
        if (searchSeq.current === seq) setLoading(false);
      });
  }, [q, filter]);

  const noteClick = (track: Track) => {
    if (!q) return;
    void api.recordSearchClick(q, track);
  };

  if (!q) {
    return (
      <div className="animate-fade-up">
        <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight">Recherche</h1>
        <p className="mb-6 text-sm text-yt-muted">
          Suggestions perso dans la barre du haut · micro (dictée) · note (écouter / fredonner).
        </p>
        {history.length > 0 ? (
          <section>
            <h2 className="mb-3 text-sm uppercase tracking-wide text-yt-muted">Récentes</h2>
            <div className="flex flex-wrap gap-2">
              {history.map((h) => (
                <Link
                  key={h}
                  to={`/search?q=${encodeURIComponent(h)}`}
                  className="rounded-full bg-yt-elevated px-4 py-2 text-sm text-yt-muted hover:text-white"
                >
                  {h}
                </Link>
              ))}
            </div>
          </section>
        ) : (
          <p className="text-yt-muted">Tape une recherche dans la barre du haut.</p>
        )}
      </div>
    );
  }

  return (
    <div className="animate-fade-up">
      <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight">Résultats</h1>
      <p className="mb-4 text-sm text-yt-muted">Pour « {q} »</p>

      <div className="mb-6 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setFilter(t.id)}
            className={`rounded-full px-4 py-1.5 text-sm transition ${
              filter === t.id ? 'bg-white text-black' : 'bg-yt-elevated text-yt-muted hover:text-white'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && (
        filter === 'song' || filter === 'all' ? (
          <div className="space-y-8">
            <SearchListSkeleton />
            {filter === 'all' && <HomeShelfSkeleton rows={1} />}
          </div>
        ) : (
          <HomeShelfSkeleton rows={2} />
        )
      )}
      {error && (
        <div className="mb-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <p>{error.includes('Bad Gateway') || error.includes('502')
            ? 'API indisponible (Bad Gateway). Vérifie que make up / ensure-api tourne.'
            : error}</p>
          <button
            type="button"
            className="mt-2 text-xs underline opacity-80 hover:opacity-100"
            onClick={() => {
              setLoading(true);
              setError('');
              api
                .search(q, filter)
                .then(setData)
                .catch((e) => setError(String(e.message || e)))
                .finally(() => setLoading(false));
            }}
          >
            Réessayer
          </button>
        </div>
      )}

      {offlineHits.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 font-display text-xl font-semibold">Sur l&apos;appareil</h2>
          <div className="space-y-1">
            {offlineHits.slice(0, 40).map((t) => (
              <TrackRow
                key={`off-${t.id}`}
                track={t}
                queue={offlineHits}
                showAlbum
                alwaysActions
              />
            ))}
          </div>
        </section>
      )}

      {data && (
        <div key={`${q}::${filter}`} className="space-y-8">
          {data.topResult && filter === 'all' && !offlineHits.some((t) => t.id === data.topResult?.id) && (
            <section>
              <h2 className="mb-3 font-display text-xl font-semibold">Meilleur résultat</h2>
              {data.topResult.type === 'artist' ||
              data.topResult.type === 'album' ||
              data.topResult.type === 'playlist' ? (
                <div className="max-w-xs" onClick={() => noteClick(data.topResult!)}>
                  <MediaCard item={data.topResult} />
                </div>
              ) : (
                <div
                  className="rounded-xl bg-[#ff0033]/12 ring-1 ring-[#ff0033]/40"
                  onClick={() => noteClick(data.topResult!)}
                >
                  <TrackRow
                    track={data.topResult}
                    queue={data.songs.length ? data.songs : [data.topResult]}
                    showAlbum
                    alwaysActions
                  />
                </div>
              )}
            </section>
          )}

          {data.songs.length > 0 &&
            (filter === 'all' || filter === 'song' || filter === 'podcast' || filter === 'audiobook') && (
            <section>
              <h2 className="mb-3 font-display text-xl font-semibold">
                {filter === 'podcast'
                  ? 'Podcasts'
                  : filter === 'audiobook'
                    ? 'Livres audio'
                    : 'Titres'}
              </h2>
              <div className="space-y-0.5">
                {data.songs.slice(0, filter === 'all' ? 12 : 40).map((t) => (
                  <div key={t.id} onClick={() => noteClick(t)}>
                    <TrackRow track={t} queue={data.songs} showAlbum />
                  </div>
                ))}
              </div>
            </section>
          )}

          {data.artists.length > 0 && (filter === 'all' || filter === 'artist') && (
            <section>
              <h2 className="mb-3 font-display text-xl font-semibold">Artistes</h2>
              <div className="shelf-scroll">
                {data.artists.map((a) => (
                  <div key={a.id} onClick={() => noteClick(a)}>
                    <MediaCard item={{ ...a, type: 'artist' }} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {data.albums.length > 0 && (filter === 'all' || filter === 'album') && (
            <section>
              <h2 className="mb-3 font-display text-xl font-semibold">Albums</h2>
              <div className="shelf-scroll">
                {data.albums.map((a) => (
                  <MediaCard key={a.id} item={{ ...a, type: 'album' }} />
                ))}
              </div>
            </section>
          )}

          {data.playlists.length > 0 && (filter === 'all' || filter === 'playlist') && (
            <section>
              <h2 className="mb-3 font-display text-xl font-semibold">Playlists</h2>
              <div className="shelf-scroll">
                {data.playlists.map((p) => (
                  <MediaCard key={p.id} item={{ ...p, type: 'playlist' }} />
                ))}
              </div>
            </section>
          )}

          {data.videos.length > 0 && (filter === 'all' || filter === 'video') && (
            <section>
              <h2 className="mb-3 font-display text-xl font-semibold">Vidéos</h2>
              <div className="space-y-0.5">
                {data.videos.slice(0, 12).map((t) => (
                  <TrackRow key={t.id} track={t} queue={data.videos} />
                ))}
              </div>
            </section>
          )}

          {!loading &&
            !data.topResult &&
            !data.songs.length &&
            !data.artists.length &&
            !data.albums.length &&
            !data.playlists.length &&
            !data.videos.length && (
              <p className="text-yt-muted">
                Aucun résultat pour « {q} ». Essaie un autre filtre ou une orthographe différente.
              </p>
            )}
        </div>
      )}
    </div>
  );
}
