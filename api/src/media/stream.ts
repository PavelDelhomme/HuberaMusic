import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, unlinkSync, readFileSync, statSync, renameSync, writeSync, ftruncateSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import {
  getAudioFormat,
  getAudioFormatViaYtDlpOnly,
  getVideoFormat,
  getYT,
  hasCachedAudioFormat,
  peekCachedAudioFormat,
  invalidateAudioFormat,
  invalidateVideoFormat,
} from '../youtube/yt.js';
import {
  ytDlpCookieArgSets,
  ytDlpExtractorArgSets,
  resolveYoutubeCookieHeader,
  YTDLP_AUDIO_FORMAT_CANDIDATES,
  ytDlpRuntimeArgs,
  ytDlpProxyCliArgs,
} from '../youtube/youtubeCookies.js';
import {
  isProxyWorthRetry,
  isUpstream5xx,
  markYoutubeProxyFailure,
  markYoutubeProxySuccess,
  youtubeProxyAttempts,
  youtubeProxyFreeEnabled,
  ensureYoutubeProxyPool,
  fetchUrlViaProxy,
  isHttpProxy,
} from '../youtube/youtubeProxy.js';
import {
  peekStreamHead,
  putStreamHead,
  warmStreamHead,
  warmStreamHeadsLazy,
  invalidateStreamHead,
  getAdvertisedTotal,
  rememberAdvertisedTotal,
  stableContentTotal,
  safeDiskRangeBounds,
} from './streamHeadCache.js';
import { findReplacementId, getReplacementId, looksUnavailable } from './trackReplacement.js';
import { findAtlasEquivalent, rememberAtlasPlayable } from './trackAtlas.js';
import { noteStreamNote, noteStreamSource, watchStreamRequest } from './streamLog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const YTDLP = join(ROOT, 'bin', 'yt-dlp');
const CACHE_DIR = join(ROOT, 'data', 'cache');
const STREAM_UPSTREAM_FILE = join(ROOT, 'data', 'stream-upstream.url');

/** Dernière lecture servie — les travaux de fond s'effacent devant une écoute en cours. */
let lastStreamAtMs = 0;

/** Innertube/format saturé **pour cet id** : skip sans 18 s de BUFFERING.
 *  Jamais un circuit global — un timeout n’empoisonne pas le reste de la biblio. */
const formatCircuitUntilById = new Map<string, number>();

function noteFormatTimeout(videoId: string): void {
  if (!videoId) return;
  formatCircuitUntilById.set(videoId, Date.now() + 45_000);
}

function noteFormatOk(videoId?: string): void {
  if (videoId) formatCircuitUntilById.delete(videoId);
}

function formatCircuitOpen(videoId: string): boolean {
  const until = formatCircuitUntilById.get(videoId) || 0;
  if (!until) return false;
  if (Date.now() >= until) {
    formatCircuitUntilById.delete(videoId);
    return false;
  }
  return true;
}

function sendStreamUnavailable(res: Response, videoId: string, detail: string): boolean {
  if (res.headersSent) return false;
  console.warn(`[stream] 410 skip ${videoId} (${detail.slice(0, 60)})`);
  res.status(410).json({
    error: 'Impossible de streamer audio',
    code: 'VIDEO_UNAVAILABLE',
    detail: detail.slice(0, 240),
    hint: 'Titre indisponible ou trop lent — passage au suivant',
  });
  return true;
}

export function msSinceLastStream(): number {
  return lastStreamAtMs ? Date.now() - lastStreamAtMs : Number.MAX_SAFE_INTEGER;
}

/** Écoute récente : les warm de fond doivent s’effacer (yt-dlp / CPU pour le titre courant). */
export function isPlaybackHot(withinMs = 90_000): boolean {
  return msSinceLastStream() < withinMs;
}

const GV_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const GV_UA_ANDROID =
  'com.google.android.youtube/19.29.37 (Linux; U; Android 14) gzip';
const GV_UA_IOS =
  'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5 like Mac OS X;)';

/** UA aligné sur le client qui a signé l’URL (`c=` dans googlevideo) — sinon 403 fréquents. */
function uaForGooglevideoUrl(url: string): string {
  try {
    const c = new URL(url).searchParams.get('c') || '';
    // ANDROID_VR (Quest) ≠ ANDROID YouTube — UA classique → 403
    if (/ANDROID_VR/i.test(c)) {
      return 'com.google.android.apps.youtube.vr.oculus/1.57.29 (Linux; U; Android 12; vr_oculus) gzip';
    }
    if (/ANDROID/i.test(c)) return GV_UA_ANDROID;
    if (/IOS|TVHTML5|TV/i.test(c)) return GV_UA_IOS;
  } catch {
    /* ignore */
  }
  return GV_USER_AGENT;
}

/** Headers navigateur pour googlevideo — sans Cookie fichier, l’UA client compte beaucoup. */
function googlevideoHeaders(url: string, range?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': uaForGooglevideoUrl(url),
    Accept: '*/*',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    Origin: 'https://www.youtube.com',
    Referer: 'https://www.youtube.com/',
  };
  if (range) headers.Range = range;
  const cookie = resolveYoutubeCookieHeader();
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/** Retry client (header ou query) — bust cache format + rotation proxy. */
export function streamRetryN(req: Request): number {
  const hdr = req.headers['x-stream-retry'];
  if (hdr != null && String(hdr).trim() !== '') {
    const n = Number(String(hdr).trim());
    if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), 99);
  }
  const q = req.query.retry ?? req.query.r;
  if (q != null && String(q).trim() !== '') {
    const n = Number(String(Array.isArray(q) ? q[0] : q).trim());
    if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), 99);
  }
  return 0;
}

async function fetchGooglevideo(
  url: string,
  range?: string,
  opts?: { preferProxies?: boolean; boundProxy?: string | null; userId?: string },
): Promise<globalThis.Response> {
  const headers = googlevideoHeaders(url, range);
  const prefer = opts?.preferProxies !== false && youtubeProxyFreeEnabled();

  const tryOnce = async (proxy: string | null) => {
    if (proxy && !isHttpProxy(proxy)) {
      throw new Error('SOCKS fetch skip');
    }
    const res = await fetchUrlViaProxy(url, proxy, {
      method: 'GET',
      headers,
      timeoutMs: 14_000,
    });
    // Status lu avant tout pipe client = détection 5xx amont.
    if (isUpstream5xx(res.status) || res.status === 0) {
      if (proxy) markYoutubeProxyFailure(proxy, 'gv');
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      throw new Error(`upstream audio ${res.status || 'fail'}`);
    }
    if (res.status === 200 || res.status === 206) {
      const cl = res.headers.get('content-length');
      if (cl === '0') {
        if (proxy) markYoutubeProxyFailure(proxy, 'gv');
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        throw new Error('upstream content-length 0');
      }
      if (proxy) markYoutubeProxySuccess(proxy, 'gv');
    }
    return res;
  };

  // URL yt-dlp liée à l’IP du proxy : fetch via ce proxy, mais si le corps
  // est vide on tourne (sinon « Chargement du flux… » jusqu’à la deadline).
  if (opts?.boundProxy) {
    if (!isHttpProxy(opts.boundProxy)) {
      throw new Error('SOCKS bound — pipe yt-dlp');
    }
    try {
      return await tryOnce(opts.boundProxy);
    } catch {
      /* rotate ci-dessous */
    }
  }

  // Innertube / OAuth : l’URL est signée pour l’IP du VPS. Les proxies publics
  // d’abord = 403 × 10 puis « Chargement du flux… ». Direct d’abord, proxies ensuite.
  if (!opts?.boundProxy) {
    try {
      return await tryOnce(null);
    } catch {
      /* proxies */
    }
  }

  if (!prefer) {
    try {
      return await tryOnce(null);
    } catch {
      await new Promise((r) => setTimeout(r, 220));
      return await tryOnce(null);
    }
  }

  const proxies = await youtubeProxyAttempts({
    max: 8,
    includeDirect: false,
    directLast: true,
    shuffle: true,
    probe: true,
    userId: opts?.userId,
  });
  let lastErr: Error | null = null;
  for (const proxy of proxies) {
    try {
      const res = await tryOnce(proxy);
      if (isUpstream5xx(res.status)) continue;
      return res;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr || new Error('upstream audio 5xx (proxies épuisés)');
}

/**
 * Téléchargement « swarm » : le PC maison offline est **normal**.
 * Le VPS découpe le googlevideo en Ranges et les récupère en parallèle
 * via plusieurs proxies gratuits (chaîne auto, IPs différentes), puis
 * reconstitue le .m4a sur le disque VPS — l’utilisateur lit ensuite le cache.
 */
const SWARM_CHUNK_BYTES = 512 * 1024;
const SWARM_PARALLEL = 4;

async function fetchSwarmChunk(
  url: string,
  start: number,
  end: number,
  opts?: { userId?: string; boundProxy?: string | null },
): Promise<Buffer | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchGooglevideo(url, `bytes=${start}-${end}`, {
        preferProxies: true,
        boundProxy: attempt === 0 ? opts?.boundProxy : undefined,
        userId: opts?.userId,
      });
      if (res.status !== 206 && res.status !== 200) {
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const expect = end - start + 1;
      if (buf.length < Math.min(8, expect)) continue;
      return buf.subarray(0, Math.min(buf.length, expect));
    } catch {
      /* autre IP */
    }
  }
  return null;
}

async function downloadViaProxyChunks(
  url: string,
  out: string,
  opts?: { userId?: string; boundProxy?: string | null },
): Promise<boolean> {
  if (!url || !youtubeProxyFreeEnabled()) return false;
  try {
    const probe = await fetchGooglevideo(url, 'bytes=0-0', {
      preferProxies: true,
      boundProxy: opts?.boundProxy,
      userId: opts?.userId,
    });
    const cr = probe.headers.get('content-range') || '';
    const cl = Number(probe.headers.get('content-length') || 0);
    try {
      await probe.body?.cancel();
    } catch {
      /* ignore */
    }
    const totalMatch = /\/(\d+)\s*$/.exec(cr);
    const total = totalMatch ? Number(totalMatch[1]) : cl;
    if (!Number.isFinite(total) || total < 256_000) return false;

    // Pas de Range (200 plein fichier) : un seul flux, on ne swarm pas.
    if (probe.status === 200 && !totalMatch) return false;

    const parts: Array<{ start: number; end: number }> = [];
    for (let s = 0; s < total; s += SWARM_CHUNK_BYTES) {
      parts.push({ start: s, end: Math.min(total - 1, s + SWARM_CHUNK_BYTES - 1) });
    }
    rememberAdvertisedTotal(
      out.replace(/^.*\//, '').replace(/\.m4a$/, ''),
      total,
    );
    // Fichier = préfixe contigu seulement (pas de ftruncate plein de zéros).
    // Exo lit le .m4a qui grossit pendant que les chunks suivants arrivent.
    const pending = new Map<number, Buffer>();
    let contiguous = 0;
    const fd = openSync(out, 'w');
    const flush = (start: number, buf: Buffer) => {
      pending.set(start, buf);
      while (pending.has(contiguous)) {
        const b = pending.get(contiguous)!;
        pending.delete(contiguous);
        writeSync(fd, b, 0, b.length, contiguous);
        contiguous += b.length;
        try {
          ftruncateSync(fd, contiguous);
        } catch {
          /* ignore */
        }
      }
    };
    try {
      const first = parts[0];
      if (first) {
        const head = await fetchSwarmChunk(url, first.start, first.end, opts);
        if (!head) throw new Error('swarm tête 0 KO');
        flush(first.start, head);
      }
      const rest = parts.slice(1);
      let failed = 0;
      const queue = [...rest];
      const worker = async () => {
        while (queue.length) {
          const p = queue.shift();
          if (!p) return;
          const buf = await fetchSwarmChunk(url, p.start, p.end, opts);
          if (!buf) {
            failed += 1;
            continue;
          }
          flush(p.start, buf);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(SWARM_PARALLEL, Math.max(1, rest.length)) }, () => worker()),
      );
      if (failed > 0 || contiguous < total * 0.92) {
        throw new Error(`swarm incomplet ${contiguous}/${total} failed=${failed}`);
      }
    } finally {
      closeSync(fd);
    }
    console.log(
      `[stream] swarm OK ${out.split('/').pop()} bytes=${contiguous} parts=${parts.length} (maison offline = normal)`,
    );
    return existsSync(out) && statSync(out).size >= Math.min(total, 256_000);
  } catch (err) {
    console.warn(
      '[stream] swarm KO — fallback yt-dlp/proxies:',
      String((err as Error).message || err).slice(0, 140),
    );
    return false;
  }
}

function ensureCache() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

export function cachePath(videoId: string) {
  ensureCache();
  return join(CACHE_DIR, `${videoId}.m4a`);
}

