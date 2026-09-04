/**
 * Ne pas laisser l’horloge partir avant que le début soit vraiment en buffer.
 * Sinon le titre « joue » 0,5–1 s dans le vide et l’intro est déjà passée.
 */

const MIN_BUFFER_SEC = 1.0;
const MAX_WAIT_MS = 3_500;

function bufferedAheadSec(el: HTMLAudioElement): number {
  try {
    if (!el.buffered.length) return 0;
    const t = Number.isFinite(el.currentTime) ? el.currentTime : 0;
    for (let i = 0; i < el.buffered.length; i++) {
      const start = el.buffered.start(i);
      const end = el.buffered.end(i);
      if (t >= start - 0.05 && t <= end + 0.05) return Math.max(0, end - t);
    }
    return Math.max(0, el.buffered.end(el.buffered.length - 1) - t);
  } catch {
    return 0;
  }
}

function startReady(el: HTMLAudioElement): boolean {
  return (
    el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA ||
    (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      bufferedAheadSec(el) >= MIN_BUFFER_SEC)
  );
}

/**
 * Après `play()` (geste utilisateur conservé) : attendre ~1 s de buffer,
 * recaler à 0 si l’horloge a sauté, puis rétablir le volume.
 */
export async function gateAudioStart(
  el: HTMLAudioElement,
  isCurrent: () => boolean,
  targetVolume: number,
): Promise<void> {
  if (!isCurrent()) return;
  const saved =
    Number.isFinite(el.volume) && el.volume > 0 ? el.volume : targetVolume;
  try {
    el.volume = 0;
  } catch {
    /* ignore */
  }

  if (!startReady(el) && bufferedAheadSec(el) < MIN_BUFFER_SEC) {
    await new Promise<void>((resolve) => {
      const finish = () => {
        el.removeEventListener('canplay', onProg);
        el.removeEventListener('canplaythrough', onProg);
        el.removeEventListener('progress', onProg);
        el.removeEventListener('loadeddata', onProg);
        window.clearTimeout(timer);
        resolve();
      };
      const onProg = () => {
        if (!isCurrent()) {
          finish();
          return;
        }
        if (startReady(el) || bufferedAheadSec(el) >= MIN_BUFFER_SEC) finish();
      };
      const timer = window.setTimeout(finish, MAX_WAIT_MS);
      el.addEventListener('canplay', onProg);
      el.addEventListener('canplaythrough', onProg);
      el.addEventListener('progress', onProg);
      el.addEventListener('loadeddata', onProg);
      onProg();
    });
  }

  if (!isCurrent()) return;

  // Volume à 0 pendant l’attente : l’horloge a pu avancer dans le vide → revenir au début.
  const t = Number.isFinite(el.currentTime) ? el.currentTime : 0;
  if (t > 0.12 && t < 3) {
    try {
      el.currentTime = 0;
    } catch {
      /* ignore */
    }
  }

  try {
    el.muted = false;
    el.volume = Math.max(0, Math.min(1, saved > 0 ? saved : targetVolume));
  } catch {
    /* ignore */
  }
}
