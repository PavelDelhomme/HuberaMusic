import { useEffect, useMemo, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { ListMusic, Mic2, MoreVertical, Pause, Play, Radio, Repeat, Repeat1, Save, Shuffle, SkipBack, SkipForward, Sparkles } from 'lucide-react';
import { api, artistNames, getToken, thumb, type Track } from '../../api';
import { usePlayer } from '../../store/player';
import { useItemActions } from '../../store/itemActions';
import { CoverImage } from '../media/CoverImage';
import { TrackRow } from '../media/TrackRow';
import { SaveQueueSheet } from './SaveQueueSheet';
import { useNavigate } from 'react-router-dom';
import {
  LYRIC_LEAD_SEC,
  LRCLIB_BASE_LAG_SEC,
  getLyricUserOffsetMs,
  nudgeLyricUserOffsetMs,
  setLyricUserOffsetMs,
} from '../../lib/player/lyricSync';

function fmtClock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}
export type NowPlayingTab = 'queue' | 'lyrics' | 'related';

const QUEUE_PAGE = 24;
const QUEUE_MAX = 100;

/** Mode Titre/Vidéo pour la session navigateur (survît au repli NP ; reset au reload). */
let sessionMediaMode: 'cover' | 'video' = 'cover';

type LyricLine = { t: number; text: string };

/** LRC uniquement — pas de faux timings sur texte brut (ça décale / n’arrête pas). */
function parseLrcLines(raw: string | null): LyricLine[] {
  if (!raw?.trim()) return [];
  const timed: LyricLine[] = [];
  const lrcRe = /^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.*)$/;
  for (const row of raw.split(/\r?\n/)) {
    const m = row.match(lrcRe);
    if (!m) continue;
    const min = Number(m[1]);
    const sec = Number(m[2]);
    const frac = m[3] ? Number(m[3].padEnd(3, '0').slice(0, 3)) / 1000 : 0;
    timed.push({ t: min * 60 + sec + frac, text: m[4] || '' });
  }
  return timed.filter((l) => l.text.trim());
}