/** ftyp brand « dash » = segments adaptatifs — Exo / offline mobile les refuse. */
function isDashBrandFile(path: string): boolean {
  try {
    if (!existsSync(path) || statSync(path).size < 16) return false;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(64);
      const n = readSync(fd, buf, 0, 64, 0);
      return isDashBrandBuffer(buf.subarray(0, n));
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function isDashBrandFilePath(path: string): boolean {
  return isDashBrandFile(path);
}

/** Détecte ftyp=dash dans les premiers octets (relais googlevideo / tête RAM). */
function isDashBrandBuffer(buf: Buffer): boolean {
  if (!buf?.byteLength || buf.byteLength < 12) return false;
  const idx = buf.indexOf(Buffer.from('ftyp'));
  if (idx < 0 || idx + 8 > buf.length) return false;
  const brand = buf.subarray(idx + 4, idx + 8).toString('ascii').toLowerCase();
  return brand === 'dash';
}

function isAndroidClient(req: Request): boolean {
  return (
    String(req.headers['x-ytm-client'] || '') === 'android' ||
    /PLM-Android/i.test(String(req.headers['user-agent'] || '')) ||
    String(req.query?.client || '') === 'android'
  );
}

/**
 * .m4a utilisable bout-en-bout (pas une tête tronquée).
 * Seuil bas : une vraie piste AAC 128k ≈ 1 Mo/min — < 512 KiB = quasi sûr partiel.
 */
const MIN_COMPLETE_DISK_BYTES = 512 * 1024;

function isGrowingDiskServable(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    if (isDashBrandFile(path)) return false;
    return statSync(path).size >= 256 * 1024;
  } catch {
    return false;
  }
}

async function waitUntilDiskServable(videoId: string, ms: number): Promise<string | null> {
  const t0 = Date.now();
  const p = cachePath(videoId);
  while (Date.now() - t0 < ms) {
    try {
      if (isCompleteEnoughDisk(p) || isGrowingDiskServable(p)) return p;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  try {
    if (isCompleteEnoughDisk(p) || isGrowingDiskServable(p)) return p;
  } catch {
    /* none */
  }
  return null;
}

async function pipeDiskFile(
  req: Request,
  res: Response,
  file: string,
  videoId: string,
  cacheTag: string,
): Promise<boolean> {
  if (res.headersSent) return false;
  const size = statSync(file).size;
  rememberAdvertisedTotal(videoId, size);
  const { createReadStream } = await import('node:fs');
  const range = req.headers.range ? String(req.headers.range) : '';
  if (range) {
    const bounds = safeDiskRangeBounds(size, range);
    if (bounds.ok) {
      const len = bounds.end - bounds.start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${bounds.start}-${bounds.end}/${size}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', len);
      res.setHeader('Content-Type', 'audio/mp4');
      res.setHeader('X-PLM-Stream-Cache', cacheTag);
      noteStreamSource(res, cacheTag);
      createReadStream(file, { start: bounds.start, end: bounds.end }).pipe(res);
      return true;
    }
  }
  res.status(200);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', size);
  res.setHeader('Content-Type', 'audio/mp4');
  res.setHeader('X-PLM-Stream-Cache', cacheTag);
  noteStreamSource(res, cacheTag);
  createReadStream(file).pipe(res);
  return true;
}

function isCompleteEnoughDisk(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const size = statSync(path).size;
    if (size < MIN_COMPLETE_DISK_BYTES) return false;
    if (isDashBrandFile(path)) return false;
    const id = path.split('/').pop()?.replace(/\.m4a$/, '');
    const advertised = id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? getAdvertisedTotal(id) : null;
    if (advertised && advertised > MIN_COMPLETE_DISK_BYTES && size < advertised * 0.85) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isCompleteEnoughDiskFile(path: string): boolean {
  return isCompleteEnoughDisk(path);
}

function purgeTinyOrDashCache(videoId: string): void {
  const p = cachePath(videoId);
  try {
    if (!existsSync(p)) return;
    const size = statSync(p).size;
    if (size > 0 && size < MIN_COMPLETE_DISK_BYTES) {
      unlinkSync(p);
      console.warn(`[stream] purge tiny cache ${videoId} size=${size}`);
      return;
    }
  } catch {
    /* ignore */
  }
  purgeDashCache(videoId);
}

/** Supprime un .m4a DASH du cache disque pour forcer un re-download progressif. */
function purgeDashCache(videoId: string): boolean {
  const p = cachePath(videoId);
  if (!isDashBrandFile(p)) return false;
  try {
    unlinkSync(p);
    console.warn(`[stream] purge DASH cache ${videoId}`);
    return true;
  } catch {
    return false;
  }
}

/** Base URL de l’API maison (env ou fichier volume).
 *  Prod : **désactivé** sauf `ALLOW_STREAM_UPSTREAM=1` (opt-in explicite).
 *  Le fichier `stream-upstream.url` seul ne suffit plus — éviter de dépendre du PC allumé.
 *  Préférer OAuth TV VPS + proxies HTTP gratuits (`YOUTUBE_HTTP_PROXY_FREE`) contre les 50x.
 */
export function resolveStreamUpstream(): string | null {
  if (!isStreamUpstreamAllowed()) return null;

  const env = (process.env.STREAM_UPSTREAM || '').trim().replace(/\/$/, '');
  if (env) return env;
  try {
    if (existsSync(STREAM_UPSTREAM_FILE)) {
      const v = readFileSync(STREAM_UPSTREAM_FILE, 'utf8').trim().replace(/\/$/, '');
      if (v.startsWith('http://') || v.startsWith('https://')) return v;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Relais maison (IP résidentielle) :
 * - `ALLOW_STREAM_UPSTREAM=1` (Portainer), ou
 * - fichier `data/stream-upstream.url` posé par `link-home-stream.sh`.
 * Sans l’un des deux, le VPS reste autonome (OAuth TV) — OK audio, souvent KO vidéo progressive.
 */
export function isStreamUpstreamAllowed(): boolean {
  if (
    process.env.ALLOW_STREAM_UPSTREAM === '1' ||
    process.env.ALLOW_STREAM_UPSTREAM === 'true'
  ) {
    return true;
  }
  try {
    if (existsSync(STREAM_UPSTREAM_FILE)) {
      const v = readFileSync(STREAM_UPSTREAM_FILE, 'utf8').trim();
      if (v.startsWith('http://') || v.startsWith('https://')) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Relais stream vers l’API maison (évite le blocage IP datacenter YouTube). */
let homeAliveCache: { at: number; ok: boolean; base: string } | null = null;
/** Timeouts / abort d’un seul titre ≠ PC éteint — streak avant poison court. */
let homeSoftFailStreak = 0;
let homeSoftFailAt = 0;

function markHomeAlive(homeBase: string) {
  homeAliveCache = {
    at: Date.now(),
    ok: true,
    base: homeBase.replace(/\/$/, ''),
  };
  homeAliveTtlMs = 45_000;
  homeSoftFailStreak = 0;
}

function markHomeDead(homeBase: string, ttlMs = 45_000) {
  homeAliveCache = {
    at: Date.now(),
    ok: false,
    base: homeBase.replace(/\/$/, ''),
  };
  homeAliveTtlMs = Math.max(8_000, ttlMs);
}

let homeAliveTtlMs = 45_000;
let homeOfflineLoggedAt = 0;

/**
 * Sonde rapide : si le PC maison est éteint, on skip le relais immédiatement
 * (sinon 20–52 s de BUFFERING avant les backends VPS/proxies).
 */
async function isHomeUpstreamReachable(homeBase: string): Promise<boolean> {
  const base = homeBase.replace(/\/$/, '');
  if (
    homeAliveCache &&
    homeAliveCache.base === base &&
    Date.now() - homeAliveCache.at < homeAliveTtlMs
  ) {
    return homeAliveCache.ok;
  }
  try {
    const r = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(1_400),
      headers: { Accept: 'application/json' },
    });
    const ok = r.ok;
    if (ok) {
      markHomeAlive(base);
    } else {
      // Health 5xx ponctuel ≠ PC éteint — re-sonde vite (8 s).
      markHomeDead(base, 8_000);
    }
    return ok;
  } catch {
    markHomeDead(base, 8_000);
    return false;
  }
}

async function proxyStreamToHome(
  req: Request,
  res: Response,
  homeBase: string,
  videoId: string,
  timeoutMs = 52_000,
  firstByteTimeoutMs = 20_000,
) {
  const wantVideo = String(req.query.type || req.query.media || '') === 'video';
  const q = wantVideo ? '?type=video' : '';
  const url = `${homeBase}/api/stream/${videoId}${q}`;
  const headers: Record<string, string> = {
    'X-YTM-Stream-Relay': '1',
  };
  if (req.headers.range) headers.Range = String(req.headers.range);
  const auth = req.headers.authorization;
  if (auth) headers.Authorization = String(auth);
  // CRITIQUE : ne PAS AbortSignal.timeout() sur tout le fetch.
  // Open-ended Android pipe pendant des minutes — un timeout global 45 s coupait
  // le flux mid-titre → stalls Exo + poison « maison offline » + avalanche mails.
  // Abort uniquement jusqu’au 1er octet (headers + first chunk).
  // 50 s : sous charge (Nothing + warm + prefetch) le PC maison peut
  // mettre 20–40 s avant le 1er octet — 28 s abortait trop tôt → file KO.
  const ac = new AbortController();
  const openMs = Math.max(firstByteTimeoutMs + 5_000, Math.min(timeoutMs, 50_000));
  const openTimer = setTimeout(() => ac.abort(), openMs);
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers,
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(openTimer);
    throw err;
  }
  if (upstream.status >= 400) {
    clearTimeout(openTimer);
    const detail = await upstream.text().catch(() => '');
    throw new Error(`home stream ${upstream.status}: ${detail.slice(0, 180)}`);
  }
  if (!upstream.body) {
    clearTimeout(openTimer);
    throw new Error('home stream sans corps');
  }
  const reader = upstream.body.getReader();
  let first: ReadableStreamReadResult<Uint8Array>;
  try {
    first = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, rej) =>
        setTimeout(
          () => rej(new Error(`home first-byte timeout ${firstByteTimeoutMs}ms`)),
          Math.max(800, firstByteTimeoutMs),
        ),
      ),
    ]);
  } catch (err) {
    clearTimeout(openTimer);
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
    throw err;
  }
  clearTimeout(openTimer);
  if (first.done || !first.value?.byteLength) throw new Error('home stream vide');
  const firstHome = Buffer.from(first.value);
  if (!wantVideo && isDashBrandBuffer(firstHome)) {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    throw new Error('home stream DASH (ftypdash)');
  }

  // Maison vivante : 1er octet OK — ne plus rester « offline » après un timeout voisin.
  markHomeAlive(homeBase);

  res.status(upstream.status);
  const ct = upstream.headers.get('content-type');
  if (ct) res.setHeader('Content-Type', ct);
  else res.setHeader('Content-Type', wantVideo ? 'video/mp4' : 'audio/mp4');
  const cr = upstream.headers.get('content-range');
  let outCr = cr;
  if (cr) {
    const tm = /\/(\d+)\s*$/.exec(cr);
    if (tm) {
      const upstreamTotal = Number(tm[1]);
      rememberAdvertisedTotal(videoId, upstreamTotal);
      const stable = stableContentTotal(videoId, upstreamTotal);
      if (stable !== upstreamTotal) {
        outCr = cr.replace(/\/\d+\s*$/, `/${stable}`);
      }
    }
  }
  if (outCr) res.setHeader('Content-Range', outCr);
  const cl = upstream.headers.get('content-length');
  if (cl) res.setHeader('Content-Length', cl);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.setHeader('X-YTM-Stream-Via', 'home');

  if (!res.write(firstHome)) {
    await new Promise((r) => res.once('drain', r));
  }
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      if (!res.write(Buffer.from(value))) {
        await new Promise((r) => res.once('drain', r));
      }
    }
  }
  res.end();
}

/** Si des headers sont déjà partis, ne jamais retenter un autre backend (crash Node). */
function endIfHeadersSent(res: Response): boolean {
  if (!res.headersSent) return false;
  try {
    if (!res.writableEnded) res.end();
  } catch {
    /* ignore */
  }
  return true;
}

async function streamViaInnertube(videoId: string, res: Response) {
  if (res.headersSent) throw new Error('headers already sent');

  const innertube = await getYT();
  let lastErr: unknown;
  let stream: ReadableStream<Uint8Array> | null = null;
  for (const client of ['ANDROID_VR', 'TV', 'IOS', 'WEB_EMBEDDED'] as const) {
    try {
      stream = await innertube.download(videoId, {
        type: 'audio',
        quality: 'best',
        format: 'any',
        client,
      } as any);
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!stream) {
    throw lastErr instanceof Error ? lastErr : new Error('Innertube download login/unavailable');
  }

  const reader = stream.getReader();
  const first = await reader.read();
  if (first.done || !first.value?.byteLength) {
    throw new Error('Innertube stream vide');
  }
  const firstBuf = Buffer.from(first.value);
  if (isDashBrandBuffer(firstBuf)) {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
    throw new Error('Innertube audio DASH (ftypdash)');
  }

  if (res.headersSent) throw new Error('headers already sent');
  res.status(200);
  res.setHeader('Content-Type', 'audio/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=3600');

  try {
    if (!res.write(firstBuf)) {
      await new Promise((r) => res.once('drain', r));
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        if (!res.write(Buffer.from(value))) {
          await new Promise((r) => res.once('drain', r));
        }
      }
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: String(err) });
    else {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }
}

function spawnYtDlpAudioPipe(
  videoId: string,
  format: string,
  cookieArgs: string[],
  res: Response,
  proxy: string | null = null,
  extractorArgs: string[] = [],
): Promise<void> {
  return spawnYtDlpMediaPipe(videoId, format, cookieArgs, res, 'audio/mp4', proxy, extractorArgs);
}

async function spawnYtDlpMediaPipe(
  videoId: string,
  format: string,
  cookieArgs: string[],
  res: Response,
  contentType: string,
  proxy: string | null = null,
  extractorArgs: string[] = [],
): Promise<void> {
  const { withYtDlpSlot } = await import('./ytDlpGate.js');
  // Proxy / IP alternate : on tente même si le direct VPS est en cooldown bot
  return withYtDlpSlot(
    () =>
      new Promise<void>((resolve, reject) => {
        if (!existsSync(YTDLP)) {
          reject(new Error('yt-dlp introuvable'));
          return;
        }
        if (res.headersSent) {
          reject(new Error('headers already sent'));
          return;
        }

        const proc = spawn(
          YTDLP,
          [
            '-f',
            format,
            '-o',
            '-',
            '--no-playlist',
            '--quiet',
            '--no-warnings',
            ...ytDlpRuntimeArgs(),
            ...extractorArgs,
            '--user-agent',
            GV_USER_AGENT,
            '--referer',
            'https://www.youtube.com/',
            ...cookieArgs,
            ...ytDlpProxyCliArgs(proxy),
            `https://www.youtube.com/watch?v=${videoId}`,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );

        let started = false;
        let settled = false;
        const fail = (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(firstByteTimer);
          try {
            proc.kill('SIGTERM');
          } catch {
            /* ignore */
          }
          reject(err);
        };

        // Sans 1er octet rapidement → passe au format / backend suivant (évite buffering mobile)
        const firstByteTimer = setTimeout(() => {
          fail(new Error('yt-dlp first-byte timeout'));
        }, 12_000);

        proc.stdout.once('data', (chunk: Buffer) => {
          if (settled) return;
          clearTimeout(firstByteTimer);
          try {
            if (res.headersSent) {
              fail(new Error('headers already sent'));
              return;
            }
            started = true;
            res.status(200);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Transfer-Encoding', 'chunked');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.write(chunk);
            proc.stdout.pipe(res);
          } catch (err) {
            fail(err instanceof Error ? err : new Error(String(err)));
          }
        });

        let errBuf = '';
        proc.stderr.on('data', (d: Buffer) => {
          errBuf += d.toString('utf8');
        });
        proc.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
        proc.on('close', (code) => {
          if (settled) return;
          if (started && code === 0) {
            settled = true;
            resolve();
            return;
          }
          fail(
            new Error(
              `yt-dlp exit ${code}${errBuf.trim() ? `: ${errBuf.trim().slice(0, 240)}` : ''}`,
            ),
          );
        });
        res.on('close', () => {
          try {
            proc.kill('SIGTERM');
          } catch {
            /* ignore */
          }
        });
      }),
    { bypassCooldown: true, noteFailure: false, live: true },
  );
}

async function streamViaYtDlp(videoId: string, res: Response, preferProxies = false) {
  const { noteYtDlpFailure, isYtDlpCoolingDown } = await import('./ytDlpGate.js');
  // Anonyme d’abord — cookies optionnels (jamais Premium requis)
  const cookieSets = ytDlpCookieArgSets();
  const extractorSets = ytDlpExtractorArgSets();
  // Peu de formats : chaque spawn peut coûter ~10 s (first-byte timeout)
  const formats = YTDLP_AUDIO_FORMAT_CANDIDATES.slice(0, preferProxies ? 2 : 3);
  // Maison offline → proxies d’abord (IP VPS souvent bot-bloquée)
  const proxies = await youtubeProxyAttempts({
    max: preferProxies ? 12 : 5,
    includeDirect: true,
    directLast: preferProxies,
    shuffle: preferProxies,
    probe: preferProxies,
  });

  let lastErr: Error | null = null;
  let sawBot = false;
  let proxyHardFails = 0;
  for (const proxy of proxies) {
    // Pendant cooldown : saute l’IP VPS directe, tente les proxies / autres IP
    if (!proxy && isYtDlpCoolingDown()) continue;
    for (const extractorArgs of extractorSets) {
      for (const cookieArgs of cookieSets) {
        for (const format of formats) {
          if (res.headersSent) throw new Error('headers already sent');
          try {
            await spawnYtDlpAudioPipe(videoId, format, cookieArgs, res, proxy, extractorArgs);
            markYoutubeProxySuccess(proxy);
            return;
          } catch (err) {
            lastErr = err instanceof Error ? err : new Error(String(err));
            if (/Sign in to confirm|not a bot|rate-limited|LOGIN_REQUIRED/i.test(lastErr.message)) {
              sawBot = true;
            }
            if (res.headersSent) throw lastErr;
            if (proxy && isProxyWorthRetry(err)) markYoutubeProxyFailure(proxy);
          }
        }
      }
    }
    if (proxy && lastErr) {
      proxyHardFails += 1;
      console.warn(
        `[stream] yt-dlp via ${proxy.slice(0, 40)} KO → suivant:`,
        lastErr.message.slice(0, 100),
      );
      // Trop de proxies morts d’affilée → recharge pool et continue (continuité)
      if (proxyHardFails >= 3 && proxyHardFails % 3 === 0) {
        const { ensureYoutubeProxyPool } = await import('../youtube/youtubeProxy.js');
        await ensureYoutubeProxyPool(true);
      }
    }
  }
  if (sawBot && lastErr) noteYtDlpFailure(lastErr);
  throw lastErr || new Error('yt-dlp audio indisponible');
}

/** Pipe progressif vidéo (fallback quand googlevideo 403 depuis le VPS). */
async function streamViaYtDlpVideo(videoId: string, res: Response, preferProxies = false) {
  const { noteYtDlpFailure, isYtDlpCoolingDown } = await import('./ytDlpGate.js');
  const cookieSets = ytDlpCookieArgSets();
  const extractorSets = ytDlpExtractorArgSets();
  const formats = [
    '18',
    '22',
    'best[height<=480][acodec!=none][vcodec!=none]',
    'best[height<=720][acodec!=none][vcodec!=none]/best',
  ];
  const proxies = await youtubeProxyAttempts({
    max: preferProxies ? 8 : 4,
    includeDirect: true,
    directLast: preferProxies,
    shuffle: preferProxies,
    probe: preferProxies,
  });
  let lastErr: Error | null = null;
  let sawBot = false;
  for (const proxy of proxies) {
    if (!proxy && isYtDlpCoolingDown()) continue;
    for (const extractorArgs of extractorSets) {
      for (const cookieArgs of cookieSets) {
        for (const format of formats) {
          if (res.headersSent) throw new Error('headers already sent');
          try {
            await spawnYtDlpMediaPipe(
              videoId,
              format,
              cookieArgs,
              res,
              'video/mp4',
              proxy,
              extractorArgs,
            );
            markYoutubeProxySuccess(proxy);
            return;
          } catch (err) {
            lastErr = err instanceof Error ? err : new Error(String(err));
            if (/Sign in to confirm|not a bot|rate-limited|LOGIN_REQUIRED/i.test(lastErr.message)) {
              sawBot = true;
            }
            if (res.headersSent) throw lastErr;
            if (proxy && isProxyWorthRetry(err)) markYoutubeProxyFailure(proxy);
          }
        }
      }
    }
  }
  if (sawBot && lastErr) noteYtDlpFailure(lastErr);
  throw lastErr || new Error('yt-dlp video indisponible');
}

/** Sert une Range entièrement couverte par la tête RAM (TTFB ≪ 50–100 ms). */
function tryServeRamHead(req: Request, res: Response, videoId: string): boolean {
  const head = peekStreamHead(videoId);
  if (!head) return false;
  // Tête DASH empoisonne Exo (stall mid-range) — jeter et retomber sur progressif.
  if (isDashBrandBuffer(head.buf)) {
    invalidateStreamHead(videoId);
    return false;
  }
  const rangeHdr = req.headers.range ? String(req.headers.range) : '';
  if (!rangeHdr) return false;
  const m = /bytes=(\d+)-(\d*)/.exec(rangeHdr);
  if (!m) return false;
  const start = Number(m[1]);
  const hasEnd = Boolean(m[2]);
  const endReq = hasEnd ? Number(m[2]) : head.buf.length - 1;
  if (!Number.isFinite(start) || start < 0 || start >= head.buf.length) return false;
  // Demande au-delà de la tête avec borne explicite → upstream (Range complète).
  if (hasEnd && endReq >= head.buf.length) return false;
  const end = Math.min(endReq, head.buf.length - 1);
  if (head.totalSize != null) rememberAdvertisedTotal(videoId, head.totalSize);
  const totalNum =
    head.totalSize != null
      ? stableContentTotal(videoId, head.totalSize)
      : null;
  const total = totalNum != null ? String(totalNum) : '*';
  const slice = head.buf.subarray(start, end + 1);
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', slice.length);
  res.setHeader('Content-Type', head.contentType || 'audio/mp4');
  res.setHeader('Cache-Control', 'private, max-age=120');
  res.setHeader('X-PLM-Stream-Cache', 'ram');
  noteStreamSource(res, 'cache mémoire');
  res.end(slice);
  return true;
}

/** URL de stream pour un autre videoId, en conservant les paramètres d'origine. */
function streamPathFor(req: Request, videoId: string): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) {
    if (typeof v === 'string') qs.set(k, v);
  }
  const suffix = qs.toString();
  return `/api/stream/${videoId}${suffix ? `?${suffix}` : ''}`;
}

