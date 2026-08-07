import { usePlayer } from '../store/player';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest('[contenteditable="true"], input, textarea, select'));
}

function setMediaHandler(
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {
    /* action non supportée */
  }
}

function audioEl() {
  return usePlayer.getState().audioEl;
}

/** Sync isPlaying depuis l’élément audio (source de vérité UI). */
function syncPlayingFromAudio() {
  const audio = audioEl();
  const p = usePlayer.getState();
  if (!audio) return;
  const playing = !audio.paused && !audio.ended;
  if (p.isPlaying !== playing) {
    usePlayer.setState({ isPlaying: playing });
  }
}

/** Play/pause unifié — passe toujours par toggle() (local + remote + UI). */
function doPlayPause() {
  usePlayer.getState().toggle();
  // Sync différé au cas où les events audio arrivent en retard
  requestAnimationFrame(() => {
    syncPlayingFromAudio();
    updateMediaSessionMetadata();
  });
}

function ensurePlaying() {
  const p = usePlayer.getState();
  if (!p.current) return;
  const audio = p.audioEl;
  // Déjà en lecture → force l’icône play
  if (audio && !audio.paused && !audio.ended) {
    usePlayer.setState({ isPlaying: true });
    updateMediaSessionMetadata();
    return;
  }
  if (p.isPlaying && audio && audio.paused) {
    // État store désynchronisé
    usePlayer.setState({ isPlaying: false });
  }
  p.toggle();
  requestAnimationFrame(() => {
    syncPlayingFromAudio();
    updateMediaSessionMetadata();
  });
}

function ensurePaused() {
  const p = usePlayer.getState();
  const audio = p.audioEl;
  if (audio && !audio.paused) {
    audio.pause();
    usePlayer.setState({ isPlaying: false });
    updateMediaSessionMetadata();
    return;
  }
  if (p.isPlaying) {
    // Remote ou store désync : toggle pour envoyer pause
    p.toggle();
  }
  usePlayer.setState({ isPlaying: false });
  updateMediaSessionMetadata();
}

function doNext() {
  void usePlayer.getState().next();
}

function doPrev() {
  void usePlayer.getState().prev();
}

/** Enregistre / rafraîchit les handlers Media Session (MPRIS Linux + OS). */
export function wireMediaSession() {
  if (!('mediaSession' in navigator)) return;

  setMediaHandler('play', () => ensurePlaying());
  setMediaHandler('pause', () => ensurePaused());
  setMediaHandler('stop', () => ensurePaused());
  setMediaHandler('previoustrack', () => doPrev());
  setMediaHandler('nexttrack', () => doNext());
  setMediaHandler('seekto', (details) => {
    if (typeof details.seekTime === 'number') usePlayer.getState().seek(details.seekTime);
  });
  setMediaHandler('seekbackward', (details) => {
    const off = details.seekOffset ?? 10;
    usePlayer.getState().seekBy(-off);
  });
  setMediaHandler('seekforward', (details) => {
    const off = details.seekOffset ?? 10;
    usePlayer.getState().seekBy(off);
  });
}

function mediaArtwork(track: {
  id: string;
  thumbnails?: { url: string; width?: number; height?: number }[];
}): MediaImage[] {
  const out: MediaImage[] = [];
  const seen = new Set<string>();
  // Chrome Media Session limite le nombre d’images artwork (~10) ;
  // au-delà : « The number of MediaImage sizes exceeds the upper limit ».
  const MAX_ARTWORK = 4;
  const push = (src: string, w: number, h: number) => {
    if (!src || seen.has(src) || out.length >= MAX_ARTWORK) return;
    seen.add(src);
    out.push({ src, sizes: `${w}x${h}`, type: 'image/jpeg' });
  };
  const thumbs = [...(track.thumbnails || [])].sort((a, b) => (a.width || 0) - (b.width || 0));
  for (const t of thumbs) {
    push(t.url, t.width || 256, t.height || t.width || 256);
  }
  if (/^[a-zA-Z0-9_-]{11}$/.test(track.id)) {
    push(`https://i.ytimg.com/vi/${track.id}/mqdefault.jpg`, 320, 180);
    push(`https://i.ytimg.com/vi/${track.id}/hqdefault.jpg`, 480, 360);
  }
  return out;
}

