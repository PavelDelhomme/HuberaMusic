import { apiUrl } from '../../api';

const FULL_CACHE = 'ytm-stream-full-v1';

/** Nombre max de pistes dont on garde le début en mémoire */
const MAX_HEAD = 18;
/** Tête générique (~10 s audio typique YT 160–256 kb/s) */
const HEAD_BYTES = 1_600 * 1024;
/** Prochain titre : plus d’octets pour un skip fluide */
const HEAD_NEXT_BYTES = 2_800 * 1024;
/** Pistes complètes en Cache Storage (instant play) — rester léger sur navigateur */
const MAX_FULL = 12;
/** Au-delà : on ne full-cache pas (trop lourd) — tête seulement */
export const FULL_PRELOAD_MAX_SEC = 12 * 60;
/** Warm format API en parallèle */
const WARM_CONCURRENCY = 5;
/** Prefetch tête en parallèle */
const HEAD_CONCURRENCY = 4;
/** Prefetch full — 1 à la fois (évite 502 / saturation avec le titre en lecture) */
const FULL_CONCURRENCY = 1;

type HeadEntry = { buf: ArrayBuffer; at: number };

const headCache = new Map<string, HeadEntry>();
const warmDone = new Map<string, number>();
const inflightWarm = new Set<string>();
const inflightHead = new Set<string>();
const inflightFull = new Set<string>();
const blobUrls = new Map<string, string>();
/** Pistes à ne jamais évincer (ex. titre en boucle « one »). */
const pinnedFull = new Set<string>();

let fullOrder: string[] = [];
/** Invalide les préchargements d’arrière-plan quand on change de titre trop vite. */
let prefetchGeneration = 0;

/** Circuit-breaker : API/stream injoignable → pause courte, puis on réessaie. */
let streamDownUntil = 0;
let streamFailStreak = 0;
let probeTimer: ReturnType<typeof setInterval> | null = null;

export function isStreamDown(): boolean {
  return Date.now() < streamDownUntil;
}

export function markStreamOk(): void {
  streamFailStreak = 0;
  streamDownUntil = 0;
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}

function ensureStreamProbe() {
  if (typeof window === 'undefined' || probeTimer) return;
  probeTimer = setInterval(() => {
    if (Date.now() < streamDownUntil) return;
    // Fin de pause : laisse une chance (prefetch / play) sans spam infini
    streamFailStreak = Math.max(0, streamFailStreak - 1);
    streamDownUntil = 0;
    if (streamFailStreak <= 0 && probeTimer) {
      clearInterval(probeTimer);
      probeTimer = null;
    }
  }, 4_000);
}

/** Signale un échec réseau / 5xx. Après 2 échecs → pause 8s (puis probe auto). */
export function markStreamFailure(reason?: string): void {
  streamFailStreak += 1;
  if (streamFailStreak >= 2) {
    streamDownUntil = Date.now() + 8_000;
    ensureStreamProbe();
    if (typeof console !== 'undefined') {
      console.warn('[stream] down — pause 8s puis retry', reason || '', `streak=${streamFailStreak}`);
    }
  }
}

/** Force une pause prefetch (ex. navigateur offline). */
export function markStreamDown(pauseMs = 60_000): void {
  streamDownUntil = Date.now() + pauseMs;
  ensureStreamProbe();
}

/** Annule les préchargements en cours (économie batterie / hors ligne). */
export function cancelPrefetchIdle(): void {
  bumpPrefetchGeneration();
}

/** Prefetch arrière-plan : ne déclenche PAS le circuit-breaker (évite spam 502). */
function notePrefetchResult(res: Response | null, _err?: unknown): void {
  if (!res) return;
  if (res.ok || res.status === 206) markStreamOk();
}

function isVideoId(id: string) {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

function touchLru<K>(map: Map<K, unknown>, key: K, max: number) {
  if (!map.has(key)) return;
  const v = map.get(key)!;
  map.delete(key);
  map.set(key, v);
  while (map.size > max) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    map.delete(first);
  }
}