export async function handleStream(req: Request, res: Response) {
  const videoId = String(req.params.id || '');
  lastStreamAtMs = Date.now();
  // Libère yt-dlp : le warm de fond ne doit pas timeout l’écoute Nothing.
  suspendBackgroundDiskWarm(videoId);
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    res.status(400).json({ error: 'ID invalide' });
    return;
  }
  watchStreamRequest(req, res, videoId);

  // Cache disque AVANT remplacement : un .m4a local prime sur un mapping
  // (sinon 1-M4Jr → r5MR7 → medley mort, alors que le fichier est déjà là).
  {
    const wantVideoEarly = String(req.query.type || req.query.media || '') === 'video';
    if (!wantVideoEarly) {
      const cachedEarly = cachePath(videoId);
      if (
        (isCompleteEnoughDisk(cachedEarly) || isGrowingDiskServable(cachedEarly)) &&
        !isDashBrandFile(cachedEarly)
      ) {
        // Servir IMMÉDIATEMENT (surtout relais maison) — avant bumpWarm / ensure /
        // open-ended wait qui bloquent l’event loop et font abort le VPS à 2 s.
        try {
          const size = statSync(cachedEarly).size;
          rememberAdvertisedTotal(videoId, size);
          import('../library/sharedCatalog.js')
            .then((m) => m.rememberReadyAudio(videoId, size))
            .catch(() => {});
          const range = req.headers.range ? String(req.headers.range) : '';
          const { createReadStream } = await import('node:fs');
          if (range) {
            const bounds = safeDiskRangeBounds(size, range);
            if (bounds.ok) {
              const len = bounds.end - bounds.start + 1;
              res.status(206);
              res.setHeader(
                'Content-Range',
                `bytes ${bounds.start}-${bounds.end}/${size}`,
              );
              res.setHeader('Accept-Ranges', 'bytes');
              res.setHeader('Content-Length', len);
              res.setHeader('Content-Type', 'audio/mp4');
              res.setHeader('X-PLM-Stream-Cache', isCompleteEnoughDisk(cachedEarly) ? 'disk-early' : 'disk-growing');
              noteStreamSource(res, isCompleteEnoughDisk(cachedEarly) ? 'cache disque (early)' : 'disque qui grossit');
              createReadStream(cachedEarly, {
                start: bounds.start,
                end: bounds.end,
              }).pipe(res);
              return;
            }
          } else {
            res.status(200);
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Length', size);
            res.setHeader('Content-Type', 'audio/mp4');
            res.setHeader('X-PLM-Stream-Cache', isCompleteEnoughDisk(cachedEarly) ? 'disk-early' : 'disk-growing');
            noteStreamSource(res, isCompleteEnoughDisk(cachedEarly) ? 'cache disque (early)' : 'disque qui grossit');
            createReadStream(cachedEarly).pipe(res);
            return;
          }
        } catch (e) {
          console.warn(
            '[stream] early disk serve KO:',
            String((e as Error).message || e).slice(0, 120),
          );
        }
      }
      // Cartographie : un autre id du même morceau est déjà sur disque → 302
      // immédiat, même si YouTube est saturé (le circuit 410 ne doit pas gagner).
      const mapped =
        getReplacementId(videoId) || findAtlasEquivalent(videoId);
      if (mapped && mapped !== videoId) {
        const mappedPath = cachePath(mapped);
        if (
          (isCompleteEnoughDisk(mappedPath) || isGrowingDiskServable(mappedPath)) &&
          !isDashBrandFile(mappedPath)
        ) {
          try {
            const size = statSync(mappedPath).size;
            rememberAdvertisedTotal(mapped, size);
            const { createReadStream } = await import('node:fs');
            res.status(200);
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Length', size);
            res.setHeader('Content-Type', 'audio/mp4');
            res.setHeader('X-PLM-Stream-Cache', 'atlas-disk');
            res.setHeader('X-PLM-Replaced-From', videoId);
            noteStreamSource(res, 'atlas disque');
            createReadStream(mappedPath).pipe(res);
            return;
          } catch {
            /* 302 ci-dessous */
          }
        }
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-PLM-Replaced-From', videoId);
        res.redirect(302, streamPathFor(req, mapped));
        return;
      }
      if (
        formatCircuitOpen(videoId) &&
        !isCompleteEnoughDisk(cachedEarly) &&
        !isGrowingDiskServable(cachedEarly) &&
        String(req.query.warm || '') !== '1'
      ) {
        sendStreamUnavailable(res, videoId, 'format circuit');
        return;
      }
    }
  }
  // Lecture réelle : cet id passe devant le batch warm (évite 22 s derrière +2/+3).
  bumpWarmPriority(videoId);

  const wantOfflineEarly =
    String(req.query.offline || '') === '1' ||
    String(req.headers['x-ytm-offline'] || '') === '1';
  const isHomeRelay =
    String(req.headers['x-ytm-stream-relay'] || '') === '1';

  // Pré-validation Android : ne PAS 410 sur timeout Innertube/proxy.
  // Un 1,5 s trop court faisait skipper des titres jouables + circuit 45 s
  // (prefetch +1 empoisonné aussi). 410 uniquement si YouTube dit mort.
  // Relais maison / offline : skip ce gate.
  {
    const wantVideoEarly = String(req.query.type || req.query.media || '') === 'video';
    const isWarmPrefetch =
      String(req.query.warm || '') === '1' ||
      String(req.headers['x-ytm-warm'] || '') === '1';
    if (!wantVideoEarly && !wantOfflineEarly && !isHomeRelay && isAndroidClient(req)) {
      const cached = cachePath(videoId);
      if (!isCompleteEnoughDisk(cached) && !isGrowingDiskServable(cached)) {
        downloadTrack(videoId, {
          progressiveOnly: true,
          preferProxies: true,
          userId: (req as any).userId,
        }).catch(() => {});
        enqueueNextDiskWarm([videoId]);

        let formatOk = false;
        try {
          const peeked = peekCachedAudioFormat(videoId, (req as any).userId);
          if (peeked?.url) {
            formatOk = true;
            noteFormatOk(videoId);
          }
        } catch {
          /* peek only */
        }
        if (!formatOk) {
          console.warn(
            `[stream] Android cold ${videoId} — kick swarm/proxy (pas de 410 probe)`,
          );
        }
        if (formatOk) {
          try {
            const { ensurePlayableOnDisk } = await import('./ensurePlayable.js');
            await ensurePlayableOnDisk(videoId, {
              userId: (req as any).userId,
              waitMs: 2_500,
              preferProxies: true,
              allowReplace: false,
            });
          } catch {
            /* pipeline */
          }
        }
      }
    }
  }

  // Maison offline / VPS sans relais → proxies gratuits avant IP datacenter.
  // Toujours préférer proxies si pool free ON (VPS DC bot-bloqué) — indépendant du tunnel maison.
  const homeUpstream = resolveStreamUpstream();
  const preferProxies =
    youtubeProxyFreeEnabled() ||
    Boolean((process.env.YOUTUBE_HTTP_PROXY || '').trim()) ||
    (homeUpstream ? !(await isHomeUpstreamReachable(homeUpstream)) : false);
  const streamUserId = (req as any).userId as string | undefined;

  const wantVideo = String(req.query.type || req.query.media || '') === 'video';
  const wantOffline =
    String(req.query.offline || '') === '1' ||
    String(req.headers['x-ytm-offline'] || '') === '1';
  const retryN = streamRetryN(req);
  if (retryN > 0 && !wantVideo) {
    invalidateAudioFormat(videoId);
    invalidateStreamHead(videoId);
  }
  // Téléchargement hors-ligne explicite : attendre le .m4a progressif disque (yt-dlp 140)
  // plutôt que le flux DASH Innertube (ftyp=dash) que le mobile refuse.
  if (wantOffline && !wantVideo) {
    purgeDashCache(videoId);
    const cached = cachePath(videoId);
    const rangeHdrEarly = req.headers.range ? String(req.headers.range) : '';
    // Probe client Range 0-0 : ne pas bloquer 75 s — le DL démarre en fond, 503 rapide.
    if (/^bytes=0-0$/i.test(rangeHdrEarly.trim())) {
      if (existsSync(cached) && isCompleteEnoughDisk(cached) && !isDashBrandFile(cached)) {
        const size = statSync(cached).size;
        res.status(206);
        res.setHeader('Content-Range', `bytes 0-0/${size}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', '1');
        res.setHeader('Content-Type', 'audio/mp4');
        res.setHeader('X-PLM-Stream-Cache', 'disk-offline-probe');
        const { createReadStream } = await import('node:fs');
        createReadStream(cached, { start: 0, end: 0 }).pipe(res);
        return;
      }
      downloadTrack(videoId, { progressiveOnly: true, preferProxies, userId: streamUserId }).catch(() => {});
      if (!res.headersSent) {
        res.status(503);
        res.setHeader('Retry-After', '2');
        res.setHeader('Cache-Control', 'no-store');
        res.json({
          error: 'Offline file preparing',
          code: 'OFFLINE_PREPARING',
          hint: 'Réessayer dans 2 s — remux en cours',
        });
      }
      return;
    }
    const waitMs = 75_000;
    try {
      await Promise.race([
        downloadTrack(videoId, { progressiveOnly: true, preferProxies, userId: streamUserId }).then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), waitMs)),
      ]);
    } catch {
      /* fallback pipeline ci-dessous */
    }
    try {
      if (existsSync(cached) && statSync(cached).size > 256 * 1024 && !isDashBrandFile(cached)) {
        const size = statSync(cached).size;
        const rangeHdr = req.headers.range ? String(req.headers.range) : '';
        if (rangeHdr) {
          const m = /bytes=(\d+)-(\d*)/.exec(rangeHdr);
          if (m) {
            const start = Number(m[1]);
            const end = m[2] ? Number(m[2]) : size - 1;
            if (Number.isFinite(start) && start >= 0 && start < size) {
              const end2 = Math.min(end, size - 1);
              const { createReadStream } = await import('node:fs');
              res.status(206);
              res.setHeader('Content-Range', `bytes ${start}-${end2}/${size}`);
              res.setHeader('Accept-Ranges', 'bytes');
              res.setHeader('Content-Length', end2 - start + 1);
              res.setHeader('Content-Type', 'audio/mp4');
              res.setHeader('Cache-Control', 'private, max-age=3600');
              res.setHeader('X-PLM-Stream-Cache', 'disk-offline');
              noteStreamSource(res, 'disque offline');
              createReadStream(cached, { start, end: end2 }).pipe(res);
              return;
            }
          }
        }
        const { createReadStream } = await import('node:fs');
        res.status(200);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', size);
        res.setHeader('Content-Type', 'audio/mp4');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.setHeader('X-PLM-Stream-Cache', 'disk-offline');
        noteStreamSource(res, 'disque offline');
        createReadStream(cached).pipe(res);
        return;
      }
    } catch (e) {
      console.warn('[stream] offline disk serve KO:', String((e as Error)?.message || e).slice(0, 120));
    }
    // Pas encore de disque : force yt-dlp URL (140) plutôt qu’Innertube DASH.
    invalidateAudioFormat(videoId);
  }
  // ExoPlayer / Media3 ouvre souvent SANS Range ou avec `bytes=0-` (illimité).
  // NE JAMAIS tronquer à 1 MiB pour Android : une coupure mid-mdat → EOFException
  // fatale (~64 s) + SimpleCache empoisonné (buf figé ~64500), même après invalidation.
  // Android : attendre le .m4a disque (jusqu’à 45 s) puis servir entier ; sinon laisser
  // le pipeline normal (relais / GV) sans borne artificielle.
  // Autres clients : tête 1 MiB seulement si disque absent (TTFB web).
  let skipHomeForOpenAndroid = false;
  if (!wantVideo) {
    const rangeRaw = String(req.headers.range || '').trim();
    const openEnded = !rangeRaw || /^bytes=0-$/i.test(rangeRaw);
    if (openEnded) {
      const cached = cachePath(videoId);
      let diskBytes = 0;
      const refreshDisk = () => {
        try {
          if (existsSync(cached)) diskBytes = statSync(cached).size;
        } catch {
          diskBytes = 0;
        }
      };
      refreshDisk();
      const isAndroid =
        String(req.headers['x-ytm-client'] || '') === 'android' ||
        /PLM-Android/i.test(String(req.headers['user-agent'] || '')) ||
        String(req.query?.client || '') === 'android';
      if (diskBytes <= 256 * 1024) {
        // Android : attente courte seulement — 45 s bloquait derrière nginx → 504 Exo.
        const formatHot = hasCachedAudioFormat(videoId, (req as any).userId);
        const head = peekStreamHead(videoId);
        let ramHot = false;
        if (head) {
          if (isDashBrandBuffer(head.buf)) {
            invalidateStreamHead(videoId);
          } else {
            ramHot = true;
          }
        }
        const waitMs = isAndroid && !formatHot && !ramHot && !formatCircuitOpen(videoId) ? 6_000 : 0;
        if (waitMs > 0) {
          void downloadTrack(videoId, {
            progressiveOnly: true,
            preferProxies,
            userId: streamUserId,
          }).catch(() => {});
          const t0 = Date.now();
          while (Date.now() - t0 < waitMs) {
            refreshDisk();
            if (diskBytes >= 256 * 1024) break;
            await new Promise((r) => setTimeout(r, 250));
          }
        }
      }
      if (diskBytes > 256 * 1024) {
        if (/^bytes=0-$/i.test(rangeRaw)) {
          req.headers.range = `bytes=0-${diskBytes - 1}`;
        }
        // sans Range → 200 + corps entier plus bas
      } else if (!isAndroid) {
        // Web <audio> : même tête Range que Android — évite un GET open-ended
        // qui pend / reçoit du DASH puis silence après rejet.
        req.headers.range = 'bytes=0-524287';
      } else {
        // Android open-ended sans .m4a : un GET sans Range fait pendrer le relais /
        // le pipe GV (corps entier) → 10–20 s avant le 1er octet.
        // Tête Range = même taille que le prefetch rapide (64 KiB trop juste pour
        // init MP4 ; 512 KiB ≈ chemin Range client qui répond en <300 ms).
        // Exo enchaîne ensuite avec des Ranges suivants (Content-Range total).
        req.headers.range = 'bytes=0-524287';
        skipHomeForOpenAndroid = true;
      }
      // Android sans disque : ne pas forcer 1 MiB — mieux un 502/retry qu’un cache toxique.
    }
  }
  const audioRangeStart = (() => {
    if (wantVideo) return 0;
    const m = /bytes=(\d+)/.exec(String(req.headers.range || ''));
    return m ? Number(m[1]) : 0;
  })();
  // Googlevideo (MWEB/IOS…) refuse souvent les Ranges mid au-delà ~1 MiB → 403.
  // Dès le début : télécharge le .m4a en fond pour les Ranges suivantes.
  if (!wantVideo && audioRangeStart === 0) {
    const { isYtDlpCoolingDown } = await import('./ytDlpGate.js');
    if (!isYtDlpCoolingDown(streamUserId)) {
      // Progressif pour TOUS (web + Android) — rejet DASH universel depuis 1.3.240.
      void downloadTrack(videoId, {
        progressiveOnly: true,
        preferProxies,
        userId: streamUserId,
      }).catch((err) => {
        const msg = String((err as Error).message || err);
        if (/cooling down|bot\/rate-limit|Sign in to confirm|rate-limited/i.test(msg)) return;
        console.warn('[stream] prefetch downloadTrack KO:', msg.slice(0, 120));
      });
    }
  }
  // Mid-range : deadline plus longue (yt-dlp peut prendre 30–90 s la 1ʳᵉ fois).
  const midNeedsDisk = !wantVideo && audioRangeStart > 0;
  // Tête audio : 16 s était trop court dès que la résolution passait par yt-dlp
  // (30–90 s à froid) → 502 systématique sur les titres pas encore en cache.
  // Vidéo : resolve + fetch GV souvent plus lent (yt-dlp -g / pipe)
  // Offline : budget large pour downloadTrack / yt-dlp 140.
  const deadlineAt =
    Date.now() +
    (wantOffline ? 95_000 : wantVideo ? 40_000 : midNeedsDisk ? 95_000 : 55_000);
  const ensureTime = (label: string) => {
    if (Date.now() >= deadlineAt) throw new Error(`stream deadline (${label})`);
  };
  const withDeadline = async <T>(label: string, p: Promise<T>, budgetMs?: number): Promise<T> => {
    ensureTime(label);
    const left = Math.max(500, deadlineAt - Date.now());
    const wait = budgetMs ? Math.min(budgetMs, left) : left;
    return await Promise.race([
      p,
      new Promise<T>((_, rej) =>
        setTimeout(() => rej(new Error(`timeout ${label}`)), wait),
      ),
    ]);
  };

  // preferProxies + homeUpstream déjà calculés en tête de handleStream.

  // Tête RAM (lazy warm) — avant disque / upstream
  if (!wantVideo && tryServeRamHead(req, res, videoId)) return;

  const androidClient = !wantVideo && isAndroidClient(req);

  // Android : démarrer tôt un .m4a progressif (yt-dlp) — le DASH Innertube
  // provoque stalls Exo → mails « auth-or-blocked / android.player.stall ».
  if (androidClient) {
    purgeDashCache(videoId);
    const cachedEarly = cachePath(videoId);
    if (!isCompleteEnoughDisk(cachedEarly)) {
      downloadTrack(videoId, { progressiveOnly: true, preferProxies, userId: streamUserId }).catch(() => {
        /* fond */
      });
    }
  }

  // Cache disque AVANT relais maison — mid-range seek (GV coupe souvent après ~1 Mo).
  if (!wantVideo) {
    const cached = cachePath(videoId);
    if (existsSync(cached) && (isDashBrandFile(cached) || !statSync(cached).size)) {
      try {
        const wasDash = isDashBrandFile(cached);
        unlinkSync(cached);
        if (wasDash) console.warn(`[stream] purge DASH avant serve ${videoId}`);
      } catch {
        /* ignore */
      }
    }
    if (midNeedsDisk && (!existsSync(cached) || !statSync(cached).size)) {
      // Budget borné : avant, un downloadTrack lent mangeait les 95 s de deadline
      // et le fallback relais/googlevideo n’avait plus de temps → 502/504 garanti.
      // Le téléchargement continue en fond (downloadInflight) pour la requête suivante.
      const budget = midRangeWaitMs(videoId);
      const dl = downloadTrack(videoId, { progressiveOnly: true, preferProxies, userId: streamUserId });
      dl.catch(() => {
        /* poursuivi en fond — l’erreur est traitée par le await borné ci-dessous */
      });
      try {
        // Budget épuisé par les Ranges précédents : au relais sans attendre.
        if (budget < 1_000) throw new Error('budget disque épuisé');
        await withDeadline('downloadTrack', dl, budget);
        noteMidRangeDownload(true, videoId);
      } catch (err) {
        const msg = String((err as Error).message || err);
        // Un budget déjà consommé par les Ranges précédents ne dit rien de la
        // santé des téléchargements : il ne doit pas peser sur le budget.
        if (!msg.includes('budget disque épuisé')) noteMidRangeDownload(false, videoId);
        // Cooldown bot : Exo retry Mid-Range × N — 1 log / 60 s max
        if (/cooling down|bot\/rate-limit|Sign in to confirm|rate-limited/i.test(msg)) {
          const now = Date.now();
          if (now - lastMidRangeCoolingLog > 60_000) {
            lastMidRangeCoolingLog = now;
            console.warn('[stream] mid-range skip (yt-dlp cooldown/bot)');
          }
        } else {
          console.warn('[stream] mid-range downloadTrack KO:', msg.slice(0, 160));
        }
      }
    }
    if (existsSync(cached) && !isDashBrandFile(cached)) {
      const size = (() => {
        try {
          return statSync(cached).size;
        } catch {
          return 0;
        }
      })();
      const incomplete = downloadInflight.has(videoId);
      // Partiel trop petit seulement — un préfixe swarm de plusieurs Mo doit rester
      // (sinon Exo re-buffer après un cooldown yt-dlp).
      if (size > 0 && size < MIN_COMPLETE_DISK_BYTES && !incomplete) {
        try {
          unlinkSync(cached);
          console.warn(`[stream] purge partiel mort ${videoId} (${size} o)`);
        } catch {
          /* ignore */
        }
      }
    }
    if (
      existsSync(cached) &&
      !isDashBrandFile(cached) &&
      (isCompleteEnoughDisk(cached) || downloadInflight.has(videoId))
    ) {
      const size = statSync(cached).size;
      const incomplete = downloadInflight.has(videoId);
      // Total annoncé = jamais la taille partielle d’un .m4a encore en cours
      // (sinon Exo coupe à ~30 s = fin du partiel, puis « reprise » au rebind).
      const advertised = stableContentTotal(videoId, size, { incomplete });
      if (!incomplete) rememberAdvertisedTotal(videoId, advertised);
      const knownTotal = getAdvertisedTotal(videoId);
      const totalHdr =
        knownTotal && knownTotal > 0
          ? Math.max(knownTotal, advertised)
          : incomplete
            ? Math.max(advertised, size)
            : advertised;
      const range = req.headers.range;
      if (range) {
        // Mid-range au-delà du partiel : attendre un peu que le fichier grossisse.
        if (incomplete) {
          const want = /bytes=(\d+)-(\d*)/.exec(String(range));
          const needEnd = want
            ? want[2]
              ? Number(want[2])
              : Number(want[1]) + 256 * 1024
            : 0;
          if (Number.isFinite(needEnd) && needEnd >= size) {
            const waitUntil = Date.now() + Math.min(12_000, midRangeWaitMs(videoId) || 8_000);
            while (Date.now() < waitUntil && downloadInflight.has(videoId)) {
              await new Promise((r) => setTimeout(r, 400));
              try {
                if (existsSync(cached) && statSync(cached).size > needEnd) break;
              } catch {
                /* ignore */
              }
            }
          }
        }
        const sizeFresh = existsSync(cached) ? statSync(cached).size : size;
        const bounds = safeDiskRangeBounds(sizeFresh, String(range));
        if (!bounds.ok) {
          res.status(416);
          // Total *complet* (pas le partiel) pour qu’Exo réessaie plus tard.
          res.setHeader('Content-Range', `bytes */${Math.max(totalHdr, sizeFresh)}`);
          res.setHeader('Accept-Ranges', 'bytes');
          res.end();
          return;
        }
        const { start, end } = bounds;
        const len = end - start + 1;
        const totalOut = Math.max(totalHdr, end + 1, sizeFresh);
        if (start === 0 && len > 0 && len <= 1024 * 1024) {
          try {
            const { openSync, readSync, closeSync } = await import('node:fs');
            const fd = openSync(cached, 'r');
            try {
              const buf = Buffer.alloc(len);
              readSync(fd, buf, 0, len, 0);
              putStreamHead(videoId, buf, {
                totalSize: incomplete ? knownTotal ?? null : totalOut,
                contentType: 'audio/mp4',
              });
              res.status(206);
              res.setHeader(
                'Content-Range',
                incomplete && !knownTotal
                  ? `bytes 0-${len - 1}/*`
                  : `bytes 0-${len - 1}/${totalOut}`,
              );
              res.setHeader('Accept-Ranges', 'bytes');
              res.setHeader('Content-Length', len);
              res.setHeader('Content-Type', 'audio/mp4');
              res.setHeader('X-PLM-Stream-Cache', 'disk-ram');
              noteStreamSource(res, 'cache disque (tête en mémoire)');
              res.end(buf);
              return;
            } finally {
              closeSync(fd);
            }
          } catch {
            /* fallback pipe */
          }
        }
        try {
          // Re-stat juste avant createReadStream : le .m4a peut encore grossir / être
          // remplacé (téléchargement parallèle) → start > taille réelle = RangeError.
          const sizeNow = existsSync(cached) ? statSync(cached).size : 0;
          const again = safeDiskRangeBounds(sizeNow, String(range));
          if (!again.ok) {
            res.status(416);
            res.setHeader(
              'Content-Range',
              `bytes */${Math.max(totalHdr, sizeNow, knownTotal || 0)}`,
            );
            res.setHeader('Accept-Ranges', 'bytes');
            res.end();
            return;
          }
          const start2 = again.start;
          const end2 = again.end;
          const len2 = end2 - start2 + 1;
          // CRITICAL : ne jamais Math.min(total, sizeNow) — c’était la cause ~30 s.
          const totalNow = Math.max(totalHdr, end2 + 1, knownTotal || 0);
          res.status(206);
          res.setHeader(
            'Content-Range',
            incomplete && totalNow <= sizeNow && !knownTotal
              ? `bytes ${start2}-${end2}/*`
              : `bytes ${start2}-${end2}/${Math.max(totalNow, sizeNow)}`,
          );
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Content-Length', len2);
          res.setHeader('Content-Type', 'audio/mp4');
          res.setHeader('X-PLM-Stream-Cache', 'disk');
          noteStreamSource(res, 'cache disque (plage)');
          const { createReadStream } = await import('node:fs');
          const rs = createReadStream(cached, { start: start2, end: end2 });
          rs.on('error', (err) => {
            console.warn(
              `[stream ${videoId}] disk range KO:`,
              String(err?.message || err).slice(0, 120),
            );
            if (!res.headersSent) {
              res.status(416);
              res.setHeader('Content-Range', `bytes */${Math.max(totalNow, sizeNow)}`);
              res.end();
            } else {
              res.destroy();
            }
          });
          rs.pipe(res);
          return;
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          (e as { trackId?: string }).trackId = videoId;
          e.message = `[stream ${videoId}] ${e.message}`;
          console.warn('[stream] disk range KO:', e.message.slice(0, 160));
          if (!res.headersSent) {
            res.status(416);
            res.setHeader('Content-Range', `bytes */${Math.max(totalHdr, size)}`);
            res.end();
          }
          return;
        }
      }
      try {
        res.setHeader('Content-Type', 'audio/mp4');
        res.setHeader('Content-Length', size);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('X-PLM-Stream-Cache', 'disk');
        noteStreamSource(res, 'cache disque (entier)');
        import('../library/sharedCatalog.js')
          .then((m) => m.rememberReadyAudio(videoId, size))
          .catch(() => {});
        const { createReadStream } = await import('node:fs');
        const rs = createReadStream(cached);
        rs.on('error', (err) => {
          console.warn(
            `[stream ${videoId}] disk full KO:`,
            String(err?.message || err).slice(0, 120),
          );
          if (!res.headersSent) res.status(500).json({ error: 'Cache disque illisible' });
          else res.destroy();
        });
        rs.pipe(res);
        return;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        (e as { trackId?: string }).trackId = videoId;
        console.warn(`[stream ${videoId}] disk full KO:`, e.message.slice(0, 120));
        if (!res.headersSent) res.status(500).json({ error: 'Cache disque illisible' });
        return;
      }
    }
  }

  // Relais maison (IP résidentielle) — optionnel.
  // Si le PC est éteint : skip immédiat → VPS + proxies gratuits (pas de 20–52 s morts).
  // Android open-ended froid : tentative courte (first-byte 3.5 s) puis fallback VPS/GV.
  if (homeUpstream) {
    const homeUp = await isHomeUpstreamReachable(homeUpstream);
    if (!homeUp) {
      if (Date.now() - homeOfflineLoggedAt > 60_000) {
        homeOfflineLoggedAt = Date.now();
        console.warn(
          '[stream] STREAM_UPSTREAM offline (maison) — normal, VPS + chaîne proxies gratuits',
        );
      }
    } else {
      // Android : first-byte maison COURT puis fallback VPS.
      // Avant 28–35 s : sous charge (Nothing+prefetch) chaque titre brûlait
      // 35 s maison AVANT le VPS → timeouts client 40 s / stalls / skip auto.
      const proxyTimeoutMs = skipHomeForOpenAndroid
        ? 22_000
        : midNeedsDisk
          ? 14_000
          : 28_000;
      const firstByteMs = skipHomeForOpenAndroid
        ? 10_000
        : midNeedsDisk
          ? 8_000
          : 12_000;
      // Soft-fail récent : ne PAS skipper la maison (elle a souvent le .m4a disque
      // en 0.05 s — skip → VPS DASH/yt-dlp = BUFFERING 40 s sur Brisa etc.).
      // À la place : first-byte très court, puis VPS.
      const softFailHome =
        homeSoftFailStreak >= 1 && Date.now() - homeSoftFailAt < 25_000;
      if (softFailHome) {
        console.warn(
          '[stream] STREAM_UPSTREAM soft-fail — maison first-byte court puis VPS',
        );
      }
      try {
        const fb = softFailHome
          ? 2_000
          : skipHomeForOpenAndroid
            ? 10_000
            : midNeedsDisk
              ? 8_000
              : 12_000;
        const pt = softFailHome
          ? 8_000
          : skipHomeForOpenAndroid
            ? 22_000
            : midNeedsDisk
              ? 14_000
              : 28_000;
        await proxyStreamToHome(req, res, homeUpstream, videoId, pt, fb);
        return;
      } catch (err) {
        if (endIfHeadersSent(res)) return;
        const msg = String((err as Error).message || err);
        console.warn('[stream] STREAM_UPSTREAM KO:', msg.slice(0, 180));
        // Ne poisonner « maison offline » QUE sur panne réseau réelle (PC/tunnel down).
        // Timeout / abort / first-byte / DASH / 410 = CE titre (ou saturation) —
        // sinon 1 titre lent → 45 s offline → fallback VPS → stalls → avalanche mails.
        const homeHardDown =
          /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|network/i.test(msg) &&
          !/home stream \d{3}|DASH|ftypdash|first-byte timeout|home first-byte timeout/i.test(
            msg,
          );
        const homeSoftSlow =
          /AbortError|aborted|timeout|first-byte timeout|home first-byte timeout/i.test(msg);
        if (homeHardDown) {
          markHomeDead(homeUpstream, 12_000);
          homeSoftFailStreak = 0;
        } else if (homeSoftSlow) {
          const now = Date.now();
          if (now - homeSoftFailAt > 40_000) homeSoftFailStreak = 0;
          homeSoftFailAt = now;
          homeSoftFailStreak += 1;
          // Ne plus markHomeDead ici : ça coupait le relais 15 s alors que le
          // disque maison servait d’autres titres en 50 ms (Brisa BUFFERING).
          if (homeSoftFailStreak >= 3) {
            console.warn(
              '[stream] STREAM_UPSTREAM soft-fail streak — first-byte maison court',
            );
          }
        }
        // Toujours tenter les backends VPS (OAuth / cookies / yt-dlp / proxies) après KO maison.
        // Opt-out explicite : STREAM_UPSTREAM_FALLBACK=0
        const forceHomeOnly =
          process.env.STREAM_UPSTREAM_FALLBACK === '0' ||
          process.env.STREAM_UPSTREAM_FALLBACK === 'false';
        if (forceHomeOnly && !midNeedsDisk && !skipHomeForOpenAndroid) {
          const isDown =
            /fetch failed|AbortError|aborted|timeout|ECONNREFUSED|ECONNRESET|ENOTFOUND|network/i.test(
              msg,
            );
          const homeStatus = /home stream (\d{3})/.exec(msg);
          const status = homeStatus ? Number(homeStatus[1]) : isDown ? 503 : 502;
          res.status(status).json({
            error: 'Impossible de streamer audio',
            detail: msg.slice(0, 240),
            hint: isDown
              ? 'Relais maison KO — le VPS utilise proxies YouTube (YOUTUBE_HTTP_PROXY_FREE). Ou : bash scripts/deploy/link-home-stream.sh'
              : 'Titre indisponible côté YouTube, ou relais saturé — réessaie dans un instant.',
          });
          return;
        }
        console.warn(
          midNeedsDisk
            ? '[stream] mid-range : relais KO — fallback backends locaux'
            : '[stream] STREAM_UPSTREAM KO — fallback backends locaux VPS',
        );
      }
    }
  }

  // (cache disque déjà traité plus haut)

  try {
    ensureTime('format');
    let format = wantVideo
      ? await withDeadline('getVideoFormat', getVideoFormat(videoId), 18_000)
      : await (async () => {
          downloadTrack(videoId, {
            progressiveOnly: true,
            preferProxies: true,
            userId: streamUserId,
          }).catch(() => {});
          const fmtP = getAudioFormat(videoId, {
            userId: (req as any).userId,
            forceFresh: retryN > 0,
            retryN,
            live: true,
          });
          const diskP = waitUntilDiskServable(videoId, 18_000);
          const winner = await Promise.race([
            fmtP
              .then((f) => ({ k: 'fmt' as const, f }))
              .catch((e: unknown) => ({ k: 'err' as const, e })),
            diskP.then((p) => (p ? { k: 'disk' as const, p } : { k: 'nodisk' as const })),
          ]);
          if (winner.k === 'disk') {
            await pipeDiskFile(req, res, winner.p, videoId, 'disk-race');
            throw new Error('__DISK_SERVED__');
          }
          if (winner.k === 'fmt' && winner.f?.url) return winner.f;
          if (winner.k === 'err') throw winner.e;
          return await withDeadline('getAudioFormatRace', fmtP, 12_000);
        })();
    if (format.url) {
      noteFormatOk(videoId);
      // Clients natifs (Android ExoPlayer) : 302 direct googlevideo = plus rapide.
      // Navigateur web : proxy (CORS / Workbox).
      // URL liée à un proxy : ne pas 302 le téléphone (IP ≠ proxy → 403).
      if (wantsDirectRedirect(req) && !format.viaProxy) {
        noteStreamSource(res, 'redirection googlevideo');
        res.setHeader('Cache-Control', 'no-store');
        if (format.bitrate) res.setHeader('X-PLM-Audio-Bitrate', String(format.bitrate));
        res.redirect(302, format.url);
        return;
      }
      const rangeHdr = req.headers.range ? String(req.headers.range) : undefined;
      const gvOpts = { preferProxies, boundProxy: format.viaProxy, userId: streamUserId };
      let upstream = await withDeadline('fetchGV', fetchGooglevideo(format.url, rangeHdr, gvOpts));
      // URL morte / anti-bot → invalide le cache format et retente 1× avant fallbacks
      if (upstream.status === 403 || upstream.status === 401 || upstream.status === 404) {
        invalidateAudioFormat(videoId);
        invalidateVideoFormat(videoId);
        invalidateStreamHead(videoId);
        format = wantVideo
          ? await withDeadline('getVideoFormat2', getVideoFormat(videoId), 12_000)
          : await withDeadline(
              'getAudioFormat2',
              preferProxies
                ? getAudioFormatViaYtDlpOnly(videoId, { live: true, preferProxies: true, userId: streamUserId })
                : getAudioFormat(videoId, { userId: (req as any).userId, live: true }),
              12_000,
            );
        if (!format.url) throw new Error(`upstream ${wantVideo ? 'video' : 'audio'} ${upstream.status}`);
        upstream = await withDeadline(
          'fetchGV2',
          fetchGooglevideo(format.url, rangeHdr, { preferProxies, boundProxy: format.viaProxy, userId: streamUserId }),
        );
      }
      // Innertube toujours 403 → URL yt-dlp (souvent OK sans cookies fichier)
      if (
        !wantVideo &&
        (upstream.status === 403 || upstream.status === 401 || upstream.status === 404)
      ) {
        try {
          format = await withDeadline(
            'ytDlpUrl',
            getAudioFormatViaYtDlpOnly(videoId, { live: true, preferProxies, userId: streamUserId }),
            12_000,
          );
          upstream = await withDeadline(
            'fetchGV3',
            fetchGooglevideo(format.url, rangeHdr, { preferProxies, boundProxy: format.viaProxy, userId: streamUserId }),
          );
        } catch {
          /* fallback pipe plus bas */
        }
      }
      // 5xx amont : ne pas retenter l’IP VPS — re-resolve yt-dlp + même proxy.
      if (!wantVideo && isUpstream5xx(upstream.status)) {
        invalidateAudioFormat(videoId);
        invalidateStreamHead(videoId);
        try {
          format = await withDeadline(
            'getAudioFormat5xx',
            getAudioFormatViaYtDlpOnly(videoId, { live: true, preferProxies: true, userId: streamUserId }),
            12_000,
          );
          if (format.url) {
            upstream = await withDeadline(
              'fetchGV5xx',
              fetchGooglevideo(format.url, rangeHdr, { preferProxies: true, boundProxy: format.viaProxy, userId: streamUserId }),
            );
          }
        } catch {
          /* throw plus bas → pipe yt-dlp */
        }
      }
      // Toujours 403 / 5xx → laisser les fallbacks yt-dlp / Innertube (log soft, pas d’alarme)
      if (upstream.status >= 400) {
        invalidateAudioFormat(videoId);
        invalidateVideoFormat(videoId);
        invalidateStreamHead(videoId);
        throw new Error(`upstream ${wantVideo ? 'video' : 'audio'} ${upstream.status}`);
      }
      if (!upstream.body) {
        throw new Error('upstream sans corps');
      }
      if (upstream.headers.get('content-length') === '0') {
        throw new Error('upstream content-length 0');
      }
      const reader = upstream.body.getReader();
      const first = await reader.read();
      if (first.done || !first.value?.byteLength) {
        throw new Error('upstream vide');
      }
      const firstBuf = Buffer.from(first.value);
      // DASH fragmenté → Exo stalle (403 mid-range / buf figé) → mails stall.
      // Forcer le chemin progressif yt-dlp / disque.
      if (!wantVideo && isDashBrandBuffer(firstBuf)) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        invalidateStreamHead(videoId);
        invalidateAudioFormat(videoId);
        downloadTrack(videoId, { progressiveOnly: true, preferProxies, userId: streamUserId }).catch(() => {
          /* fond */
        });
        console.warn(`[stream] reject DASH googlevideo ${videoId} → progressif`);
        throw new Error('upstream audio DASH (ftypdash)');
      }
      if (res.headersSent) return;
      noteStreamSource(res, 'relais googlevideo');
      res.status(upstream.status);
      const ct = upstream.headers.get('content-type');
      const cr = upstream.headers.get('content-range');
      const ar = upstream.headers.get('accept-ranges');
      if (ct) res.setHeader('Content-Type', ct);
      else res.setHeader('Content-Type', wantVideo ? 'video/mp4' : 'audio/mp4');
      if (cr) {
        const tm = /\/(\d+)\s*$/.exec(cr);
        if (tm) {
          const upstreamTotal = Number(tm[1]);
          rememberAdvertisedTotal(videoId, upstreamTotal);
          const stable = stableContentTotal(videoId, upstreamTotal);
          res.setHeader(
            'Content-Range',
            stable !== upstreamTotal ? cr.replace(/\/\d+\s*$/, `/${stable}`) : cr,
          );
        } else {
          res.setHeader('Content-Range', cr);
        }
      }
      const cl = upstream.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);
      if (ar) res.setHeader('Accept-Ranges', ar);
      else res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=1800');
      if (!wantVideo && format.bitrate) {
        res.setHeader('X-PLM-Audio-Bitrate', String(format.bitrate));
      }
      // Remplit la tête RAM si on stream le début (lazy warm pour le prochain client)
      if (!wantVideo) {
        const rangeStart = rangeHdr ? Number(/bytes=(\d+)/.exec(rangeHdr)?.[1] || -1) : 0;
        if (rangeStart === 0) {
          let totalSize: number | null = null;
          if (cr) {
            const tm = /\/(\d+)\s*$/.exec(cr);
            if (tm) totalSize = Number(tm[1]);
          }
          putStreamHead(videoId, firstBuf, {
            totalSize,
            contentType: ct || 'audio/mp4',
          });
          if (totalSize != null) rememberAdvertisedTotal(videoId, totalSize);
        }
      }
      if (!res.write(firstBuf)) {
        await new Promise((r) => res.once('drain', r));
      }
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          if (!res.write(Buffer.from(value))) {
            await new Promise((r) => res.once('drain', r));
          }
        }
      }
      res.end();
      return;
    }
  } catch (err) {
    if (endIfHeadersSent(res)) return;
    // Soft : les fallbacks yt-dlp suivent souvent — évite de spammer les logs
    const msg = String((err as Error).message || err);
    if (msg === '__DISK_SERVED__') return;
    if (!/upstream audio 403|upstream audio 401|upstream audio DASH/i.test(msg)) {
      console.warn('[stream] format/proxy KO:', msg.slice(0, 160));
    }
    // Titre VRAIMENT mort (unavailable) : remplacer / 410.
    // Timeout format/proxy : on continue vers disque + swarm (pas un skip).
    if (!wantVideo && looksUnavailable(msg)) {
      try {
        const known = getReplacementId(videoId);
        if (known && !res.headersSent) {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-PLM-Replaced-From', videoId);
          res.redirect(302, streamPathFor(req, known));
          return;
        }
      } catch {
        /* 410 ci-dessous */
      }
      void findReplacementId(videoId, { userId: (req as any).userId }).catch(() => null);
      noteFormatTimeout(videoId);
      sendStreamUnavailable(res, videoId, msg);
      return;
    }
    if (!wantVideo && !res.headersSent) {
      const late = await waitUntilDiskServable(videoId, 10_000);
      if (late) {
        await pipeDiskFile(req, res, late, videoId, 'disk-after-format');
        return;
      }
    }
  }

  // Après rejet DASH / 403 : préparer le disque en fond, puis pipe yt-dlp immédiat
  // (Android). Avant : wait 14 s silencieux sur remux→403 → Nothing « charge… » infini.
  if (!wantVideo && !res.headersSent && !midNeedsDisk) {
    const cachedProg = cachePath(videoId);
    if (!isCompleteEnoughDisk(cachedProg)) {
      downloadTrack(videoId, { progressiveOnly: true, preferProxies, userId: streamUserId }).catch(() => {});
    }
    if (isCompleteEnoughDisk(cachedProg) || isGrowingDiskServable(cachedProg)) {
      try {
        const size = statSync(cachedProg).size;
        const rangeHdr = req.headers.range ? String(req.headers.range) : '';
        rememberAdvertisedTotal(videoId, size);
        if (rangeHdr) {
          const bounds = safeDiskRangeBounds(size, rangeHdr);
          if (bounds.ok) {
            const { createReadStream } = await import('node:fs');
            const len = bounds.end - bounds.start + 1;
            res.status(206);
            res.setHeader('Content-Range', `bytes ${bounds.start}-${bounds.end}/${size}`);
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Length', len);
            res.setHeader('Content-Type', 'audio/mp4');
            res.setHeader('X-PLM-Stream-Cache', 'disk-progressive');
            noteStreamSource(res, 'disque progressif (anti-DASH)');
            createReadStream(cachedProg, { start: bounds.start, end: bounds.end }).pipe(res);
            return;
          }
        } else {
          const { createReadStream } = await import('node:fs');
          res.status(200);
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Content-Length', size);
          res.setHeader('Content-Type', 'audio/mp4');
          res.setHeader('X-PLM-Stream-Cache', 'disk-progressive');
          noteStreamSource(res, 'disque progressif (anti-DASH)');
          createReadStream(cachedProg).pipe(res);
          return;
        }
      } catch (e) {
        console.warn(
          '[stream] progressive disk serve KO:',
          String((e as Error).message || e).slice(0, 120),
        );
      }
    }
    if (isAndroidClient(req) && !res.headersSent) {
      // Budget dédié hors deadline globale (souvent déjà mangée par maison+DASH).
      const antiDashRace = async <T>(label: string, p: Promise<T>, ms: number): Promise<T> =>
        Promise.race([
          p,
          new Promise<T>((_, rej) =>
            setTimeout(() => rej(new Error(`timeout ${label}`)), ms),
          ),
        ]);
      try {
        // 1) URL itag 140 (yt-dlp -g) + fetch GV — souvent <10 s, vs pipe qui
        // timeout à 12 s sous charge (Brisa / fail-mail).
        const rangeHdr = req.headers.range ? String(req.headers.range) : undefined;
        const fmt = await antiDashRace(
          'ytdlpUrlAntiDash',
          getAudioFormatViaYtDlpOnly(videoId, { live: true, preferProxies: true, userId: streamUserId }),
          28_000,
        );
        if (fmt?.url && !res.headersSent) {
          const upstream = await antiDashRace(
            'fetchGVAntiDash',
          fetchGooglevideo(fmt.url, rangeHdr, { preferProxies: true, userId: streamUserId, boundProxy: fmt.viaProxy }),
            12_000,
          );
          if (upstream.status < 400 && upstream.body) {
            const reader = upstream.body.getReader();
            const first = await antiDashRace('readGVAntiDash', reader.read(), 8_000);
            if (!first.done && first.value?.byteLength) {
              const firstBuf = Buffer.from(first.value);
              if (!isDashBrandBuffer(firstBuf)) {
                noteStreamSource(res, 'yt-dlp URL (anti-DASH)');
                res.status(upstream.status);
                const ct = upstream.headers.get('content-type');
                if (ct) res.setHeader('Content-Type', ct);
                else res.setHeader('Content-Type', 'audio/mp4');
                const cr = upstream.headers.get('content-range');
                if (cr) res.setHeader('Content-Range', cr);
                const cl = upstream.headers.get('content-length');
                if (cl) res.setHeader('Content-Length', cl);
                res.setHeader('Accept-Ranges', 'bytes');
                res.setHeader('Cache-Control', 'public, max-age=1800');
                if (!res.write(firstBuf)) await new Promise((r) => res.once('drain', r));
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (value && !res.write(Buffer.from(value))) {
                    await new Promise((r) => res.once('drain', r));
                  }
                }
                res.end();
                return;
              }
              try {
                await reader.cancel();
              } catch {
                /* ignore */
              }
            }
          }
        }
      } catch (e) {
        console.warn(
          '[stream] yt-dlp URL anti-DASH KO:',
          String((e as Error).message || e).slice(0, 140),
        );
      }
      try {
        // 2) Pipe progressif — budget un peu plus large, hors deadline globale.
        noteStreamSource(res, 'yt-dlp pipe (anti-DASH)');
        await antiDashRace('ytdlpPipeAntiDash', streamViaYtDlp(videoId, res, true), 22_000);
        return;
      } catch (e) {
        console.warn(
          '[stream] yt-dlp anti-DASH KO:',
          String((e as Error).message || e).slice(0, 140),
        );
        if (!res.headersSent) {
          // Timeout yt-dlp ≠ titre mort : 502 pour retry, pas un 302 lyrics.
          res.status(502).json({
            error: 'Impossible de streamer audio',
            code: 'STREAM_TEMP_UNAVAILABLE',
            detail: String((e as Error).message || e).slice(0, 200),
            hint: 'Progressif indisponible (VPS) — skip / retry',
          });
          return;
        }
      }
    }
  }

  // Fallbacks — vidéo : pipe yt-dlp progressif ; audio : yt-dlp puis Innertube
  if (wantVideo) {
    try {
      ensureTime('ytdlpVideo');
      noteStreamSource(res, 'yt-dlp vidéo (flux direct)');
      await withDeadline('ytdlpVideoPipe', streamViaYtDlpVideo(videoId, res, preferProxies));
      return;
    } catch (err) {
      if (endIfHeadersSent(res)) return;
      const msg = String((err as Error).message || err);
      console.warn('[stream] yt-dlp video KO:', msg.slice(0, 160));
    }
    if (!res.headersSent) {
      res.status(502).json({
        error: 'Impossible de streamer la vidéo',
        hint: 'Format progressif indisponible pour ce titre',
      });
    }
    return;
  }

  // Seek mid-range : les pipes yt-dlp / Innertube partent du début (HTTP 200) → Exo rebobine.
  if (midNeedsDisk && !res.headersSent) {
    noteStreamNote(res, 'seek demandé sans cache disque');
    res.status(503).json({
      error: 'Seek en cours de préparation',
      detail: 'Cache disque absent — téléchargement en cours ou indisponible',
      retryAfter: 3,
      hint: 'Réessaie le seek dans quelques secondes (le titre peut encore se charger).',
    });
    return;
  }

  try {
    ensureTime('ytdlp');
    noteStreamSource(res, 'yt-dlp (flux direct)');
    await withDeadline('ytdlpPipe', streamViaYtDlp(videoId, res, preferProxies));
    return;
  } catch (err) {
    if (endIfHeadersSent(res)) return;
    const msg = String((err as Error).message || err);
    if (!/format is not available|first-byte timeout|stream deadline|timeout /i.test(msg)) {
      console.warn('[stream] yt-dlp KO:', msg.slice(0, 160));
    }
  }

  // Sous charge / IP bloquée : « non 2xx » sans proxies → un dernier passage forcé via pool.
  if (!preferProxies && !res.headersSent) {
    try {
      await ensureYoutubeProxyPool(true);
      ensureTime('ytdlpProxyForce');
      noteStreamSource(res, 'yt-dlp (proxies forcés)');
      await withDeadline('ytdlpPipeProxy', streamViaYtDlp(videoId, res, true));
      return;
    } catch (err) {
      if (endIfHeadersSent(res)) return;
      console.warn(
        '[stream] yt-dlp proxies forcés KO:',
        String((err as Error).message || err).slice(0, 140),
      );
    }
  }

  try {
    noteStreamSource(res, 'Innertube (dernier recours)');
    await streamViaInnertube(videoId, res);
  } catch (err) {
    if (!res.headersSent) {
      const detail = String(err);
      console.warn('[stream] all backends KO:', String((err as Error).message || err).slice(0, 160));
      // Remplacement UNIQUEMENT si la vidéo est vraiment morte — un timeout
      // proxy/yt-dlp ne doit pas 302 vers une autre piste (coupe mid-titre).
      if (!wantVideo && looksUnavailable(detail)) {
        try {
          const replacement =
            getReplacementId(videoId) ||
            (await findReplacementId(videoId, { userId: (req as any).userId }));
          if (replacement && !res.headersSent) {
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-PLM-Replaced-From', videoId);
            res.redirect(302, streamPathFor(req, replacement));
            return;
          }
        } catch (replErr) {
          console.warn(
            '[stream] remplacement KO:',
            String((replErr as Error).message || replErr).slice(0, 140),
          );
        }
      }
      const cookies = resolveYoutubeCookieHeader();
      noteStreamNote(res, `tous les backends KO : ${detail.slice(0, 200)}`);
      if (!wantVideo && looksUnavailable(detail)) {
        res.status(410).json({
          error: 'Impossible de streamer audio',
          code: 'VIDEO_UNAVAILABLE',
          detail: detail.slice(0, 240),
          hint: 'Titre retiré / privé — passage au suivant côté app',
        });
        return;
      }
      res.status(502).json({
        error: 'Impossible de streamer audio',
        detail,
        hint: cookies
          ? 'Réessaie dans quelques secondes — ou rafraîchis la session navigateur (ops)'
          : 'Vérifie le réseau / relais maison (link-home-stream.sh). Session navigateur optionnelle.',
      });
    }
  }
}

