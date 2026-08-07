import { Link, useNavigate } from 'react-router-dom';
import type { Track } from '../api';
import { api } from '../api';
import { usePlayer } from '../store/player';
import { Check, Library, MoreHorizontal, Pin, Play, Plus } from 'lucide-react';
import { ArtistLinks } from './ArtistLinks';
import { CoverImage } from './CoverImage';
import { useLibrary } from '../store/library';
import { usePins } from '../store/pins';
import { useState, type MouseEvent } from 'react';
import { useItemActions } from '../store/itemActions';
import { PlayingCoverOverlay } from './PlayingBars';
import { useNowPlayingMatch } from '../lib/nowPlaying';

function isLocalPlaylist(item: Track) {
  return item.id.startsWith('local:') || item.album?.id?.startsWith('local:');
}

function localPlaylistId(item: Track) {
  if (item.id.startsWith('local:')) return item.id.slice(6);
  if (item.album?.id?.startsWith('local:')) return item.album.id.slice(6);
  return item.id;
}

export function MediaCard({ item, queue }: { item: Track; queue?: Track[] }) {
  const play = usePlayer((s) => s.play);
  const playQueue = usePlayer((s) => s.playQueue);
  const navigate = useNavigate();
  const openActions = useItemActions((s) => s.open);
  const { applyLibrary, isPlaylistLiked, hasAlbum, hasArtist, isInLibrary } = useLibrary();
  const pinned = usePins((s) => s.isPinned(item.id));
  const togglePin = usePins((s) => s.togglePin);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [playBusy, setPlayBusy] = useState(false);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinToast, setPinToast] = useState<string | null>(null);
  const { active: nowActive, playing: nowPlaying } = useNowPlayingMatch(item);

  const local = isLocalPlaylist(item);
  const isMood = item.id.startsWith('mood:') || item.id.includes('moods_and_genres');
  const href = local
    ? `/local-playlist/${localPlaylistId(item)}`
    : isMood
      ? `/mood/${encodeURIComponent(item.id.replace(/^mood:/, ''))}?title=${encodeURIComponent(item.title)}`
      : item.type === 'artist'
        ? `/artist/${item.id}`
        : item.type === 'album'
          ? `/album/${item.id}`
          : item.type === 'playlist'
            ? `/playlist/${item.id}`
            : null;

  const inLib =
    saved ||
    (item.type === 'playlist' && !local && isPlaylistLiked(item.id)) ||
    (item.type === 'album' && hasAlbum(item.id)) ||
    (item.type === 'artist' && hasArtist(item.id)) ||
    ((item.type === 'song' || item.type === 'video' || item.type === 'unknown') && isInLibrary(item.id));

  const openItem = () => {
    if (href) {
      navigate(href);
      return;
    }
    void play(item, queue, { forceRestart: true });
  };

  /** Bouton Play : lance vraiment l’album/playlist (pas seulement naviguer). */
  const onPlay = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (playBusy) return;

    if (isMood && href) {
      navigate(href);
      return;
    }

    if (item.type === 'album' && !local) {
      setPlayBusy(true);
      void api
        .album(item.id)
        .then((r) => {
          if (r.tracks?.length) void playQueue(r.tracks, 0, { sourceId: item.id, sourceKind: 'album' });
          else if (href) navigate(href);
        })
        .catch(() => {
          if (href) navigate(href);
        })
        .finally(() => setPlayBusy(false));
      return;
    }

    if ((item.type === 'playlist' || local) && !isMood) {
      setPlayBusy(true);
      if (local) {
        const pl = useLibrary.getState().playlists.find((p) => p.id === localPlaylistId(item));
        const tracks = pl?.tracks || [];
        if (tracks.length) {
          void playQueue(tracks, 0, { sourceId: item.id, sourceKind: 'playlist' });
        } else if (href) navigate(href);
        setPlayBusy(false);
        return;
      }
      void api
        .playlist(item.id)
        .then((r) => {
          if (r.tracks?.length) {
            void playQueue(r.tracks, 0, { sourceId: item.id, sourceKind: 'playlist' });
          } else if (href) navigate(href);
        })
        .catch(() => {
          if (href) navigate(href);
        })
        .finally(() => setPlayBusy(false));
      return;
    }

    if (href && item.type === 'artist') {
      navigate(href);
      return;
    }
    void play(item, queue, { forceRestart: true });
  };

  const openMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openActions(item);
  };

  const addLibrary = async (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy || inLib || local) return;
    setBusy(true);
    try {
      if (item.type === 'playlist') {
        // Aimer la playlist seulement — pas de copie de tous les titres
        const r = await api.likePlaylist({
          id: item.id,
          title: item.title,
          thumbnails: item.thumbnails,
          type: 'playlist',
        });
        applyLibrary(r.library);
        setSaved(true);
      } else if (item.type === 'album') {
        const r = await api.saveAlbum({
          id: item.id,
          title: item.title,
          artists: item.artists,
          thumbnails: item.thumbnails,
          type: 'album',
        });
        applyLibrary(r.library);
        setSaved(true);
      } else if (item.type === 'artist') {
        const r = await api.saveArtist({
          id: item.id,
          name: item.title,
          title: item.title,
          thumbnails: item.thumbnails,
          type: 'artist',
        });
        applyLibrary(r.library);
        setSaved(true);
      } else if (/^[a-zA-Z0-9_-]{11}$/.test(item.id)) {
        const r = await api.toggleLibrarySong(item);
        applyLibrary(r.library);
        setSaved(r.saved);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(false);
    }
  };

  const onTogglePin = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (pinBusy) return;
    setPinBusy(true);
    void togglePin(item)
      .then((r) => {
        setPinToast(r === 'pinned' ? 'Épinglé' : 'Retiré');
        window.setTimeout(() => setPinToast(null), 1600);
      })
      .catch((err) => console.error(err))
      .finally(() => setPinBusy(false));
  };

  const cover = (
    <div
      className={`relative overflow-hidden bg-yt-elevated ${
        item.type === 'artist' ? 'rounded-full' : 'rounded-lg'
      }`}
    >
      <div
        role="button"
        tabIndex={0}
        className="aspect-square cursor-pointer"
        onClick={openItem}
        onContextMenu={openMenu}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openItem();
          }
        }}
      >
        <CoverImage
          item={item}
          size={400}
          rounded={item.type === 'artist' ? 'full' : 'lg'}
          className="transition duration-300 group-hover:scale-[1.03]"
        />
        <PlayingCoverOverlay active={nowActive} playing={nowPlaying} size="md" />
      </div>
      {/* Épingle toujours visible si épinglé (pas seulement au survol) */}
      {pinned && (
        <button
          type="button"
          title="Retirer de l'accès rapide"
          aria-label="Retirer de l'accès rapide"
          disabled={pinBusy}
          onClick={onTogglePin}
          className="absolute left-2 top-2 z-[2] flex h-8 w-8 items-center justify-center rounded-full bg-yt-red text-white shadow-lg disabled:opacity-60"
        >
          <Pin className="h-3.5 w-3.5 fill-current" />
        </button>
      )}
      <div className="pointer-events-none absolute bottom-2 right-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
        <button
          type="button"
          title="Plus d'options"
          onClick={openMenu}
          className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full bg-black/70 text-white shadow-lg"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {!pinned && (
          <button
            type="button"
            title="Épingler à l’accès rapide"
            disabled={pinBusy}
            onClick={onTogglePin}
            className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full bg-black/70 text-white shadow-lg"
          >
            <Pin className="h-4 w-4" />
          </button>
        )}
        {(item.type === 'playlist' || item.type === 'album' || item.type === 'artist') && !local && (
          <button
            type="button"
            title={inLib ? 'Dans la bibliothèque' : 'Ajouter à la bibliothèque'}
            disabled={busy || inLib}
            onClick={addLibrary}
            className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full bg-black/70 text-white shadow-lg disabled:opacity-50"
          >
            {inLib ? <Library className="h-4 w-4 text-yt-red" /> : <Plus className="h-4 w-4" />}
          </button>
        )}
        {(item.type === 'song' || item.type === 'video' || item.type === 'unknown' || !href) && (
          <button
            type="button"
            onClick={onPlay}
            disabled={playBusy}
            className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-yt-red text-white shadow-lg disabled:opacity-60"
          >
            <Play className="h-5 w-5 fill-white" />
          </button>
        )}
        {(item.type === 'playlist' || item.type === 'album') && (
          <button
            type="button"
            onClick={onPlay}
            disabled={playBusy}
            title="Lire"
            className="pointer-events-auto flex h-10 w-10 items-center justify-center rounded-full bg-yt-red text-white shadow-lg disabled:opacity-60"
          >
            <Play className="h-5 w-5 fill-white" />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="group relative w-40 shrink-0 text-left sm:w-44" onContextMenu={openMenu}>
      {cover}
      {pinToast && (
        <div className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-full bg-black/85 px-2.5 py-1 text-[11px] font-medium text-white shadow-lg">
          {pinToast === 'Épinglé' ? (
            <span className="inline-flex items-center gap-1">
              <Check className="h-3 w-3 text-emerald-400" /> Épinglé
            </span>
          ) : (
            pinToast
          )}
        </div>
      )}
      <div className="mt-2 flex items-start gap-1 px-0.5">
        <div className="min-w-0 flex-1">
          {href ? (
            <Link to={href} className="block truncate text-sm font-medium hover:underline">
              {item.title}
            </Link>
          ) : (
            <button
              type="button"
              className="block w-full truncate text-left text-sm font-medium"
              onClick={() => void play(item, queue, { forceRestart: true })}
            >
              {item.title}
            </button>
          )}
          <div className="truncate text-xs text-yt-muted">
            {item.id.startsWith('mood:') || item.id.includes('moods_and_genres')
              ? 'Ambiance'
              : item.type === 'artist'
                ? 'Artiste'
                : item.type === 'playlist'
                  ? item.artists?.length
                    ? <ArtistLinks track={item} />
                    : 'Playlist'
                  : item.type === 'album'
                    ? item.artists?.length
                      ? <ArtistLinks track={item} />
                      : 'Album'
                    : item.artists?.length
                      ? <ArtistLinks track={item} />
                      : item.type === 'song' || item.type === 'video'
                        ? 'Titre'
                        : item.type}
          </div>
        </div>
        <button
          type="button"
          aria-label="Plus d'options"
          onClick={openMenu}
          className="shrink-0 rounded-full p-1 text-yt-muted opacity-100 transition hover:text-white sm:opacity-0 sm:group-hover:opacity-100"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export function ShelfRow({ title, items }: { title: string; items: Track[] }) {
  if (!items.length) return null;
  return (
    <section className="animate-fade-up mb-8">
      {title ? <h2 className="mb-3 font-display text-xl font-semibold tracking-tight">{title}</h2> : null}
      <div className="shelf-scroll">
        {items.map((item, i) => (
          <MediaCard key={`${title}-${item.id}-${i}`} item={item} queue={items} />
        ))}
      </div>
    </section>
  );
}