export function SyncedLyrics({
  text,
  timed,
  source,
}: {
  text: string | null;
  timed?: { startMs: number; text: string }[] | null;
  source?: 'youtube' | 'lrclib' | 'lrc' | null;
}) {
  const audioEl = usePlayer((s) => s.audioEl);
  const isPlaying = usePlayer((s) => s.isPlaying);
  const duration = usePlayer((s) => s.duration);
  const currentId = usePlayer((s) => s.current?.id);
  const storeSource = usePlayer((s) => s.lyricsSource);
  const lyricsSource = source ?? storeSource;
  const seek = usePlayer((s) => s.seek);
  const [clock, setClock] = useState(0);
  const [userOffsetMs, setUserOffsetMs] = useState(() => getLyricUserOffsetMs(currentId));
  const activeRef = useRef<HTMLParagraphElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const prevIdxRef = useRef(-1);
  const userScrollUntilRef = useRef(0);
  const lastActiveRef = useRef(-1);

  useEffect(() => {
    setUserOffsetMs(getLyricUserOffsetMs(currentId));
  }, [currentId]);

  const lines = useMemo(() => {
    if (timed?.length) {
      // Heuristique prudente : secondes dans « startMs » seulement si toute la plage < 10 min
      // et cohérente avec la durée (évite de traiter des ms précoces comme des secondes).
      const values = timed.map((l) => Number(l.startMs) || 0);
      const maxRaw = Math.max(...values);
      const dur = duration > 0 ? duration : 0;
      const looksLikeSeconds =
        maxRaw > 0 &&
        maxRaw < 600 &&
        (dur <= 0 || maxRaw <= dur * 1.5) &&
        values.filter((v) => v > 0).length >= 2;
      return timed.map((l) => ({
        t: looksLikeSeconds ? Number(l.startMs) || 0 : (Number(l.startMs) || 0) / 1000,
        text: l.text,
      }));
    }
    return parseLrcLines(text);
  }, [text, timed, duration]);

  const leadSec = LYRIC_LEAD_SEC;
  const offsetSec = userOffsetMs / 1000;
  // LRCLIB / LRC brut : souvent en avance sur le flux YT → lag de base
  const sourceLagSec =
    lyricsSource === 'lrclib' || lyricsSource === 'lrc' ? LRCLIB_BASE_LAG_SEC : 0;

  // Horloge = audio réel ; ne re-render que si l’index actif change
  useEffect(() => {
    if (!lines.length) return;
    let raf = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const el = usePlayer.getState().audioEl;
      if (el && Number.isFinite(el.currentTime)) {
        const t = el.currentTime + leadSec - offsetSec - sourceLagSec;
        let idx = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].t <= t) idx = i;
          else break;
        }
        if (idx !== lastActiveRef.current) {
          lastActiveRef.current = idx;
          setClock(el.currentTime);
        }
      }
      if (el && !el.paused && !el.ended) {
        raf = requestAnimationFrame(tick);
      }
    };
    const el = audioEl;
    if (el && Number.isFinite(el.currentTime)) {
      lastActiveRef.current = -1;
      setClock(el.currentTime);
    }
    if (isPlaying) raf = requestAnimationFrame(tick);
    const onSeeked = () => {
      const a = usePlayer.getState().audioEl;
      if (a && Number.isFinite(a.currentTime)) {
        lastActiveRef.current = -1;
        setClock(a.currentTime);
      }
    };
    el?.addEventListener('seeked', onSeeked);
    el?.addEventListener('timeupdate', onSeeked);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      el?.removeEventListener('seeked', onSeeked);
      el?.removeEventListener('timeupdate', onSeeked);
    };
  }, [lines, isPlaying, audioEl, leadSec, offsetSec, sourceLagSec]);

  const activeIdx = useMemo(() => {
    if (!lines.length) return -1;
    const t = clock + leadSec - offsetSec - sourceLagSec;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].t <= t) idx = i;
      else break;
    }
    return idx;
  }, [lines, clock, leadSec, offsetSec, sourceLagSec]);

  useEffect(() => {
    const lineEl = activeRef.current;
    if (!lineEl || activeIdx < 0) return;
    if (Date.now() < userScrollUntilRef.current) {
      prevIdxRef.current = activeIdx;
      return;
    }
    let scroller: HTMLElement | null = scrollerRef.current;
    if (scroller) {
      let n: HTMLElement | null = lineEl.parentElement;
      while (n) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 8) {
          scroller = n;
          break;
        }
        n = n.parentElement;
      }
    }
    if (!scroller) return;
    const prev = prevIdxRef.current;
    prevIdxRef.current = activeIdx;
    const lineTop =
      lineEl.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    const top = lineTop - scroller.clientHeight / 2 + lineEl.clientHeight / 2;
    const jump = prev < 0 || Math.abs(activeIdx - prev) > 1;
    scroller.scrollTo({
      top: Math.max(0, top),
      behavior: jump ? 'smooth' : 'auto',
    });
  }, [activeIdx]);

  // Texte brut sans timings → scroll libre, pas de faux karaoké
  if (!lines.length) {
    return (
      <div className="whitespace-pre-wrap px-2 py-6 text-base leading-8 text-[#c6c6c6] sm:px-4 sm:text-[17px] sm:leading-9">
        {text || 'Paroles indisponibles pour ce titre.'}
      </div>
    );
  }

  return (
    <div className="relative">
      {currentId && (
        <div className="sticky top-0 z-10 mb-2 space-y-1 bg-yt-surface/90 px-2 py-1.5 backdrop-blur-sm">
          <p className="text-center text-[10px] text-yt-muted">
            Appui long sur une ligne pour recaler le rythme
          </p>
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            <button
              type="button"
              className="rounded-full border border-yt-border px-2 py-1 text-[11px] text-yt-muted hover:bg-yt-hover hover:text-white"
              title="Retarder d’1 s"
              onClick={() => {
                if (!currentId) return;
                setUserOffsetMs(nudgeLyricUserOffsetMs(currentId, 1000));
                lastActiveRef.current = -1;
              }}
            >
              −1 s
            </button>
            <button
              type="button"
              className="rounded-full border border-yt-border px-2 py-1 text-[11px] text-yt-muted hover:bg-yt-hover hover:text-white"
              title="Retarder de 0,75 s"
              onClick={() => {
                if (!currentId) return;
                setUserOffsetMs(nudgeLyricUserOffsetMs(currentId, 750));
                lastActiveRef.current = -1;
              }}
            >
              −0,75
            </button>
            <button
              type="button"
              className="rounded-full border border-yt-border px-2.5 py-1 text-[11px] text-yt-muted hover:bg-yt-hover hover:text-white"
              title="Paroles trop en avance"
              onClick={() => {
                if (!currentId) return;
                setUserOffsetMs(nudgeLyricUserOffsetMs(currentId, 200));
                lastActiveRef.current = -1;
              }}
            >
              Trop tôt
            </button>
            <span className="min-w-[3.5rem] text-center text-[11px] font-semibold tabular-nums text-yt-muted">
              {userOffsetMs === 0
                ? 'sync'
                : `${userOffsetMs > 0 ? '+' : ''}${(userOffsetMs / 1000).toFixed(2)} s`}
            </span>
            <button
              type="button"
              className="rounded-full border border-yt-border px-2.5 py-1 text-[11px] text-yt-muted hover:bg-yt-hover hover:text-white"
              title="Paroles trop en retard"
              onClick={() => {
                if (!currentId) return;
                setUserOffsetMs(nudgeLyricUserOffsetMs(currentId, -200));
                lastActiveRef.current = -1;
              }}
            >
              Trop tard
            </button>
            <button
              type="button"
              className="rounded-full border border-yt-border px-2 py-1 text-[11px] text-yt-muted hover:bg-yt-hover hover:text-white"
              title="Avancer de 0,75 s"
              onClick={() => {
                if (!currentId) return;
                setUserOffsetMs(nudgeLyricUserOffsetMs(currentId, -750));
                lastActiveRef.current = -1;
              }}
            >
              +0,75
            </button>
            <button
              type="button"
              className="rounded-full border border-yt-border px-2 py-1 text-[11px] text-yt-muted hover:bg-yt-hover hover:text-white"
              title="Avancer d’1 s"
              onClick={() => {
                if (!currentId) return;
                setUserOffsetMs(nudgeLyricUserOffsetMs(currentId, -1000));
                lastActiveRef.current = -1;
              }}
            >
              +1 s
            </button>
            {userOffsetMs !== 0 && (
              <button
                type="button"
                className="rounded-full border border-yt-border px-2.5 py-1 text-[11px] text-yt-muted hover:bg-yt-hover hover:text-white"
                onClick={() => {
                  if (!currentId) return;
                  setLyricUserOffsetMs(currentId, 0);
                  setUserOffsetMs(0);
                  lastActiveRef.current = -1;
                }}
              >
                Reset
              </button>
            )}
          </div>
        </div>
      )}
      <div
        ref={scrollerRef}
        data-lyrics-scroll
        className="space-y-4 px-3 py-6 sm:px-6"
        onWheel={() => {
          userScrollUntilRef.current = Date.now() + 4000;
        }}
        onTouchMove={() => {
          userScrollUntilRef.current = Date.now() + 4000;
        }}
      >
        {lines.map((line, i) => {
          const active = i === activeIdx;
          const past = activeIdx >= 0 && i < activeIdx;
          return (
            <p
              key={`${i}-${line.t}`}
              ref={active ? activeRef : undefined}
              role="button"
              tabIndex={0}
              onClick={() => seek(Math.max(0, line.t))}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!currentId) return;
                const el = usePlayer.getState().audioEl;
                const now = el && Number.isFinite(el.currentTime) ? el.currentTime : clock;
                const nextMs = Math.round(
                  (now + leadSec - sourceLagSec - line.t) * 1000,
                );
                setLyricUserOffsetMs(currentId, nextMs);
                setUserOffsetMs(getLyricUserOffsetMs(currentId));
                lastActiveRef.current = -1;
              }}
              onTouchStart={(e) => {
                const target = e.currentTarget;
                const timer = window.setTimeout(() => {
                  if (!currentId) return;
                  const el = usePlayer.getState().audioEl;
                  const now = el && Number.isFinite(el.currentTime) ? el.currentTime : clock;
                  const nextMs = Math.round(
                    (now + leadSec - sourceLagSec - line.t) * 1000,
                  );
                  setLyricUserOffsetMs(currentId, nextMs);
                  setUserOffsetMs(getLyricUserOffsetMs(currentId));
                  lastActiveRef.current = -1;
                  target.dataset.calibrated = '1';
                }, 480);
                target.dataset.longPressTimer = String(timer);
              }}
              onTouchEnd={(e) => {
                const t = e.currentTarget.dataset.longPressTimer;
                if (t) window.clearTimeout(Number(t));
                if (e.currentTarget.dataset.calibrated === '1') {
                  e.preventDefault();
                  delete e.currentTarget.dataset.calibrated;
                }
                delete e.currentTarget.dataset.longPressTimer;
              }}
              onTouchCancel={(e) => {
                const t = e.currentTarget.dataset.longPressTimer;
                if (t) window.clearTimeout(Number(t));
                delete e.currentTarget.dataset.longPressTimer;
                delete e.currentTarget.dataset.calibrated;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  seek(Math.max(0, line.t));
                }
              }}
              className={`origin-left cursor-pointer rounded-lg px-2 transition-all duration-200 hover:text-white ${
                active
                  ? 'bg-[#ff0033]/22 py-2 text-3xl font-extrabold leading-tight text-white underline decoration-yt-red decoration-2 underline-offset-4 sm:text-4xl'
                  : past
                    ? 'text-base leading-7 text-white/25 sm:text-lg'
                    : 'text-lg leading-8 text-[#9a9a9a] sm:text-xl sm:leading-9'
              }`}
              title="Clic : aller à cet instant · Appui long : caler le sync"
            >
              {line.text || '\u00a0'}
            </p>
          );
        })}
      </div>
    </div>
  );
}