/** Pré-résout l’URL audio/vidéo (chauffe le cache format sans streamer). */
export async function handleStreamUrl(req: Request, res: Response) {
  const videoId = String(req.params.id || '');
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    res.status(400).json({ error: 'ID invalide' });
    return;
  }
  const wantVideo = String(req.query.type || req.query.media || '') === 'video';
  const retryN = streamRetryN(req);

  // VPS → PC maison : chauffe le resolve chez soi, mais renvoie TOUJOURS le proxy API.
  // Les URLs googlevideo sont liées à l’IP du PC maison → 403 depuis navigateur/téléphone.
  const homeUpstream = resolveStreamUpstream();
  if (homeUpstream) {
    const homeUp = await isHomeUpstreamReachable(homeUpstream);
    if (homeUp) {
      try {
        const q = wantVideo ? '?type=video' : '';
        const headers: Record<string, string> = {
          'X-YTM-Stream-Relay': '1',
        };
        const relayTok = (process.env.STREAM_RELAY_TOKEN || '').trim();
        if (relayTok) headers['X-YTM-Stream-Relay-Token'] = relayTok;
        const auth = req.headers.authorization;
        if (auth) headers.Authorization = String(auth);
        const upstream = await fetch(`${homeUpstream}/api/stream/${videoId}/url${q}`, {
          headers,
          signal: AbortSignal.timeout(3_000),
        });
        if (!upstream.ok) {
          const detail = await upstream.text().catch(() => '');
          console.warn(
            `[stream-url] STREAM_UPSTREAM warm ${upstream.status}:`,
            detail.slice(0, 160),
          );
        }
      } catch (err) {
        console.warn('[stream-url] STREAM_UPSTREAM warm KO:', (err as Error).message);
      }
      res.json({
        url: `/api/stream/${videoId}${wantVideo ? '?type=video' : ''}`,
        expiresAt: Date.now() + 3_600_000,
        mimeType: wantVideo ? 'video/mp4' : 'audio/mp4',
        kind: wantVideo ? 'video' : 'audio',
        via: 'proxy',
      });
      return;
    }
    // Relais maison configuré mais down : résoudre le format sur le VPS
    // (sinon /url répond 30 ms sans jamais chauffer Innertube/proxy).
  }

  try {
    const uid = (req as any).userId as string | undefined;
    if (retryN > 0 && !wantVideo) {
      invalidateAudioFormat(videoId);
      invalidateStreamHead(videoId);
    }
    const format = wantVideo
      ? await getVideoFormat(videoId)
      : await getAudioFormat(videoId, { userId: uid, forceFresh: retryN > 0, retryN });
    res.json({
      url: format.url,
      expiresAt: format.expiresAt,
      mimeType: format.mimeType ?? null,
      bitrate: format.bitrate ?? null,
      kind: wantVideo ? 'video' : 'audio',
    });
    // Chauffe la tête RAM en fond (prochain play ≪ 100 ms)
    if (!wantVideo && format.url) {
      void warmStreamHead(videoId, (range) =>
        fetchGooglevideo(format.url, range, { userId: uid, boundProxy: format.viaProxy }),
      );
    }
  } catch (err) {
    res.status(502).json({
      error: wantVideo ? 'Impossible de résoudre la vidéo' : 'Impossible de résoudre le stream',
      detail: String(err),
    });
  }
}

