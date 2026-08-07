import { Link, useNavigate } from 'react-router-dom';
import type { Track } from '../api';
import { usePlayer } from '../store/player';
import { Heart, MoreHorizontal, Pin, Play, Radio } from 'lucide-react';
import { useLibrary } from '../store/library';
import { useEffect, useState } from 'react';
import { ArtistLinks } from './ArtistLinks';
import { CoverImage } from './CoverImage';
import { formatTrackDuration } from '../lib/time';
import { useItemActions } from '../store/itemActions';
import { PlayingCoverOverlay } from './PlayingBars';
import { usePins } from '../store/pins';

type Props = {
  track: Track;
  index?: number;
  queue?: Track[];
  showAlbum?: boolean;
  /** Remplace le comportement de lecture (ex. file d'attente) */
  onPlay?: () => void;
  /** Index dans la file pour drag & drop */
  queueIndex?: number;
  draggable?: boolean;
  /** Affiche toujours like / radio / ⋮ (file d'attente) */
  alwaysActions?: boolean;
  /** Masque le numéro de piste (plus de place pour le titre) */
  hideIndex?: boolean;
  /** Contexte playlist locale (suppression) */
  playlistId?: string;
  onRemoveFromPlaylist?: () => void;
};

function isPlayable(t: Track) {
  return t.type === 'song' || t.type === 'video' || t.type === 'unknown' || /^[a-zA-Z0-9_-]{11}$/.test(t.id);
}

