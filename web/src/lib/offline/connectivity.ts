/** Connectivité navigateur : coupe le prefetch hors ligne, reprend à la reconnexion. */
import { markStreamOk, markStreamDown, cancelPrefetchIdle } from '../audio/streamPrefetch';

type OnlineListener = (online: boolean) => void;
const listeners = new Set<OnlineListener>();
let wired = false;

export function isBrowserOnline(): boolean {
  try {
    return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  } catch {
    return true;
  }
}

export function onConnectivityChange(fn: OnlineListener): () => void {
  listeners.add(fn);
  ensureWired();
  return () => listeners.delete(fn);
}

function ensureWired() {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  const emit = (online: boolean) => {
    if (online) {
      markStreamOk();
    } else {
      markStreamDown(60_000);
      cancelPrefetchIdle();
    }
    for (const fn of [...listeners]) {
      try {
        fn(online);
      } catch {
        /* ignore */
      }
    }
  };
  window.addEventListener('online', () => emit(true));
  window.addEventListener('offline', () => emit(false));
  if (!isBrowserOnline()) emit(false);
}

/** À appeler une fois au boot de l’app web. */
export function initConnectivityWatch(onOnlineResume?: () => void) {
  ensureWired();
  if (onOnlineResume) {
    onConnectivityChange((online) => {
      if (online) onOnlineResume();
    });
  }
}