/** Warm batch : file limitée, réponse immédiate (E5 — ne pas bloquer l’UI 16 s). */
type WarmJob = { id: string; userId?: string };
const warmQueue: WarmJob[] = [];
const warmQueued = new Set<string>();
let warmWorkers = 0;
const WARM_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.STREAM_WARM_CONCURRENCY || 4) || 4));
const WARM_BATCH_CAP = Math.max(4, Math.min(32, Number(process.env.STREAM_WARM_BATCH_CAP || 16) || 16));

/** File .m4a disque (basse priorité) — partagée + file J’aime prioritaire séparée. */
const diskWarmQueue: string[] = [];
const diskWarmQueued = new Set<string>();
/** Priorité haute : favoris / lecture — ne pas dropper quand la file générique est pleine. */
const likesDiskWarmQueue: string[] = [];
const likesDiskWarmQueued = new Set<string>();
/** Prochain titre en file d’écoute : warm disque même pendant une lecture (évite 20 s au skip). */
const nextDiskWarmQueue: string[] = [];
const nextDiskWarmQueued = new Set<string>();
let diskWarmBusyCount = 0;
const DISK_WARM_CONCURRENCY = 2;

function diskWarmCap(): number {
  return Math.max(40, Math.min(400, Number(process.env.TASTE_WARM_DISK_QUEUE || 200) || 200));
}

