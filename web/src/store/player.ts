import { create } from 'zustand';
import { api, artistNames, type Track } from '../api';
import { listCachedTracks, resolvePlayUrl, streamProxyUrl } from '../lib/offline/offlineCache';
import { isBrowserOnline } from '../lib/offline/connectivity';
import {
  prefetchAround,
  resolvePrefetchedPlayUrl,
  warmFormat,
  isPrefetchBlobUrl,
  isStreamDown,
  markStreamFailure,
  markStreamOk,
  pinFullTrack,
  clearPinnedFull,
} from '../lib/audio/streamPrefetch';
import { eqNeedsSameOrigin, setMeterPreferred } from '../lib/audio/equalizer';
import { resetSilenceSkip, shouldSkipTrailingSilence } from '../lib/audio/silenceSkip';
import { trackDurationSeconds, formatClock } from '../lib/util/time';
import { perfStart } from '../lib/util/perf';
import { useSession } from './session';
import { useLibrary } from './library';
import {
  clearCachedMix,
  getCachedMix,
  isPrecomputedMixSource,
  mixCacheKey,
  MIX_TARGET,
  setCachedMix,
} from '../lib/util/mixCache';

/** Sync préférence lecture auto → compte (multi-appareils). */
function syncAutoplayPref(on: boolean) {
  void api.savePrefs({ autoplaySuggestions: on }).catch(() => undefined);
}

/** Hydrate autoplay depuis /api/prefs (appelé au login). */
export async function hydrateAutoplayFromPrefs() {
  try {
    const r = await api.prefs();
    const v = r.prefs?.autoplaySuggestions;
    if (typeof v === 'boolean') {
      usePlayer.setState({ autoplay: v });
      persistPlayer();
    }
  } catch {
    /* ignore */
  }
}

type RepeatMode = 'off' | 'all' | 'one';

function refreshMediaSession() {
  void import('../lib/audio/mediaKeys')
    .then((m) => {
      m.wireMediaSession();
      m.updateMediaSessionMetadata();
    })
    .catch(() => undefined);
}

type PlayerState = {
  current: Track | null;
  queue: Track[];
  queueIndex: number;
  /** Fin exclusive de la file « utilisateur » (album / playlist lancée). Au-delà = autoplay. */
  userQueueEnd: number;
  /** Collection d’où vient la file (album / playlist / mix…) — overlay « en lecture ». */
  sourceId: string | null;
  sourceKind: 'album' | 'playlist' | 'mix' | 'artist' | 'radio' | null;
  /** Suggestions automatiques après la file (style YTM). */
  autoplay: boolean;
  isPlaying: boolean;
  isLoading: boolean;
  shuffle: boolean;
  /**
   * Ordre « naturel » de la suite (après le titre courant) quand le shuffle est actif.
   * Permet de restaurer l’ordre initial à la désactivation, y compris les ajouts autoplay.
   */
  shuffleNatural: Track[] | null;
  repeat: RepeatMode;
  volume: number;
  progress: number;
  duration: number;
  showQueue: boolean;
  showLyrics: boolean;
  /** Mode présentation Now Playing : cover = skip silence de fin ; video = laisse finir. */
  mediaPresentation: 'cover' | 'video';
  lyrics: string | null;
  lyricsTimed: { startMs: number; text: string }[] | null;
  lyricsSource: 'youtube' | 'lrclib' | 'lrc' | null;
  related: Track[];
  /** Seed pour lequel `related` a été fetché (évite de réinjecter une vieille liste). */
  relatedSeedId: string | null;
  relatedLoading: boolean;
  /** Remplissage « À suivre » en cours (fast/full). */
  autoRadioLoading: boolean;
  /** Hint court (skip sans suite, etc.). */
  queueHint: string | null;
  relatedError: string | null;
  hydrated: boolean;
  play: (
    track: Track,
    queue?: Track[],
    opts?: {
      preserveQueue?: boolean;
      noAutoRadio?: boolean;
      keepUserBoundary?: boolean;
      /** Nouvelle playlist / titre depuis l’UI : remplace la file et repart de 0. */
      forceRestart?: boolean;
      sourceId?: string | null;
      sourceKind?: 'album' | 'playlist' | 'mix' | 'artist' | 'radio' | null;
    },
  ) => Promise<void>;
  playQueue: (
    tracks: Track[],
    startIndex?: number,
    opts?: {
      sourceId?: string | null;
      sourceKind?: 'album' | 'playlist' | 'mix' | 'artist' | 'radio' | null;
    },
  ) => Promise<void>;
  playAt: (index: number) => Promise<void>;
  /**
   * Clic dans « À suivre » : place le titre juste après le courant puis le lance,
   * sans marquer les suggestions intermédiaires comme déjà jouées.
   */
  playUpcomingInQueue: (index: number) => Promise<void>;
  toggle: () => void;
  next: (opts?: { fromEnded?: boolean }) => Promise<void>;
  prev: () => Promise<void>;
  setProgress: (n: number) => void;
  seek: (n: number) => void;
  /** Avance / recule relativement à la position audio réelle (pas le progress Zustand throttle). */
  seekBy: (deltaSec: number) => void;
  setDuration: (n: number) => void;
  setVolume: (n: number) => void;
  toggleShuffle: () => void;
  /** Like / dislike : réoriente les futures propositions sans toucher à la file déjà chargée. */
  refreshRecoAfterFeedback: (trackId: string, verdict: 'good' | 'bad') => void;
  cycleRepeat: () => void;
  toggleQueue: () => void;
  toggleLyrics: () => void;
  setMediaPresentation: (mode: 'cover' | 'video') => void;
  toggleAutoplay: () => void;
  setAutoplay: (on: boolean) => void;
  /** Relance le remplissage de la zone « À suivre ». */
  topUpAutoplay: () => void;
  addNext: (track: Track) => void;
  addToQueue: (track: Track) => void;
  moveInQueue: (fromIndex: number, toIndex: number) => void;
  removeFromQueue: (index: number) => void;
  /** Retire les titres avant l’index courant (section « Déjà joués »). */
  clearPlayedFromQueue: () => void;
  /** Vide la suite : garde le titre en cours, coupe l’autoplay. */
  clearUpcomingFromQueue: () => void;
  /** Arrête tout et vide la file (barre lecteur disparaît). */
  stopAndClear: () => void;
  appendRelated: (tracks: Track[]) => void;
  clearQueue: () => void;
  /** Insère / remplace la suite après le titre courant sans le relancer. */
  enqueueAfterCurrent: (
    tracks: Track[],
    opts?: { replaceRest?: boolean; cap?: number; sourceId?: string | null; sourceKind?: PlayerState['sourceKind'] },
  ) => void;
  startMix: (track: Track) => Promise<void>;
  /** Radio style YTM : depuis un titre, album ou artiste. */
  startRadio: (opts: {
    kind: 'track' | 'album' | 'artist';
    id: string;
    seed?: Track;
    /** Si true, favorise les titres du même artiste (quand kind=track). */
    stayClose?: boolean;
  }) => Promise<{ added: number; soft: boolean } | void>;
  hydrate: () => Promise<void>;
  applyRemoteState: (state: Partial<PlayerState> & { current?: Track | null }, playAudio?: boolean) => Promise<void>;
  loadRelated: (trackId: string) => Promise<void>;
  sleepLabel: string | null;
  sleepUntilEnd: boolean;
  /** Pause après le dernier titre de la file (pas de radio auto). */
  sleepUntilQueueEnd: boolean;
  playError: string | null;
  /** Timer : délai ms, fin de piste, fin de file, ou null pour annuler. */
  setSleepTimer: (
    delayMs: number | 'end' | 'queue' | null,
    label: string | null,
  ) => void;
  clearPlayError: () => void;
  audioEl: HTMLAudioElement | null;
  /** Second <audio> : précharge le titre suivant (skip A/B). */
  standbyEl: HTMLAudioElement | null;
  bindAudio: (el: HTMLAudioElement | null) => void;
  bindStandbyAudio: (el: HTMLAudioElement | null) => void;
};

let sleepTimerHandle: number | null = null;

function clearSleepTimerInternal() {
  if (sleepTimerHandle != null) {
    window.clearTimeout(sleepTimerHandle);
    sleepTimerHandle = null;
  }
}

function isPlayable(t: Track) {
  return /^[a-zA-Z0-9_-]{11}$/.test(t.id);
}