async function authHeaders(): Promise<HeadersInit> {
  const h: Record<string, string> = {};
  try {
    const t = localStorage.getItem('ytm_token') || sessionStorage.getItem('ytm_token');
    if (t) h.Authorization = `Bearer ${t}`;
  } catch {
    /* ignore */
  }
  return h;
}

/** Annule / ignore les préchargements full/head en cours (changement de titre). */
export function bumpPrefetchGeneration() {
  prefetchGeneration += 1;
  return prefetchGeneration;
}

/** Chauffe le déchiffrement googlevideo côté API (latence principale). */
export async function warmFormat(id: string): Promise<void> {
  if (!isVideoId(id) || isStreamDown()) return;
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  } catch {
    /* ignore */
  }
  const last = warmDone.get(id);
  if (last && Date.now() - last < 4 * 60_000) return;
  if (inflightWarm.has(id)) return;
  inflightWarm.add(id);
  try {
    const res = await fetch(apiUrl(`/api/stream/${id}/url`), {
      credentials: 'include',
      headers: await authHeaders(),
    });
    // Warm arrière-plan : ne pas tripper le circuit-breaker (évite pause lecture)
    notePrefetchResult(res);
    if (res.ok) warmDone.set(id, Date.now());
    if (warmDone.size > 80) {
      const first = warmDone.keys().next().value;
      if (first) warmDone.delete(first);
    }
  } catch {
    /* silence prefetch */
  } finally {
    inflightWarm.delete(id);
  }
}

/** Batch warm format (1 requête HTTP). */
export async function warmFormats(ids: string[]): Promise<void> {
  if (isStreamDown()) return;
  const need = [...new Set(ids.filter(isVideoId))].filter((id) => {
    const last = warmDone.get(id);
    return !(last && Date.now() - last < 4 * 60_000);
  });
  if (!need.length) return;
  try {
    const res = await fetch(apiUrl('/api/stream/warm'), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(await authHeaders()),
      },
      body: JSON.stringify({ ids: need.slice(0, 16) }),
    });
    notePrefetchResult(res);
    if (res.ok) {
      const now = Date.now();
      for (const id of need.slice(0, 16)) warmDone.set(id, now);
    } else if (!isStreamDown()) {
      await runPool(need.slice(0, 8), WARM_CONCURRENCY, warmFormat);
    }
  } catch {
    // Pas de fallback individuel si l’API est down (évite N requêtes mortes)
  }
}

/** Précharge le début du flux (Range) en RAM — démarrage quasi immédiat. */
export async function warmHead(id: string, gen?: number, bytes = HEAD_BYTES): Promise<void> {
  if (!isVideoId(id) || isStreamDown()) return;
  if (gen !== undefined && gen !== prefetchGeneration) return;
  if (headCache.has(id)) {
    touchLru(headCache, id, MAX_HEAD);
    return;
  }
  if (inflightHead.has(id)) return;
  inflightHead.add(id);
  try {
    if (gen !== undefined && gen !== prefetchGeneration) return;
    await warmFormat(id);
    if (gen !== undefined && gen !== prefetchGeneration || isStreamDown()) return;
    const res = await fetch(apiUrl(`/api/stream/${id}`), {
      credentials: 'include',
      headers: {
        ...(await authHeaders()),
        Range: `bytes=0-${bytes - 1}`,
      },
    });
    notePrefetchResult(res);
    if (gen !== undefined && gen !== prefetchGeneration) return;
    if (!res.ok && res.status !== 206) return;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 2048) return;
    if (gen !== undefined && gen !== prefetchGeneration) return;
    headCache.set(id, { buf, at: Date.now() });
    while (headCache.size > MAX_HEAD) {
      const first = headCache.keys().next().value;
      if (first === undefined) break;
      headCache.delete(first);
    }
  } catch (e) {
    notePrefetchResult(null, e);
  } finally {
    inflightHead.delete(id);
  }
}

