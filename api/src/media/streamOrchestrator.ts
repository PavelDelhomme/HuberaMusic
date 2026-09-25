/**
 * Abort skip scopé : on coupe la résolution Innertube/yt-dlp de CET user,
 * pas le .m4a partagé ni le prefetch file (warm).
 *
 * Compteur de consommateurs par videoId :
 *  - user:<id>  → lecture / skip
 *  - warm:next  → titre suivant
 *  - warm:search → 1er hit recherche
 * On n’avorte le réseau disque que s’il ne reste PERSONNE et que le fichier
 * n’est pas encore servable (< 256 Ko). Sinon on laisse finir (cache utile).
 */
const userResolutions = new Map<string, AbortController>();
const consumers = new Map<string, Set<string>>();
const downloadAbort = new Map<string, AbortController>();

export function beginUserResolution(userId: string | undefined): AbortSignal {
  if (!userId) return new AbortController().signal;
  const prev = userResolutions.get(userId);
  if (prev && !prev.signal.aborted) {
    try {
      prev.abort();
    } catch {
      /* ignore */
    }
  }
  const next = new AbortController();
  userResolutions.set(userId, next);
  return next.signal;
}

export function endUserResolution(userId: string | undefined, signal?: AbortSignal): void {
  if (!userId) return;
  const cur = userResolutions.get(userId);
  if (cur && (!signal || cur.signal === signal)) {
    userResolutions.delete(userId);
  }
}

export function addDownloadConsumer(videoId: string, key: string): AbortSignal {
  let set = consumers.get(videoId);
  if (!set) {
    set = new Set();
    consumers.set(videoId, set);
  }
  set.add(key);
  let ac = downloadAbort.get(videoId);
  if (!ac || ac.signal.aborted) {
    ac = new AbortController();
    downloadAbort.set(videoId, ac);
  }
  return ac.signal;
}

export function removeDownloadConsumer(videoId: string, key: string): { remaining: number; aborted: boolean } {
  const set = consumers.get(videoId);
  if (set) {
    set.delete(key);
    if (set.size === 0) consumers.delete(videoId);
  }
  const remaining = consumers.get(videoId)?.size || 0;
  return { remaining, aborted: false };
}

/** Skip : abort résolution user. Ne touche pas aux warm:* ni aux autres users. */
export function onUserSkip(userId: string | undefined): void {
  if (!userId) return;
  const prev = userResolutions.get(userId);
  if (prev) {
    try {
      prev.abort();
    } catch {
      /* ignore */
    }
    userResolutions.delete(userId);
  }
  const key = `user:${userId}`;
  for (const [videoId, set] of [...consumers.entries()]) {
    if (!set.has(key)) continue;
    set.delete(key);
    if (set.size === 0) consumers.delete(videoId);
  }
}

export function downloadSignal(videoId: string): AbortSignal | undefined {
  return downloadAbort.get(videoId)?.signal;
}

export function shouldAbortOrphanDownload(videoId: string, diskBytes: number): boolean {
  const remaining = consumers.get(videoId)?.size || 0;
  if (remaining > 0) return false;
  if (diskBytes >= 256 * 1024) return false;
  const ac = downloadAbort.get(videoId);
  if (ac && !ac.signal.aborted) {
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
  }
  downloadAbort.delete(videoId);
  return true;
}

const searchTokens = new Map<string, { n: number; resetAt: number }>();

export function canSearchWarm(userId: string | undefined): boolean {
  if (!userId) return false;
  const now = Date.now();
  let b = searchTokens.get(userId);
  if (!b || now >= b.resetAt) {
    b = { n: 2, resetAt: now + 10_000 };
    searchTokens.set(userId, b);
  }
  if (b.n <= 0) return false;
  b.n -= 1;
  return true;
}