/** Clé titre+artiste normalisée — évite doublons « même chanson » avec ids différents. */
function trackFingerprint(t: Track): string {
  const title = (t.title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const artist = (t.artists?.[0]?.name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${title}|${artist}`;
}

/** Interleave par artiste — max ~1/4 du seed, pas de rafales même auteur / même titre. */
function diversifyByArtist(
  tracks: Track[],
  seedArtist?: { id?: string; name?: string } | null,
  seedTrack?: Track | null,
): Track[] {
  const seedKey = (seedArtist?.id || seedArtist?.name || '').toLowerCase();
  const seedFp = seedTrack ? trackFingerprint(seedTrack) : '';
  const buckets = new Map<string, Track[]>();
  const seenFp = new Set<string>();
  for (const t of tracks) {
    if (!isPlayable(t)) continue;
    const fp = trackFingerprint(t);
    if (!fp.startsWith('|') && (fp === seedFp || seenFp.has(fp))) continue;
    seenFp.add(fp);
    const key = (t.artists?.[0]?.id || t.artists?.[0]?.name || t.id).toLowerCase();
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(t);
  }
  const keys = [...buckets.keys()].sort((a, b) => {
    if (a === seedKey) return 1;
    if (b === seedKey) return -1;
    return (buckets.get(b)?.length || 0) - (buckets.get(a)?.length || 0);
  });
  const out: Track[] = [];
  const seen = new Set<string>();
  let seedHits = 0;
  let guard = 0;
  while (out.length < 80 && guard++ < 400) {
    let added = false;
    for (const k of keys) {
      const bucket = buckets.get(k);
      if (!bucket?.length) continue;
      if (seedKey && k === seedKey && seedHits >= Math.max(1, Math.floor(out.length / 4) + 1)) {
        continue;
      }
      const t = bucket.shift()!;
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
      if (seedKey && k === seedKey) seedHits += 1;
      added = true;
      if (out.length >= 80) break;
    }
    if (!added) break;
  }
  return out;
}

function mergeArtists(
  local: Track['artists'] = [],
  remote: Track['artists'] = [],
): Track['artists'] {
  if (!remote.length) return local;
  if (!local.length) return remote;
  return remote.map((r, i) => {
    const l = local.find((x) => x.name.toLowerCase() === r.name.toLowerCase()) || local[i];
    return {
      name: r.name || l?.name || 'Artiste',
      id: r.id || l?.id,
    };
  });
}

const PLAYER_STORAGE_KEY = 'ytm_player_v1';
/** Conserve un historique court + une longue suite (évite de saturer localStorage). */
const QUEUE_KEEP_BEFORE = 48;
const QUEUE_KEEP_AFTER = 80;

type PersistedPlayer = {
  v?: number;
  current: Track | null;
  queue: Track[];
  queueIndex: number;
  userQueueEnd?: number;
  autoplay?: boolean;
  volume: number;
  shuffle: boolean;
  repeat: RepeatMode;
  progress: number;
  /** Durée en secondes — pour la barre de progression dès le reload (sans attendre Play). */
  duration?: number;
  savedAt?: number;
};

function slimTrack(t: Track): Track {
  const thumbs = (t.thumbnails || []).slice(0, 2);
  return {
    id: t.id,
    title: t.title,
    type: t.type,
    artists: t.artists,
    album: t.album,
    duration: t.duration,
    thumbnails: thumbs,
  };
}

function trimQueueForPersist(
  queue: Track[],
  queueIndex: number,
  userQueueEnd: number,
): { queue: Track[]; queueIndex: number; userQueueEnd: number } {
  if (queue.length <= QUEUE_KEEP_BEFORE + 1 + QUEUE_KEEP_AFTER) {
    return {
      queue: queue.map(slimTrack),
      queueIndex,
      userQueueEnd: Math.min(userQueueEnd, queue.length),
    };
  }
  const start = Math.max(0, queueIndex - QUEUE_KEEP_BEFORE);
  const end = Math.min(queue.length, queueIndex + 1 + QUEUE_KEEP_AFTER);
  return {
    queue: queue.slice(start, end).map(slimTrack),
    queueIndex: queueIndex - start,
    userQueueEnd: Math.max(0, Math.min(userQueueEnd, end) - start),
  };
}

function loadPersisted(): Partial<PersistedPlayer> {
  try {
    const raw = localStorage.getItem(PLAYER_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as PersistedPlayer;
  } catch {
    return {};
  }
}

function persistPlayer() {
  try {
    const s = usePlayer.getState();
    if (!s.current && (!s.queue || s.queue.length === 0)) {
      localStorage.removeItem(PLAYER_STORAGE_KEY);
      return;
    }

    let progress = s.progress;
    const audio = s.audioEl;
    if (audio && Number.isFinite(audio.currentTime) && audio.currentTime > 0) {
      progress = audio.currentTime;
    }

    const trimmed = trimQueueForPersist(
      s.queue || [],
      s.queueIndex || 0,
      typeof s.userQueueEnd === 'number' ? s.userQueueEnd : (s.queue || []).length,
    );
    const durationSec =
      s.duration > 0
        ? s.duration
        : s.current
          ? trackDurationSeconds(s.current) || 0
          : 0;
    const payload: PersistedPlayer = {
      v: 3,
      current: s.current ? slimTrack(s.current) : null,
      queue: trimmed.queue,
      queueIndex: trimmed.queueIndex,
      userQueueEnd: trimmed.userQueueEnd,
      autoplay: s.autoplay !== false,
      volume: s.volume,
      shuffle: s.shuffle,
      repeat: s.repeat,
      progress,
      duration: durationSec > 0 ? durationSec : undefined,
      savedAt: Date.now(),
    };

    try {
      localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Quota : garder un historique avant + la suite (pas seulement le titre courant)
      const qi = Math.max(0, s.queueIndex || 0);
      const full = s.queue || [];
      const start = Math.max(0, qi - 24);
      const end = Math.min(full.length, qi + 40);
      const q = full.slice(start, end).map(slimTrack);
      const newQi = qi - start;
      const oldEnd = typeof s.userQueueEnd === 'number' ? s.userQueueEnd : full.length;
      const compact: PersistedPlayer = {
        v: 3,
        current: s.current ? slimTrack(s.current) : q[newQi] || q[0] || null,
        queue: q.length ? q : s.current ? [slimTrack(s.current)] : [],
        queueIndex: q.length ? newQi : 0,
        userQueueEnd: Math.max(0, Math.min(oldEnd, end) - start),
        autoplay: s.autoplay !== false,
        volume: s.volume,
        shuffle: s.shuffle,
        repeat: s.repeat,
        progress,
        duration: durationSec > 0 ? durationSec : undefined,
        savedAt: Date.now(),
      };
      localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(compact));
    }
  } catch {
    /* private mode / quota */
  }
}

/** Flush immédiat (fermeture onglet / app / arrière-plan). */
export function flushPlayerPersist() {
  persistPlayer();
}

function installPersistLifecycle() {
  if (typeof window === 'undefined') return;
  const flush = () => {
    try {
      persistPlayer();
    } catch {
      /* ignore */
    }
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  // PWA / mobile : freeze de la page
  window.addEventListener('freeze', flush);
}

installPersistLifecycle();

let lastHttpPublishAt = 0;
let lastHttpSignature = '';

function publish() {
  // Sync off → file / titre / progress restent locaux (compte partagé seulement).
  if (!useSession.getState().receiveRemoteSync) {
    persistPlayer();
    return;
  }
  const s = usePlayer.getState();
  const payload = {
    current: s.current,
    queue: s.queue,
    queueIndex: s.queueIndex,
    userQueueEnd: s.userQueueEnd,
    autoplay: s.autoplay,
    isPlaying: s.isPlaying,
    progress: s.progress,
    duration: s.duration,
    volume: s.volume,
    shuffle: s.shuffle,
    repeat: s.repeat,
    updatedAt: Date.now(),
  };
  // WS (temps réel entre appareils connectés)
  useSession.getState().publishState(payload);

  // HTTP → SQLite : pour que le mobile récupère titre + timecode au cold start
  const sig = `${s.current?.id || ''}|${s.queueIndex}|${s.isPlaying}|${Math.floor(s.progress)}`;
  const now = Date.now();
  // Important = changement de piste / play-pause ; sinon throttle ~4s pour le progress
  const trackOrPlayChanged =
    lastHttpSignature.split('|').slice(0, 3).join('|') !== sig.split('|').slice(0, 3).join('|');
  if (trackOrPlayChanged || now - lastHttpPublishAt > 4000) {
    lastHttpPublishAt = now;
    lastHttpSignature = sig;
    void import('../api')
      .then(({ api }) => api.publishSessionState(payload))
      .catch(() => undefined);
  }

  persistPlayer();
  void import('../lib/audio/backgroundAudio')
    .then(({ setNativePlaybackNotification }) =>
      setNativePlaybackNotification({
        playing: s.isPlaying,
        title: s.current?.title,
        artist: s.current ? artistNames(s.current) : 'Lecture en cours',
      }),
    )
    .catch(() => undefined);
}

async function restoreAudioFromPersisted() {
  const { audioEl, current, progress, volume, duration } = usePlayer.getState();
  if (!audioEl || !current || !isPlayable(current)) return;
  // Déjà chargé pour ce titre
  if (audioEl.dataset.trackId === current.id && audioEl.src) return;
  try {
    const src = await resolvePlayUrl(current.id);
    // Ne pas révoquer un blob encore dans le cache prefetch (skip suivant)
    if (audioEl.src.startsWith('blob:') && !isPrefetchBlobUrl(audioEl.src)) {
      URL.revokeObjectURL(audioEl.src);
    }
    audioEl.src = src;
    audioEl.dataset.trackId = current.id;
    audioEl.muted = false;
    audioEl.volume = volume > 0.02 ? volume : 0.9;
    const seekTo = progress > 0 ? progress : 0;
    const applySeek = () => {
      try {
        if (seekTo > 0 && Number.isFinite(audioEl.duration) && seekTo < audioEl.duration) {
          audioEl.currentTime = seekTo;
        } else if (seekTo > 0) {
          audioEl.currentTime = seekTo;
        }
      } catch {
        /* ignore */
      }
      const metaDur = Number.isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : 0;
      if (metaDur > 0 && !(usePlayer.getState().duration > 0)) {
        usePlayer.getState().setDuration(metaDur);
      }
      refreshMediaSession();
    };
    // Précharge metadata sans play (barre de progression visible tout de suite)
    try {
      audioEl.load();
    } catch {
      /* ignore */
    }
    if (audioEl.readyState >= 1) applySeek();
    else audioEl.addEventListener('loadedmetadata', applySeek, { once: true });
    // Seed durée depuis le track / persist si metadata encore absente
    if (!(duration > 0)) {
      const seed = trackDurationSeconds(current);
      if (seed && seed > 0) usePlayer.getState().setDuration(seed);
    }
    void usePlayer.getState().loadRelated(current.id);
    refreshMediaSession();
  } catch (err) {
    console.error('restore playback', err);
  }
}

function isActivePlayer() {
  // Sync titre off → contrôles 100 % locaux (deux appareils = deux musiques).
  if (!useSession.getState().receiveRemoteSync) return true;
  return useSession.getState().isActivePlayer;
}

function sendCmd(command: Record<string, unknown>) {
  useSession.getState().sendCommand(command);
}

/**
 * Prend la main audio sur CET appareil.
 * Sync off → pas de claim hub (chaque appareil joue pour soi).
 */
function claimLocalPlayer() {
  if (!useSession.getState().receiveRemoteSync) {
    useSession.setState({ isActivePlayer: true });
    return;
  }
  if (isActivePlayer()) return;
  const s = useSession.getState();
  const me = s.deviceId;
  if (me) s.setActive(me);
  else s.transferHere();
  useSession.setState({ isActivePlayer: true });
}

/** Dès qu'un titre démarre (même 1s) → historique + listen_events */
function recordStarted(track: Track) {
  void useLibrary.getState().recordPlay(track);
  void api
    .listen({ trackId: track.id, event: 'start', progressPct: 0, track })
    .catch(() => undefined);
}

let listenTrackId: string | null = null;
let listenStartedAt = 0;
let lastProgressSent = 0;
let completedForTrack: string | null = null;

export function reportListenProgress(progress: number, duration: number) {
  const current = usePlayer.getState().current;
  if (!current?.id || !duration) return;
  if (listenTrackId !== current.id) {
    listenTrackId = current.id;
    listenStartedAt = Date.now();
    lastProgressSent = 0;
    completedForTrack = null;
  }
  const pct = Math.min(100, (progress / duration) * 100);
  if (pct - lastProgressSent >= 25 && pct < 90) {
    lastProgressSent = pct;
    void api
      .listen({ trackId: current.id, event: 'progress', progressPct: pct })
      .catch(() => undefined);
  }
  if (pct >= 90 && completedForTrack !== current.id) {
    completedForTrack = current.id;
    void api
      .listen({
        trackId: current.id,
        event: 'complete',
        progressPct: pct,
        durationMs: Math.round(duration * 1000),
        track: current,
      })
      .catch(() => undefined);
  }
}

export function reportSkipIfEarly(progress: number) {
  const current = usePlayer.getState().current;
  if (!current?.id) return;
  const elapsed = Date.now() - listenStartedAt;
  if (progress < 15 || elapsed < 15_000) {
    void api
      .listen({
        trackId: current.id,
        event: 'skip',
        progressPct: Math.min(100, (progress / Math.max(1, usePlayer.getState().duration)) * 100),
        durationMs: elapsed,
      })
      .catch(() => undefined);
  }
}

/** Génération pour ignorer les play() obsolètes si l’utilisateur saute vite */
let playGeneration = 0;
/** Horodatage du dernier bump de génération (ignorer erreurs audio pendant un skip). */
let lastPlayGenAt = 0;
/** Retry unique si le stream coupe avant ~88 % de la durée méta. */
const earlyEndRetryById = new Map<string, number>();

/** Coalesce skips rapides : un seul chargement audio pour la dernière demande. */
let playCoalesceTimer: ReturnType<typeof setTimeout> | null = null;
let playCoalesceSeq = 0;
const playCoalesceWaiters: Array<() => void> = [];

function bumpPlayGeneration() {
  playGeneration += 1;
  lastPlayGenAt = Date.now();
  return playGeneration;
}

function pauseBothAudio() {
  const { audioEl, standbyEl } = usePlayer.getState();
  for (const el of [audioEl, standbyEl]) {
    if (!el) continue;
    try {
      el.pause();
    } catch {
      /* ignore */
    }
  }
}

/** Attend 60ms de « calme » puis exécute ; les appels précédents se résolvent sans jouer. */
function coalescePlay(gen: number, run: () => Promise<void>): Promise<void> {
  const seq = ++playCoalesceSeq;
  return new Promise<void>((resolve) => {
    playCoalesceWaiters.push(resolve);
    if (playCoalesceTimer != null) clearTimeout(playCoalesceTimer);
    playCoalesceTimer = setTimeout(() => {
      playCoalesceTimer = null;
      const waiters = playCoalesceWaiters.splice(0);
      void (async () => {
        try {
          if (seq !== playCoalesceSeq || gen !== playGeneration) return;
          await run();
        } finally {
          for (const w of waiters) w();
        }
      })();
    }, 30);
  });
}

async function resolveCachedUrl(trackId: string) {
  // 1) Cache offline / prefetch full blob → instant
  const prefetched = await resolvePrefetchedPlayUrl(trackId);
  if (prefetched) return prefetched;

  // 2) URL directe googlevideo — rapide, mais CORS/403 depuis localhost (ou EQ branché).
  //    Sur navigateur local / http → toujours proxy same-origin.
  const host =
    typeof location !== 'undefined' ? location.hostname : '';
  const isLocalBrowser =
    !host ||
    /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host) ||
    (typeof location !== 'undefined' && location.protocol === 'http:' && host !== 'ytmusic.delhomme.ovh');
  if (!eqNeedsSameOrigin() && !isLocalBrowser) {
    try {
      const r = await api.streamUrl(trackId);
      if (r?.url && /^https?:\/\//i.test(r.url)) return r.url;
    } catch {
      /* fallback proxy */
    }
  }

  // 3) Proxy /api/stream/:id
  void warmFormat(trackId);
  return resolvePlayUrl(trackId);
}

function schedulePrefetch(queue: Track[], queueIndex: number) {
  if (isStreamDown()) return;
  const playable = queue.filter(isPlayable);
  const ids = playable.map((t) => t.id);
  if (!ids.length) return;
  const currentId = queue[queueIndex]?.id;
  let idx = currentId ? ids.indexOf(currentId) : -1;
  if (idx < 0) idx = Math.min(Math.max(0, queueIndex), ids.length - 1);
  const saveData =
    typeof navigator !== 'undefined' &&
    ((navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
      ?.saveData ||
      /^(2g|slow-2g|3g)$/i.test(
        (navigator as Navigator & { connection?: { effectiveType?: string } }).connection?.effectiveType ||
          '',
      ));
  const loopOne = usePlayer.getState().repeat === 'one';
  const durationsSec = playable.map((t) => trackDurationSeconds(t));
  // Pendant la lecture : peu de full-prefetch (évite de voler la bande du titre long)
  prefetchAround(ids, idx, {
    ahead: saveData ? 3 : 6,
    behind: 0,
    fullAhead: saveData || loopOne ? 0 : 2,
    delayFullMs: saveData ? 5000 : 1800,
    durationsSec,
    loopOne,
  });
  // Standby : blob seulement (pas de 2ᵉ stream concurrent qui provoque 502)
  if (loopOne) {
    const cur = playable[idx];
    if (cur) {
      pinFullTrack(cur.id);
      void armStandby(cur.id);
    }
  } else {
    clearPinnedFull();
    const nextTrack = playable[idx + 1];
    if (nextTrack) void armStandby(nextTrack.id);
  }
}

/** Génère un id de « bras » standby pour ignorer les armements obsolètes. */
let standbyArmGen = 0;

async function armStandby(trackId: string) {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(trackId) || isStreamDown()) return;
  const standby = usePlayer.getState().standbyEl;
  if (!standby) return;
  if (standby.dataset.trackId === trackId && standby.readyState >= 2) return;
  const my = ++standbyArmGen;
  try {
    // Chauffe juste le format API (léger). Blob full si déjà en cache.
    void warmFormat(trackId);
    const blobUrl = await resolvePrefetchedPlayUrl(trackId);
    if (my !== standbyArmGen) return;
    if (!blobUrl) return; // pas de 2ᵉ download stream pendant la lecture
    if (usePlayer.getState().current?.id === trackId) return;
    standby.pause();
    standby.src = blobUrl;
    standby.dataset.trackId = trackId;
    standby.preload = 'auto';
    try {
      standby.load();
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Un seul remplissage autoplay à la fois (évite tempête related×N au skip). */
let autoRadioInflight: { seedId: string; promise: Promise<void> } | null = null;
let autoRadioSeq = 0;

/** Ajoute des titres en zone autoplay dès qu’un pool arrive (sans attendre les autres APIs). */
function mergeAutoTracks(seedId: string, pool: Track[], relatedUpdate?: Track[]) {
  const state = usePlayer.getState();
  // Toujours remplir « À suivre » (affichage) — autoplay ne contrôle que l’auto-avance en fin de file user
  // Ignore les réponses obsolètes (titre déjà changé)
  if (state.current?.id && state.current.id !== seedId) return;
  const boundary = Math.max(state.userQueueEnd || 0, state.queueIndex + 1);
  const autoLen = state.queue.length - boundary;
  if (autoLen >= 40) return;
  const existing = new Set(state.queue.map((t) => t.id));
  // Titres déjà passés dans cette session (avant l’index courant) → ne pas les remettre en « À suivre »
  for (let i = 0; i < state.queueIndex; i++) {
    const id = state.queue[i]?.id;
    if (id) existing.add(id);
  }
  const extra: Track[] = [];
  for (const t of pool) {
    if (!t?.id || t.id === seedId || existing.has(t.id) || !isPlayable(t)) continue;
    existing.add(t.id);
    extra.push(t);
    if (extra.length >= 80) break;
  }
  if (!extra.length && !relatedUpdate?.length) return;
  const patch: Partial<PlayerState> = {};
  if (extra.length) {
    patch.queue = [...state.queue, ...extra];
    // Conserve l’ordre naturel pour restore shuffle (ajouts autoplay inclus)
    if (state.shuffle) {
      patch.shuffleNatural = [...(state.shuffleNatural || state.queue.slice(state.queueIndex + 1)), ...extra];
    }
  }
  if (relatedUpdate?.length) {
    patch.related = relatedUpdate;
    patch.relatedSeedId = seedId;
  }
  if (!Object.keys(patch).length) return;
  usePlayer.setState(patch);
  if (patch.queue) {
    // Différer le prefetch : laisser le stream courant respirer (similaires / autoplay)
    const q = patch.queue;
    const qi = state.queueIndex;
    window.setTimeout(() => {
      if (usePlayer.getState().queue === q || usePlayer.getState().current?.id === seedId) {
        schedulePrefetch(usePlayer.getState().queue, usePlayer.getState().queueIndex);
      } else {
        schedulePrefetch(q, qi);
      }
    }, 2800);
    void enrichMissingDurations(patch.queue);
  }
  publish();
}

/** Remplit les durées manquantes (souvent absentes sur related/radio) via /api/track. */
let enrichDurSeq = 0;
async function enrichMissingDurations(tracks: Track[]) {
  const missing = tracks
    .filter((t) => isPlayable(t) && trackDurationSeconds(t) == null)
    .slice(0, 16);
  if (!missing.length) return;
  const my = ++enrichDurSeq;
  for (const t of missing) {
    if (my !== enrichDurSeq) return;
    try {
      const meta = await api.track(t.id);
      const sec =
        typeof meta?.track?.durationSeconds === 'number' && meta.track.durationSeconds > 0
          ? Math.floor(meta.track.durationSeconds)
          : trackDurationSeconds(meta?.track || {});
      const clock = meta?.track?.duration || (sec != null ? formatClock(sec) : '');
      if (!clock && sec == null) continue;
      usePlayer.setState((s) => {
        const patchTrack = (q: Track): Track =>
          q.id !== t.id
            ? q
            : {
                ...q,
                duration: clock || q.duration,
                durationSeconds: sec ?? q.durationSeconds,
              };
        return {
          queue: s.queue.map(patchTrack),
          current: s.current ? patchTrack(s.current) : s.current,
        };
      });
    } catch {
      /* ignore */
    }
    await sleep(60);
  }
}

/** Remplit la zone autoplay (après userQueueEnd) — progressive, dédupliquée. */
let queueHintTimer: number | null = null;
function flashQueueHint(msg: string) {
  if (queueHintTimer != null) window.clearTimeout(queueHintTimer);
  usePlayer.setState({ queueHint: msg });
  queueHintTimer = window.setTimeout(() => {
    usePlayer.setState({ queueHint: null });
    queueHintTimer = null;
  }, 2800);
}

async function ensureAutoRadio(seedId: string) {
  if (isStreamDown()) return;
  const cur = usePlayer.getState();
  // Toujours précharger les suggestions visibles — autoplay = auto-avance seulement
  const userEnd = Math.max(cur.userQueueEnd || 0, cur.queueIndex + 1);
  const remainingUser = Math.max(0, userEnd - cur.queueIndex - 1);
  // Mix / radio déjà précalculé (~200) : pas d’extension incrémentale
  if (isPrecomputedMixSource(cur.sourceKind, remainingUser)) {
    schedulePrefetch(cur.queue, cur.queueIndex);
    return;
  }
  const autoUpcoming = cur.queue.slice(userEnd).filter(isPlayable);
  if (autoUpcoming.length >= 40) {
    schedulePrefetch(cur.queue, cur.queueIndex);
    return;
  }
  if (!isPlayable({ id: seedId } as Track)) return;

  if (autoRadioInflight?.seedId === seedId) {
    return autoRadioInflight.promise;
  }

  const seq = ++autoRadioSeq;
  usePlayer.setState({ autoRadioLoading: true });
  const promise = (async () => {
    // Déjà des related en mémoire pour CE titre → injecte immédiatement
    const snap = usePlayer.getState();
    if (
      snap.related?.length &&
      snap.relatedSeedId === seedId &&
      snap.current?.id === seedId
    ) {
      mergeAutoTracks(seedId, snap.related);
    }

    // 1) related?fast=1 (= upNext côté API) — un seul appel, pas de double getUpNext
    const fastP = api
      .related(seedId, { fast: true })
      .then((r) => {
        if (seq !== autoRadioSeq) return r;
        const pool = [
          ...(r.related || []),
          ...(r.radio || []),
          ...((r as { tracks?: Track[] }).tracks || []),
        ];
        mergeAutoTracks(seedId, pool, pool.length ? pool : undefined);
        return r;
      })
      .catch((err) => {
        console.warn('auto-radio related fast', err);
        return null;
      });

    // 2) Enrichissement complet en arrière-plan (search + biblio) — batch court pour autoplay
    const fullP = api
      .related(seedId, { full: false })
      .then((r) => {
        if (seq !== autoRadioSeq) return r;
        const pool = [
          ...(r.related || []),
          ...(r.radio || []),
          ...((r as { tracks?: Track[] }).tracks || []),
        ];
        mergeAutoTracks(seedId, pool, pool.length ? pool : undefined);
        return r;
      })
      .catch((err) => {
        console.warn('auto-radio related', err);
        return null;
      });

    await fastP;
    void fullP;
  })();

  autoRadioInflight = { seedId, promise };
  try {
    await promise;
  } finally {
    if (autoRadioInflight?.seedId === seedId) autoRadioInflight = null;
    if (autoRadioSeq === seq) {
      usePlayer.setState({ autoRadioLoading: false });
    }
  }
}

async function playLocal(track: Track, state: PlayerState, gen: number) {
  const t0 = performance.now();
  // Toujours l’élément primaire (jamais de swap A/B — casse l’EQ / silence)
  const audio = usePlayer.getState().audioEl || state.audioEl;
  if (!audio) return;
  if (gen !== playGeneration) return;

  const targetVol = Math.max(0, Math.min(1, state.volume > 0 ? state.volume : 0.9));

  // Si le même titre est déjà chargé sur le primary → seek 0 + play (skip/loop rapide)
  if (
    audio.dataset.trackId === track.id &&
    audio.src &&
    audio.readyState >= 2 &&
    !audio.src.endsWith(window.location.pathname)
  ) {
    try {
      audio.muted = false;
      audio.volume = targetVol;
      audio.currentTime = 0;
      const p = audio.play();
      if (gen === playGeneration) {
        usePlayer.setState({ isLoading: false, isPlaying: true, playError: null });
      }
      await p;
      if (typeof console !== 'undefined') {
        console.info(`[play] ${track.id} reuse ${(performance.now() - t0).toFixed(0)}ms`);
      }
      return;
    } catch (err) {
      if (gen !== playGeneration) return;
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'AbortError') return;
      // sinon recharge en cold path
    }
  }

  // Si le standby a déjà ce titre bufferisé → copie l’URL sur le primary (sans swap d’élément)
  const standby = usePlayer.getState().standbyEl;
  let srcFromStandby: string | null = null;
  if (
    standby &&
    standby.dataset.trackId === track.id &&
    standby.src &&
    standby.readyState >= 2
  ) {
    srcFromStandby = standby.currentSrc || standby.src;
  }

  const srcPromise = srcFromStandby
    ? Promise.resolve(srcFromStandby)
    : resolveCachedUrl(track.id);
  const metaPromise = api.track(track.id).catch(() => undefined);

  // Démarre TOUT DE SUITE sur le proxy (sync) pour garder le geste utilisateur
  // (sinon await resolveCachedUrl + coalesce → NotAllowedError / titre « coché » sans son).
  const quickSrc = srcFromStandby || streamProxyUrl(track.id);
  const elEarly = usePlayer.getState().audioEl || audio;
  let earlyStarted = false;
  try {
    elEarly.src = quickSrc;
    elEarly.dataset.trackId = track.id;
    elEarly.muted = false;
    elEarly.volume = targetVol;
    try {
      elEarly.load();
    } catch {
      /* ignore */
    }
    if (gen === playGeneration) {
      usePlayer.setState({ isLoading: false, isPlaying: true, playError: null });
    }
    const earlyPlay = elEarly.play();
    earlyStarted = true;
    void earlyPlay.catch(() => {
      earlyStarted = false;
    });
  } catch {
    earlyStarted = false;
  }

  let enriched = track;
  if (/^[a-zA-Z0-9_-]{11}$/.test(track.id)) {
    const ytimg = [
      { url: `https://i.ytimg.com/vi/${track.id}/hqdefault.jpg`, width: 480, height: 360 },
      { url: `https://i.ytimg.com/vi/${track.id}/mqdefault.jpg`, width: 320, height: 180 },
      ...(track.thumbnails || []).filter(
        (t) => t?.url && !/\/(hq720|maxresdefault|sddefault)\./i.test(t.url),
      ),
    ];
    enriched = { ...track, thumbnails: ytimg };
    if (gen === playGeneration) {
      usePlayer.setState((s) => ({
        current: enriched,
        queue: s.queue.map((t, i) =>
          i === s.queueIndex || t.id === track.id
            ? { ...t, thumbnails: t.thumbnails?.length ? t.thumbnails : ytimg }
            : t,
        ),
      }));
      refreshMediaSession();
    }
  }

  const src = await srcPromise;
  if (gen !== playGeneration) return;
  if (!src) throw new Error('Source audio indisponible');

  // Re-lire l’élément actif (peut avoir changé… mais on ne swap plus)
  const el = usePlayer.getState().audioEl || audio;

  const tryPlaySrc = async (playSrc: string) => {
    el.src = playSrc;
    el.dataset.trackId = track.id;
    el.muted = false;
    el.volume = targetVol;
    try {
      el.load();
    } catch {
      /* ignore */
    }
    return el.play();
  };

  let usedSrc = src;
  if (gen === playGeneration) {
    usePlayer.setState({ isLoading: false, isPlaying: true, playError: null });
  }

  // Déjà en lecture sur le même proxy → ne pas recharger (évite silence + 2ᵉ clic)
  const sameQuick =
    earlyStarted &&
    el.dataset.trackId === track.id &&
    (el.src.includes(`/api/stream/${track.id}`) || el.src === quickSrc) &&
    !src.startsWith('blob:') &&
    src.includes(`/api/stream/${track.id}`);
  if (sameQuick && !el.paused) {
    usedSrc = quickSrc;
    if (typeof console !== 'undefined') {
      console.info(`[play] ${track.id} early-proxy ${(performance.now() - t0).toFixed(0)}ms`);
    }
  } else if (
    earlyStarted &&
    el.dataset.trackId === track.id &&
    !el.paused &&
    src.startsWith('blob:')
  ) {
    // Ne PAS upgrader vers blob en cours de lecture (load() = silence / coupe)
    usedSrc = quickSrc;
    if (typeof console !== 'undefined') {
      console.info(`[play] ${track.id} keep-early-proxy (no mid-play blob upgrade)`);
    }
  } else {
    try {
      el.pause();
    } catch {
      /* ignore */
    }
    if (gen !== playGeneration) return;

    const isDirectCdn =
      /^https?:\/\//i.test(src) &&
      !src.includes('/api/stream/') &&
      !src.startsWith('blob:');

    try {
      await tryPlaySrc(src);
    } catch (err) {
      if (gen !== playGeneration) return;
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'AbortError') return;
      // CDN 403 (IP VPS ≠ navigateur) ou NotSupported → proxy
      if (isDirectCdn) {
        const proxySrc = await resolvePlayUrl(track.id);
        if (gen !== playGeneration) return;
        usedSrc = proxySrc;
        try {
          await tryPlaySrc(proxySrc);
        } catch (err2) {
          if (gen !== playGeneration) return;
          const n2 = err2 instanceof DOMException ? err2.name : '';
          if (n2 === 'AbortError') return;
          const detail =
            err2 instanceof Error ? err2.message : String(err2 || '');
          throw new Error(
            detail && detail !== 'Lecture bloquée ou interrompue'
              ? `Lecture impossible (${detail})`
              : 'Lecture impossible — flux indisponible',
          );
        }
      } else {
        try {
          el.load();
          await el.play();
        } catch (err2) {
          if (gen !== playGeneration) return;
          const n2 = err2 instanceof DOMException ? err2.name : '';
          if (n2 === 'AbortError') return;
          const detail =
            err2 instanceof Error ? err2.message : String(err2 || '');
          throw new Error(
            detail && !/NotAllowedError|NotSupportedError/i.test(detail)
              ? `Lecture impossible (${detail})`
              : 'Lecture impossible — flux indisponible',
          );
        }
      }
    }
  }
  if (gen !== playGeneration) return;

  {
    const s = usePlayer.getState();
    if (s.audioEl === el) {
      el.muted = false;
      el.volume = s.volume > 0 ? s.volume : targetVol;
    }
  }

  void metaPromise.then((meta) => {
    if (gen !== playGeneration) return;
    if (!meta?.track) return;
    const thumbs =
      meta.track.thumbnails?.length
        ? meta.track.thumbnails
        : enriched.thumbnails?.length
          ? enriched.thumbnails
          : track.thumbnails;
    // meta.track en dernier pour durée / titre officiels (ne pas les écraser avec enriched vide)
    const next = {
      ...enriched,
      ...meta.track,
      title: meta.track.title || enriched.title,
      artists: mergeArtists(enriched.artists, meta.track.artists),
      thumbnails: thumbs,
      album: meta.track.album || enriched.album,
      duration: meta.track.duration || enriched.duration,
      durationSeconds:
        meta.track.durationSeconds ??
        enriched.durationSeconds ??
        trackDurationSeconds(meta.track) ??
        trackDurationSeconds(enriched) ??
        undefined,
    };
    usePlayer.setState((s) => ({
      current: next,
      queue: s.queue.map((t, i) =>
        i === s.queueIndex || t.id === next.id
          ? {
              ...t,
              ...next,
              thumbnails: next.thumbnails?.length ? next.thumbnails : t.thumbnails,
              duration: next.duration || t.duration,
              durationSeconds: next.durationSeconds ?? t.durationSeconds,
            }
          : t,
      ),
    }));
    refreshMediaSession();
  });

  if (typeof console !== 'undefined') {
    const via = srcFromStandby
      ? 'standby-url'
      : usedSrc.includes('googlevideo.com') || usedSrc.includes('googleusercontent')
        ? 'direct'
        : usedSrc.startsWith('blob:')
          ? 'blob'
          : 'proxy';
    console.info(`[play] ${track.id} ${via} ${(performance.now() - t0).toFixed(0)}ms`);
  }

  if (
    Number.isFinite(el.duration) &&
    el.duration > 0 &&
    !trackDurationSeconds(usePlayer.getState().current || track)
  ) {
    const sec = Math.floor(el.duration);
    usePlayer.setState((s) => {
      if (!s.current || s.current.id !== track.id) return s;
      const patched = {
        ...s.current,
        durationSeconds: sec,
        duration: formatClock(sec),
      };
      return {
        current: patched,
        queue: s.queue.map((t) => (t.id === track.id ? { ...t, ...patched } : t)),
        duration: sec,
      };
    });
  }

  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  refreshMediaSession();
}

