import { CoverImage } from './CoverImage';
import type { Track } from '../../api';
import { Library, MoreHorizontal, Pause, Pin, Play, Plus } from 'lucide-react';
import { useState, type MouseEvent } from 'react';
import { PlayingCoverOverlay } from '../player/PlayingBars';
import { useNowPlayingMatch } from '../../lib/player/nowPlaying';
import { usePins } from '../../store/pins';

/** Carte mix style album : mosaïque 2×2. Clic carte → ouvrir ; Play → lecture. */
export function MixCollageCard({
  id,
  title,
  tracks,
  onOpen,
  onPlay,
  /** @deprecated utiliser onOpen / onPlay */
  onClick,
  busy,
  subtitle = 'Mix',
  saved = false,
  playing = false,
  onSave,
  onMore,
}: {
  id?: string;
  title: string;
  tracks: Track[];
  onOpen?: () => void;
  onPlay?: () => void;
  onClick?: () => void;
  busy?: boolean;
  subtitle?: string;
  saved?: boolean;
  playing?: boolean;
  onSave?: () => void;
  onMore?: () => void;
}) {
  const open = onOpen || onClick || (() => undefined);
  const play = onPlay || onClick || open;
  const covers = tracks.slice(0, 4);
  while (covers.length < 4 && covers.length > 0) {
    covers.push(covers[covers.length % Math.max(1, tracks.length)]!);
  }
  const { active: nowActive, playing: nowPlaying } = useNowPlayingMatch({
    id: id || title,
    type: 'mix',
    tracks,
    covers: tracks,
  });
  const showPlaying = playing || nowActive;
  const pinned = usePins((s) => (id ? s.isPinned(id) : false));
  const togglePin = usePins((s) => s.togglePin);
  const [pinBusy, setPinBusy] = useState(false);

  const stop = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="group w-36 shrink-0 text-left sm:w-40">
      <div
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        }}
        className="relative aspect-square cursor-pointer overflow-hidden rounded-lg bg-yt-elevated shadow-md ring-1 ring-white/5 transition group-hover:ring-white/20 disabled:opacity-60"
      >
        {covers.length === 0 ? (
          <div className="grid h-full w-full grid-cols-2 grid-rows-2 gap-px bg-black/40">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex items-center justify-center bg-gradient-to-br from-[#3a3a3a] to-[#1a1a1a] text-lg font-semibold text-white/40"
              >
                {(title.trim().charAt(i % Math.max(1, title.trim().length)) || 'M').toUpperCase()}
              </div>
            ))}
          </div>
        ) : (
          <div className="grid h-full w-full grid-cols-2 grid-rows-2 gap-px bg-black/40">
            {covers.slice(0, 4).map((t, i) => (
              <div key={`${t.id}-${i}`} className="relative min-h-0 min-w-0 overflow-hidden bg-yt-elevated">
                <CoverImage item={t} size={200} rounded="none" className="h-full w-full" />
              </div>
            ))}
          </div>
        )}

        <PlayingCoverOverlay active={showPlaying} playing={playing || nowPlaying} size="md" />

        {pinned && id && (
          <button
            type="button"
            title="Retirer de l'accès rapide"
            aria-label="Retirer de l'accès rapide"
            disabled={pinBusy}
            onClick={(e) => {
              stop(e);
              if (pinBusy) return;
              setPinBusy(true);
              void togglePin({
                id,
                title,
                type: 'mix',
                thumbnails: tracks[0]?.thumbnails,
              })
                .catch((err) => console.error(err))
                .finally(() => setPinBusy(false));
            }}
            className="absolute left-2 top-2 z-[2] flex h-8 w-8 items-center justify-center rounded-full bg-yt-red text-white shadow-lg disabled:opacity-60"
          >
            <Pin className="h-3.5 w-3.5 fill-current" />
          </button>
        )}

        <button
          type="button"
          title={playing || nowPlaying ? 'Pause / relancer' : 'Lire'}
          disabled={busy}
          onClick={(e) => {
            stop(e);
            play();
          }}
          className={`absolute right-2 top-2 z-[2] flex h-10 w-10 items-center justify-center rounded-full bg-yt-red text-white shadow-lg transition sm:group-hover:opacity-100 disabled:opacity-60 ${
            showPlaying ? 'opacity-100' : 'opacity-100 sm:opacity-0'
          }`}
        >
          {playing || nowPlaying ? (
            <Pause className="h-5 w-5 fill-white" />
          ) : (
            <Play className="h-5 w-5 fill-white" />
          )}
        </button>

        <div className="pointer-events-none absolute bottom-2 right-2 z-[2] flex gap-1 opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100">
          {onMore && (
            <button
              type="button"
              title="Plus d'options"
              onClick={(e) => {
                stop(e);
                onMore();
              }}
              className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full bg-black/70 text-white shadow-lg"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          )}
          {onSave && (
            <button
              type="button"
              title={saved ? 'Dans la bibliothèque' : 'Enregistrer le mix'}
              disabled={busy || saved}
              onClick={(e) => {
                stop(e);
                if (!saved) onSave();
              }}
              className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full bg-black/70 text-white shadow-lg disabled:opacity-70"
            >
              {saved ? <Library className="h-4 w-4 text-yt-red" /> : <Plus className="h-4 w-4" />}
            </button>
          )}
        </div>

        {busy && (
          <div className="absolute inset-0 z-[3] flex items-center justify-center bg-black/50 text-xs font-medium text-white">
            …
          </div>
        )}
      </div>
      <div className="mt-2 px-0.5">
        <button
          type="button"
          onClick={open}
          className="block w-full truncate text-left text-sm font-medium hover:underline"
        >
          {title}
        </button>
        <div className="truncate text-xs text-yt-muted">{subtitle}</div>
      </div>
    </div>
  );
}
