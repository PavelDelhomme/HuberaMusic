import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, openSync, readSync, closeSync, unlinkSync, readFileSync, statSync } from 'node:fs';
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
  markYoutubeProxyFailure,
  markYoutubeProxySuccess,
  youtubeProxyAttempts,
  youtubeProxyFreeEnabled,
  ensureYoutubeProxyPool,
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
import { noteStreamNote, noteStreamSource, watchStreamRequest } from './streamLog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const YTDLP = join(ROOT, 'bin', 'yt-dlp');
const CACHE_DIR = join(ROOT, 'data', 'cache');
const STREAM_UPSTREAM_FILE = join(ROOT, 'data', 'stream-upstream.url');

/** Dernière lecture servie — les travaux de fond s'effacent devant une écoute en cours. */
let lastStreamAtMs = 0;

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

async function fetchGooglevideo(url: string, range?: string): Promise<globalThis.Response> {
  const doFetch = () =>
    fetch(url, {
      headers: googlevideoHeaders(url, range),
      redirect: 'follow',
    });
  try {
    const first = await doFetch();
    // 502/503/504 googlevideo souvent transitoires — 1 retry court avant de remonter au client.
    if (first.status === 502 || first.status === 503 || first.status === 504) {
      await new Promise((r) => setTimeout(r, 280));
      return await doFetch();
    }
    return first;
  } catch (err) {
    await new Promise((r) => setTimeout(r, 220));
    return await doFetch();
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

function isCompleteEnoughDisk(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const size = statSync(path).size;
    if (size < MIN_COMPLETE_DISK_BYTES) return false;
    if (isDashBrandFile(path)) return false;
    return true;
  } catch {
    return false;
  }
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

/**
 * Sonde rapide : si le PC maison est éteint, on skip le relais immédiatement
 * (sinon 20–52 s de BUFFERING avant les backends VPS/proxies).
 */
async function isHomeUpstreamReachable(homeBase: string): Promise<boolean> {
  const base = homeBase.replace(/\/$/, '');
  if (
    homeAliveCache &&
    homeAliveCache.base === base &&
    Date.now() - homeAliveCache.at < 45_000
  ) {
    return homeAliveCache.ok;
  }
  try {
    const r = await fetch(`${base}/api/health`, {
      signal: AbortSignal.timeout(1_400),
      headers: { Accept: 'application/json' },
    });
    const ok = r.ok;
    homeAliveCache = { at: Date.now(), ok, base };
    return ok;
  } catch {
    homeAliveCache = { at: Date.now(), ok: false, base };
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
  // Timeout global = plafond ; first-byte plus court pour open Android (évite 20 s BUFFERING).
  const upstream = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(Math.max(firstByteTimeoutMs + 2_000, timeoutMs)),
  });
  if (upstream.status >= 400) {
    const detail = await upstream.text().catch(() => '');
    throw new Error(`home stream ${upstream.status}: ${detail.slice(0, 180)}`);
  }
  if (!upstream.body) throw new Error('home stream sans corps');
  const reader = upstream.body.getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise<ReadableStreamReadResult<Uint8Array>>((_, rej) =>
      setTimeout(
        () => rej(new Error(`home first-byte timeout ${firstByteTimeoutMs}ms`)),
        Math.max(800, firstByteTimeoutMs),
      ),
    ),
  ]);
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
    max: preferProxies ? 10 : 5,
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
  // Titre déjà connu comme mort : rejouer directement le remplaçant validé.
  {
    const known = getReplacementId(videoId);
    if (known) {
      noteStreamSource(res, `remplacement → ${known}`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-PLM-Replaced-From', videoId);
      res.redirect(302, streamPathFor(req, known));
      return;
    }
  }
  // Lecture réelle : cet id passe devant le batch warm (évite 22 s derrière +2/+3).
  bumpWarmPriority(videoId);

  // Maison offline / VPS sans relais → proxies gratuits avant IP datacenter.
  const homeUpstream = resolveStreamUpstream();
  const preferProxies = homeUpstream
    ? !(await isHomeUpstreamReachable(homeUpstream))
    : youtubeProxyFreeEnabled();

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
    const waitMs = 75_000;
    try {
      await Promise.race([
        downloadTrack(videoId, { progressiveOnly: true, preferProxies }).then(() => true),
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
      if (diskBytes <= 1024 * 1024) {
        // Android : attente courte seulement — 45 s bloquait derrière nginx → 504 Exo.
        // Si format/tête déjà chauds → ne PAS attendre le .m4a (volait 2.5 s à Exo).
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
        // Android : un peu plus long pour obtenir un .m4a progressif (anti-DASH).
        const waitMs = isAndroid && !formatHot && !ramHot ? 4_000 : 0;
        if (waitMs > 0) {
          try {
            await Promise.race([
              downloadTrack(videoId, { progressiveOnly: true, preferProxies }).then(() => true),
              new Promise<boolean>((r) => setTimeout(() => r(false), waitMs)),
            ]);
          } catch {
            /* ignore */
          }
          refreshDisk();
        }
      }
      if (diskBytes > 1024 * 1024) {
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
    if (!isYtDlpCoolingDown()) {
      // Progressif pour TOUS (web + Android) — rejet DASH universel depuis 1.3.240.
      void downloadTrack(videoId, {
        progressiveOnly: true,
        preferProxies,
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
    (wantOffline ? 95_000 : wantVideo ? 40_000 : midNeedsDisk ? 95_000 : 35_000);
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
      downloadTrack(videoId, { progressiveOnly: true, preferProxies }).catch(() => {
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
      const dl = downloadTrack(videoId, { progressiveOnly: androidClient, preferProxies });
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
      // Partiel mort (échec yt-dlp) : ne pas servir à Exo (EOF / stall).
      if (size > 0 && !incomplete && !isCompleteEnoughDisk(cached)) {
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
      console.warn(
        '[stream] STREAM_UPSTREAM offline (maison) — VPS + proxies gratuits',
      );
    } else {
      const proxyTimeoutMs = skipHomeForOpenAndroid
        ? 10_000
        : midNeedsDisk
          ? 18_000
          : 20_000;
      const firstByteMs = skipHomeForOpenAndroid ? 3_500 : 8_000;
      try {
        await proxyStreamToHome(req, res, homeUpstream, videoId, proxyTimeoutMs, firstByteMs);
        return;
      } catch (err) {
        if (endIfHeadersSent(res)) return;
        const msg = String((err as Error).message || err);
        console.warn('[stream] STREAM_UPSTREAM KO:', msg.slice(0, 180));
        homeAliveCache = {
          at: Date.now(),
          ok: false,
          base: homeUpstream.replace(/\/$/, ''),
        };
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
      ? await withDeadline('getVideoFormat', getVideoFormat(videoId))
      : await withDeadline(
          // Progressif pour web + Android (DASH Innertube rejeté → silence navigateur).
          'getAudioFormatProgressive',
          getAudioFormatViaYtDlpOnly(videoId, {
            live: true,
            preferProxies,
          }).catch(() =>
            getAudioFormat(videoId, {
              userId: (req as any).userId,
              forceFresh: true,
              retryN,
              live: true,
            }),
          ),
        );
    if (format.url) {
      // Clients natifs (Android ExoPlayer) : 302 direct googlevideo = plus rapide.
      // Navigateur web : proxy (CORS / Workbox).
      if (wantsDirectRedirect(req)) {
        noteStreamSource(res, 'redirection googlevideo');
        res.setHeader('Cache-Control', 'no-store');
        if (format.bitrate) res.setHeader('X-PLM-Audio-Bitrate', String(format.bitrate));
        res.redirect(302, format.url);
        return;
      }
      const rangeHdr = req.headers.range ? String(req.headers.range) : undefined;
      let upstream = await withDeadline('fetchGV', fetchGooglevideo(format.url, rangeHdr));
      // URL morte / anti-bot → invalide le cache format et retente 1× avant fallbacks
      if (upstream.status === 403 || upstream.status === 401 || upstream.status === 404) {
        invalidateAudioFormat(videoId);
        invalidateVideoFormat(videoId);
        invalidateStreamHead(videoId);
        format = wantVideo
          ? await withDeadline('getVideoFormat2', getVideoFormat(videoId))
          : await withDeadline(
              'getAudioFormat2',
              getAudioFormat(videoId, { userId: (req as any).userId, live: true }),
            );
        if (!format.url) throw new Error(`upstream ${wantVideo ? 'video' : 'audio'} ${upstream.status}`);
        upstream = await withDeadline('fetchGV2', fetchGooglevideo(format.url, rangeHdr));
      }
      // Innertube toujours 403 → URL yt-dlp (souvent OK sans cookies fichier)
      if (
        !wantVideo &&
        (upstream.status === 403 || upstream.status === 401 || upstream.status === 404)
      ) {
        try {
          format = await withDeadline('ytDlpUrl', getAudioFormatViaYtDlpOnly(videoId, { live: true, preferProxies }));
          upstream = await withDeadline('fetchGV3', fetchGooglevideo(format.url, rangeHdr));
        } catch {
          /* fallback pipe plus bas */
        }
      }
      // 5xx amont : invalide + 1 re-resolve format (URL neuve) avant d’abandonner.
      if (!wantVideo && (upstream.status === 502 || upstream.status === 503 || upstream.status === 504)) {
        invalidateAudioFormat(videoId);
        invalidateStreamHead(videoId);
        try {
          format = await withDeadline(
            'getAudioFormat5xx',
            getAudioFormat(videoId, { userId: (req as any).userId, live: true }),
          );
          if (format.url) {
            await new Promise((r) => setTimeout(r, 200));
            upstream = await withDeadline('fetchGV5xx', fetchGooglevideo(format.url, rangeHdr));
          }
        } catch {
          /* throw plus bas si toujours KO */
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
        downloadTrack(videoId, { progressiveOnly: true, preferProxies }).catch(() => {
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
    if (!/upstream audio 403|upstream audio 401|upstream audio DASH/i.test(msg)) {
      console.warn('[stream] format/proxy KO:', msg.slice(0, 160));
    }
    // Titre mort : remplacer tout de suite (évite 60–100 s de proxies inutiles).
    if (!wantVideo && looksUnavailable(msg)) {
      try {
        const replacement =
          getReplacementId(videoId) ||
          (await Promise.race([
            findReplacementId(videoId, { userId: (req as any).userId }),
            // Cap court : l’app doit recevoir 410 vite pour skipper (Nothing).
            new Promise<null>((r) => setTimeout(() => r(null), 2_500)),
          ]));
        if (replacement && !res.headersSent) {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-PLM-Replaced-From', videoId);
          res.redirect(302, streamPathFor(req, replacement));
          return;
        }
      } catch (replErr) {
        console.warn(
          '[stream] remplacement early KO:',
          String((replErr as Error).message || replErr).slice(0, 140),
        );
      }
      // Pas de remplaçant : 410 immédiat — le client skip sans 6× retries / 50 s.
      if (!res.headersSent) {
        res.status(410).json({
          error: 'Impossible de streamer audio',
          code: 'VIDEO_UNAVAILABLE',
          detail: msg.slice(0, 240),
          hint: 'Titre retiré / privé — passage au suivant côté app',
        });
        return;
      }
    }
  }

  // Après rejet DASH / 403 : laisser le téléchargement progressif aboutir, puis servir disque.
  if (!wantVideo && !res.headersSent && !midNeedsDisk) {
    const cachedProg = cachePath(videoId);
    if (!isCompleteEnoughDisk(cachedProg)) {
      try {
        await Promise.race([
          downloadTrack(videoId, { progressiveOnly: true, preferProxies }),
          new Promise<void>((r) => setTimeout(r, 14_000)),
        ]);
      } catch {
        /* yt-dlp pipe ci-dessous */
      }
    }
    if (isCompleteEnoughDisk(cachedProg)) {
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
      // Remplacement : toujours tenter (unavailable OU transient CDN). Un mapping
      // déjà connu court-circuite ; sinon findReplacementId pour tout le monde.
      if (!wantVideo) {
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
      void warmStreamHead(videoId, (range) => fetchGooglevideo(format.url, range));
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
let diskWarmBusy = false;

function diskWarmCap(): number {
  return Math.max(40, Math.min(400, Number(process.env.TASTE_WARM_DISK_QUEUE || 200) || 200));
}

function likesDiskWarmCap(): number {
  return Math.max(80, Math.min(2000, Number(process.env.LIKES_DISK_WARM_QUEUE || 800) || 800));
}

async function runDiskWarmWorker() {
  if (diskWarmBusy) return;
  diskWarmBusy = true;
  try {
    while (likesDiskWarmQueue.length || diskWarmQueue.length) {
      // Lecture utilisateur : ne PAS consommer de slots yt-dlp (sinon Aléatoire timeout).
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
        await downloadTrack(id);
      } catch {
        /* best-effort — le titre reste candidate au prochain sweep */
      }
      await new Promise((r) => setTimeout(r, isPlaybackHot(60_000) ? 2_000 : 400));
    }
  } finally {
    diskWarmBusy = false;
    if (likesDiskWarmQueue.length || diskWarmQueue.length) void runDiskWarmWorker();
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
    busy: diskWarmBusy,
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
          await warmStreamHead(job.id, (range) => fetchGooglevideo(format.url, range));
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
        return (range) => fetchGooglevideo(format.url, range);
      },
      Math.min(6, ids.length),
    );
    return;
  }
  enqueueStreamWarm(ids, uid);
  res.json({
    ok: true,
    requested: ids.length,
    queued: true,
    pending: warmQueue.length + warmWorkers,
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

export async function downloadTrack(
  videoId: string,
  opts?: { progressiveOnly?: boolean; preferProxies?: boolean },
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

    // 1) Innertube — sauf si progressiveOnly (DASH fréquent → refuse hors-ligne)
    if (!opts?.progressiveOnly) {
      try {
        await downloadTrackViaInnertube(videoId, out);
        if (isCompleteEnoughDisk(out)) {
          return out;
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

    if (!existsSync(YTDLP)) {
      throw new Error('Audio download indisponible (innertube + yt-dlp)');
    }

    // Innertube a pu laisser un .m4a vide / fd ouvert — purge avant yt-dlp
    // sinon yt-dlp exit 0 puis le close late tronque le fichier → « yt-dlp 0 ».
    if (existsSync(out) && !isCompleteEnoughDisk(out)) {
      try {
        unlinkSync(out);
      } catch {
        /* ignore */
      }
    }

    const { withYtDlpSlot, isYtDlpCoolingDown, noteYtDlpFailure, ytDlpCooldownRemainingMs } =
      await import('./ytDlpGate.js');

    // 2) yt-dlp via proxies (même pendant cooldown VPS) — disque mid-range Android
    let lastErr: Error | null = null;
    let sawBot = false;
    const cookieSets = ytDlpCookieArgSets({ forDownload: true });
    const extractorSets = ytDlpExtractorArgSets();
    const proxies = await youtubeProxyAttempts({
      max: opts?.preferProxies ? 10 : 5,
      includeDirect: true,
      directLast: Boolean(opts?.preferProxies),
      shuffle: Boolean(opts?.preferProxies),
      probe: Boolean(opts?.preferProxies),
    });
    for (const proxy of proxies) {
      if (!proxy && isYtDlpCoolingDown()) continue;
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
                { bypassCooldown: true, noteFailure: false },
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
    if (sawBot && lastErr) noteYtDlpFailure(lastErr);
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
    if (/cooling down|Sign in to confirm|rate-limited|not a bot|LOGIN_REQUIRED/i.test(failMsg)) {
      downloadFailUntil.set(videoId, {
        until: Date.now() + Math.max(180_000, ytDlpCooldownRemainingMs()),
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

void pipeline;
