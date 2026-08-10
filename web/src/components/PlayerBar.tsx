import type { PointerEvent as ReactPointerEvent, SyntheticEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  Cast,
  Heart,
  Moon,
  MoreVertical,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  ThumbsDown,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { api, artistNames } from '../api';
import { usePlayer } from '../store/player';
import { useLibrary } from '../store/library';
import { useSession } from '../store/session';
import { useItemActions } from '../store/itemActions';
import { CoverImage } from './CoverImage';
import { formatClock, formatRemaining, trackDurationSeconds } from '../lib/time';
import { useHoldSeek } from '../lib/holdSeek';
import { applySleepPick, SLEEP_TIMER_OPTIONS } from '../lib/sleepTimer';
import type { NowPlayingTab } from './NowPlaying';

/** Empêche le clic de remonter jusqu’au footer (qui ouvre le Now Playing). */
function stop(e: SyntheticEvent) {
  e.stopPropagation();
}

export function PlayerBar({
  onOpenDevices,
  onExpand,
  expanded = false,
  onCollapse,
  compactEmpty = false,
}: {
  onOpenDevices?: () => void;
  onExpand?: (tab?: NowPlayingTab) => void;
  expanded?: boolean;
  onCollapse?: () => void;
  compactEmpty?: boolean;
}) {
  const {
    current,
    isPlaying,
    isLoading,
    progress,
    duration,
    volume,
    shuffle,
    repeat,
    toggle,
    next,
    prev,
    seek,
    setVolume,
    toggleShuffle,
    cycleRepeat,
    audioEl,
    queueIndex,
    sleepLabel,
    setSleepTimer,
    playError,
    clearPlayError,
    autoRadioLoading,
    queueHint,
  } = usePlayer();
  const { isLiked, toggleLike } = useLibrary();
  const openActions = useItemActions((s) => s.open);
  const isActivePlayer = useSession((s) => s.isActivePlayer);
  const receiveRemoteSync = useSession((s) => s.receiveRemoteSync);
  const devices = useSession((s) => s.devices);
  const activePlayerId = useSession((s) => s.activePlayerId);
  const transferHere = useSession((s) => s.transferHere);
  const activeName = devices.find((d) => d.id === activePlayerId)?.name;

  const [muted, setMuted] = useState(false);
  const [uiPlaying, setUiPlaying] = useState(isPlaying);
  const [liveProgress, setLiveProgress] = useState(progress);
  const [bufferedPct, setBufferedPct] = useState(0);
  const [sleepOpen, setSleepOpen] = useState(false);
  const prevVol = useRef(volume);
  const footerRef = useRef<HTMLElement | null>(null);
  const volumeWrapRef = useRef<HTMLDivElement | null>(null);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const swipeY0 = useRef<number | null>(null);

  const holdPrev = useHoldSeek(-1, () => {
    void prev();
  });
  const holdNext = useHoldSeek(1, () => {
    void next();
  });

  // Si le volume change hors UI (↑/↓ clavier), désactive le mute local
  useEffect(() => {
    if (volume > 0.001) setMuted(false);
  }, [volume]);

  // Barre fluide : lit l’élément audio (évite re-render store à chaque timeupdate)
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = usePlayer.getState().audioEl;
      if (el && !el.paused && !el.ended && Number.isFinite(el.currentTime)) {
        setLiveProgress(el.currentTime);
      } else {
        setLiveProgress(usePlayer.getState().progress);
      }
      if (el && el.buffered.length > 0 && el.duration > 0) {
        try {
          const end = el.buffered.end(el.buffered.length - 1);
          setBufferedPct(Math.min(100, (end / el.duration) * 100));
        } catch {
          /* ignore */
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [current?.id]);

  useEffect(() => {
    setLiveProgress(progress);
  }, [progress, current?.id]);

  // Icône play/pause = état réel de l’élément <audio> (touches média / MPRIS)
  useEffect(() => {
    const el = audioEl;
    if (!el) {
      setUiPlaying(isPlaying);
      return;
    }
    const sync = () => setUiPlaying(!el.paused && !el.ended);
    sync();
    el.addEventListener('play', sync);
    el.addEventListener('playing', sync);
    el.addEventListener('pause', sync);
    el.addEventListener('ended', sync);
    return () => {
      el.removeEventListener('play', sync);
      el.removeEventListener('playing', sync);
      el.removeEventListener('pause', sync);
      el.removeEventListener('ended', sync);
    };
  }, [audioEl, isPlaying, queueIndex]);

  /** Publie la hauteur réelle du lecteur pour positionner la nav bas (évite chevauchement). */
  useEffect(() => {
    const clear = () => document.documentElement.style.setProperty('--ytm-player-h', '0px');
    if (!current) {
      clear();
      return;
    }
    const el = footerRef.current;
    if (!el) {
      clear();
      return;
    }
    const publish = () => {
      document.documentElement.style.setProperty('--ytm-player-h', `${el.offsetHeight}px`);
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      clear();
    };
  }, [current, isActivePlayer, activeName]);

  // Molette sur la zone volume : ±5 % par cran (passive:false pour bloquer le scroll page)
  // Doit rester AVANT tout return conditionnel (Rules of Hooks).
  useEffect(() => {
    const el = volumeWrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (delta === 0) return;
      const step = 0.05;
      const cur = mutedRef.current ? 0 : usePlayer.getState().volume;
      const next = Math.max(0, Math.min(1, Math.round((cur + (delta < 0 ? step : -step)) * 100) / 100));
      setVolume(next);
      setMuted(next === 0);
      if (next > 0) prevVol.current = next;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setVolume]);

  useEffect(() => {
    if (!sleepOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Element && t.closest('[data-sleep-menu]')) return;
      setSleepOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSleepOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [sleepOpen]);

  if (!current) {
    if (compactEmpty) {
      return (
        <footer className="pointer-events-none fixed bottom-0 left-0 right-0 z-40 hidden h-0 lg:block" aria-hidden />
      );
    }
    return (
      <footer className="fixed bottom-0 left-0 right-0 z-50 border-t border-yt-border bg-black px-4 py-4 text-center text-sm text-yt-muted">
        Sélectionne un titre pour commencer
      </footer>
    );
  }

  const expand = (tab?: NowPlayingTab) => onExpand?.(tab);
  const effectiveDuration =
    duration > 0
      ? duration
      : Number.isFinite(audioEl?.duration) && (audioEl?.duration || 0) > 0
        ? Number(audioEl?.duration)
        : trackDurationSeconds(current) || 0;
  const displayProgress = liveProgress;
  const pct =
    effectiveDuration > 0 ? Math.min(100, Math.max(0, (displayProgress / effectiveDuration) * 100)) : 0;

  const seekFromClientX = (el: HTMLElement, clientX: number) => {
    const dur = effectiveDuration > 0 ? effectiveDuration : Number(audioEl?.duration) || 0;
    if (!(dur > 0)) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    seek(ratio * dur);
  };

  const onSeekPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    stop(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromClientX(e.currentTarget, e.clientX);
  };

  const onSeekMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    stop(e);
    seekFromClientX(e.currentTarget, e.clientX);
  };

  const toggleMute = () => {
    if (muted || volume === 0) {
      const v = prevVol.current > 0 ? prevVol.current : 0.7;
      setVolume(v);
      setMuted(false);
    } else {
      prevVol.current = volume;
      setVolume(0);
      setMuted(true);
    }
  };

  const listenHere = (e: SyntheticEvent) => {
    stop(e);
    transferHere();
    useSession.setState({ isActivePlayer: true });
    void toggle();
  };

  return (
    <footer
      ref={footerRef}
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-yt-border bg-[#0a0a0a]/95 backdrop-blur-md"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      onClick={() => expand('queue')}
      onTouchStart={(e) => {
        if (expanded) return;
        swipeY0.current = e.touches[0]?.clientY ?? null;
      }}
      onTouchEnd={(e) => {
        if (expanded) {
          swipeY0.current = null;
          return;
        }
        const y0 = swipeY0.current;
        swipeY0.current = null;
        const y1 = e.changedTouches[0]?.clientY;
        if (y0 == null || y1 == null) return;
        // Swipe bas sur barre réduite → replier seulement (ne pas vider la lecture)
        if (y1 - y0 > 64) {
          e.preventDefault();
          onCollapse?.();
        }
      }}
    >
      {/* Seek : temps restant | barre | durée totale */}
      <div className="flex items-center gap-1.5 px-2" onClick={stop} onPointerDown={stop}>
        <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-yt-muted">
          {formatRemaining(displayProgress, effectiveDuration)}
        </span>
        <div
          className="group relative h-5 min-w-0 flex-1 cursor-pointer"
          onPointerDown={onSeekPointer}
          onPointerMove={onSeekMove}
          role="slider"
          aria-valuemin={0}
          aria-valuemax={effectiveDuration || 0}
          aria-valuenow={displayProgress}
          aria-label="Position du morceau"
          tabIndex={0}
          onKeyDown={(e) => {
            stop(e);
            const dur = effectiveDuration;
            if (!(dur > 0)) return;
            const cur = displayProgress;
            if (e.key === 'ArrowRight') seek(Math.min(dur, cur + 5));
            if (e.key === 'ArrowLeft') seek(Math.max(0, cur - 5));
          }}
        >
          <div className="absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 bg-[#3a3a3a] transition group-hover:h-1">
            <div
              className="absolute inset-y-0 left-0 bg-[#5c5c5c]"
              style={{ width: `${bufferedPct}%` }}
            />
            <div className="relative h-full bg-[#ff0033]" style={{ width: `${pct}%` }}>
              <span
                className="absolute right-0 top-1/2 h-2.5 w-2.5 -translate-y-1/2 translate-x-1/2 rounded-full bg-[#ff0033] shadow-[0_0_0_2px_#000] ring-1 ring-[#ff0033]/40 transition group-hover:scale-125"
                aria-hidden
              />
            </div>
          </div>
        </div>
        <span className="w-9 shrink-0 text-left text-[10px] tabular-nums text-yt-muted">
          {effectiveDuration > 0 ? formatClock(effectiveDuration) : '0:00'}
        </span>
      </div>

      {!isActivePlayer && receiveRemoteSync && activeName && (
        <div
          className="flex items-center justify-center gap-2 border-b border-yt-border/60 px-3 py-1 text-[11px] text-yt-muted"
          onClick={stop}
        >
          <span className="truncate">
            Sur <span className="text-white">{activeName}</span>
          </span>
          <button
            type="button"
            onClick={listenHere}
            className="shrink-0 rounded-full bg-yt-red px-2.5 py-0.5 text-[11px] font-medium text-white"
          >
            Écouter ici
          </button>
        </div>
      )}

      {(playError || sleepLabel || queueHint) && (
        <div
          className="flex items-center gap-2 border-b border-yt-border/60 px-3 py-1.5 text-[11px]"
          onClick={stop}
        >
          {playError ? (
            <>
              <span className="min-w-0 flex-1 truncate text-red-300">{playError}</span>
              <button
                type="button"
                className="shrink-0 rounded-full p-1 text-yt-muted hover:text-white"
                onClick={() => clearPlayError()}
                title="Fermer"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </>
          ) : queueHint ? (
            <span className="min-w-0 flex-1 truncate text-yt-muted">{queueHint}</span>
          ) : (
            <>
              <Moon className="h-3.5 w-3.5 shrink-0 text-amber-200" />
              <span className="min-w-0 flex-1 truncate text-amber-100/90">
                Minuteur : {sleepLabel}
              </span>
              <button
                type="button"
                className="shrink-0 rounded-full px-2 py-0.5 text-[10px] text-yt-muted hover:bg-white/10 hover:text-white"
                onClick={() => setSleepTimer(null, null)}
              >
                Annuler
              </button>
            </>
          )}
        </div>
      )}

      {/* —— Mobile (< sm) : 2 lignes lisibles —— */}
      <div className="px-2 pb-1.5 pt-1 sm:hidden">
        <div className="flex items-center gap-2">
          <div className="h-11 w-11 shrink-0 overflow-hidden rounded-md">
            <CoverImage item={current} size={96} rounded="md" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold leading-tight text-white">{current.title}</div>
            <div className="truncate text-[11px] text-yt-muted">{artistNames(current)}</div>
          </div>
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              void toggleLike(current);
            }}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-yt-muted"
            title="J'aime"
          >
            <Heart
              className={`h-5 w-5 ${
                isLiked(current.id) ? 'fill-yt-red text-yt-red' : 'fill-none text-yt-muted'
              }`}
            />
          </button>
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              openActions(current, { queueIndex });
            }}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-yt-muted"
            title="Plus d'options"
          >
            <MoreVertical className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-0.5 flex items-center justify-center gap-0.5" onClick={stop} onPointerDown={stop}>
          <button
            type="button"
            onPointerDown={holdPrev.onPointerDown}
            onPointerUp={holdPrev.onPointerUp}
            onPointerCancel={holdPrev.onPointerCancel}
            onLostPointerCapture={holdPrev.onLostPointerCapture}
            onContextMenu={holdPrev.onContextMenu}
            onClick={holdPrev.onClick}
            className="flex h-10 w-10 items-center justify-center rounded-full text-white touch-none select-none"
            aria-label="Titre précédent"
            title="Clic : précédent · Appui long : reculer dans le titre"
          >
            <SkipBack className="h-5 w-5 fill-white" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              toggle();
            }}
            disabled={isLoading}
            className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-black disabled:opacity-60"
            aria-label={uiPlaying ? 'Pause' : 'Lecture'}
          >
            {uiPlaying ? <Pause className="h-5 w-5 fill-black" /> : <Play className="h-5 w-5 fill-black" />}
          </button>
          <button
            type="button"
            onPointerDown={holdNext.onPointerDown}
            onPointerUp={holdNext.onPointerUp}
            onPointerCancel={holdNext.onPointerCancel}
            onLostPointerCapture={holdNext.onLostPointerCapture}
            onContextMenu={holdNext.onContextMenu}
            onClick={holdNext.onClick}
            disabled={autoRadioLoading}
            className="flex h-10 w-10 items-center justify-center rounded-full text-white disabled:opacity-50 touch-none select-none"
            aria-label="Titre suivant"
            title={
              autoRadioLoading
                ? 'Chargement des suggestions…'
                : 'Clic : suivant · Appui long : avancer dans le titre'
            }
          >
            <SkipForward className="h-5 w-5 fill-white" />
          </button>
          <div className="relative" data-sleep-menu onClick={stop} onPointerDown={stop}>
            <button
              type="button"
              onClick={(e) => {
                stop(e);
                setSleepOpen((v) => !v);
              }}
              title={sleepLabel ? `Minuteur : ${sleepLabel}` : 'Mise en veille'}
              aria-label="Mise en veille"
              className={`flex h-10 w-10 items-center justify-center rounded-full ${
                sleepLabel ? 'text-amber-200' : 'text-white/70'
              }`}
            >
              <Moon className="h-5 w-5" />
            </button>
            {sleepOpen && (
              <div className="absolute bottom-full right-0 z-[60] mb-2 w-56 overflow-hidden rounded-xl border border-yt-border bg-[#161616] py-1 shadow-2xl">
                {SLEEP_TIMER_OPTIONS.map((pick) => (
                  <button
                    key={pick.label}
                    type="button"
                    className="flex w-full px-3 py-2.5 text-left text-sm text-white hover:bg-white/10"
                    onClick={(e) => {
                      stop(e);
                      applySleepPick(pick, setSleepTimer);
                      setSleepOpen(false);
                    }}
                  >
                    {pick.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* —— Desktop / tablette (≥ sm) —— */}
      <div className="mx-auto hidden max-w-[1600px] items-center gap-3 px-3 py-2.5 sm:flex md:gap-4 md:px-5 md:py-3">
        <div className="flex shrink-0 items-center gap-1 sm:gap-1.5" onClick={stop} onPointerDown={stop}>
          <button
            type="button"
            onPointerDown={holdPrev.onPointerDown}
            onPointerUp={holdPrev.onPointerUp}
            onPointerCancel={holdPrev.onPointerCancel}
            onLostPointerCapture={holdPrev.onLostPointerCapture}
            onContextMenu={holdPrev.onContextMenu}
            onClick={holdPrev.onClick}
            className="flex h-11 w-11 items-center justify-center rounded-full text-white hover:bg-white/10 touch-none select-none"
            aria-label="Titre précédent"
            title="Clic : précédent · Appui long : reculer dans le titre"
          >
            <SkipBack className="h-6 w-6 fill-white" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              toggle();
            }}
            disabled={isLoading}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-white text-black transition hover:scale-105 disabled:opacity-60"
            aria-label={uiPlaying ? 'Pause' : 'Lecture'}
          >
            {uiPlaying ? <Pause className="h-6 w-6 fill-black" /> : <Play className="h-6 w-6 fill-black" />}
          </button>
          <button
            type="button"
            onPointerDown={holdNext.onPointerDown}
            onPointerUp={holdNext.onPointerUp}
            onPointerCancel={holdNext.onPointerCancel}
            onLostPointerCapture={holdNext.onLostPointerCapture}
            onContextMenu={holdNext.onContextMenu}
            onClick={holdNext.onClick}
            disabled={autoRadioLoading}
            className="flex h-11 w-11 items-center justify-center rounded-full text-white hover:bg-white/10 disabled:opacity-50 touch-none select-none"
            aria-label="Titre suivant"
            title={
              autoRadioLoading
                ? 'Chargement des suggestions…'
                : 'Clic : suivant · Appui long : avancer dans le titre'
            }
          >
            <SkipForward className="h-6 w-6 fill-white" />
          </button>
          <span className="ml-2 whitespace-nowrap text-xs tabular-nums text-yt-muted">
            {formatRemaining(displayProgress, effectiveDuration)}
            <span className="mx-1 text-yt-muted/50">/</span>
            {effectiveDuration > 0 ? formatClock(effectiveDuration) : '0:00'}
          </span>
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-center gap-3">
          <div className="h-12 w-12 shrink-0 overflow-hidden rounded-md md:h-14 md:w-14">
            <CoverImage item={current} size={120} rounded="md" />
          </div>
          <div className="min-w-0 max-w-[min(420px,36vw)]">
            <div className="truncate text-sm font-semibold text-white">{current.title}</div>
            <div className="truncate text-xs text-yt-muted">
              {artistNames(current)}
              {current.album?.name ? <span> — {current.album.name}</span> : null}
            </div>
          </div>
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              const willLike = !isLiked(current.id);
              void toggleLike(current);
              void api
                .recoFeedback({
                  trackId: current.id,
                  verdict: willLike ? 'good' : 'bad',
                  context: 'player_bar_like',
                })
                .catch(() => undefined);
            }}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-yt-muted hover:bg-white/10 hover:text-white"
            title="J'aime"
          >
            <Heart
              className={`h-5 w-5 ${
                isLiked(current.id) ? 'fill-yt-red text-yt-red' : 'fill-none text-yt-muted'
              }`}
            />
          </button>
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              void api
                .recoFeedback({ trackId: current.id, verdict: 'bad', context: 'player_bar' })
                .catch(() => undefined);
            }}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-yt-muted hover:bg-white/10 hover:text-white"
            title="Je n'aime pas"
          >
            <ThumbsDown className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              stop(e);
              openActions(current, { queueIndex });
            }}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-yt-muted hover:bg-white/10 hover:text-white"
            title="Plus d'options"
          >
            <MoreVertical className="h-5 w-5" />
          </button>
        </div>

        <div className="relative flex shrink-0 items-center justify-end gap-1 sm:gap-1.5" onClick={stop}>
          <div className="flex items-center gap-1.5 sm:gap-2" ref={volumeWrapRef} title="Molette : régler le volume">
            <button
              type="button"
              title={muted || volume === 0 ? 'Réactiver le son' : 'Couper le son'}
              aria-label={muted || volume === 0 ? 'Réactiver le son' : 'Couper le son'}
              onClick={(e) => {
                stop(e);
                toggleMute();
              }}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-yt-muted hover:bg-white/10 hover:text-white"
            >
              {muted || volume === 0 ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
            </button>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setVolume(v);
                  setMuted(v === 0);
                  if (v > 0) prevVol.current = v;
                }}
                onPointerDown={stop}
                onClick={stop}
                className="progress-range h-1.5 w-16 cursor-pointer accent-[#ff0033] sm:w-24 md:w-28"
                aria-label="Volume"
              />
              <span className="hidden w-8 tabular-nums text-[11px] text-yt-muted md:inline">
                {Math.round((muted ? 0 : volume) * 100)}
              </span>
            </div>
          </div>
          <div className="relative" data-sleep-menu onClick={stop} onPointerDown={stop}>
            <button
              type="button"
              onClick={(e) => {
                stop(e);
                setSleepOpen((v) => !v);
              }}
              title={sleepLabel ? `Minuteur : ${sleepLabel}` : 'Mise en veille'}
              aria-label="Mise en veille"
              aria-expanded={sleepOpen}
              className={`flex h-11 w-11 items-center justify-center rounded-full ${
                sleepLabel ? 'text-amber-200' : 'text-yt-muted/50 hover:bg-white/10 hover:text-yt-muted'
              }`}
            >
              <Moon className="h-5 w-5" />
            </button>
            {sleepOpen && (
              <div className="absolute bottom-full right-0 z-[60] mb-2 w-56 overflow-hidden rounded-xl border border-yt-border bg-[#161616] py-1 shadow-2xl">
                <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-yt-muted">
                  Mise en veille
                </p>
                {SLEEP_TIMER_OPTIONS.map((pick) => (
                  <button
                    key={pick.label}
                    type="button"
                    className="flex w-full px-3 py-2.5 text-left text-sm text-white hover:bg-white/10"
                    onClick={(e) => {
                      stop(e);
                      applySleepPick(pick, setSleepTimer);
                      setSleepOpen(false);
                    }}
                  >
                    {pick.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={cycleRepeat}
            title={
              repeat === 'off'
                ? 'Boucle désactivée'
                : repeat === 'all'
                  ? 'Boucler toute la file'
                  : 'Boucler le titre'
            }
            className={`flex h-11 w-11 items-center justify-center rounded-full ${repeat !== 'off' ? 'text-yt-red' : 'text-yt-muted/50 hover:bg-white/10 hover:text-yt-muted'}`}
          >
            {repeat === 'one' ? <Repeat1 className="h-5 w-5" /> : <Repeat className="h-5 w-5" />}
          </button>
          <button
            type="button"
            onClick={toggleShuffle}
            title="Aléatoire"
            className={`flex h-11 w-11 items-center justify-center rounded-full ${shuffle ? 'text-yt-red' : 'text-yt-muted/50 hover:bg-white/10 hover:text-yt-muted'}`}
          >
            <Shuffle className="h-5 w-5" />
          </button>
          {onOpenDevices && (
            <button
              type="button"
              onClick={onOpenDevices}
              className={`flex h-11 w-11 items-center justify-center rounded-full ${
                receiveRemoteSync && !isActivePlayer
                  ? 'text-yt-red'
                  : 'text-yt-muted hover:bg-white/10 hover:text-white'
              }`}
              title={
                receiveRemoteSync && !isActivePlayer
                  ? 'Cast · lecture sur un autre appareil'
                  : 'Cast'
              }
            >
              <Cast className="h-5 w-5" />
            </button>
          )}
          {onCollapse && expanded && (
            <button
              type="button"
              onClick={onCollapse}
              className="flex h-11 w-11 items-center justify-center rounded-full text-yt-muted hover:bg-white/10 hover:text-white"
              title="Réduire"
            >
              ✕
            </button>
          )}
        </div>
      </div>
    </footer>
  );
}