const audioRuntimeBound = new WeakSet<HTMLAudioElement>();

function attachAudioRuntime(
  el: HTMLAudioElement,
  get: () => PlayerState,
  set: (partial: Partial<PlayerState>) => void,
) {
  if (audioRuntimeBound.has(el)) return;
  audioRuntimeBound.add(el);
  const sync = () => refreshMediaSession();
  el.addEventListener('play', () => {
    if (get().audioEl !== el) return;
    sync();
  });
  el.addEventListener('pause', () => {
    if (get().audioEl !== el) return;
    sync();
  });
  el.addEventListener('ended', () => {
    if (get().audioEl !== el) return;
    sync();
    const s = get();
    if (s.sleepUntilEnd) {
      clearSleepTimerInternal();
      el.pause();
      set({ isPlaying: false, sleepLabel: null, sleepUntilEnd: false, sleepUntilQueueEnd: false });
      return;
    }
    if (s.sleepUntilQueueEnd && s.queueIndex >= s.queue.length - 1) {
      clearSleepTimerInternal();
      el.pause();
      set({ isPlaying: false, sleepLabel: null, sleepUntilEnd: false, sleepUntilQueueEnd: false });
    }
  });
  // Coupe les silences de fin (mode titre uniquement — pas en mode vidéo)
  el.addEventListener('timeupdate', () => {
    if (get().audioEl !== el) return;
    const s = get();
    if (!s.isPlaying || !s.current?.id) return;
    const lastLyricMs =
      s.lyricsTimed?.length
        ? Math.max(...s.lyricsTimed.map((l) => l.startMs || 0))
        : null;
    if (
      shouldSkipTrailingSilence(el, {
        videoMode: s.mediaPresentation === 'video',
        trackId: s.current.id,
        isPlaying: s.isPlaying,
        lastLyricMs,
      })
    ) {
      void get().next({ fromEnded: true });
    }
  });
  el.addEventListener('loadeddata', () => {
    resetSilenceSkip(get().current?.id);
  });
  let recovering = false;
  /** Limite les relances auto après erreur média (évite boucle 502 infinie). */
  let mediaAutoRetry = 0;
  el.addEventListener('error', () => {
    void (async () => {
      if (recovering) return;
      if (get().audioEl !== el) return;
      // Skip rapide : erreurs de src aborté / clear — ignorer
      if (Date.now() - lastPlayGenAt < 800) return;
      const track = get().current;
      if (!track?.id) return;
      if (el.dataset.trackId && el.dataset.trackId !== track.id) return;
      if (!el.src || el.src === window.location.href) return;
      if (get().playError && isStreamDown()) {
        try {
          el.pause();
        } catch {
          /* ignore */
        }
        set({ isPlaying: false, isLoading: false });
        return;
      }
      recovering = true;
      const gen = playGeneration;
      try {
        // Fin de titre souvent vue comme MEDIA_ERR_NETWORK / decode quand le CDN coupe :
        // ce n’est PAS une panne Wi‑Fi — enchaîner le suivant proprement.
        const dur = Number(el.duration);
        const t = Number(el.currentTime);
        const nearEnd =
          Number.isFinite(dur) &&
          dur >= 30 &&
          Number.isFinite(t) &&
          t > 0 &&
          (t / dur >= 0.88 || dur - t <= 5);
        if (nearEnd) {
          markStreamOk();
          mediaAutoRetry = 0;
          set({ playError: null, isLoading: false });
          void get().next({ fromEnded: true });
          return;
        }

        markStreamOk();
        const fresh = await resolvePlayUrl(track.id);
        if (gen !== playGeneration || get().current?.id !== track.id) return;
        if (Date.now() - lastPlayGenAt < 400) return;
        const bust = fresh.includes('?') ? `${fresh}&r=${Date.now()}` : `${fresh}?r=${Date.now()}`;
        el.src = bust.startsWith('blob:') ? fresh : bust;
        el.dataset.trackId = track.id;
        el.load();
        await new Promise<void>((resolve, reject) => {
          const t = window.setTimeout(() => reject(new Error('timeout')), 20_000);
          const ok = () => {
            window.clearTimeout(t);
            resolve();
          };
          const bad = () => {
            window.clearTimeout(t);
            reject(new Error('stream'));
          };
          el.addEventListener('canplay', ok, { once: true });
          el.addEventListener('error', bad, { once: true });
        });
        if (gen !== playGeneration || get().current?.id !== track.id) return;
        await el.play();
        markStreamOk();
        mediaAutoRetry = 0;
        set({ isPlaying: true, isLoading: false, playError: null });
        refreshMediaSession();
      } catch {
        if (gen !== playGeneration) return;
        // Hors-ligne navigateur : bascule cache local ou titre suivant en cache
        if (!isBrowserOnline()) {
          mediaAutoRetry = 0;
          markStreamOk();
          const q = get().queue;
          const idx = get().queueIndex;
          const nextCached = await (async () => {
            for (let i = idx + 1; i < q.length; i++) {
              const id = q[i]?.id;
              if (!id) continue;
              const url = await resolvePlayUrl(id).catch(() => null);
              if (url && String(url).startsWith('blob:')) return { i, track: q[i]! };
            }
            return null;
          })();
          if (nextCached) {
            set({ playError: null, isLoading: true });
            void get().play(nextCached.track, q, {
              preserveQueue: true,
              forceRestart: true,
            });
            return;
          }
          set({
            isPlaying: false,
            isLoading: false,
            playError: 'Hors ligne — titre non disponible sur cet appareil.',
          });
          refreshMediaSession();
          return;
        }
        markStreamFailure('audio-error');
        if (gen === playGeneration && get().current?.id === track.id) {
          try {
            el.pause();
          } catch {
            /* ignore */
          }
          mediaAutoRetry += 1;
          const maxAuto = 2;
          if (mediaAutoRetry > maxAuto) {
            set({
              isPlaying: false,
              isLoading: false,
              playError:
                'Stream indisponible. Réessaie manuellement ou change de titre.',
            });
            refreshMediaSession();
            persistPlayer();
            publish();
            return;
          }
          // Retry discret — pas de toast anxiogène au 1er échec
          const delayMs = mediaAutoRetry === 1 ? 2_500 : 7_000;
          set({
            isPlaying: false,
            isLoading: true,
            playError:
              mediaAutoRetry === 1
                ? null
                : `Reprise du flux… (${mediaAutoRetry}/${maxAuto})`,
          });
          refreshMediaSession();
          persistPlayer();
          publish();
          window.setTimeout(() => {
            if (playGeneration !== gen) return;
            if (get().current?.id !== track.id) return;
            markStreamOk();
            set({ playError: null, isLoading: true });
            void usePlayer.getState().play(track, usePlayer.getState().queue, {
              preserveQueue: true,
              keepUserBoundary: true,
            });
          }, delayMs);
        }
      } finally {
        recovering = false;
      }
    })();
  });
}