/** Met toute la piste en Cache Storage (play instantané au skip). */
export async function warmFull(id: string, gen?: number): Promise<void> {
  if (!isVideoId(id) || typeof caches === 'undefined' || isStreamDown()) return;
  if (gen !== undefined && gen !== prefetchGeneration) return;
  if (inflightFull.has(id)) return;
  inflightFull.add(id);
  try {
    if (gen !== undefined && gen !== prefetchGeneration) return;
    const cache = await caches.open(FULL_CACHE);
    const url = apiUrl(`/api/stream/${id}`);
    const existing = await cache.match(url);
    if (existing) {
      bumpFull(id);
      return;
    }
    await warmFormat(id);
    if (gen !== undefined && gen !== prefetchGeneration || isStreamDown()) return;
    const res = await fetch(url, {
      credentials: 'include',
      headers: await authHeaders(),
    });
    notePrefetchResult(res);
    if (gen !== undefined && gen !== prefetchGeneration) return;
    if (!res.ok) return; // 502 etc. : silence, pas de circuit-breaker
    await cache.put(url, res.clone());
    bumpFull(id);
    await evictFull(cache);
  } catch (e) {
    notePrefetchResult(null, e);
  } finally {
    inflightFull.delete(id);
  }
}

function bumpFull(id: string) {
  fullOrder = fullOrder.filter((x) => x !== id);
  fullOrder.push(id);
}

/** Épingle une piste full-cache (boucle one) — ne sera pas évincée. */
export function pinFullTrack(id: string) {
  if (!isVideoId(id)) return;
  pinnedFull.clear();
  pinnedFull.add(id);
  bumpFull(id);
}

export function clearPinnedFull() {
  pinnedFull.clear();
}

async function evictFull(cache: Cache) {
  while (fullOrder.length > MAX_FULL) {
    const old = fullOrder.find((id) => !pinnedFull.has(id));
    if (!old) break;
    fullOrder = fullOrder.filter((x) => x !== old);
    const url = apiUrl(`/api/stream/${old}`);
    await cache.delete(url);
    const blob = blobUrls.get(old);
    if (blob) {
      URL.revokeObjectURL(blob);
      blobUrls.delete(old);
    }
  }
}

function shouldFullCache(durationSeconds?: number | null): boolean {
  // Durée inconnue → pas de full (évite de pomper la bande d’un titre long en cours)
  if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return false;
  }
  return durationSeconds <= FULL_PRELOAD_MAX_SEC;
}

