import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLibrary } from '../../store/library';
import { TrackRow } from '../../components/media/TrackRow';
import { Heart, Play, Plus, Shuffle, Trash2, X } from 'lucide-react';
import { usePlayer } from '../../store/player';
import { MediaCard } from '../../components/media/MediaCard';
import { CoverImage } from '../../components/media/CoverImage';
import { MixCollageCard } from '../../components/media/MixCollageCard';
import { useItemActions } from '../../store/itemActions';
import { HomeShelfSkeleton } from '../../components/media/HomeShelfSkeleton';
import { api, type Track } from '../../api';
import { formatTotalDuration, sumTracksDurationSeconds } from '../../lib/util/time';
import { warmFormats } from '../../lib/audio/streamPrefetch';

function shuffleTracks(tracks: Track[]) {
  const copy = [...tracks];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function LibraryListSkeleton({ rows = 8 }: { rows?: number }) {
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

export function LibraryPage() {
  const navigate = useNavigate();
  const { songs, liked, playlists, history, recentEntities, albums, artists, mixes, likedPlaylists, createPlaylist, deletePlaylist, hasMix, loaded, error, refresh } =
    useLibrary();
  const playQueue = usePlayer((s) => s.playQueue);
  const openActions = useItemActions((s) => s.open);
  const [tab, setTab] = useState<'ajouts' | 'titres' | 'liked' | 'playlists' | 'albums' | 'artists' | 'mixes' | 'history' | 'podcasts' | 'audiobooks'>('ajouts');
  const [name, setName] = useState('');

  const tabs = [
    ['ajouts', 'Ajouts'],
    ['titres', 'Titres'],
    ['liked', "J'aime"],
    ['playlists', 'Playlists'],
    ['albums', 'Albums'],
    ['mixes', mixes.length ? `Mixes (${mixes.length})` : 'Mixes'],
    ['artists', 'Artistes'],
    ['podcasts', 'Podcasts'],
    ['audiobooks', 'Livres audio'],
    ['history', 'Historique'],
  ] as const;

  const spokenFromLib = (kind: 'podcast' | 'audiobook') => {
    const pool = [...songs, ...liked, ...albums];
    return pool.filter((t) => {
      const typ = String(t.type || '').toLowerCase();
      const title = String(t.title || '').toLowerCase();
      if (kind === 'audiobook') {
        return typ.includes('audiobook') || typ.includes('livre') || title.includes('audiobook') || title.includes('livre audio');
      }
      return typ.includes('podcast') || title.includes('podcast') || title.includes('épisode');
    });
  };

  return (
    <div className="animate-fade-up">
      <h1 className="mb-6 font-display text-3xl font-semibold tracking-tight">Bibliothèque</h1>

      {error && (
        <div className="mb-4 rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <p>{error}</p>
          <button
            type="button"
            className="mt-2 text-xs underline opacity-80 hover:opacity-100"
            onClick={() => void refresh()}
          >
            Réessayer
          </button>
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-2">
        {tab !== 'ajouts' && (
          <button
            type="button"
            onClick={() => setTab('ajouts')}
            className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-1.5 text-sm text-black"
            title="Fermer le filtre · retour bibliothèque"
          >
            {tabs.find(([id]) => id === tab)?.[1] ?? tab}
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        {tabs
          .filter(([id]) => id !== 'ajouts' && id !== tab)
          .map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className="rounded-full bg-yt-elevated px-4 py-1.5 text-sm text-yt-muted hover:text-white"
            >
              {label}
            </button>
          ))}
        {tab === 'ajouts' &&
          tabs
            .filter(([id]) => id !== 'ajouts')
            .map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className="rounded-full bg-yt-elevated px-4 py-1.5 text-sm text-yt-muted hover:text-white"
              >
                {label}
              </button>
            ))}
      </div>

      {!loaded && tab !== 'podcasts' && tab !== 'audiobooks' ? (
        tab === 'titres' || tab === 'liked' || tab === 'history' || tab === 'ajouts' ? (
          <LibraryListSkeleton />
        ) : (
          <HomeShelfSkeleton rows={2} />
        )
      ) : null}

      {loaded && tab === 'ajouts' && (
        <div>
          <p className="mb-4 text-sm text-yt-muted">Enregistré récemment dans ta bibliothèque.</p>
          {songs.length === 0 && albums.length === 0 && playlists.length === 0 && mixes.length === 0 ? (
            <p className="text-yt-muted">Rien d&apos;enregistré pour l&apos;instant.</p>
          ) : (
            <>
              {[...songs.slice(0, 30)].map((t) => (
                <TrackRow key={t.id} track={t} queue={songs} showAlbum />
              ))}
              {albums.slice(0, 12).length > 0 && (
                <div className="mt-6 shelf-scroll">
                  {albums.slice(0, 12).map((a) => (
                    <MediaCard key={`alb-${a.id}`} item={{ ...a, type: a.type || 'album' }} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {loaded && tab === 'titres' && (
        <div>
          <p className="mb-4 text-sm text-yt-muted">
            Titres enregistrés dans ta bibliothèque (indépendant des J&apos;aime).
          </p>
          {songs.length === 0 ? (
            <p className="text-yt-muted">
              Aucun titre. Utilise « Enregistrer dans la bibliothèque » sur un morceau.
            </p>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void playQueue(songs, 0)}
                  className="inline-flex items-center gap-2 rounded-full bg-yt-red px-5 py-2.5 text-sm font-medium"
                >
                  <Play className="h-4 w-4 fill-white" /> Tout lire
                </button>
                <button
                  type="button"
                  onClick={() => void playQueue(shuffleTracks(songs), 0)}
                  className="inline-flex items-center gap-2 rounded-full bg-yt-elevated px-5 py-2.5 text-sm font-medium text-yt-muted hover:text-white"
                >
                  <Shuffle className="h-4 w-4" /> Aléatoire
                </button>
              </div>
              {songs.map((t) => (
                <TrackRow key={t.id} track={t} queue={songs} showAlbum />
              ))}
            </>
          )}
        </div>
      )}

      {loaded && tab === 'liked' && (
        <div>
          <p className="mb-4 text-sm text-yt-muted">
            Tes titres aimés — le cœur uniquement, sans obligation de les enregistrer.
          </p>
          {liked.length === 0 ? (
            <p className="text-yt-muted">Aucun J&apos;aime pour l&apos;instant.</p>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void playQueue(liked, 0)}
                  className="inline-flex items-center gap-2 rounded-full bg-yt-red px-5 py-2.5 text-sm font-medium"
                >
                  <Play className="h-4 w-4 fill-white" /> Tout lire
                </button>
                <button
                  type="button"
                  onClick={() => void playQueue(shuffleTracks(liked), 0)}
                  className="inline-flex items-center gap-2 rounded-full bg-yt-elevated px-5 py-2.5 text-sm font-medium text-yt-muted hover:text-white"
                >
                  <Shuffle className="h-4 w-4" /> Aléatoire
                </button>
              </div>
              {liked.map((t) => (
                <TrackRow key={t.id} track={t} queue={liked} showAlbum />
              ))}
            </>
          )}
        </div>
      )}

      {loaded && tab === 'history' && (
        <div>
          <p className="mb-4 text-sm text-yt-muted">
            Titres démarrés et collections lancées récemment.
          </p>
          {recentEntities.length > 0 && (
            <section className="mb-8">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-yt-muted">
                Playlists & albums récents
              </h2>
              <div className="shelf-scroll">
                {recentEntities.map((item) => (
                  <MediaCard key={`ent-${item.type}-${item.id}`} item={item} />
                ))}
              </div>
            </section>
          )}
          {history.length === 0 ? (
            <p className="text-yt-muted">L&apos;historique apparaîtra dès que tu lances un titre.</p>
          ) : (
            <>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-yt-muted">
                Titres
              </h2>
              <div className="mb-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void playQueue(history, 0)}
                  className="inline-flex items-center gap-2 rounded-full bg-yt-red px-5 py-2.5 text-sm font-medium"
                >
                  <Play className="h-4 w-4 fill-white" /> Tout lire
                </button>
                <button
                  type="button"
                  onClick={() => void playQueue(shuffleTracks(history), 0)}
                  className="inline-flex items-center gap-2 rounded-full bg-yt-elevated px-5 py-2.5 text-sm font-medium text-yt-muted hover:text-white"
                >
                  <Shuffle className="h-4 w-4" /> Aléatoire
                </button>
              </div>
              {history.map((t) => (
                <TrackRow key={t.id} track={t} queue={history} showAlbum />
              ))}
            </>
          )}
        </div>
      )}

      {loaded && tab === 'albums' && (
        <div>
          {albums.length === 0 ? (
            <p className="text-yt-muted">Ajoute des albums via Importer ou le bouton « Ajouter à la bibliothèque ».</p>
          ) : (
            <>
              <p className="mb-4 text-sm text-yt-muted">Ouvre un album pour Lecture ou Aléatoire.</p>
              <div className="shelf-scroll">
                {albums.map((a: any) => (
                  <MediaCard
                    key={a.id}
                    item={{
                      id: a.id,
                      title: a.title,
                      artists: a.artists || [],
                      thumbnails: a.thumbnails || [],
                      type: 'album',
                    }}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {loaded && tab === 'mixes' && (
        <div>
          {mixes.length === 0 ? (
            <p className="text-yt-muted">
              Aucun mix enregistré. Sur Accueil → Mixés pour toi, appuie sur + ou ⋮ pour en sauver.
            </p>
          ) : (
            <>
              <p className="mb-4 text-sm text-yt-muted">
                {mixes.length} mix{mixes.length > 1 ? 'es' : ''} · lecture depuis ta bibliothèque.
              </p>
              <div className="shelf-scroll">
                {mixes.map((m: any) => {
                  const mixTracks = (m.tracks || m.covers || []) as Track[];
                  const total = formatTotalDuration(sumTracksDurationSeconds(mixTracks));
                  return (
                  <MixCollageCard
                    key={m.id}
                    id={m.id}
                    title={m.title}
                    tracks={(m.covers || m.tracks || []) as Track[]}
                    subtitle={
                      [
                        'Mix enregistré',
                        mixTracks.length
                          ? `${mixTracks.length} titre${mixTracks.length !== 1 ? 's' : ''}`
                          : '',
                        total,
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    }
                    saved={hasMix(m.id)}
                    onOpen={() => navigate(`/mix/${encodeURIComponent(m.id)}`)}
                    onPlay={() => {
                      const tracks = (m.tracks || m.covers || []).filter((t: Track) =>
                        /^[a-zA-Z0-9_-]{11}$/.test(t.id),
                      );
                      if (tracks.length) {
                        void playQueue(tracks, 0, { sourceId: m.id, sourceKind: 'mix' });
                        void warmFormats(tracks.slice(0, 3).map((t: Track) => t.id));
                      } else {
                        void api.recoRadio(m.id).then((r) => {
                          if (r.tracks?.length) {
                            void playQueue(r.tracks, 0, { sourceId: m.id, sourceKind: 'mix' });
                            void warmFormats(r.tracks.slice(0, 3).map((t) => t.id));
                          }
                        });
                      }
                    }}
                    onMore={() =>
                      openActions({
                        ...m,
                        type: 'mix',
                        artists: [{ name: 'Mix radio' }],
                      } as Track)
                    }
                  />
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {loaded && tab === 'artists' && (
        <div>
          {artists.length === 0 ? (
            <p className="text-yt-muted">Ajoute des artistes à ta bibliothèque pour les retrouver ici.</p>
          ) : (
            <>
              <p className="mb-4 text-sm text-yt-muted">Ouvre un artiste pour ses titres et sa radio.</p>
              <div className="shelf-scroll">
                {artists.map((a: any) => (
                  <MediaCard
                    key={a.id}
                    item={{
                      id: a.id,
                      title: a.name || a.title,
                      artists: [],
                      thumbnails: a.thumbnails || [],
                      type: 'artist',
                    }}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {loaded && tab === 'playlists' && (
        <div>
          <form
            className="mb-6 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              void createPlaylist(name.trim());
              setName('');
            }}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nom de la playlist"
              className="flex-1 rounded-full border border-yt-border bg-yt-surface px-4 py-2 text-sm outline-none focus:border-white/30"
            />
            <button
              type="submit"
              className="flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium text-black"
            >
              <Plus className="h-4 w-4" /> Créer
            </button>
          </form>

          {(() => {
            const allLocalTracks = playlists
              .flatMap((p) => p.tracks || [])
              .filter((t) => /^[a-zA-Z0-9_-]{11}$/.test(t.id));
            const unique = [...new Map(allLocalTracks.map((t) => [t.id, t])).values()];
            if (unique.length === 0) {
              return playlists.length + likedPlaylists.length > 0 ? (
                <p className="mb-4 text-sm text-yt-muted">Ouvre une playlist pour lancer la lecture.</p>
              ) : null;
            }
            return (
              <div className="mb-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void playQueue(unique, 0)}
                  className="inline-flex items-center gap-2 rounded-full bg-yt-red px-5 py-2.5 text-sm font-medium"
                >
                  <Play className="h-4 w-4 fill-white" /> Tout lire
                </button>
                <button
                  type="button"
                  onClick={() => void playQueue(shuffleTracks(unique), 0)}
                  className="inline-flex items-center gap-2 rounded-full bg-yt-elevated px-5 py-2.5 text-sm font-medium text-yt-muted hover:text-white"
                >
                  <Shuffle className="h-4 w-4" /> Aléatoire
                </button>
              </div>
            );
          })()}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <button
              type="button"
              onClick={() => setTab('liked')}
              className="rounded-xl bg-yt-elevated p-4 text-left transition hover:bg-yt-hover"
            >
              <div className="mb-3 flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-yt-red to-yt-red-dim">
                <Heart className="h-16 w-16 fill-white text-white" />
              </div>
              <div className="font-medium">Titres aimés</div>
              <div className="text-xs text-yt-muted">
                {[
                  `Playlist automatique · ${liked.length} titre${liked.length !== 1 ? 's' : ''}`,
                  formatTotalDuration(sumTracksDurationSeconds(liked)),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </div>
            </button>

            {likedPlaylists.map((p: any) => (
              <Link
                key={p.id}
                to={`/playlist/${p.id}`}
                className="rounded-xl bg-yt-elevated p-4 transition hover:bg-yt-hover"
              >
                <div className="mb-3 aspect-square overflow-hidden rounded-lg bg-yt-border">
                  <CoverImage
                    item={{ title: p.title, thumbnails: p.thumbnails || [] }}
                    size={400}
                    rounded="lg"
                  />
                </div>
                <div className="font-medium">{p.title}</div>
                <div className="text-xs text-yt-muted">{p.author || 'YouTube'} · aimée</div>
              </Link>
            ))}

            {playlists.map((p) => (
              <div key={p.id} className="rounded-xl bg-yt-elevated p-4 transition hover:bg-yt-hover">
                <Link to={`/local-playlist/${p.id}`} className="block">
                  <div className="mb-3 aspect-square overflow-hidden rounded-lg bg-yt-border">
                    <CoverImage
                      item={
                        p.coverUrl
                          ? { title: p.name, thumbnails: [{ url: p.coverUrl }] }
                          : p.tracks[0] || { title: p.name, thumbnails: [] }
                      }
                      size={400}
                      rounded="lg"
                    />
                  </div>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-yt-muted">
                    {[
                      `${p.trackCount ?? p.tracks.length} titre${(p.trackCount ?? p.tracks.length) !== 1 ? 's' : ''}`,
                      formatTotalDuration(sumTracksDurationSeconds(p.tracks || [])),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </Link>
                <button
                  type="button"
                  onClick={() => void deletePlaylist(p.id)}
                  className="mt-3 flex items-center gap-1 text-xs text-yt-muted hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Supprimer
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {(tab === 'podcasts' || tab === 'audiobooks') && (
        <div>
          <p className="mb-4 text-sm text-yt-muted">
            {tab === 'podcasts'
              ? 'Uniquement les podcasts ajoutés à ta bibliothèque.'
              : 'Uniquement les livres audio ajoutés à ta bibliothèque.'}
          </p>
          {(() => {
            const items = spokenFromLib(tab === 'audiobooks' ? 'audiobook' : 'podcast');
            if (!items.length) {
              return (
                <p className="text-yt-muted">
                  Aucun élément ajouté. Enregistre via ⋮ → bibliothèque (ou Recherche).
                </p>
              );
            }
            return (
              <>
                <div className="mb-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void playQueue(items, 0)}
                    className="inline-flex items-center gap-2 rounded-full bg-yt-red px-5 py-2.5 text-sm font-medium"
                  >
                    <Play className="h-4 w-4 fill-white" /> Tout lire
                  </button>
                  <button
                    type="button"
                    onClick={() => void playQueue(shuffleTracks(items), 0)}
                    className="inline-flex items-center gap-2 rounded-full bg-yt-elevated px-5 py-2.5 text-sm font-medium"
                  >
                    <Shuffle className="h-4 w-4" /> Aléatoire
                  </button>
                </div>
                <div className="space-y-0.5">
                  {items.map((t) => (
                    <TrackRow key={t.id} track={t} queue={items} showAlbum />
                  ))}
                </div>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}