function likesDiskWarmCap(): number {
  return Math.max(80, Math.min(2000, Number(process.env.LIKES_DISK_WARM_QUEUE || 800) || 800));
}

async function runDiskWarmWorker() {
  if (diskWarmBusyCount >= DISK_WARM_CONCURRENCY) return;
  diskWarmBusyCount += 1;
  try {
    while (nextDiskWarmQueue.length || likesDiskWarmQueue.length || diskWarmQueue.length) {
      const nextId = nextDiskWarmQueue.shift();
      if (nextId) {
        nextDiskWarmQueued.delete(nextId);
        try {
          await downloadTrack(nextId, { progressiveOnly: true, preferProxies: true });
        } catch {
          /* best-effort */
        }
        if (nextDiskWarmQueue.length) void runDiskWarmWorker();
        await new Promise((r) => setTimeout(r, isPlaybackHot(60_000) ? 200 : 120));
        continue;
      }
      // Lecture utilisateur : ne PAS consommer de slots yt-dlp génériques (sinon Aléatoire timeout).
      if (isPlaybackHot(60_000)) {
        await new Promise((r) => setTimeout(r, 4_000));
        continue;
      }
      const id = likesDiskWarmQueue.shift() || diskWarmQueue.shift();
      if (!id) break;
      likesDiskWarmQueued.delete(id);
      diskWarmQueued.delete(id);
      try {
        const { isYtDlpCoolingDown } = await import('./ytDlpGate.js');
        if (isYtDlpCoolingDown()) {
          likesDiskWarmQueue.unshift(id);
          likesDiskWarmQueued.add(id);
          await new Promise((r) => setTimeout(r, 8_000));
          continue;
        }
        await downloadTrack(id, { progressiveOnly: true, preferProxies: true });
      } catch {
        /* best-effort — le titre reste candidate au prochain sweep */
      }
      await new Promise((r) => setTimeout(r, isPlaybackHot(60_000) ? 2_000 : 400));
    }
  } finally {
    diskWarmBusyCount = Math.max(0, diskWarmBusyCount - 1);
    if (nextDiskWarmQueue.length || likesDiskWarmQueue.length || diskWarmQueue.length) {
      void runDiskWarmWorker();
    }
  }
}