async function runPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  gen?: number,
) {
  const q = [...items];
  const workers = Array.from({ length: Math.min(limit, q.length) }, async () => {
    while (q.length) {
      if (gen !== undefined && gen !== prefetchGeneration) return;
      const item = q.shift();
      if (item === undefined) break;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Précharge autour de l’index courant.
 * - warm format + tête Range
 * - full cache pour courant + suivants si durée ≤ 10 min (skip / boucle fluides)
 */
export function prefetchAround(
  trackIds: string[],
  currentIndex: number,
  opts?: {
    ahead?: number;
    behind?: number;
    fullAhead?: number;
    delayFullMs?: number;
    /** Durées en secondes alignées sur trackIds filtrés videoId. */
    durationsSec?: (number | null | undefined)[];
    /** Boucle sur un seul titre → full-cache + pin. */
    loopOne?: boolean;
  },
) {
  if (isStreamDown()) return;
  const ahead = opts?.ahead ?? 6;
  const behind = opts?.behind ?? 1;
  const fullAhead = opts?.fullAhead ?? 3;
  const delayFullMs = opts?.delayFullMs ?? 180;
  const ids = trackIds.filter(isVideoId);
  if (!ids.length) return;

  const gen = bumpPrefetchGeneration();
  const idx = Math.max(0, Math.min(currentIndex, ids.length - 1));
  const durAt = (i: number) => opts?.durationsSec?.[i] ?? null;

  const around: string[] = [];
  for (let i = Math.max(0, idx - behind); i < ids.length && i <= idx + ahead; i++) {
    around.push(ids[i]);
  }
  const unique = [...new Set(around)];

  const currentId = ids[idx];
  if (opts?.loopOne && currentId) {
    pinFullTrack(currentId);
  } else if (!opts?.loopOne) {
    clearPinnedFull();
  }

  // Uniquement le SUIVANT en full (pas le courant = double download + 502)
  const nextId = ids[idx + 1];
  if (opts?.loopOne && currentId) {
    void warmFormat(currentId).then(() => {
      if (gen !== prefetchGeneration) return;
      void warmFull(currentId, gen);
    });
  } else if (nextId && shouldFullCache(durAt(idx + 1))) {
    void warmFormat(nextId);
  }

  void warmFormats(unique).then(() => {
    if (gen !== prefetchGeneration) return;
    const ordered = [
      ids[idx + 1],
      ids[idx + 2],
      ids[idx + 3],
      ids[idx + 4],
      ids[idx + 5],
      ids[idx + 6],
      ids[idx],
      ids[idx - 1],
    ].filter((id): id is string => Boolean(id) && unique.includes(id));
    // Pas de Range sur le titre courant : concurrence avec <audio> → démarrage lent / coupes
    const headTargets = [...new Set(ordered)].filter((id) => id !== currentId);
    return runPool(headTargets, HEAD_CONCURRENCY, (id) => {
      const n = ids[idx + 1];
      const n2 = ids[idx + 2];
      const n3 = ids[idx + 3];
      const bytes =
        id === n
          ? HEAD_NEXT_BYTES
          : id === n2 || id === n3
            ? Math.floor(HEAD_NEXT_BYTES * 0.55)
            : HEAD_BYTES;
      return warmHead(id, gen, bytes);
    }, gen);
  });

  const fullIds: string[] = [];
  // fullAhead à partir de +1 seulement (pas le courant)
  for (let i = 1; i <= fullAhead; i++) {
    const t = ids[idx + i];
    if (t && shouldFullCache(durAt(idx + i))) fullIds.push(t);
  }
  if (fullIds.length) {
    globalThis.setTimeout(() => {
      if (gen !== prefetchGeneration) return;
      void runPool([...new Set(fullIds)], FULL_CONCURRENCY, (id) => warmFull(id, gen), gen);
    }, delayFullMs);
  }
}

/** True si la piste est déjà en Cache Storage (skip quasi instantané). */
export async function hasFullCache(trackId: string): Promise<boolean> {
  if (!isVideoId(trackId) || typeof caches === 'undefined') return false;
  if (blobUrls.has(trackId)) return true;
  try {
    const cache = await caches.open(FULL_CACHE);
    return Boolean(await cache.match(apiUrl(`/api/stream/${trackId}`)));
  } catch {
    return false;
  }
}

/** URL de lecture : blob cache full > stream (tête déjà chaude côté navigateur/API). */
export async function resolvePrefetchedPlayUrl(trackId: string): Promise<string | null> {
  if (!isVideoId(trackId) || typeof caches === 'undefined') return null;
  try {
    const cached = blobUrls.get(trackId);
    if (cached) return cached;
    const cache = await caches.open(FULL_CACHE);
    const hit = await cache.match(apiUrl(`/api/stream/${trackId}`));
    if (!hit) return null;
    const blob = await hit.blob();
    if (blob.size < 4096) return null;
    const url = URL.createObjectURL(blob);
    const prev = blobUrls.get(trackId);
    if (prev) URL.revokeObjectURL(prev);
    blobUrls.set(trackId, url);
    bumpFull(trackId);
    return url;
  } catch {
    return null;
  }
}

/** True si cette URL blob est encore gérée par le prefetch (ne pas révoquer). */
export function isPrefetchBlobUrl(url: string): boolean {
  if (!url?.startsWith('blob:')) return false;
  for (const v of blobUrls.values()) {
    if (v === url) return true;
  }
  return false;
}

export function prefetchStats() {
  return {
    heads: headCache.size,
    warmed: warmDone.size,
    full: fullOrder.length,
    gen: prefetchGeneration,
  };
}