export const usePlayer = create<PlayerState>((set, get) => ({
  current: null,
  queue: [],
  queueIndex: 0,
  userQueueEnd: 0,
  sourceId: null,
  sourceKind: null,
  autoplay: true,
  isPlaying: false,
  isLoading: false,
  shuffle: false,
  shuffleNatural: null,
  repeat: 'off',
  volume: 0.9,
  progress: 0,
  duration: 0,
  showQueue: false,
  showLyrics: false,
  mediaPresentation: 'cover',
  lyrics: null,
  lyricsTimed: null,
  lyricsSource: null,
  related: [],
  relatedSeedId: null,
  relatedLoading: false,
  autoRadioLoading: false,
  queueHint: null,
  relatedError: null,
  hydrated: false,
  audioEl: null,
  standbyEl: null,
  sleepLabel: null,
  sleepUntilEnd: false,
  sleepUntilQueueEnd: false,
  playError: null,

  bindAudio: (el) => {
    set({ audioEl: el });
    if (el) attachAudioRuntime(el, get, set);
    if (el && get().hydrated && get().current) {
      void restoreAudioFromPersisted();
    }
  },

  bindStandbyAudio: (el) => {
    set({ standbyEl: el });
    if (el) attachAudioRuntime(el, get, set);
  },

  setSleepTimer: (delayMs, label) => {
    clearSleepTimerInternal();
    if (delayMs == null || label == null) {
      set({ sleepLabel: null, sleepUntilEnd: false, sleepUntilQueueEnd: false });
      return;
    }
    if (delayMs === 'end') {
      set({ sleepLabel: label, sleepUntilEnd: true, sleepUntilQueueEnd: false });
      return;
    }
    if (delayMs === 'queue') {
      set({ sleepLabel: label, sleepUntilEnd: false, sleepUntilQueueEnd: true });
      return;
    }
    set({ sleepLabel: label, sleepUntilEnd: false, sleepUntilQueueEnd: false });
    sleepTimerHandle = window.setTimeout(() => {
      const audio = get().audioEl;
      audio?.pause();
      clearSleepTimerInternal();
      set({ isPlaying: false, sleepLabel: null, sleepUntilEnd: false, sleepUntilQueueEnd: false });
    }, delayMs);
  },

  clearPlayError: () => {
    markStreamOk();
    set({ playError: null });
  },

  hydrate: async () => {
    if (get().hydrated) return;
    const saved = loadPersisted();
    const queue = Array.isArray(saved.queue) ? saved.queue : [];
    const queueIndex = Math.min(
      Math.max(0, saved.queueIndex || 0),
      Math.max(0, queue.length - 1),
    );
    const current =
      saved.current ||
      (queue.length ? queue[queueIndex] || queue[0] : null) ||
      null;
    const userQueueEnd =
      typeof saved.userQueueEnd === 'number'
        ? Math.min(Math.max(saved.userQueueEnd, queue.length ? queueIndex + 1 : 0), queue.length)
        : queue.length;
    const progress = typeof saved.progress === 'number' ? saved.progress : 0;
    const durationSeed =
      typeof saved.duration === 'number' && saved.duration > 0
        ? saved.duration
        : current
          ? trackDurationSeconds(current) || 0
          : 0;
    set({
      current,
      queue,
      queueIndex: queue.length ? queueIndex : 0,
      userQueueEnd,
      autoplay: saved.autoplay !== false,
      // Volume 0 persisté = quasi toujours un mute accidentel (fade bug) → défaut audible
      volume:
        typeof saved.volume === 'number' && saved.volume > 0.02 ? saved.volume : 0.9,
      shuffle: Boolean(saved.shuffle),
      repeat: saved.repeat || 'off',
      progress,
      duration: durationSeed,
      isPlaying: false,
      hydrated: true,
    });
    await restoreAudioFromPersisted();
    refreshMediaSession();
  },

  playQueue: async (tracks, startIndex = 0, opts) => {
    const end = perfStart('playQueue');
    const playable = tracks.filter(isPlayable);
    if (!playable.length) {
      end('empty');
      return;
    }
    const idx = Math.min(Math.max(0, startIndex), playable.length - 1);
    const precomputed =
      opts?.sourceKind === 'mix' ||
      opts?.sourceKind === 'radio' ||
      opts?.sourceKind === 'album' ||
      opts?.sourceKind === 'artist';
    // Nouvelle file explicite → annule radio auto / file précédente, repart de zéro
    autoRadioSeq += 1;
    autoRadioInflight = null;
    await get().play(playable[idx], playable, {
      preserveQueue: true,
      forceRestart: true,
      sourceId: opts?.sourceId,
      sourceKind: opts?.sourceKind,
      noAutoRadio: precomputed && playable.length >= 20,
    });
    if (precomputed && playable.length >= 20) {
      set({ autoplay: false });
    }
    end(`${playable.length} tracks`);
  },

  play: async (track, queue, opts) => {
    const end = perfStart('play');
    // Clic Lecture sur cet appareil → son ici (pas seulement remote cmd)
    claimLocalPlayer();

    const filtered = (queue || []).filter(isPlayable);
    // Ne jamais lancer un ID non-vidéo (album/playlist/mood) comme stream
    if (!isPlayable(track) && !filtered.length) {
      set({ isLoading: false, isPlaying: false });
      end('unplayable');
      return;
    }
    const nextQueue = filtered.length ? filtered : isPlayable(track) ? [track] : [];
    if (!nextQueue.length) {
      set({ isLoading: false, isPlaying: false });
      end('empty');
      return;
    }
    const playTrack = isPlayable(track) ? track : nextQueue[0];
    const idx = Math.max(0, nextQueue.findIndex((t) => t.id === playTrack.id));
    const prev = get().current;
    const audio = get().audioEl;
    const sameStillPlaying =
      Boolean(prev?.id) &&
      prev!.id === playTrack.id &&
      Boolean(audio) &&
      audio!.dataset.trackId === playTrack.id &&
      !audio!.paused &&
      !audio!.ended;
    // Soft-continue UNIQUEMENT dans la même file (playAt). Lecture playlist/titre → repart de 0.
    if (sameStillPlaying && opts?.keepUserBoundary && !opts?.forceRestart) {
      set({
        current: playTrack,
        queue: nextQueue,
        queueIndex: idx >= 0 ? idx : 0,
        userQueueEnd: Math.min(
          Math.max(get().userQueueEnd || 0, (idx >= 0 ? idx : 0) + 1),
          nextQueue.length,
        ),
        sourceId: opts?.sourceId !== undefined ? opts.sourceId : get().sourceId,
        sourceKind: opts?.sourceKind !== undefined ? opts.sourceKind : get().sourceKind,
        isLoading: false,
        playError: null,
      });
      schedulePrefetch(nextQueue, idx >= 0 ? idx : 0);
      persistPlayer();
      publish();
      refreshMediaSession();
      end('soft-continue');
      return;
    }
    const keepBoundary = Boolean(opts?.keepUserBoundary) && !opts?.forceRestart;
    const inferredAlbum =
      opts?.sourceId === undefined && playTrack.album?.id
        ? { sourceId: playTrack.album.id, sourceKind: 'album' as const }
        : null;
    const nextSourceId =
      opts?.sourceId !== undefined
        ? opts.sourceId
        : inferredAlbum
          ? inferredAlbum.sourceId
          : keepBoundary
            ? get().sourceId
            : null;
    const nextSourceKind =
      opts?.sourceKind !== undefined
        ? opts.sourceKind
        : inferredAlbum
          ? inferredAlbum.sourceKind
          : keepBoundary
            ? get().sourceKind
            : null;
    set({
      current: playTrack,
      queue: nextQueue,
      queueIndex: idx >= 0 ? idx : 0,
      userQueueEnd: keepBoundary
        ? Math.min(Math.max(get().userQueueEnd || 0, (idx >= 0 ? idx : 0) + 1), nextQueue.length)
        : nextQueue.length,
      sourceId: nextSourceId,
      sourceKind: nextSourceKind,
      isLoading: true,
      progress: 0,
      lyrics: null,
      lyricsTimed: null,
      lyricsSource: null,
      playError: null,
      // Nouvelle file → oublie l’ordre shuffle précédent
      ...(keepBoundary ? {} : { shuffleNatural: null, ...(opts?.forceRestart ? { shuffle: false } : {}) }),
      // Garde les suggestions jusqu’au remplacement (évite trou « Chargement… » sur Similaires)
      relatedLoading: true,
      relatedError: null,
    });
    // Notif OS immédiatement (titre cible) — avant le buffer audio
    refreshMediaSession();

    // Annule un ensureAutoRadio en vol (nouvelle file / nouveau seed)
    autoRadioSeq += 1;

    const gen = bumpPlayGeneration();
    // Ne PAS bumpPrefetchGeneration ici : ça tuait le warm/full du titre suivant.
    pauseBothAudio();
    // Re-pousse les métadonnées après pause (events audio ne doivent pas vider la barre)
    refreshMediaSession();
    // Invalide les armements standby obsolètes
    standbyArmGen += 1;

    // Warm léger du suivant (pas de chargement audio concurrent pendant le coalesce)
    {
      const n = nextQueue[(idx >= 0 ? idx : 0) + 1];
      if (n) void warmFormat(n.id);
    }

    // Similaires dès le play (fast ~10) — indépendant de l’onglet ouvert
    const seedId = playTrack.id;
    const radioGen = gen;
    resetSilenceSkip(seedId);
    // Nouveau titre (pas un retry early-end) → reset compteur pour les autres ids
    for (const k of [...earlyEndRetryById.keys()]) {
      if (k !== seedId) earlyEndRetryById.delete(k);
    }
    queueMicrotask(() => {
      if (radioGen !== playGeneration) return;
      void get().loadRelated(seedId);
      if (!opts?.noAutoRadio) {
        void ensureAutoRadio(seedId);
      }
      // Paroles timed en fond → aide le skip de silence de fin
      void api
        .lyrics(seedId)
        .then((r) => {
          if (get().current?.id !== seedId) return;
          set({
            lyrics: r.lyrics || get().lyrics,
            lyricsTimed: r.timed || null,
            lyricsSource: (r as { source?: 'youtube' | 'lrclib' | 'lrc' | null }).source ?? null,
          });
        })
        .catch(() => undefined);
    });

    const attemptPlay = async (attempt: number): Promise<void> => {
      try {
        await playLocal(playTrack, get(), gen);
        if (gen !== playGeneration) return;
        markStreamOk();
        recordStarted(get().current || playTrack);
        set({ isPlaying: true, isLoading: false, playError: null });
        publish();
        schedulePrefetch(get().queue, get().queueIndex);
        end(playTrack.id);
      } catch (err) {
        if (gen !== playGeneration) return;
        console.error(err);
        markStreamFailure(err instanceof Error ? err.message : 'play');
        const raw =
          err instanceof Error
            ? err.message
            : typeof err === 'string'
              ? err
              : 'Lecture impossible';
        const msg = /502|unavailable|deadline|Impossible de streamer/i.test(raw)
          ? 'Stream serveur indisponible (502) — nouvel essai…'
          : raw;
        if (attempt < 2) {
          set({
            isLoading: true,
            isPlaying: false,
            playError: `${msg} (${attempt + 1}/2)`,
          });
          publish();
          const delay = attempt === 0 ? 2_000 : 5_000;
          await sleep(delay);
          if (gen !== playGeneration) return;
          if (get().current?.id !== playTrack.id) return;
          markStreamOk();
          return attemptPlay(attempt + 1);
        }
        set({
          isLoading: false,
          isPlaying: false,
          playError: /502|unavailable|deadline/i.test(raw)
            ? 'Stream indisponible. Réessaie ou change de titre.'
            : msg,
        });
        publish();
        end(`fail:${playTrack.id}`);
      }
    };

    // Skips rapides : UI à jour tout de suite, un seul load audio (dernier gagne)
    await coalescePlay(gen, () => attemptPlay(0));
  },

  playAt: async (index) => {
    const { queue } = get();
    const track = queue[index];
    if (!track) return;
    claimLocalPlayer();
    // Index cible tout de suite (évite barre média / UI sur l’ancien titre pendant le load)
    set({ queueIndex: index, current: track, isLoading: true, progress: 0, playError: null });
    refreshMediaSession();
    await get().play(track, queue, { preserveQueue: true, keepUserBoundary: true });
    // play() recalcule l’index via findIndex — forcer le bon si doublons d’id
    if (get().queueIndex !== index && get().queue[index]?.id === track.id) {
      set({ queueIndex: index });
    }
    publish();
    refreshMediaSession();
  },

  playUpcomingInQueue: async (index) => {
    const { queue, queueIndex } = get();
    if (!queue[index]) return;
    // Passé / courant → jump classique
    if (index <= queueIndex) {
      await get().playAt(index);
      return;
    }
    const dest = queueIndex + 1;
    if (index !== dest) {
      get().moveInQueue(index, dest);
    }
    // Après move, le titre cliqué est juste après le courant
    await get().playAt(dest);
  },

  toggle: () => {
    claimLocalPlayer();
    const { audioEl, current, queue, progress } = get();
    if (!audioEl) {
      if (current) {
        void get().play(current, queue.length ? queue : [current], { preserveQueue: true });
      }
      return;
    }
    // Source de vérité = élément audio (évite icône pause alors que ça joue encore)
    const actuallyPlaying = !audioEl.paused && !audioEl.ended;
    if (actuallyPlaying) {
      audioEl.pause();
      set({ isPlaying: false });
      refreshMediaSession();
      persistPlayer();
      publish();
      return;
    }
    const needsLoad =
      !audioEl.src ||
      audioEl.src === window.location.href ||
      (current && audioEl.dataset.trackId !== current.id);

    const waitCanPlay = (el: HTMLAudioElement) =>
      new Promise<void>((resolve) => {
        if (el.readyState >= 2) {
          resolve();
          return;
        }
        const done = () => {
          el.removeEventListener('canplay', done);
          el.removeEventListener('loadeddata', done);
          resolve();
        };
        el.addEventListener('canplay', done, { once: true });
        el.addEventListener('loadeddata', done, { once: true });
        window.setTimeout(done, 8_000);
      });

    const resumeAtProgress = async () => {
      set({ isLoading: true });
      try {
        if (needsLoad && current) {
          await restoreAudioFromPersisted();
        }
        const seekTo = progress > 0 ? progress : 0;
        if (seekTo > 0) {
          try {
            audioEl.currentTime = seekTo;
          } catch {
            /* ignore */
          }
        }
        await waitCanPlay(audioEl);
        if (seekTo > 0 && Math.abs(audioEl.currentTime - seekTo) > 1.5) {
          try {
            audioEl.currentTime = seekTo;
          } catch {
            /* ignore */
          }
        }
        await audioEl.play();
        set({ isPlaying: true, isLoading: false, playError: null });
        refreshMediaSession();
        persistPlayer();
        publish();
        if (current?.id) void ensureAutoRadio(current.id);
      } catch (err) {
        console.error(err);
        set({ isLoading: false });
        if (current) {
          // Reprend au timecode persisté (pas un restart froid à 0)
          await get().play(current, queue.length ? queue : [current], {
            preserveQueue: true,
            noAutoRadio: false,
          });
          const el = get().audioEl;
          const p = get().progress;
          if (el && p > 0) {
            try {
              el.currentTime = p;
            } catch {
              /* ignore */
            }
          }
        }
      }
    };

    void resumeAtProgress();
  },

  next: async (opts) => {
    claimLocalPlayer();
    // playError ne doit pas bloquer un next manuel (sinon UI/clavier « morts »)
    if (get().playError) set({ playError: null });
    if (isStreamDown()) {
      markStreamOk(); // laisse une chance au skip manuel
    }

    // Fin « trop tôt » : le stream a coupé alors qu’il restait du titre → 1 retry
    if (opts?.fromEnded) {
      const s = get();
      const cur = s.current;
      const el = s.audioEl;
      const expected = Number(cur?.durationSeconds) || 0;
      const heard = Math.max(
        Number.isFinite(el?.currentTime) ? el!.currentTime : 0,
        s.progress || 0,
      );
      if (
        cur?.id &&
        expected >= 45 &&
        heard > 8 &&
        heard < expected * 0.88 &&
        (earlyEndRetryById.get(cur.id) || 0) < 1
      ) {
        earlyEndRetryById.set(cur.id, 1);
        const idx = s.queueIndex;
        if (idx >= 0 && s.queue[idx]?.id === cur.id) {
          await get().playAt(idx);
          return;
        }
      }
    }

    const { queue, queueIndex, repeat, shuffle, current, progress } = get();
    if (!queue.length) {
      if (current?.id) {
        await ensureAutoRadio(current.id);
        const q = get().queue;
        const idx = get().queueIndex;
        if (idx + 1 < q.length) await get().playAt(idx + 1);
        else flashQueueHint('Suggestions en cours… réessaie suivant');
      }
      return;
    }
    reportSkipIfEarly(progress);
    // Boucle 1 titre : à la fin → seek 0 sans recharger (déjà en mémoire)
    if (repeat === 'one' && opts?.fromEnded) {
      const audio = get().audioEl;
      if (audio && current?.id && audio.dataset.trackId === current.id) {
        try {
          audio.currentTime = 0;
          await audio.play();
          set({ isPlaying: true, progress: 0, playError: null });
          refreshMediaSession();
          persistPlayer();
          publish();
          schedulePrefetch(queue, queueIndex);
          return;
        } catch {
          /* fallback playAt */
        }
      }
      await get().playAt(queueIndex);
      return;
    }
    let nextIndex = queueIndex + 1;
    const end = get().userQueueEnd || 0;
    // Fin naturelle sur le dernier titre « user » : stop si lecture auto OFF (suggestions restent visibles)
    if (
      opts?.fromEnded &&
      get().autoplay === false &&
      queueIndex < end &&
      nextIndex >= end
    ) {
      const audio = get().audioEl;
      if (audio) audio.pause();
      set({ isPlaying: false });
      refreshMediaSession();
      persistPlayer();
      publish();
      return;
    }
    // Suivant manuel au bord / hors file user : charge les suggestions si besoin
    if (
      !opts?.fromEnded &&
      get().autoplay === false &&
      nextIndex >= end &&
      nextIndex >= queue.length
    ) {
      if (current?.id) {
        await ensureAutoRadio(current.id);
        const q = get().queue;
        const idx = get().queueIndex;
        if (idx + 1 < q.length) {
          await get().playAt(idx + 1);
        } else {
          flashQueueHint('Suggestions en cours… réessaie suivant');
        }
      }
      return;
    }
    if (nextIndex >= queue.length) {
      if (get().sleepUntilQueueEnd) {
        const audio = get().audioEl;
        if (audio) audio.pause();
        clearSleepTimerInternal();
        set({
          isPlaying: false,
          sleepLabel: null,
          sleepUntilEnd: false,
          sleepUntilQueueEnd: false,
        });
        refreshMediaSession();
        persistPlayer();
        publish();
        return;
      }
      if (repeat === 'all' || repeat === 'one') {
        nextIndex = 0;
      } else if (current?.id) {
        await ensureAutoRadio(current.id);
        const q = get().queue;
        const idx = get().queueIndex;
        if (idx + 1 < q.length) {
          await get().playAt(idx + 1);
        } else {
          flashQueueHint('Suggestions en cours… réessaie suivant');
        }
        return;
      } else {
        return;
      }
    }
    if (shuffle && queue.length > 1) {
      const candidates = queue
        .map((t, i) => ({ t, i }))
        .filter((x) => x.i !== queueIndex);
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      if (pick) {
        await get().playAt(pick.i);
        return;
      }
    }
    await get().playAt(nextIndex);
  },

  prev: async () => {
    claimLocalPlayer();
    const { audioEl, progress, queueIndex, queue } = get();
    // Source de vérité = audio (progress Zustand peut être en retard d’1 tick)
    const t = audioEl && Number.isFinite(audioEl.currentTime) ? audioEl.currentTime : progress;
    // Style YouTube Music / Google Music : > 4 s → recommence le titre ; sinon titre précédent
    if (t > 4) {
      if (audioEl) {
        try {
          audioEl.currentTime = 0;
        } catch {
          /* ignore */
        }
      }
      set({ progress: 0 });
      publish();
      return;
    }
    if (queueIndex > 0) {
      await get().playAt(queueIndex - 1);
      return;
    }
    // Début de file : restart le titre courant
    if (audioEl) {
      try {
        audioEl.currentTime = 0;
      } catch {
        /* ignore */
      }
      set({ progress: 0 });
      if (audioEl.paused) void get().toggle();
      publish();
    } else if (queue[0]) {
      await get().playAt(0);
    }
  },

  setProgress: (n) => {
    const prev = get().progress;
    const now = Date.now();
    const jumped = Math.abs(n - prev) > 1.2;
    const last = (get() as PlayerState & { _lastProgressAt?: number })._lastProgressAt || 0;
    // Throttle UI store ~2.5 Hz (la barre lit aussi audioEl en live)
    if (!jumped && now - last < 400) return;
    (get() as PlayerState & { _lastProgressAt?: number })._lastProgressAt = now;
    set({ progress: n });
    const { duration, isPlaying } = get();
    if ('mediaSession' in navigator && duration) {
      try {
        navigator.mediaSession.setPositionState({
          duration,
          position: Math.min(n, duration),
          playbackRate: get().audioEl?.playbackRate || 1,
        });
      } catch {
        /* ignore */
      }
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }
    const now2 = Date.now();
    const lastPersist = (get() as PlayerState & { _lastPersist?: number })._lastPersist || 0;
    if (now2 - lastPersist > 4000) {
      (get() as PlayerState & { _lastPersist?: number })._lastPersist = now2;
      persistPlayer();
    }
    // Publie le timecode pour les autres appareils (throttle via publish())
    if (isPlaying && isActivePlayer() && now2 - lastHttpPublishAt > 3000) {
      publish();
    }
  },

  seek: (n) => {
    const t = Math.max(0, Number.isFinite(n) ? n : 0);
    if (!isActivePlayer()) {
      sendCmd({ action: 'seek', time: t });
      set({ progress: t });
      return;
    }
    const { audioEl } = get();
    if (audioEl) {
      try {
        audioEl.currentTime = t;
      } catch {
        /* ignore NotSupportedError pendant chargement */
      }
    }
    set({ progress: t });
    publish();
  },

  seekBy: (deltaSec) => {
    const { audioEl, progress, duration } = get();
    const cur =
      audioEl && Number.isFinite(audioEl.currentTime) ? audioEl.currentTime : progress;
    const audioDur =
      audioEl && Number.isFinite(audioEl.duration) && audioEl.duration > 0 ? audioEl.duration : 0;
    const max =
      duration > 0 ? duration : audioDur > 0 ? audioDur : Math.max(cur + Math.abs(deltaSec), cur);
    const next = Math.max(0, Math.min(max, cur + deltaSec));
    // Scrub rapide (appui long) : pas de publish/persist à chaque tick
    if (!isActivePlayer()) {
      sendCmd({ action: 'seek', time: next });
      set({ progress: next });
      return;
    }
    if (audioEl) {
      try {
        audioEl.currentTime = next;
      } catch {
        /* ignore NotSupportedError pendant chargement */
      }
    }
    set({ progress: next });
    const now = Date.now();
    const last = (get() as PlayerState & { _lastSeekPublishAt?: number })._lastSeekPublishAt || 0;
    if (now - last > 900) {
      (get() as PlayerState & { _lastSeekPublishAt?: number })._lastSeekPublishAt = now;
      publish();
    }
  },

  setDuration: (n) => set({ duration: n }),

  setVolume: (n) => {
    const v = Math.max(0, Math.min(1, n));
    if (!isActivePlayer()) {
      sendCmd({ action: 'volume', volume: v });
      set({ volume: v });
      return;
    }
    const { audioEl } = get();
    if (audioEl) {
      audioEl.muted = false;
      audioEl.volume = v;
    }
    set({ volume: v });
    publish();
  },

  toggleShuffle: () => {
    const turningOn = !get().shuffle;
    if (turningOn) {
      // Réordonne uniquement la suite — snapshot naturel pour restore
      set((s) => {
        const qi = s.queueIndex;
        const head = s.queue.slice(0, qi + 1);
        const rest = s.queue.slice(qi + 1);
        const natural = rest.map((t) => t);
        const shuffled = [...rest];
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const tmp = shuffled[i]!;
          shuffled[i] = shuffled[j]!;
          shuffled[j] = tmp;
        }
        return { shuffle: true, queue: [...head, ...shuffled], shuffleNatural: natural };
      });
    } else {
      set((s) => {
        const qi = s.queueIndex;
        const head = s.queue.slice(0, qi + 1);
        const rest = s.queue.slice(qi + 1);
        const natural = s.shuffleNatural || [];
        const restIds = new Set(rest.map((t) => t.id));
        const byId = new Map(rest.map((t) => [t.id, t] as const));
        const restored: Track[] = [];
        for (const t of natural) {
          if (restIds.has(t.id) && byId.has(t.id)) {
            restored.push(byId.get(t.id)!);
            restIds.delete(t.id);
          }
        }
        for (const t of rest) {
          if (restIds.has(t.id)) restored.push(t);
        }
        return { shuffle: false, queue: [...head, ...restored], shuffleNatural: null };
      });
    }
    if (!isActivePlayer()) sendCmd({ action: 'shuffle', value: get().shuffle });
    else publish();
    persistPlayer();
    schedulePrefetch(get().queue, get().queueIndex);
  },

  refreshRecoAfterFeedback: (trackId, verdict) => {
    autoRadioSeq += 1;
    autoRadioInflight = null;
    try {
      clearCachedMix(mixCacheKey('track', trackId));
      const curId = get().current?.id;
      if (curId && curId !== trackId) clearCachedMix(mixCacheKey('track', curId));
    } catch {
      /* ignore */
    }
    set((s) => {
      let queue = s.queue;
      let userQueueEnd = s.userQueueEnd;
      let shuffleNatural = s.shuffleNatural;
      // Dislike : retire le titre des propositions déjà en file (pas le courant)
      if (verdict === 'bad' && trackId) {
        const qi = s.queueIndex;
        const nextQ = s.queue.filter((t, i) => i <= qi || t.id !== trackId);
        if (nextQ.length !== s.queue.length) {
          const removedBeforeEnd = s.queue
            .slice(0, Math.max(s.userQueueEnd || 0, 0))
            .filter((t, i) => i > qi && t.id === trackId).length;
          queue = nextQ;
          userQueueEnd = Math.max(qi + 1, (s.userQueueEnd || 0) - removedBeforeEnd);
          userQueueEnd = Math.min(userQueueEnd, queue.length);
          if (shuffleNatural?.length) {
            shuffleNatural = shuffleNatural.filter((t) => t.id !== trackId);
          }
        }
      }
      return {
        queue,
        userQueueEnd,
        shuffleNatural,
        // Force un nouveau fetch de suggestions pour la suite (file déjà chargée intacte)
        related: [],
        relatedSeedId: null,
      };
    });
    persistPlayer();
    publish();
    const cur = get().current;
    if (cur?.id) void ensureAutoRadio(cur.id);
  },

  cycleRepeat: () => {
    set((s) => ({
      repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off',
    }));
    if (!isActivePlayer()) sendCmd({ action: 'repeat', value: get().repeat });
    else publish();
    schedulePrefetch(get().queue, get().queueIndex);
  },

  toggleQueue: () => set((s) => ({ showQueue: !s.showQueue, showLyrics: false })),

  setMediaPresentation: (mode) => {
    set({ mediaPresentation: mode });
    // Mode vidéo : pas de skip silence → on peut re-autoriser les URLs directes
    setMeterPreferred(mode !== 'video');
    resetSilenceSkip(get().current?.id);
  },

  toggleLyrics: async () => {
    const { showLyrics, current } = get();
    if (showLyrics) {
      set({ showLyrics: false });
      return;
    }
    set({ showLyrics: true, showQueue: false });
    if (current) {
      try {
        const { lyrics, timed, source } = await api.lyrics(current.id);
        set({
          lyrics,
          lyricsTimed: timed || null,
          lyricsSource: source ?? null,
        });
      } catch {
        set({ lyrics: null, lyricsTimed: null, lyricsSource: null });
      }
    }
  },

  toggleAutoplay: () => {
    get().setAutoplay(!get().autoplay);
  },

  setAutoplay: (on) => {
    if (!on) {
      // Garde les suggestions visibles — coupe seulement l’auto-avance
      set({ autoplay: false });
      persistPlayer();
      publish();
      void syncAutoplayPref(false);
      return;
    }
    set({ autoplay: true });
    persistPlayer();
    publish();
    void syncAutoplayPref(true);
    const cur = get().current;
    if (cur?.id) void ensureAutoRadio(cur.id);
  },

  topUpAutoplay: () => {
    const cur = get().current;
    if (cur?.id) void ensureAutoRadio(cur.id);
  },

  addNext: (track) => {
    const state = get();
    const empty = !state.current || state.queue.length === 0;
    if (empty) {
      void get().play(track, [track], { preserveQueue: true });
      return;
    }
    if (!isActivePlayer()) {
      sendCmd({ action: 'add_next', track });
    }
    set((s) => {
      const q = [...s.queue];
      const insertAt = s.queueIndex + 1;
      q.splice(insertAt, 0, track);
      let end = typeof s.userQueueEnd === 'number' ? s.userQueueEnd : s.queue.length;
      if (insertAt < end) end += 1;
      else end = insertAt + 1;
      return { queue: q, userQueueEnd: end };
    });
    publish();
  },

  addToQueue: (track) => {
    const state = get();
    const empty = !state.current || state.queue.length === 0;
    if (empty) {
      void get().play(track, [track], { preserveQueue: true });
      return;
    }
    if (!isActivePlayer()) sendCmd({ action: 'add_queue', track });
    set((s) => {
      const q = [...s.queue];
      let end = typeof s.userQueueEnd === 'number' ? s.userQueueEnd : s.queue.length;
      end = Math.min(Math.max(end, s.queueIndex + 1), q.length);
      q.splice(end, 0, track);
      return { queue: q, userQueueEnd: end + 1 };
    });
    publish();
  },

  moveInQueue: (fromIndex, toIndex) => {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;
    set((s) => {
      if (fromIndex >= s.queue.length || toIndex >= s.queue.length) return s;
      const q = [...s.queue];
      const [item] = q.splice(fromIndex, 1);
      q.splice(toIndex, 0, item);
      let qi = s.queueIndex;
      if (fromIndex === qi) qi = toIndex;
      else if (fromIndex < qi && toIndex >= qi) qi -= 1;
      else if (fromIndex > qi && toIndex <= qi) qi += 1;
      let end = typeof s.userQueueEnd === 'number' ? s.userQueueEnd : s.queue.length;
      if (fromIndex < end) end -= 1;
      if (toIndex < end) end += 1;
      return { queue: q, queueIndex: qi, userQueueEnd: Math.max(qi + 1, end) };
    });
    publish();
  },

  removeFromQueue: (index) => {
    set((s) => {
      if (index < 0 || index >= s.queue.length) return s;
      // Ne pas retirer le titre en cours via cette action (utiliser next)
      if (index === s.queueIndex) return s;
      const q = s.queue.filter((_, i) => i !== index);
      const qi = index < s.queueIndex ? s.queueIndex - 1 : s.queueIndex;
      let end = typeof s.userQueueEnd === 'number' ? s.userQueueEnd : s.queue.length;
      if (index < end) end -= 1;
      return {
        queue: q,
        queueIndex: Math.max(0, Math.min(qi, q.length - 1)),
        userQueueEnd: Math.min(end, q.length),
      };
    });
    publish();
  },

  clearPlayedFromQueue: () => {
    set((s) => {
      if (s.queueIndex <= 0) return s;
      const drop = s.queueIndex;
      const q = s.queue.slice(drop);
      const prevEnd = typeof s.userQueueEnd === 'number' ? s.userQueueEnd : s.queue.length;
      const end = Math.max(0, prevEnd - drop);
      return {
        queue: q,
        queueIndex: 0,
        userQueueEnd: Math.min(end, q.length),
      };
    });
    publish();
  },

  clearUpcomingFromQueue: () => {
    set((s) => {
      const cur = s.current ?? s.queue[s.queueIndex];
      if (!cur) {
        return { queue: [], queueIndex: 0, userQueueEnd: 0, autoplay: false };
      }
      return {
        queue: [cur],
        queueIndex: 0,
        userQueueEnd: 1,
        autoplay: false,
      };
    });
    publish();
  },

  stopAndClear: () => {
    try {
      const el = get().audioEl;
      if (el) {
        el.pause();
        el.removeAttribute('src');
        el.load();
        delete el.dataset.trackId;
      }
      const standby = get().standbyEl;
      if (standby) {
        standby.pause();
        standby.removeAttribute('src');
        standby.load();
      }
    } catch {
      /* ignore DOM / media errors */
    }
    set({
      current: null,
      queue: [],
      queueIndex: 0,
      userQueueEnd: 0,
      isPlaying: false,
      isLoading: false,
      progress: 0,
      duration: 0,
      showQueue: false,
      showLyrics: false,
      playError: null,
      queueHint: null,
      autoplay: false,
    });
    try {
      publish();
    } catch {
      /* ignore */
    }
  },

  appendRelated: (tracks) => {
    set((s) => {
      const ids = new Set(s.queue.map((t) => t.id));
      const extra = tracks.filter((t) => isPlayable(t) && !ids.has(t.id));
      // Zone auto uniquement — ne pas étendre userQueueEnd
      return { queue: [...s.queue, ...extra], related: tracks };
    });
    publish();
  },

  clearQueue: () => {
    set({ queue: [], queueIndex: 0, userQueueEnd: 0 });
    publish();
  },

  enqueueAfterCurrent: (tracks, opts) => {
    const cap = opts?.cap ?? 36;
    const replaceRest = opts?.replaceRest !== false;
    const state = get();
    const extras = tracks
      .filter(isPlayable)
      .filter((t) => t.id !== state.current?.id)
      .filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i)
      .slice(0, cap);
    if (!extras.length) return;

    if (!state.current || state.queue.length === 0) {
      void get().play(extras[0]!, extras, {
        preserveQueue: true,
        sourceId: opts?.sourceId ?? undefined,
        sourceKind: opts?.sourceKind ?? undefined,
      });
      return;
    }

    set((s) => {
      const qi = s.queueIndex;
      const head = s.queue.slice(0, qi + 1);
      const kept = replaceRest
        ? []
        : s.queue.slice(qi + 1).filter((t) => !extras.some((e) => e.id === t.id));
      const q = [...head, ...extras, ...kept].slice(0, qi + 1 + MIX_TARGET);
      return {
        queue: q,
        userQueueEnd: Math.max(q.length, qi + 1),
        showQueue: true,
        sourceId: opts?.sourceId !== undefined ? opts.sourceId : s.sourceId,
        sourceKind: opts?.sourceKind !== undefined ? opts.sourceKind : s.sourceKind,
      };
    });
    schedulePrefetch(get().queue, get().queueIndex);
    persistPlayer();
    publish();
  },

  startMix: async (track) => {
    await get().startRadio({ kind: 'track', id: track.id, seed: track });
  },

  startRadio: async ({ kind, id, seed, stayClose }) => {
    set({ isLoading: true, showQueue: true, showLyrics: false });
    try {
      let seedTrack: Track | null = seed && isPlayable(seed) ? seed : null;
      let pool: Track[] = [];

      // Hors-ligne : mix à partir des titres déjà sur l’appareil (pas d’API)
      if (!isBrowserOnline()) {
        const local = (await listCachedTracks()).filter(isPlayable);
        if (!local.length) return { added: 0, soft: false as const };
        const seedId = seedTrack?.id;
        const head =
          (seedId && local.find((t) => t.id === seedId)) ||
          local[Math.floor(Math.random() * local.length)]!;
        const rest = local
          .filter((t) => t.id !== head.id)
          .sort(() => Math.random() - 0.5)
          .slice(0, MIX_TARGET);
        const mix = [head, ...rest];
        autoRadioSeq += 1;
        autoRadioInflight = null;
        await get().play(head, mix, {
          preserveQueue: true,
          forceRestart: true,
          noAutoRadio: true,
          sourceId: head.id,
          sourceKind: 'radio',
        });
        set({
          showQueue: true,
          showLyrics: false,
          autoplay: false,
          shuffle: false,
          shuffleNatural: null,
          related: rest,
          relatedSeedId: head.id,
        });
        return { added: rest.length, soft: false as const };
      }

      const cacheKind = kind === 'track' ? 'track' : kind === 'album' ? 'album' : 'artist';
      const cKey = mixCacheKey(cacheKind, id);
      const cached = getCachedMix(cKey);
      if (cached?.length) {
        pool = cached.filter((t) => isPlayable(t) && t.id !== seedTrack?.id);
        if (!seedTrack) seedTrack = cached.find(isPlayable) || null;
      }

      if (!pool.length) {
        if (kind === 'track') {
          const trackId = id;
          // related API — full=false d’abord (évite timeout ~200 titres)
          const rel = await api
            .related(trackId, { full: false })
            .catch(() => ({ related: [] as Track[], radio: [] as Track[], tracks: [] as Track[] }));
          const raw = [
            ...(rel.related || []),
            ...(rel.radio || []),
            ...((rel as { tracks?: Track[] }).tracks || []),
          ];
          pool = raw.filter((t) => t.id !== trackId && isPlayable(t));
          if (stayClose && seedTrack?.artists?.[0]) {
            const artistKey = (
              seedTrack.artists[0].id ||
              seedTrack.artists[0].name ||
              ''
            ).toLowerCase();
            const close = pool.filter((t) =>
              (t.artists || []).some(
                (a) => (a.id || a.name || '').toLowerCase() === artistKey,
              ),
            );
            const far = pool.filter(
              (t) =>
                !(t.artists || []).some(
                  (a) => (a.id || a.name || '').toLowerCase() === artistKey,
                ),
            );
            pool = [...close.slice(0, 20), ...far].slice(0, MIX_TARGET);
          }
          // Pas de diversify client : ranking serveur déjà diversifié
          if (!seedTrack) {
            seedTrack = { id: trackId, title: 'Radio', artists: [], thumbnails: [], type: 'song' };
          }
          setCachedMix(cKey, pool, {
            generatedAt: (rel as { generatedAt?: number }).generatedAt,
            target: (rel as { target?: number }).target,
          });
        } else if (kind === 'album') {
          const [radioRes, albumRes] = await Promise.all([
            api.albumRadio(id).catch(() => ({ tracks: [] as Track[] })),
            api.album(id).catch(() => null),
          ]);
          const albumTracks = (albumRes?.tracks || []).filter(isPlayable);
          seedTrack = seedTrack || albumTracks[0] || null;
          const radio = (radioRes.tracks || []).filter(
            (t) => isPlayable(t) && t.id !== seedTrack?.id,
          );
          const albumRest = albumTracks.filter((t) => t.id !== seedTrack?.id).slice(0, 6);
          pool = [...radio, ...albumRest];
          setCachedMix(cKey, pool, {
            generatedAt: (radioRes as { generatedAt?: number }).generatedAt,
            target: (radioRes as { target?: number }).target,
          });
        } else {
          const [radioRes, artistRes] = await Promise.all([
            api.artistRadio(id).catch(() => ({ tracks: [] as Track[] })),
            api.artist(id).catch(() => null),
          ]);
          const songs = (artistRes?.songs || []).filter(isPlayable);
          seedTrack = seedTrack || songs[0] || (radioRes.tracks || []).find(isPlayable) || null;
          const radio = (radioRes.tracks || []).filter(
            (t) => isPlayable(t) && t.id !== seedTrack?.id,
          );
          pool = [...songs.filter((t) => t.id !== seedTrack?.id).slice(0, 8), ...radio];
          setCachedMix(cKey, pool, {
            generatedAt: (radioRes as { generatedAt?: number }).generatedAt,
            target: (radioRes as { target?: number }).target,
          });
        }
      }

      // Dédup
      const seen = new Set<string>();
      const uniq: Track[] = [];
      for (const t of pool) {
        if (!t.id || seen.has(t.id)) continue;
        seen.add(t.id);
        uniq.push(t);
        if (uniq.length >= MIX_TARGET) break;
      }
      pool = uniq;

      if (!seedTrack || !isPlayable(seedTrack)) {
        seedTrack = pool[0] || null;
        if (seedTrack) pool = pool.slice(1);
      }
      if (!seedTrack) return { added: 0, soft: false as const };

      const upcoming = pool.filter((t) => t.id !== seedTrack!.id).slice(0, MIX_TARGET);
      const mix = [seedTrack, ...upcoming];
      set({ related: pool, relatedSeedId: seedTrack.id });

      const nextKind =
        kind === 'track' ? ('radio' as const) : kind === 'album' ? ('album' as const) : ('artist' as const);

      // Radio explicite = hard-start : nouvelle base, file remplacée, déjà joués abandonnés
      autoRadioSeq += 1;
      autoRadioInflight = null;
      await get().play(seedTrack, mix, {
        preserveQueue: true,
        forceRestart: true,
        noAutoRadio: upcoming.length >= 12,
        sourceId: kind === 'track' ? seedTrack.id : id,
        sourceKind: nextKind,
      });
      set({
        showQueue: true,
        showLyrics: false,
        autoplay: upcoming.length < 12,
        shuffle: false,
        shuffleNatural: null,
      });
      return { added: upcoming.length, soft: false as const };
    } catch (err) {
      console.error('startRadio', err);
      if (seed && isPlayable(seed)) {
        await get().play(seed, [seed], { preserveQueue: true, forceRestart: true });
      }
      return { added: 0, soft: false as const };
    } finally {
      set({ isLoading: false });
    }
  },

  loadRelated: async (trackId) => {
    set({ relatedLoading: true, relatedError: null });
    try {
      const seed = usePlayer.getState().current;
      // Phase 1 : fast — on garde cette liste (ne pas écraser ensuite)
      const relFast = await api
        .related(trackId, { fast: true })
        .catch(() => ({ related: [] as Track[], radio: [] as Track[] }));
      if (usePlayer.getState().current?.id && usePlayer.getState().current?.id !== trackId) {
        set({ relatedLoading: false });
        return;
      }
      let pool = (relFast.related?.length ? relFast.related : relFast.radio || []).filter(isPlayable);
      let first: Track[] = [];
      if (pool.length) {
        first = diversifyByArtist(pool, seed?.artists?.[0], seed).slice(0, 10);
        set({
          related: first,
          relatedSeedId: trackId,
          relatedLoading: false,
          relatedError: null,
        });
      }
      // Phase 2 : enrichir seulement (append), jamais remplacer la 1ʳᵉ liste
      const rel = await api
        .related(trackId, { full: false })
        .catch(() => ({ related: [] as Track[], radio: [] as Track[] }));
      if (usePlayer.getState().current?.id && usePlayer.getState().current?.id !== trackId) {
        set({ relatedLoading: false });
        return;
      }
      pool = (rel.related?.length ? rel.related : rel.radio || []).filter(isPlayable);
      const diversified = diversifyByArtist(pool, seed?.artists?.[0], seed);
      const prev = usePlayer.getState().relatedSeedId === trackId ? usePlayer.getState().related : first;
      const seenId = new Set(prev.map((t) => t.id));
      const seenFp = new Set(prev.map(trackFingerprint));
      if (seed) seenFp.add(trackFingerprint(seed));
      const extras = diversified.filter((t) => {
        if (seenId.has(t.id)) return false;
        const fp = trackFingerprint(t);
        if (fp && seenFp.has(fp)) return false;
        seenId.add(t.id);
        seenFp.add(fp);
        return true;
      });
      const merged = [...prev, ...extras].slice(0, 80);
      set({
        related: merged,
        relatedSeedId: trackId,
        relatedLoading: false,
        relatedError: merged.length ? null : 'Aucune suggestion pour ce titre.',
      });
      if (merged.length) {
        mergeAutoTracks(trackId, merged, merged);
      }
    } catch (e) {
      if (usePlayer.getState().current?.id === trackId) {
        set({
          relatedLoading: false,
          relatedError: e instanceof Error ? e.message : 'Suggestions indisponibles',
        });
      } else {
        set({ relatedLoading: false });
      }
    }
  },

  applyRemoteState: async (state, playAudio = false) => {
    set({
      current: state.current ?? get().current,
      queue: state.queue ?? get().queue,
      queueIndex: state.queueIndex ?? get().queueIndex,
      userQueueEnd: state.userQueueEnd ?? get().userQueueEnd,
      autoplay: state.autoplay ?? get().autoplay,
      isPlaying: state.isPlaying ?? get().isPlaying,
      progress: state.progress ?? get().progress,
      duration: state.duration ?? get().duration,
      volume: state.volume ?? get().volume,
      shuffle: state.shuffle ?? get().shuffle,
      repeat: state.repeat ?? get().repeat,
    });

    if (playAudio && state.current && isActivePlayer()) {
      try {
        set({ isLoading: true });
        const gen = ++playGeneration;
        await playLocal(state.current, get(), gen);
        const audio = get().audioEl;
        if (audio && typeof state.progress === 'number') audio.currentTime = state.progress;
        if (state.isPlaying === false) {
          audio?.pause();
          set({ isPlaying: false, isLoading: false });
        } else {
          set({ isPlaying: true, isLoading: false });
        }
        refreshMediaSession();
      } catch (err) {
        // Abort / NotSupported déjà gérés dans playLocal — log discret
        console.warn('applyRemoteState play', err);
        set({ isLoading: false });
      }
    }
  },
}));