export function enqueueNextDiskWarm(ids: string[]) {
  for (const id of ids) {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) continue;
    if (nextDiskWarmQueued.has(id)) continue;
    try {
      const p = cachePath(id);
      if (isCompleteEnoughDisk(p) && statSync(p).size >= 3 * 1024 * 1024) continue;
    } catch {
      /* continue */
    }
    const gi = diskWarmQueue.indexOf(id);
    if (gi >= 0) {
      diskWarmQueue.splice(gi, 1);
      diskWarmQueued.delete(id);
    }
    const li = likesDiskWarmQueue.indexOf(id);
    if (li >= 0) {
      likesDiskWarmQueue.splice(li, 1);
      likesDiskWarmQueued.delete(id);
    }
    if (nextDiskWarmQueue.length >= 12) break;
    nextDiskWarmQueued.add(id);
    nextDiskWarmQueue.push(id);
  }
  if (nextDiskWarmQueue.length || likesDiskWarmQueue.length || diskWarmQueue.length) {
    void runDiskWarmWorker();
  }
}

/** Enfile des téléchargements .m4a (cap file générique). */
export function enqueueDiskWarm(ids: string[]) {
  const cap = diskWarmCap();
  for (const id of ids) {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) continue;
    if (diskWarmQueued.has(id) || likesDiskWarmQueued.has(id)) continue;
    try {
      const p = cachePath(id);
      if (isCompleteEnoughDisk(p) && statSync(p).size >= 3 * 1024 * 1024) continue;
    } catch {
      /* continue */
    }
    if (diskWarmQueue.length >= cap) break;
    diskWarmQueued.add(id);
    diskWarmQueue.push(id);
  }
  if (diskWarmQueue.length || likesDiskWarmQueue.length) void runDiskWarmWorker();
}

/**
 * Warm disque prioritaire pour les J’aime (et titres critiques).
 * File séparée + cap élevé — ne doit pas être écrasée par le taste warm générique.
 */
export function enqueueLikesDiskWarm(ids: string[]) {
  const cap = likesDiskWarmCap();
  for (const id of ids) {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) continue;
    if (likesDiskWarmQueued.has(id)) continue;
    try {
      const p = cachePath(id);
      if (isCompleteEnoughDisk(p) && statSync(p).size >= 3 * 1024 * 1024) continue;
    } catch {
      /* continue */
    }
    // Retirer de la file générique si présent → priorité likes.
    const gi = diskWarmQueue.indexOf(id);
    if (gi >= 0) {
      diskWarmQueue.splice(gi, 1);
      diskWarmQueued.delete(id);
    }
    if (likesDiskWarmQueue.length >= cap) break;
    likesDiskWarmQueued.add(id);
    likesDiskWarmQueue.push(id);
  }
  if (likesDiskWarmQueue.length || diskWarmQueue.length) void runDiskWarmWorker();
}

export function diskWarmQueueStats(): {
  generic: number;
  likes: number;
  busy: boolean;
} {
  return {
    generic: diskWarmQueue.length,
    likes: likesDiskWarmQueue.length,
    busy: diskWarmBusyCount > 0,
  };
}

/** Pendant une écoute : vider le warm générique pour libérer yt-dlp (Aléatoire / cold). */
export function suspendBackgroundDiskWarm(keepCurrentId?: string) {
  const keep = keepCurrentId && /^[a-zA-Z0-9_-]{11}$/.test(keepCurrentId) ? keepCurrentId : '';
  while (diskWarmQueue.length) {
    const id = diskWarmQueue.shift()!;
    diskWarmQueued.delete(id);
  }
  // Likes : ne garder que le titre courant (sinon la file likes monopolise aussi).
  const keptLikes: string[] = [];
  while (likesDiskWarmQueue.length) {
    const id = likesDiskWarmQueue.shift()!;
    likesDiskWarmQueued.delete(id);
    if (id === keep && keptLikes.length === 0) keptLikes.push(id);
  }
  for (const id of keptLikes) {
    likesDiskWarmQueued.add(id);
    likesDiskWarmQueue.push(id);
  }
  // Ne pas vider nextDiskWarmQueue : c’est le titre suivant de la file d’écoute.
}

async function runWarmWorker() {
  const maxWorkers = isPlaybackHot(90_000) ? 1 : WARM_CONCURRENCY;
  if (warmWorkers >= maxWorkers) return;
  warmWorkers += 1;
  try {
    while (warmQueue.length) {
      if (isPlaybackHot(90_000) && warmWorkers > 1) break;
      const job = warmQueue.shift();
      if (!job) break;
      warmQueued.delete(job.id);
      try {
        const format = await getAudioFormat(job.id, { userId: job.userId });
        if (format?.url) {
          await warmStreamHead(job.id, (range) =>
            fetchGooglevideo(format.url, range, { userId: job.userId, boundProxy: format.viaProxy }),
          );
        }
      } catch {
        /* best-effort */
      }
    }
  } finally {
    warmWorkers -= 1;
    if (warmQueue.length) void runWarmWorker();
  }
}

export function bumpWarmPriority(id: string) {
  if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return;
  const i = warmQueue.findIndex((j) => j.id === id);
  if (i > 0) {
    const [job] = warmQueue.splice(i, 1);
    if (job) warmQueue.unshift(job);
  }
  // Priorité absolue sur files disque (likes puis générique).
  const li = likesDiskWarmQueue.indexOf(id);
  if (li > 0) {
    likesDiskWarmQueue.splice(li, 1);
    likesDiskWarmQueue.unshift(id);
  } else if (li < 0) {
    const di = diskWarmQueue.indexOf(id);
    if (di >= 0) {
      diskWarmQueue.splice(di, 1);
      diskWarmQueued.delete(id);
    }
    try {
      const p = cachePath(id);
      if (!isCompleteEnoughDisk(p) || statSync(p).size < 3 * 1024 * 1024) {
        if (!likesDiskWarmQueued.has(id)) {
          likesDiskWarmQueued.add(id);
          likesDiskWarmQueue.unshift(id);
          void runDiskWarmWorker();
        }
      }
    } catch {
      /* ignore */
    }
  }
}

export function enqueueStreamWarm(ids: string[], userId?: string) {
  if (!ids.length) return;
  const [first, ...rest] = ids;
  const pushFront = (id: string) => {
    if (warmQueued.has(id)) {
      bumpWarmPriority(id);
      return;
    }
    warmQueued.add(id);
    warmQueue.unshift({ id, userId });
  };
  if (first) pushFront(first);
  for (const id of rest) {
    if (warmQueued.has(id)) continue;
    warmQueued.add(id);
    warmQueue.push({ id, userId });
  }
  const start = Math.min(WARM_CONCURRENCY, warmQueue.length);
  for (let i = 0; i < start; i++) void runWarmWorker();
}