export function TrackRow({
  track,
  index,
  queue,
  showAlbum,
  onPlay,
  queueIndex,
  draggable,
  alwaysActions,
  hideIndex,
  playlistId,
  onRemoveFromPlaylist,
}: Props) {
  const play = usePlayer((s) => s.play);
  const startRadio = usePlayer((s) => s.startRadio);
  const moveInQueue = usePlayer((s) => s.moveInQueue);
  const current = usePlayer((s) => s.current);
  const isPlaying = usePlayer((s) => s.isPlaying);
  const { isLiked, toggleLike } = useLibrary();
  const openActions = useItemActions((s) => s.open);
  const pinned = usePins((s) => s.isPinned(track.id));
  const togglePin = usePins((s) => s.togglePin);
  const [dragging, setDragging] = useState(false);
  const [enriched, setEnriched] = useState<Track>(track);
  const [pinBusy, setPinBusy] = useState(false);
  const navigate = useNavigate();
  const active = current?.id === track.id;
  const liked = isLiked(track.id);
  const inQueue = typeof queueIndex === 'number';
  const showActions = alwaysActions || inQueue;

  useEffect(() => {
    setEnriched(track);
  }, [track]);

  const open = () => {
    if (onPlay) {
      onPlay();
      return;
    }
    if (track.type === 'artist') navigate(`/artist/${track.id}`);
    else if (track.type === 'album') navigate(`/album/${track.id}`);
    else if (track.type === 'playlist') navigate(`/playlist/${track.id}`);
    else void play(track, queue, { forceRestart: true });
  };

  const openMenu = (e?: { stopPropagation?: () => void; preventDefault?: () => void }) => {
    e?.stopPropagation?.();
    e?.preventDefault?.();
    openActions(enriched, {
      queueIndex,
      playlistId,
      onRemoveFromPlaylist,
    });
  };

  const albumId = enriched.album?.id;
  const albumName = enriched.album?.name;

  return (
    <div
      className={`group flex items-center gap-2.5 rounded-lg px-1.5 py-2 transition-colors hover:bg-yt-hover sm:gap-3 sm:px-2 ${
        active ? 'bg-yt-hover/80' : ''
      } ${dragging ? 'opacity-50' : ''} ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
      draggable={Boolean(draggable && typeof queueIndex === 'number')}
      onContextMenu={openMenu}
      onDragStart={(e) => {
        if (typeof queueIndex !== 'number') return;
        setDragging(true);
        e.dataTransfer.setData('text/queue-index', String(queueIndex));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragEnd={() => setDragging(false)}
      onDragOver={(e) => {
        if (!draggable || typeof queueIndex !== 'number') return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }}
      onDrop={(e) => {
        if (!draggable || typeof queueIndex !== 'number') return;
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/queue-index'));
        if (!Number.isFinite(from) || from === queueIndex) return;
        moveInQueue(from, queueIndex);
      }}
    >
      {typeof index === 'number' && !hideIndex ? (
        <span className="w-5 shrink-0 text-center text-xs tabular-nums text-yt-muted sm:w-6 sm:text-sm">
          {index + 1}
        </span>
      ) : null}

      <div className="relative shrink-0">
        <button
          type="button"
          onClick={open}
          className="relative flex h-11 w-11 items-center justify-center overflow-hidden rounded-md bg-yt-elevated sm:h-12 sm:w-12"
        >
          <CoverImage item={enriched} size={96} rounded="md" />
          <PlayingCoverOverlay active={active} playing={Boolean(active && isPlaying)} size="sm" />
          {!active && (
            <span className="absolute inset-0 z-[2] flex items-center justify-center bg-black/50 opacity-0 transition group-hover:opacity-100">
              <Play className="h-5 w-5 fill-white text-white" />
            </span>
          )}
        </button>
        {pinned && (
          <button
            type="button"
            title="Retirer de l'accès rapide"
            aria-label="Retirer de l'accès rapide"
            disabled={pinBusy}
            onClick={(e) => {
              e.stopPropagation();
              if (pinBusy) return;
              setPinBusy(true);
              void togglePin(enriched)
                .catch((err) => console.error(err))
                .finally(() => setPinBusy(false));
            }}
            className="absolute -left-1 -top-1 z-[3] flex h-5 w-5 items-center justify-center rounded-full bg-yt-red text-white shadow disabled:opacity-60"
          >
            <Pin className="h-2.5 w-2.5 fill-current" />
          </button>
        )}
      </div>

      <div className="min-w-0 flex-1 text-left">
        <button type="button" onClick={open} className="w-full text-left">
          <div
            className={`truncate text-[13px] font-medium leading-snug sm:text-sm ${
              active ? 'text-yt-red' : 'text-white'
            }`}
            title={track.title}
          >
            {track.title}
          </div>
        </button>
        <div className="truncate text-xs text-yt-muted">
          <ArtistLinks track={enriched} />
          {showAlbum && albumName ? (
            <>
              {' · '}
              {albumId ? (
                <Link
                  to={`/album/${albumId}`}
                  onClick={(e) => e.stopPropagation()}
                  className="hover:underline hover:text-white"
                >
                  {albumName}
                </Link>
              ) : (
                albumName
              )}
            </>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-0 sm:gap-0.5">
        <span className="mr-0.5 min-w-[2.5rem] text-right text-[11px] tabular-nums text-yt-muted sm:mr-1 sm:min-w-[2.75rem] sm:text-xs">
          {formatTrackDuration(track) || '—'}
        </span>
        <button
          type="button"
          title={liked ? 'Retirer des titres aimés' : "J'aime"}
          onClick={(e) => {
            e.stopPropagation();
            void toggleLike(track);
          }}
          className="flex h-9 w-9 items-center justify-center rounded-full text-yt-muted transition hover:bg-white/10 hover:text-white sm:h-10 sm:w-10"
        >
          <Heart
            className={`h-4 w-4 sm:h-5 sm:w-5 ${
              liked ? 'fill-yt-red text-yt-red' : 'fill-none text-yt-muted'
            }`}
          />
        </button>
        {isPlayable(track) && (
          <button
            type="button"
            title="Lancer un mix à partir de ce titre"
            aria-label="Lancer un mix à partir de ce titre"
            onClick={(e) => {
              e.stopPropagation();
              void startRadio({ kind: 'track', id: track.id, seed: track });
            }}
            className={`flex h-9 w-9 items-center justify-center rounded-full text-yt-muted transition hover:bg-white/10 hover:text-white sm:h-10 sm:w-10 ${
              showActions ? 'hidden opacity-100 sm:inline-flex' : 'opacity-0 group-hover:inline-flex'
            }`}
          >
            <Radio className="h-4 w-4 text-yt-red sm:h-5 sm:w-5" />
          </button>
        )}
        <button
          type="button"
          aria-label="Plus d'options"
          onClick={openMenu}
          className={`flex h-9 w-9 items-center justify-center rounded-full text-yt-muted transition hover:bg-white/10 hover:text-white sm:h-10 sm:w-10 ${
            showActions ? 'opacity-100' : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100'
          }`}
        >
          <MoreHorizontal className="h-4 w-4 sm:h-5 sm:w-5" />
        </button>
      </div>
    </div>
  );
}