// Wire remote events once
let wired = false;
export function wireRemotePlayer() {
  if (wired || typeof window === 'undefined') return;
  wired = true;

  window.addEventListener('ytm-remote-command', ((ev: CustomEvent) => {
    if (!isActivePlayer()) return;
    const cmd = ev.detail || {};
    const p = usePlayer.getState();
    switch (cmd.action) {
      case 'play':
        void p.play(cmd.track, cmd.queue, { preserveQueue: true });
        break;
      case 'play_at':
        void p.playAt(cmd.index);
        break;
      case 'pause':
        if (p.isPlaying) p.toggle();
        break;
      case 'resume':
        if (!p.isPlaying) p.toggle();
        break;
      case 'next':
        void p.next();
        break;
      case 'prev':
        void p.prev();
        break;
      case 'seek':
        p.seek(cmd.time);
        break;
      case 'volume':
        p.setVolume(cmd.volume);
        break;
      case 'shuffle':
        if (p.shuffle !== cmd.value) p.toggleShuffle();
        break;
      case 'repeat':
        while (usePlayer.getState().repeat !== cmd.value) p.cycleRepeat();
        break;
      case 'add_next':
        p.addNext(cmd.track);
        break;
      case 'add_queue':
        p.addToQueue(cmd.track);
        break;
      default:
        break;
    }
  }) as EventListener);

  window.addEventListener('ytm-become-player', ((ev: CustomEvent) => {
    const { state, autoplay } = ev.detail || {};
    void usePlayer.getState().applyRemoteState(state || {}, Boolean(autoplay ?? true));
  }) as EventListener);
}