export async function handleStreamWarm(req: Request, res: Response) {
  const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const ids = [
    ...new Set(
      raw
        .map((x: unknown) => String(x || ''))
        .filter((id: string): id is string => /^[a-zA-Z0-9_-]{11}$/.test(id)),
    ),
  ].slice(0, WARM_BATCH_CAP) as string[];
  if (!ids.length) {
    res.status(400).json({ error: 'ids requis' });
    return;
  }
  const uid = (req as any).userId as string | undefined;
  // Mode legacy (tests) : attendre les formats si wait=1
  const wait =
    String(req.query.wait || req.body?.wait || '') === '1' ||
    String(req.query.wait || req.body?.wait || '') === 'true';
  if (wait) {
    const results = await Promise.allSettled(
      ids.map((id: string) => getAudioFormat(id, { userId: uid })),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    res.json({ ok: true, requested: ids.length, warmed: ok, waited: true });
    warmStreamHeadsLazy(
      ids,
      async (id) => {
        const format = await getAudioFormat(id, { userId: uid });
        return (range) => fetchGooglevideo(format.url, range, { userId: uid, boundProxy: format.viaProxy });
      },
      Math.min(6, ids.length),
    );
    return;
  }
  enqueueStreamWarm(ids, uid);
  enqueueNextDiskWarm(ids);
  // Prépare aussi le .m4a intégral (suite de file) — pas seulement la tête RAM.
  try {
    const { ensurePlayableQueueAhead } = await import('./ensurePlayable.js');
    ensurePlayableQueueAhead(ids, { userId: uid });
  } catch {
    /* ignore */
  }
  res.json({
    ok: true,
    requested: ids.length,
    queued: true,
    pending: warmQueue.length + warmWorkers,
    ensure: true,
  });
}

/**
 * Redirect 302 vers googlevideo — uniquement si demandé explicitement (?redirect=1).
 * Ne pas auto-rediriger ExoPlayer/OkHttp : l’URL CDN est liée à l’IP du serveur API,
 * donc un client sur une autre IP reçoit 403.
 */
function wantsDirectRedirect(req: Request): boolean {
  return String(req.query.redirect || '') === '1';
}

/** Évite N yt-dlp parallèles pour le même titre (ExoPlayer multi-Range). */
const downloadInflight = new Map<string, Promise<string>>();
/** Après échec bot/cooldown : ne pas relancer Innertube/yt-dlp en boucle (Exo multi-Range). */
const downloadFailUntil = new Map<string, { until: number; msg: string }>();
/** Début du téléchargement en cours, pour borner l'attente cumulée des Ranges. */
const downloadStartedAt = new Map<string, number>();
let lastMidRangeCoolingLog = 0;

const MID_RANGE_BUDGET_MAX_MS = 35_000;
const MID_RANGE_BUDGET_MIN_MS = 3_000;
/** Budget mid-range par titre (un bot sur A ne doit pas couper le seek de B). */
const midRangeBudgetById = new Map<string, number>();

function noteMidRangeDownload(ok: boolean, videoId?: string) {
  if (!videoId) return;
  const cur = midRangeBudgetById.get(videoId) ?? MID_RANGE_BUDGET_MAX_MS;
  midRangeBudgetById.set(
    videoId,
    ok ? MID_RANGE_BUDGET_MAX_MS : Math.max(MID_RANGE_BUDGET_MIN_MS, Math.floor(cur / 2)),
  );
}

/**
 * Temps qu'un Range peut encore accorder au téléchargement disque.
 *
 * Le lecteur redemande le même Range toutes les quelques secondes, et tous ces
 * appels retombent sur **un seul** téléchargement, qui enchaîne proxies,
 * cookies et formats et peut durer plusieurs minutes. Un budget par requête
 * faisait donc repayer l'attente complète à chaque fois : trente-cinq secondes
 * de silence par Range, alors que le relais googlevideo, lui, répond en une
 * fraction de seconde. Le budget court désormais depuis le lancement du
 * téléchargement, pas depuis l'arrivée de la requête.
 */
function midRangeWaitMs(videoId: string): number {
  const budget = midRangeBudgetById.get(videoId) ?? MID_RANGE_BUDGET_MAX_MS;
  const started = downloadStartedAt.get(videoId);
  if (!started) return budget;
  return Math.max(0, budget - (Date.now() - started));
}

/**
 * Une seule résolution d’URL googlevideo à la fois (8 s).
 * 1.3.276 = N deadlines 16 s en parallèle (stampede).
 * 1.3.277 = zéro getAudioFormat → swarm jamais pour un titre froid.
 * Ici : file unique, le titre en cours passe devant, le suivant attend.
 */
let formatResolveTail: Promise<unknown> = Promise.resolve();

async function resolveFormatForSwarm(
  videoId: string,
  userId?: string,
): Promise<ReturnType<typeof peekCachedAudioFormat>> {
  const peeked = peekCachedAudioFormat(videoId, userId);
  if (peeked?.url) return peeked;
  const run = async () => {
    const again = peekCachedAudioFormat(videoId, userId);
    if (again?.url) return again;
    try {
      const fmt = await Promise.race([
        getAudioFormat(videoId, { userId, live: true }),
        new Promise<null>((r) => setTimeout(() => r(null), 18_000)),
      ]);
      return fmt && fmt.url ? fmt : null;
    } catch {
      return null;
    }
  };
  const job = formatResolveTail.then(run, run);
  formatResolveTail = job.then(
    () => undefined,
    () => undefined,
  );
  return await job;
}

export async function downloadTrack(
  videoId: string,
  opts?: { progressiveOnly?: boolean; preferProxies?: boolean; userId?: string },
): Promise<string> {
  ensureCache();
  const out = cachePath(videoId);
  if (opts?.progressiveOnly) purgeDashCache(videoId);
  else if (isDashBrandFile(out)) purgeDashCache(videoId);
  // Ne pas traiter une tête tronquée comme « déjà téléchargée ».
  if (isCompleteEnoughDisk(out) && !downloadInflight.has(videoId)) return out;
  if (existsSync(out) && !isCompleteEnoughDisk(out) && !downloadInflight.has(videoId)) {
    purgeTinyOrDashCache(videoId);
  }

  const blocked = downloadFailUntil.get(videoId);
  if (blocked && Date.now() < blocked.until) {
    throw new Error(blocked.msg);
  }
  if (existsSync(out)) {
    if (isCompleteEnoughDisk(out) && !downloadInflight.has(videoId)) return out;
    if (!downloadInflight.has(videoId) && !isCompleteEnoughDisk(out)) {
      try {
        unlinkSync(out);
      } catch {
        /* ignore */
      }
    }
  }
  const pending = downloadInflight.get(videoId);
  if (pending) return pending;

  const job = (async (): Promise<string> => {
    if (isCompleteEnoughDisk(out)) return out;

    // progressiveOnly : yt-dlp+proxies d’abord.
    // Remux OAuth (fetch GV) depuis le VPS = quasi toujours 403 → ne plus le mettre
    // en tête (sinon ensure/warm bloquent et Nothing reste en « charge… »).

    // 1) Innertube — sauf si progressiveOnly (DASH fréquent → refuse hors-ligne)
    if (!opts?.progressiveOnly) {
      try {
        await downloadTrackViaInnertube(videoId, out);
        if (isCompleteEnoughDisk(out)) {
          return out;
        }
        // DASH écrit par Innertube → remux plutôt que jeter
        if (existsSync(out) && isDashBrandFile(out) && statSync(out).size >= MIN_COMPLETE_DISK_BYTES) {
          const tmp = `${out}.dash.tmp`;
          try {
            const { renameSync } = await import('node:fs');
            renameSync(out, tmp);
            await remuxToProgressiveM4a(tmp, out);
            try {
              unlinkSync(tmp);
            } catch {
              /* ignore */
            }
            if (isCompleteEnoughDisk(out) && !isDashBrandFile(out)) {
              downloadFailUntil.delete(videoId);
              return out;
            }
          } catch {
            try {
              if (existsSync(tmp)) unlinkSync(tmp);
            } catch {
              /* ignore */
            }
          }
        }
        if (existsSync(out) && (isDashBrandFile(out) || statSync(out).size < MIN_COMPLETE_DISK_BYTES)) {
          try {
            unlinkSync(out);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* fallback yt-dlp */
      }
    }

    // Swarm : 1 résolution d’URL à la fois (8 s), puis chunks visibles tout de suite.
    try {
      const format = await resolveFormatForSwarm(videoId, opts?.userId);
      if (format?.url) {
        const swarmOk = await downloadViaProxyChunks(format.url, out, {
          userId: opts?.userId,
          boundProxy: format.viaProxy || null,
        });
        if (swarmOk && isCompleteEnoughDisk(out) && !isDashBrandFile(out)) {
          downloadFailUntil.delete(videoId);
          midRangeBudgetById.set(videoId, MID_RANGE_BUDGET_MAX_MS);
          return out;
        }
      }
    } catch (err) {
      console.warn(
        '[stream] swarm skip',
        videoId,
        String((err as Error).message || err).slice(0, 100),
      );
    }

    if (!existsSync(YTDLP)) {
      // Dernier recours sans binaire yt-dlp
      if (!opts?.progressiveOnly) {
        try {
          await downloadTrackViaFormatRemux(videoId, out, opts?.userId);
          if (isCompleteEnoughDisk(out) && !isDashBrandFile(out)) return out;
        } catch {
          /* ignore */
        }
      }
      throw new Error('Audio download indisponible (innertube + yt-dlp)');
    }

    // Innertube / swarm ont pu laisser un préfixe utile — ne jeter que le tout petit / DASH.
    if (existsSync(out) && !isCompleteEnoughDisk(out)) {
      try {
        const sz = statSync(out).size;
        if (sz < 256_000 || isDashBrandFile(out)) unlinkSync(out);
      } catch {
        /* ignore */
      }
    }

    const { withYtDlpSlot, isYtDlpCoolingDown, noteYtDlpFailure, ytDlpCooldownRemainingMs } =
      await import('./ytDlpGate.js');

    if (isYtDlpCoolingDown(opts?.userId)) {
      throw new Error('yt-dlp cooling down — swarm / préfixe disque');
    }
    // 2) yt-dlp via proxies (même pendant cooldown VPS) — disque mid-range Android
    let lastErr: Error | null = null;
    let sawBot = false;
    const cookieSets = ytDlpCookieArgSets({ forDownload: true });
    const extractorSets = ytDlpExtractorArgSets();
    const proxies = await youtubeProxyAttempts({
      max: opts?.preferProxies ? 12 : 5,
      includeDirect: true,
      directLast: Boolean(opts?.preferProxies),
      shuffle: Boolean(opts?.preferProxies),
      probe: Boolean(opts?.preferProxies),
      userId: opts?.userId,
    });
    for (const proxy of proxies) {
      if (!proxy && isYtDlpCoolingDown(opts?.userId)) continue;
      for (const extractorArgs of extractorSets) {
        for (const cookieArgs of cookieSets) {
          for (const format of YTDLP_AUDIO_FORMAT_CANDIDATES) {
            try {
              const extractAudio =
                format.startsWith('18/') || format.startsWith('18')
                  ? (['-x', '--audio-format', 'm4a'] as const)
                  : ([] as const);
              await withYtDlpSlot(
                () =>
                  new Promise<void>((resolve, reject) => {
                    const proc = spawn(
                      YTDLP,
                      [
                        '-f',
                        format,
                        '-o',
                        out,
                        '--no-playlist',
                        '--no-warnings',
                        '--newline',
                        ...extractAudio,
                        ...ytDlpRuntimeArgs(),
                        ...extractorArgs,
                        ...cookieArgs,
                        ...ytDlpProxyCliArgs(proxy),
                        `https://www.youtube.com/watch?v=${videoId}`,
                      ],
                      { stdio: ['ignore', 'ignore', 'pipe'] },
                    );
                    let err = '';
                    proc.stderr?.on('data', (c) => {
                      err += String(c);
                      if (err.length > 4_000) err = err.slice(-4_000);
                    });
                    proc.on('error', reject);
                    proc.on('close', (code) => {
                      if (code === 0 && existsSync(out) && statSync(out).size > 0) {
                        resolve();
                        return;
                      }
                      const tip = err
                        .split('\n')
                        .map((l) => l.trim())
                        .filter((l) => /^ERROR:/i.test(l))
                        .pop();
                      reject(new Error(tip || `yt-dlp ${code}`));
                    });
                  }),
                { bypassCooldown: true, noteFailure: false, userId: opts?.userId },
              );
              if (isCompleteEnoughDisk(out)) {
                downloadFailUntil.delete(videoId);
                markYoutubeProxySuccess(proxy);
                return out;
              }
              if (existsSync(out)) {
                try {
                  unlinkSync(out);
                } catch {
                  /* ignore */
                }
              }
            } catch (err) {
              lastErr = err instanceof Error ? err : new Error(String(err));
              if (/Sign in to confirm|not a bot|rate-limited|LOGIN_REQUIRED/i.test(lastErr.message)) {
                sawBot = true;
              }
              if (proxy && isProxyWorthRetry(err)) markYoutubeProxyFailure(proxy);
            }
          }
        }
      }
    }

    if (isCompleteEnoughDisk(out)) {
      downloadFailUntil.delete(videoId);
      return out;
    }

    // Après yt-dlp bot-bloqué : encore une chance OAuth+remux (cookies fichier souvent morts).
    try {
      await downloadTrackViaFormatRemux(videoId, out, opts?.userId);
      if (isCompleteEnoughDisk(out) && !isDashBrandFile(out)) {
        downloadFailUntil.delete(videoId);
        return out;
      }
    } catch (err) {
      console.warn(
        `[stream] format-remux post-ytdlp KO ${videoId}:`,
        String((err as Error).message || err).slice(0, 120),
      );
    }

    if (sawBot && lastErr) noteYtDlpFailure(lastErr, opts?.userId);
    const failMsg = lastErr?.message || 'Audio download KO';
    if (existsSync(out) && !isCompleteEnoughDisk(out)) {
      try {
        unlinkSync(out);
      } catch {
        /* ignore */
      }
    }
    // Quand YouTube nous prend pour un robot, réessayer quinze secondes plus tard
    // relance des minutes de tentatives vouées à l'échec pendant que le lecteur
    // attend. Le relais googlevideo sert très bien le morceau en attendant.
    // Remux OAuth a déjà été tenté : cooldown court (pas 3 min) pour ne pas bloquer ensure.
    if (/cooling down|Sign in to confirm|rate-limited|not a bot|LOGIN_REQUIRED/i.test(failMsg)) {
      downloadFailUntil.set(videoId, {
        until: Date.now() + Math.max(45_000, Math.min(120_000, ytDlpCooldownRemainingMs())),
        msg: failMsg.slice(0, 160),
      });
    } else {
      downloadFailUntil.set(videoId, {
        until: Date.now() + 30_000,
        msg: failMsg.slice(0, 160),
      });
    }
    throw lastErr || new Error('Audio download KO');
  })().finally(() => {
    downloadInflight.delete(videoId);
    downloadStartedAt.delete(videoId);
  });

  downloadStartedAt.set(videoId, Date.now());
  downloadInflight.set(videoId, job);
  return job;
}

async function downloadTrackViaInnertube(videoId: string, out: string): Promise<void> {
  const { getSignedStreamYT } = await import('../youtube/streamAuth.js');
  const innertube = (await getSignedStreamYT().catch(() => null)) || (await getYT());
  let stream: ReadableStream<Uint8Array> | null = null;
  let lastErr: unknown;
  for (const client of ['TV', 'WEB_EMBEDDED', 'MWEB', 'IOS', 'ANDROID_VR'] as const) {
    try {
      stream = await innertube.download(videoId, {
        type: 'audio',
        quality: 'best',
        format: 'any',
        client,
      } as any);
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!stream) {
    throw lastErr instanceof Error ? lastErr : new Error('Innertube download indisponible');
  }
  const file = createWriteStream(out);
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        if (!file.write(Buffer.from(value))) {
          await new Promise<void>((r) => file.once('drain', () => r()));
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      file.end(() => resolve());
      file.on('error', reject);
    });
  } catch (err) {
    try {
      file.destroy();
    } catch {
      /* ignore */
    }
    try {
      if (existsSync(out)) unlinkSync(out);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Cookies yt-dlp souvent morts sur VPS ; OAuth Innertube donne encore une URL googlevideo
 * (souvent ftyp=dash). On télécharge puis remux ffmpeg → .m4a progressif jouable Exo.
 */
async function remuxToProgressiveM4a(src: string, dest: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'ffmpeg',
      ['-y', '-i', src, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', dest],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let err = '';
    proc.stderr?.on('data', (c) => {
      err += String(c);
      if (err.length > 3_000) err = err.slice(-3_000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0 && existsSync(dest) && statSync(dest).size > 0) resolve();
      else reject(new Error(`ffmpeg remux ${code}: ${err.slice(-200)}`));
    });
  });
}

/** OAuth/format URL → fichier progressif (remux si DASH). Indépendant des cookies yt-dlp. */
async function downloadTrackViaFormatRemux(
  videoId: string,
  out: string,
  userId?: string,
): Promise<void> {
  const format = await getAudioFormat(videoId, { live: true, forceFresh: false, userId });
  if (!format?.url) throw new Error('format remux: pas d’URL');
  const tmp = `${out}.dash.tmp`;
  try {
    if (existsSync(tmp)) unlinkSync(tmp);
    const upstream = await fetchGooglevideo(format.url, undefined, {
      userId,
      boundProxy: format.viaProxy,
    });
    if (!upstream.ok || !upstream.body) {
      throw new Error(`format remux gv ${upstream.status}`);
    }
    const file = createWriteStream(tmp);
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        if (!file.write(Buffer.from(value))) {
          await new Promise<void>((r) => file.once('drain', () => r()));
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      file.end(() => resolve());
      file.on('error', reject);
    });
    if (!existsSync(tmp) || statSync(tmp).size < MIN_COMPLETE_DISK_BYTES) {
      throw new Error('format remux: téléchargement trop petit');
    }
    if (isDashBrandFile(tmp)) {
      if (existsSync(out)) {
        try {
          unlinkSync(out);
        } catch {
          /* ignore */
        }
      }
      await remuxToProgressiveM4a(tmp, out);
    } else {
      // Déjà progressif : déplacer
      try {
        if (existsSync(out)) unlinkSync(out);
      } catch {
        /* ignore */
      }
      const { renameSync } = await import('node:fs');
      renameSync(tmp, out);
    }
    if (isDashBrandFile(out) || !isCompleteEnoughDisk(out)) {
      throw new Error('format remux: sortie encore DASH / incomplète');
    }
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

void pipeline;
