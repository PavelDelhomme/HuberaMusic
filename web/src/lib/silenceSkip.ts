/**
 * Mesure le niveau audio (RMS) pour couper les silences de fin.
 * Partage le graphe Web Audio avec l’égaliseur (createMediaElementSource ×1).
 */
import { ensureAudioGraphForMeter, sampleAudioRms } from './equalizer';

const SILENCE_RMS = 0.018;
/** Silence continu avant skip (ms). */
const SILENCE_HOLD_MS = 850;
/** Ne cherche le silence qu’après cette part du titre (évite intros / breaks). */
const MIN_PROGRESS = 0.50;
/** Ou bien dans les N dernières secondes. */
const TAIL_WINDOW_SEC = 45;
/** Ignore les titres trop courts. */
const MIN_DURATION_SEC = 40;

export type SilenceSkipOpts = {
  /** Mode vidéo : ne pas couper (visuel possible). */
  videoMode: boolean;
  trackId: string | null | undefined;
  isPlaying: boolean;
  /** Dernière lyric (ms) — accélère le skip si déjà en outro. */
  lastLyricMs?: number | null;
};

type SilenceState = {
  trackId: string | null;
  silentForMs: number;
  lastTs: number;
  skippedId: string | null;
};

const state: SilenceState = {
  trackId: null,
  silentForMs: 0,
  lastTs: 0,
  skippedId: null,
};

export function resetSilenceSkip(trackId?: string | null) {
  state.trackId = trackId ?? null;
  state.silentForMs = 0;
  state.lastTs = 0;
  if (trackId && state.skippedId === trackId) state.skippedId = null;
}

/**
 * À appeler régulièrement (timeupdate). Retourne true si on doit passer au suivant.
 */
export function shouldSkipTrailingSilence(
  el: HTMLAudioElement,
  opts: SilenceSkipOpts,
): boolean {
  if (opts.videoMode) {
    state.silentForMs = 0;
    return false;
  }
  if (!opts.isPlaying || el.paused || el.ended) {
    state.silentForMs = 0;
    return false;
  }
  const id = opts.trackId;
  if (!id || state.skippedId === id) return false;

  const dur = el.duration;
  const t = el.currentTime;
  if (!Number.isFinite(dur) || !Number.isFinite(t) || dur < MIN_DURATION_SEC) return false;

  const inTail = t >= dur - TAIL_WINDOW_SEC || t / dur >= MIN_PROGRESS;
  const lastLyric = opts.lastLyricMs;
  const pastLyrics =
    typeof lastLyric === 'number' &&
    lastLyric > 0 &&
    t * 1000 >= lastLyric + 2000 &&
    lastLyric / 1000 >= dur * 0.45;

  if (!inTail && !pastLyrics) {
    state.silentForMs = 0;
    return false;
  }

  // Il doit rester un vrai bout de silence à brûler
  if (dur - t < 0.9) return false;

  if (state.trackId !== id) {
    state.trackId = id;
    state.silentForMs = 0;
    state.lastTs = performance.now();
  }

  void ensureAudioGraphForMeter(el);
  const rms = sampleAudioRms();
  const now = performance.now();
  const dt = state.lastTs > 0 ? Math.min(500, now - state.lastTs) : 0;
  state.lastTs = now;

  // Sans analyseur : fallback lyrics agressif
  if (rms == null) {
    if (pastLyrics && dur - t >= 1.5) {
      state.skippedId = id;
      state.silentForMs = 0;
      return true;
    }
    return false;
  }

  if (rms < SILENCE_RMS) {
    state.silentForMs += dt;
  } else {
    state.silentForMs = 0;
  }

  const hold = pastLyrics ? 550 : SILENCE_HOLD_MS;
  if (state.silentForMs >= hold) {
    state.skippedId = id;
    state.silentForMs = 0;
    return true;
  }
  return false;
}