export function updateMediaSessionMetadata() {
  if (!('mediaSession' in navigator)) return;
  const { current, progress, duration, isLoading, isPlaying } = usePlayer.getState();
  const audio = audioEl();
  const actuallyPlaying = audio ? !audio.paused && !audio.ended : isPlaying;
  // Pendant le chargement d’un saut lointain : garder métadonnées + état « paused »
  // (évite barre OS vide jusqu’au prochain expand/collapse).
  const playing = isLoading ? false : actuallyPlaying;

  if (!current) {
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    } catch {
      /* ignore */
    }
    return;
  }

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title || '…',
      artist: current.artists?.map((a) => a.name).filter(Boolean).join(', ') || 'Artiste',
      album: current.album?.name || 'PLM',
      artwork: mediaArtwork(current),
    });
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    const dur = Number.isFinite(duration) && duration > 0 ? duration : audio?.duration || 0;
    const pos = Number.isFinite(progress) ? progress : audio?.currentTime || 0;
    if (dur > 0 && Number.isFinite(pos)) {
      navigator.mediaSession.setPositionState({
        duration: dur,
        position: Math.min(Math.max(0, pos), dur),
        playbackRate: audio?.playbackRate || 1,
      });
    } else {
      // Durée inconnue pendant buffer : quand même une position 0 pour peupler la barre
      try {
        navigator.mediaSession.setPositionState({
          duration: Math.max(dur, 1),
          position: 0,
          playbackRate: 1,
        });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  wireMediaSession();
}

type MediaAction = 'playpause' | 'play' | 'pause' | 'stop' | 'next' | 'prev';

function mediaActionFromEvent(e: KeyboardEvent): MediaAction | null {
  const k = e.key;
  const c = e.code;
  const code = e.keyCode || (e as KeyboardEvent & { which?: number }).which || 0;

  if (
    k === 'MediaPlayPause' ||
    c === 'MediaPlayPause' ||
    k === 'AudioPlay' ||
    c === 'AudioPlay' ||
    code === 179
  ) {
    return 'playpause';
  }
  if (k === 'MediaPlay' || c === 'MediaPlay' || code === 250) return 'play';
  if (k === 'MediaPause' || c === 'MediaPause') return 'pause';
  if (k === 'MediaStop' || c === 'MediaStop' || code === 178) return 'stop';
  if (k === 'MediaTrackNext' || c === 'MediaTrackNext' || code === 176) return 'next';
  if (k === 'MediaTrackPrevious' || c === 'MediaTrackPrevious' || code === 177) return 'prev';

  if ((k === 'Unidentified' || k === '' || !k) && code) {
    if (code === 179) return 'playpause';
    if (code === 176) return 'next';
    if (code === 177) return 'prev';
    if (code === 178) return 'stop';
  }
  return null;
}

let lastMediaAction: MediaAction | null = null;
let lastMediaAt = 0;

function handleMediaAction(action: MediaAction) {
  const now = Date.now();
  if (action === lastMediaAction && now - lastMediaAt < 280) return;
  lastMediaAction = action;
  lastMediaAt = now;

  const p = usePlayer.getState();
  if (!p.current && action !== 'stop') return;
  if (action === 'playpause') doPlayPause();
  else if (action === 'play') ensurePlaying();
  else if (action === 'pause' || action === 'stop') ensurePaused();
  else if (action === 'next') doNext();
  else if (action === 'prev') doPrev();
}

/**
 * Raccourcis clavier app-wide + Media Session (MPRIS).
 * Bindings multiples : Ctrl souvent capturé par le DE Linux (workspaces).
 */
export function installMediaKeys(): () => void {
  wireMediaSession();
  updateMediaSessionMetadata();

  const onKey = (e: KeyboardEvent) => {
    const media = mediaActionFromEvent(e);
    if (media) {
      e.preventDefault();
      e.stopPropagation();
      handleMediaAction(media);
      return;
    }

    if (e.type === 'keyup') return;
    if (isTypingTarget(e.target)) return;
    if (e.metaKey) return;

    const key = e.key;
    const code = e.code;

    // —— Volume (↑ / ↓ ou + / −) — même hors lecture ——
    const volUp =
      (!e.ctrlKey && !e.altKey && !e.shiftKey && (key === 'ArrowUp' || code === 'ArrowUp')) ||
      (!e.ctrlKey && !e.altKey && (key === '+' || key === '=' || code === 'Equal' || code === 'NumpadAdd'));
    const volDown =
      (!e.ctrlKey && !e.altKey && !e.shiftKey && (key === 'ArrowDown' || code === 'ArrowDown')) ||
      (!e.ctrlKey && !e.altKey && (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract'));
    if (volUp || volDown) {
      e.preventDefault();
      e.stopPropagation();
      const p = usePlayer.getState();
      const step = 0.05;
      const base = p.volume > 0.001 ? p.volume : 0;
      const next = Math.max(0, Math.min(1, Math.round((base + (volUp ? step : -step)) * 100) / 100));
      p.setVolume(next);
      return;
    }

    if (!usePlayer.getState().current) return;

    // —— Play / Pause ——
    // Espace, K, P (sans modificateur)
    if (
      (!e.ctrlKey && !e.altKey && !e.shiftKey && (code === 'Space' || key === ' ' || key === 'k' || key === 'K' || key === 'p' || key === 'P')) ||
      (e.ctrlKey && !e.altKey && !e.shiftKey && (key === 'p' || key === 'P' || code === 'Space'))
    ) {
      e.preventDefault();
      e.stopPropagation();
      doPlayPause();
      return;
    }

    // —— Suivant ——
    // Ctrl/Alt/Shift+→ , ] , . , Shift+N , N
    if (
      ((e.ctrlKey || e.altKey || e.shiftKey) && (key === 'ArrowRight' || code === 'ArrowRight')) ||
      (!e.ctrlKey && !e.altKey && (key === ']' || code === 'BracketRight' || key === '.' || code === 'Period')) ||
      (e.shiftKey && (key === 'N' || key === 'n')) ||
      (!e.ctrlKey && !e.altKey && !e.shiftKey && (key === 'n' || key === 'N') && code === 'KeyN')
    ) {
      // N seul = next (YouTube) ; Shift+N aussi
      if ((key === 'n' || key === 'N') && !e.shiftKey && (e.ctrlKey || e.altKey)) {
        /* ignore Ctrl+N = nouvel onglet */
      } else if ((key === 'n' || key === 'N') && e.ctrlKey) {
        return;
      } else {
        e.preventDefault();
        e.stopPropagation();
        doNext();
        return;
      }
    }

    // —— Précédent ——
    // Ctrl/Alt/Shift+← , [ , , , Shift+P already used for play — use Shift+, or B
    if (
      ((e.ctrlKey || e.altKey || e.shiftKey) && (key === 'ArrowLeft' || code === 'ArrowLeft')) ||
      (!e.ctrlKey && !e.altKey && (key === '[' || code === 'BracketLeft' || key === ',' || code === 'Comma')) ||
      (!e.ctrlKey && !e.altKey && !e.shiftKey && (key === 'b' || key === 'B'))
    ) {
      e.preventDefault();
      e.stopPropagation();
      doPrev();
      return;
    }

    // Seek J / L / ← / → — relatif à audio.currentTime (progress Zustand est throttle → faux « reset »)
    if (!e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (key === 'j' || key === 'J') {
        e.preventDefault();
        e.stopPropagation();
        usePlayer.getState().seekBy(-10);
        return;
      }
      if (key === 'l' || key === 'L') {
        e.preventDefault();
        e.stopPropagation();
        usePlayer.getState().seekBy(10);
        return;
      }
      if (key === 'ArrowLeft' || code === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        usePlayer.getState().seekBy(-5);
        return;
      }
      if (key === 'ArrowRight' || code === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        usePlayer.getState().seekBy(5);
        return;
      }
    }
  };

  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKey, true);

  const unsub = usePlayer.subscribe((state, prev) => {
    if (
      state.current?.id !== prev.current?.id ||
      state.isPlaying !== prev.isPlaying ||
      state.isLoading !== prev.isLoading ||
      state.audioEl !== prev.audioEl ||
      Math.floor(state.progress) !== Math.floor(prev.progress) ||
      state.duration !== prev.duration
    ) {
      if (
        state.current?.id === prev.current?.id &&
        state.isPlaying === prev.isPlaying &&
        state.isLoading === prev.isLoading &&
        state.audioEl === prev.audioEl
      ) {
        if (Math.abs(state.progress - prev.progress) < 1 && state.duration === prev.duration) {
          return;
        }
      }
      updateMediaSessionMetadata();
    }
  });

  const onVis = () => {
    if (document.visibilityState === 'visible') {
      wireMediaSession();
      syncPlayingFromAudio();
      updateMediaSessionMetadata();
    }
  };
  const onFocus = () => {
    wireMediaSession();
    syncPlayingFromAudio();
    updateMediaSessionMetadata();
  };
  const onPointer = () => {
    wireMediaSession();
  };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('focus', onFocus);
  window.addEventListener('pointerdown', onPointer, { passive: true });

  const keepAlive = window.setInterval(() => {
    if (!usePlayer.getState().current) return;
    syncPlayingFromAudio();
    try {
      const audio = audioEl();
      const playing = audio ? !audio.paused && !audio.ended : usePlayer.getState().isPlaying;
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
      const { progress, duration } = usePlayer.getState();
      const dur = duration || audio?.duration || 0;
      const pos = audio?.currentTime ?? progress;
      if (dur > 0 && Number.isFinite(pos)) {
        navigator.mediaSession.setPositionState({
          duration: dur,
          position: Math.min(Math.max(0, pos), dur),
          playbackRate: audio?.playbackRate || 1,
        });
      }
    } catch {
      /* ignore */
    }
  }, 12_000);

  let attached: HTMLAudioElement | null = null;
  const audioListeners: Array<[string, EventListener]> = [];
  const attachAudio = (el: HTMLAudioElement | null) => {
    if (attached === el) return;
    if (attached) {
      for (const [ev, fn] of audioListeners) attached.removeEventListener(ev, fn);
      audioListeners.length = 0;
    }
    attached = el;
    if (!el) return;
    const bump = () => {
      syncPlayingFromAudio();
      wireMediaSession();
      updateMediaSessionMetadata();
    };
    for (const ev of ['play', 'playing', 'pause', 'ended', 'loadedmetadata'] as const) {
      el.addEventListener(ev, bump);
      audioListeners.push([ev, bump]);
    }
    bump();
  };
  attachAudio(usePlayer.getState().audioEl);
  const unsubAudio = usePlayer.subscribe((s, prev) => {
    if (s.audioEl !== prev.audioEl) attachAudio(s.audioEl);
  });

  return () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('keyup', onKey, true);
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('pointerdown', onPointer);
    window.clearInterval(keepAlive);
    unsub();
    unsubAudio();
    attachAudio(null);
  };
}