export function NowPlaying({
  open,
  onClose,
  initialTab = 'queue',
}: {
  open: boolean;
  onClose: () => void;
  initialTab?: NowPlayingTab;
}) {
  const current = usePlayer((s) => s.current);
  const queue = usePlayer((s) => s.queue);
  const queueIndex = usePlayer((s) => s.queueIndex);
  const userQueueEnd = usePlayer((s) => s.userQueueEnd);
  const autoplay = usePlayer((s) => s.autoplay);
  const autoRadioLoading = usePlayer((s) => s.autoRadioLoading);
  const related = usePlayer((s) => s.related);
  const relatedLoading = usePlayer((s) => s.relatedLoading);
  const relatedSeedId = usePlayer((s) => s.relatedSeedId);
  const playAt = usePlayer((s) => s.playAt);
  const playUpcomingInQueue = usePlayer((s) => s.playUpcomingInQueue);
  const addNext = usePlayer((s) => s.addNext);
  const appendRelated = usePlayer((s) => s.appendRelated);
  const loadRelated = usePlayer((s) => s.loadRelated);
  const toggleAutoplay = usePlayer((s) => s.toggleAutoplay);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const toggleShuffle = usePlayer((s) => s.toggleShuffle);
  const cycleRepeat = usePlayer((s) => s.cycleRepeat);
  const toggle = usePlayer((s) => s.toggle);
  const next = usePlayer((s) => s.next);
  const prev = usePlayer((s) => s.prev);
  const seek = usePlayer((s) => s.seek);
  const progress = usePlayer((s) => s.progress);
  const duration = usePlayer((s) => s.duration);
  const topUpAutoplay = usePlayer((s) => s.topUpAutoplay);
  const openActions = useItemActions((s) => s.open);
  const audioEl = usePlayer((s) => s.audioEl);
  const isPlaying = usePlayer((s) => s.isPlaying);
  const [tab, setTab] = useState<NowPlayingTab>(initialTab);
  const [lyricsText, setLyricsText] = useState<string | null>(null);
  const [lyricsTimed, setLyricsTimed] = useState<{ startMs: number; text: string }[] | null>(null);
  const [lyricsSource, setLyricsSource] = useState<'youtube' | 'lrclib' | 'lrc' | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [queueVisible, setQueueVisible] = useState(QUEUE_PAGE);
  const [similarVisible, setSimilarVisible] = useState(10);
  const [saveOpen, setSaveOpen] = useState(false);
  const [mediaMode, setMediaMode] = useState<'cover' | 'video'>(sessionMediaMode);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const navigate = useNavigate();
  const queueScrollRef = useRef<HTMLDivElement>(null);
  const coverRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const touchRef = useRef<{ x: number; y: number; atTop: boolean } | null>(null);

  const setMode = (mode: 'cover' | 'video') => {
    sessionMediaMode = mode;
    setMediaMode(mode);
    usePlayer.getState().setMediaPresentation(mode);
  };

  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setMediaMode(sessionMediaMode);
      usePlayer.getState().setMediaPresentation(sessionMediaMode);
    }
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (saveOpen) {
        setSaveOpen(false);
        return;
      }
      onClose();
    };
    // Capture : prioritaire sur les raccourcis média / recherche
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, saveOpen]);

  useEffect(() => {
    if (!open || !current?.id) return;
    void loadRelated(current.id);
    if (autoplay) topUpAutoplay();
  }, [open, current?.id, loadRelated, autoplay, topUpAutoplay]);

  useEffect(() => {
    setQueueVisible(QUEUE_PAGE);
    setSimilarVisible(10);
  }, [current?.id]);

  useEffect(() => {
    if (!open || tab !== 'lyrics' || !current?.id) return;
    let cancelled = false;
    setLyricsLoading(true);
    // Ne pas vider tout de suite → évite flash « indisponible »
    void api
      .lyrics(current.id)
      .then((r) => {
        if (cancelled) return;
        setLyricsText(r.lyrics || null);
        setLyricsTimed(r.timed || null);
        setLyricsSource(r.source ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setLyricsText(null);
        setLyricsTimed(null);
        setLyricsSource(null);
      })
      .finally(() => {
        if (!cancelled) setLyricsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, tab, current?.id]);

  // Charge l’URL vidéo seulement en mode Vidéo — resolve visual (fallback clip)
  useEffect(() => {
    if (!open || mediaMode !== 'video' || !current?.id) {
      setVideoUrl(null);
      setVideoError(null);
      setVideoLoading(false);
      return;
    }
    let cancelled = false;
    setVideoLoading(true);
    setVideoError(null);
    setVideoUrl(null);
    const artist = artistNames(current);
    void api
      .trackVisual(current.id, {
        title: current.title,
        artist: artist || undefined,
        durationSeconds: current.durationSeconds ?? undefined,
      })
      .then(async (vis) => {
        if (cancelled) return;
        if (!vis.visualId) {
          setVideoError('Pas de clip vidéo pour ce titre');
          return;
        }
        // Warm resolve sur l’ID visuel
        await api.streamUrl(vis.visualId, 'video').catch(() => null);
        if (cancelled) return;
        const tok = getToken();
        setVideoUrl(
          `/api/stream/${vis.visualId}?type=video${
            tok ? `&access_token=${encodeURIComponent(tok)}` : ''
          }`,
        );
      })
      .catch((e) => {
        if (!cancelled) setVideoError(String(e?.message || e || 'Vidéo indisponible'));
      })
      .finally(() => {
        if (!cancelled) setVideoLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, mediaMode, current?.id, current?.title]);

  // Sync image+son : vidéo muette calée sur l’audio (pause / seek inclus)
  useEffect(() => {
    if (mediaMode !== 'video' || !videoRef.current || !audioEl) return;
    const v = videoRef.current;
    v.muted = true;
    const sync = () => {
      if (!Number.isFinite(audioEl.currentTime)) return;
      if (Math.abs(v.currentTime - audioEl.currentTime) > 0.25) {
        try {
          v.currentTime = audioEl.currentTime;
        } catch {
          /* ignore seek race */
        }
      }
      if (audioEl.paused || audioEl.ended) {
        if (!v.paused) v.pause();
      } else if (v.paused) {
        void v.play().catch(() => {});
      }
    };
    sync();
    const onPlay = () => void v.play().catch(() => {});
    const onPause = () => v.pause();
    const onSeek = () => {
      try {
        v.currentTime = audioEl.currentTime;
      } catch {
        /* */
      }
    };
    audioEl.addEventListener('play', onPlay);
    audioEl.addEventListener('pause', onPause);
    audioEl.addEventListener('seeked', onSeek);
    audioEl.addEventListener('timeupdate', sync);
    const iv = window.setInterval(sync, 250);
    return () => {
      audioEl.removeEventListener('play', onPlay);
      audioEl.removeEventListener('pause', onPause);
      audioEl.removeEventListener('seeked', onSeek);
      audioEl.removeEventListener('timeupdate', sync);
      window.clearInterval(iv);
      v.pause();
    };
  }, [mediaMode, audioEl, videoUrl, isPlaying]);

  if (!open || !current) return null;

  const boundary = Math.min(Math.max(userQueueEnd || 0, 0), queue.length);
  const playingUser = queueIndex < boundary;
  /** Titres déjà joués dans la file (cliquables pour y revenir). */
  const playedBefore = queueIndex > 0 ? queue.slice(0, queueIndex) : [];
  const userUpcomingAll = playingUser ? queue.slice(queueIndex + 1, boundary) : [];
  const autoList = autoplay
    ? playingUser
      ? queue.slice(boundary)
      : queue.slice(queueIndex + 1)
    : [];
  const autoVisible = autoList.slice(0, Math.min(queueVisible, QUEUE_MAX));
  const canLoadMoreQueue = autoVisible.length < Math.min(autoList.length, QUEUE_MAX);
  const relatedArtists = uniqueArtists(related);
  const relatedForQueue = related.filter((t) => !queue.some((q) => q.id === t.id)).slice(0, 20);
  const saveTracks = queue; // joués + courant + suite déjà en mémoire (pas le futur non chargé)

  const onQueueScroll = () => {
    const el = queueScrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 120) return;
    if (tab === 'queue' && canLoadMoreQueue) {
      setQueueVisible((n) => Math.min(QUEUE_MAX, n + QUEUE_PAGE, autoList.length));
    }
    if (tab === 'related') {
      setSimilarVisible((n) => Math.min(related.length, n + 10));
    }
  };

  const onPanelTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    if (!t) return;
    const el = queueScrollRef.current;
    touchRef.current = {
      x: t.clientX,
      y: t.clientY,
      atTop: !el || el.scrollTop <= 2,
    };
  };

  const onPanelTouchEnd = (e: TouchEvent) => {
    const start = touchRef.current;
    touchRef.current = null;
    const t = e.changedTouches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    // Swipe horizontal → File ↔ Similaires
    if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      if (dx < 0 && tab === 'queue') setTab('related');
      else if (dx > 0 && tab === 'related') setTab('queue');
      else if (dx < 0 && tab === 'lyrics') setTab('related');
      else if (dx > 0 && tab === 'lyrics') setTab('queue');
      return;
    }
    // En haut + pull bas marqué → réaffiche le lecteur (cover) — seuil haut pour ne pas
    // « rétracter » quand on scrolle juste vers Déjà joués.
    if (tab === 'queue' && start.atTop && dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.5) {
      coverRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  return (
    <div className="fixed inset-0 z-[45] flex flex-col overflow-hidden bg-[#030303] text-white animate-fade-up">
      {/* Ambient blur YTM — derrière tout le contenu */}
      {current && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
          <img
            src={thumb(current, 240) || undefined}
            alt=""
            className="absolute inset-0 h-full w-full scale-125 object-cover opacity-45 blur-3xl"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-black/75 to-[#030303]" />
        </div>
      )}
      <div className="relative mx-auto grid min-h-0 w-full max-w-[1800px] flex-1 grid-cols-1 gap-3 overflow-hidden px-2 pb-[100px] pt-3 sm:px-4 md:grid-cols-[minmax(260px,0.85fr)_minmax(420px,1.25fr)] md:gap-8 md:px-6 lg:grid-cols-[minmax(280px,0.75fr)_minmax(520px,1.35fr)] lg:gap-10 lg:px-10 xl:px-14">
        <div
          ref={coverRef}
          className={`min-h-0 flex-col items-center justify-center overflow-hidden ${
            tab === 'queue' ? 'hidden md:flex' : 'flex'
          }`}
        >
          <div className="mb-4 flex rounded-full bg-[#1d1d1d] p-1 text-xs font-medium">
            <button
              type="button"
              onClick={() => setMode('cover')}
              className={`rounded-full px-5 py-1.5 transition ${
                mediaMode === 'cover' ? 'bg-white/15 text-white' : 'text-yt-muted hover:text-white'
              }`}
            >
              Titre
            </button>
            <button
              type="button"
              onClick={() => setMode('video')}
              className={`rounded-full px-5 py-1.5 transition ${
                mediaMode === 'video' ? 'bg-white/15 text-white' : 'text-yt-muted hover:text-white'
              }`}
            >
              Vidéo
            </button>
          </div>
          <div className="relative aspect-square w-full max-w-[min(88vw,520px)] overflow-hidden rounded-md bg-yt-elevated shadow-[0_20px_60px_rgba(0,0,0,0.65)] lg:max-w-[min(42vw,560px)]">
            {mediaMode === 'cover' ? (
              <CoverImage item={current} size={800} rounded="md" alt={current.title} />
            ) : videoLoading ? (
              <div className="flex h-full items-center justify-center text-sm text-yt-muted">
                Chargement vidéo…
              </div>
            ) : videoError ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-sm text-yt-muted">
                <CoverImage item={current} size={400} rounded="md" alt={current.title} />
                <p>{videoError}</p>
              </div>
            ) : videoUrl ? (
              <video
                ref={videoRef}
                key={videoUrl}
                src={videoUrl}
                className="h-full w-full object-contain bg-black"
                playsInline
                muted
                preload="metadata"
                onLoadedMetadata={() => {
                  const v = videoRef.current;
                  const a = usePlayer.getState().audioEl;
                  if (v && a && Number.isFinite(a.currentTime)) {
                    try {
                      v.currentTime = a.currentTime;
                    } catch {
                      /* */
                    }
                    if (!a.paused) void v.play().catch(() => {});
                  }
                }}
              />
            ) : (
              <CoverImage item={current} size={800} rounded="md" alt={current.title} />
            )}
          </div>
        </div>

        <aside
          className="flex min-h-0 min-w-0 flex-col overflow-hidden md:pt-1"
          onTouchStart={onPanelTouchStart}
          onTouchEnd={onPanelTouchEnd}
        >
          <div className="mb-1 flex border-b border-white/10 text-[11px] font-bold tracking-wider sm:text-xs">
            <TabBtn active={tab === 'queue'} onClick={() => setTab('queue')} icon={<ListMusic className="h-3.5 w-3.5" />}>
              File
            </TabBtn>
            <TabBtn active={tab === 'lyrics'} onClick={() => setTab('lyrics')} icon={<Mic2 className="h-3.5 w-3.5" />}>
              Paroles
            </TabBtn>
            <TabBtn active={tab === 'related'} onClick={() => setTab('related')} icon={<Sparkles className="h-3.5 w-3.5" />}>
              Similaires
            </TabBtn>
          </div>

          <div
            ref={queueScrollRef}
            className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain"
            onScroll={tab === 'queue' || tab === 'related' ? onQueueScroll : undefined}
          >
            {tab === 'queue' && (
              <div>
                <section>
                    <div className="mb-3 space-y-2 px-1 pt-1">
                      <div className="flex items-center gap-2 text-[11px] tabular-nums text-yt-muted">
                        <span className="w-9 shrink-0">{fmtClock(progress)}</span>
                        <input
                          type="range"
                          min={0}
                          max={Math.max(1, duration || 1)}
                          step={0.25}
                          value={Math.min(progress, duration || 0)}
                          onChange={(e) => seek(Number(e.target.value))}
                          className="h-1.5 w-full cursor-pointer accent-yt-red"
                          aria-label="Position"
                        />
                        <span className="w-9 shrink-0 text-right">{fmtClock(duration)}</span>
                      </div>
                      <div className="flex items-center justify-center gap-1">
                        <button
                          type="button"
                          onClick={toggleShuffle}
                          title={shuffle ? 'Aléatoire activé (suite)' : 'Aléatoire (suite)'}
                          className={`flex h-10 w-10 items-center justify-center rounded-full transition ${
                            shuffle ? 'text-yt-red' : 'text-yt-muted hover:bg-white/10 hover:text-white'
                          }`}
                        >
                          <Shuffle className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void prev()}
                          title="Précédent"
                          className="flex h-10 w-10 items-center justify-center rounded-full text-white hover:bg-white/10"
                        >
                          <SkipBack className="h-5 w-5 fill-current" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void toggle()}
                          title={isPlaying ? 'Pause' : 'Lecture'}
                          className="mx-1 flex h-12 w-12 items-center justify-center rounded-full bg-white text-black hover:scale-105"
                        >
                          {isPlaying ? (
                            <Pause className="h-6 w-6 fill-current" />
                          ) : (
                            <Play className="h-6 w-6 fill-current" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => void next()}
                          title="Suivant"
                          className="flex h-10 w-10 items-center justify-center rounded-full text-white hover:bg-white/10"
                        >
                          <SkipForward className="h-5 w-5 fill-current" />
                        </button>
                        <button
                          type="button"
                          onClick={cycleRepeat}
                          title={
                            repeat === 'one'
                              ? 'Boucler le titre'
                              : repeat === 'all'
                                ? 'Boucler toute la file'
                                : 'Boucle désactivée'
                          }
                          className={`flex h-10 w-10 items-center justify-center rounded-full transition ${
                            repeat !== 'off' ? 'text-yt-red' : 'text-yt-muted hover:bg-white/10 hover:text-white'
                          }`}
                        >
                          {repeat === 'one' ? <Repeat1 className="h-4 w-4" /> : <Repeat className="h-4 w-4" />}
                        </button>
                        <button
                          type="button"
                          disabled={saveTracks.length === 0}
                          onClick={() => setSaveOpen(true)}
                          className="ml-1 flex h-10 w-10 items-center justify-center rounded-full text-yt-muted transition hover:bg-white/10 hover:text-white disabled:opacity-40"
                          title="Enregistrer la file dans une playlist"
                        >
                          <Save className="h-4 w-4" />
                        </button>
                      </div>
                    </div>

                  {playedBefore.length > 0 && (
                    <div className="mb-3">
                      <p className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-yt-muted">
                        Déjà joués
                      </p>
                      <div className="opacity-70">
                        {playedBefore.map((t, i) => (
                          <TrackRow
                            key={`played-${t.id}-${i}`}
                            track={t}
                            queue={queue}
                            queueIndex={i}
                            hideIndex
                            draggable
                            alwaysActions
                            onPlay={() => void playAt(i)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                  <p className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-yt-muted">
                    En cours
                  </p>
                  <div className="mb-1 rounded-md bg-[#ff0033]/18 ring-1 ring-[#ff0033]/55">
                    <TrackRow
                      track={current}
                      queue={queue}
                      queueIndex={queueIndex}
                      hideIndex
                      draggable
                      alwaysActions
                    />
                  </div>

                  {userUpcomingAll.length > 0 && (
                    <div className="mt-3">
                      <p className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide text-yt-muted">
                        Ensuite dans ta file
                      </p>
                      {userUpcomingAll.map((t, i) => {
                        const abs = queueIndex + 1 + i;
                        return (
                          <TrackRow
                            key={`user-${t.id}-${abs}`}
                            track={t}
                            queue={queue}
                            queueIndex={abs}
                            hideIndex
                            draggable
                            alwaysActions
                            onPlay={() => void playAt(abs)}
                          />
                        );
                      })}
                    </div>
                  )}

                  {!playingUser && userUpcomingAll.length === 0 && playedBefore.length === 0 && (
                    <p className="px-2 py-3 text-center text-xs text-yt-muted">
                      Ta file manuelle est vide — suite en lecture auto.
                    </p>
                  )}
                </section>

                <section className="mt-5 border-t border-white/10 pt-4">
                  <div className="mb-3 flex items-center justify-between gap-2 px-1">
                    <div className="min-w-0">
                      <h3 className="flex items-center gap-2 font-display text-base font-semibold">
                        <Radio className="h-4 w-4 text-yt-red" />
                        À suivre
                      </h3>
                      <p className="mt-0.5 text-[11px] text-yt-muted">
                        Lecture automatique · suggestions
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={autoplay}
                      onClick={() => toggleAutoplay()}
                      className={`relative h-7 w-12 shrink-0 rounded-full transition ${
                        autoplay ? 'bg-yt-red' : 'bg-white/15'
                      }`}
                      title={autoplay ? 'Désactiver la lecture auto' : 'Activer la lecture auto'}
                    >
                      <span
                        className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${
                          autoplay ? 'left-5' : 'left-0.5'
                        }`}
                      />
                    </button>
                  </div>

                  {!autoplay && (
                    <p className="px-2 py-4 text-center text-sm text-yt-muted">
                      Lecture auto désactivée — la file s&apos;arrête après tes titres.
                    </p>
                  )}

                  {autoplay &&
                    autoVisible.map((t, i) => {
                      const abs = (playingUser ? boundary : queueIndex + 1) + i;
                      return (
                        <TrackRow
                          key={`auto-${t.id}-${abs}`}
                          track={t}
                          queue={queue}
                          queueIndex={abs}
                          hideIndex
                          draggable
                          alwaysActions
                          onPlay={() => void playUpcomingInQueue(abs)}
                        />
                      );
                    })}

                  {autoplay && canLoadMoreQueue && (
                    <button
                      type="button"
                      className="w-full py-3 text-center text-xs text-yt-muted hover:text-white"
                      onClick={() =>
                        setQueueVisible((n) => Math.min(QUEUE_MAX, n + QUEUE_PAGE, autoList.length))
                      }
                    >
                      Charger plus ({autoVisible.length} / {Math.min(autoList.length, QUEUE_MAX)})
                    </button>
                  )}

                  {autoplay && autoList.length === 0 && relatedForQueue.length === 0 && (
                    <div className="px-2 py-4 text-center">
                      <p className="text-sm text-yt-muted">
                        {autoRadioLoading
                          ? 'Chargement des suggestions…'
                          : 'Aucune suggestion pour l’instant.'}
                      </p>
                      {!autoRadioLoading && (
                        <button
                          type="button"
                          className="mt-2 text-xs text-yt-red hover:underline"
                          onClick={() => topUpAutoplay()}
                        >
                          Réessayer
                        </button>
                      )}
                    </div>
                  )}

                  {autoplay && relatedForQueue.length > 0 && autoList.length === 0 && (
                    <div className="mt-2">
                      <div className="mb-2 flex items-center justify-between px-1">
                        <span className="text-xs text-yt-muted">Propositions</span>
                        <button
                          type="button"
                          className="text-xs text-yt-muted hover:text-white"
                          onClick={() => appendRelated(relatedForQueue)}
                        >
                          Tout ajouter
                        </button>
                      </div>
                      {relatedForQueue.map((t) => (
                        <TrackRow
                          key={`qrel-${t.id}`}
                          track={t}
                          queue={related}
                          alwaysActions
                          hideIndex
                          onPlay={() => {
                            addNext(t);
                            void playUpcomingInQueue(queueIndex + 1);
                          }}
                        />
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}

            {tab === 'lyrics' && (
              <div>
                <div className="mb-2 flex items-start justify-between gap-2 px-1 pt-1">
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-display text-base font-semibold leading-tight" title={current.title}>
                      {current.title}
                    </h3>
                    <p className="truncate text-xs text-yt-muted">{artistNames(current)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => openActions(current, { queueIndex })}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-yt-muted hover:bg-white/10 hover:text-white"
                    title="Plus d'options"
                    aria-label="Plus d'options"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </button>
                </div>
                {lyricsLoading ? (
                  <div className="px-3 py-5 text-sm text-yt-muted">Chargement des paroles…</div>
                ) : (
                  <SyncedLyrics text={lyricsText} timed={lyricsTimed} source={lyricsSource} />
                )}
              </div>
            )}

            {tab === 'related' && (
              <div className="space-y-7 pt-1">
                <section>
                  <div className="mb-3 flex items-center justify-between px-1">
                    <h3 className="font-display text-lg font-semibold">Découvrez également</h3>
                    {related.length > 0 && relatedSeedId === current?.id && (
                      <button
                        type="button"
                        className="text-xs text-yt-muted hover:text-white"
                        onClick={() => appendRelated(related)}
                      >
                        Tout ajouter
                      </button>
                    )}
                  </div>
                  {relatedLoading && related.length === 0 && (
                    <p className="px-2 text-sm text-yt-muted">Chargement des suggestions…</p>
                  )}
                  {!relatedLoading && related.length === 0 && (
                    <p className="px-2 text-sm text-yt-muted">Aucune suggestion pour l’instant.</p>
                  )}
                  {(relatedSeedId === current?.id ? related : []).slice(0, similarVisible).map((t) => (
                    <TrackRow key={`rel-${t.id}`} track={t} queue={related} hideIndex />
                  ))}
                  {relatedSeedId === current?.id && similarVisible < related.length && (
                    <button
                      type="button"
                      className="w-full py-3 text-center text-xs text-yt-muted hover:text-white"
                      onClick={() => setSimilarVisible((n) => Math.min(related.length, n + 10))}
                    >
                      Charger plus ({similarVisible} / {related.length})
                    </button>
                  )}
                </section>

                {relatedArtists.length > 0 && (
                  <section className="pb-4">
                    <h3 className="mb-4 px-1 font-display text-lg font-semibold">Artistes similaires</h3>
                    <div className="flex gap-5 overflow-x-auto pb-2">
                      {relatedArtists.map((a) => (
                        <button
                          key={a.id || a.name}
                          type="button"
                          className="flex w-28 shrink-0 flex-col items-center gap-2 text-center"
                          onClick={() => {
                            if (!a.id) return;
                            onClose();
                            navigate(`/artist/${a.id}`);
                          }}
                        >
                          <div className="h-24 w-24 overflow-hidden rounded-full bg-yt-elevated">
                            {a.thumb ? (
                              <img src={a.thumb} alt="" className="h-full w-full object-cover" />
                            ) : (
                              <div className="flex h-full w-full items-center justify-center text-2xl text-yt-muted">
                                {a.name.slice(0, 1)}
                              </div>
                            )}
                          </div>
                          <span className="line-clamp-2 text-xs font-medium">{a.name}</span>
                          <span className="text-[10px] text-yt-muted">Artiste</span>
                        </button>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>

      <SaveQueueSheet
        open={saveOpen}
        tracks={saveTracks}
        onClose={() => setSaveOpen(false)}
      />
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-1 py-3 uppercase transition sm:gap-2 sm:px-2 ${
        active ? 'border-white text-white' : 'border-transparent text-yt-muted hover:text-white'
      }`}
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  );
}

function uniqueArtists(tracks: Track[]) {
  const seen = new Set<string>();
  const out: { id?: string; name: string; thumb?: string }[] = [];
  for (const t of tracks) {
    for (const a of t.artists || []) {
      const key = a.id || a.name;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ id: a.id, name: a.name, thumb: thumb(t, 200) || undefined });
      if (out.length >= 10) return out;
    }
  }
  return out;
}
