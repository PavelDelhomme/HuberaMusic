import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import { getAudioFormat, getAudioFormatViaYtDlpOnly, getVideoFormat, getYT, invalidateAudioFormat, invalidateVideoFormat } from '../youtube/yt.js';
import {
  ytDlpCookieArgSets,
  resolveYoutubeCookieHeader,
  YTDLP_AUDIO_FORMAT_CANDIDATES,
  ytDlpRuntimeArgs,
} from '../youtube/youtubeCookies.js';
import {
  peekStreamHead,
  putStreamHead,
  warmStreamHead,
  warmStreamHeadsLazy,
  invalidateStreamHead,
  rememberAdvertisedTotal,
  stableContentTotal,
  safeDiskRangeBounds,
} from './streamHeadCache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const YTDLP = join(ROOT, 'bin', 'yt-dlp');
const CACHE_DIR = join(ROOT, 'data', 'cache');
const STREAM_UPSTREAM_FILE = join(ROOT, 'data', 'stream-upstream.url');

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

async function fetchGooglevideo(url: string, range?: string): Promise<globalThis.Response> {
  return fetch(url, {
    headers: googlevideoHeaders(url, range),
    redirect: 'follow',
  });
}
function ensureCache() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

export function cachePath(videoId: string) {
  ensureCache();
  return join(CACHE_DIR, `${videoId}.m4a`);
}

/** Base URL de l’API maison (env ou fichier volume).
 *  Prod : désactivé sauf ALLOW_STREAM_UPSTREAM=1 ou fichier stream-upstream.url (tunnel maison).
 */
export function resolveStreamUpstream(): string | null {
  const appEnv = String(process.env.APP_ENV || process.env.NODE_ENV || '').toLowerCase();
  let fileUpstream: string | null = null;
  try {
    if (existsSync(STREAM_UPSTREAM_FILE)) {
      const v = readFileSync(STREAM_UPSTREAM_FILE, 'utf8').trim().replace(/\/$/, '');
      if (v.startsWith('http://') || v.startsWith('https://')) fileUpstream = v;
    }
  } catch {
    /* ignore */
  }
  const allow =
    process.env.ALLOW_STREAM_UPSTREAM === '1' ||
    process.env.ALLOW_STREAM_UPSTREAM === 'true' ||
    Boolean(fileUpstream);
  const isProd = appEnv === 'production' || appEnv === 'prod';
  if (isProd && !allow) return null;

  const env = (process.env.STREAM_UPSTREAM || '').trim().replace(/\/$/, '');
  if (env) return env;
  return fileUpstream;
}

/** Prod : relais maison autorisé (env ou fichier tunnel sur le volume). */
export function isStreamUpstreamAllowed(): boolean {
  if (
    process.env.ALLOW_STREAM_UPSTREAM === '1' ||
    process.env.ALLOW_STREAM_UPSTREAM === 'true'
  ) {
    return true;
  }
  try {
    if (!existsSync(STREAM_UPSTREAM_FILE)) return false;
    const v = readFileSync(STREAM_UPSTREAM_FILE, 'utf8').trim();
    return v.startsWith('http://') || v.startsWith('https://');
  } catch {
    return false;
  }
}

/** Relais stream vers l’API maison (évite le blocage IP datacenter YouTube). */
async function proxyStreamToHome(
  req: Request,
  res: Response,
  homeBase: string,
  videoId: string,
  timeoutMs = 52_000,
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
  const upstream = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(Math.max(15_000, timeoutMs)),
  });
  if (upstream.status >= 400) {
    const detail = await upstream.text().catch(() => '');
    throw new Error(`home stream ${upstream.status}: ${detail.slice(0, 180)}`);
  }
  if (!upstream.body) throw new Error('home stream sans corps');
  const reader = upstream.body.getReader();
  const first = await reader.read();
  if (first.done || !first.value?.byteLength) throw new Error('home stream vide');

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

  if (!res.write(Buffer.from(first.value))) {
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

  if (res.headersSent) throw new Error('headers already sent');
  res.status(200);
  res.setHeader('Content-Type', 'audio/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=3600');

  try {
    if (!res.write(Buffer.from(first.value))) {
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
): Promise<void> {
  return spawnYtDlpMediaPipe(videoId, format, cookieArgs, res, 'audio/mp4');
}

function spawnYtDlpMediaPipe(
  videoId: string,
  format: string,
  cookieArgs: string[],
  res: Response,
  contentType: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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
        '--extractor-args',
        'youtube:player_client=android_vr,tv,ios,web_embedded',
        '--user-agent',
        GV_USER_AGENT,
        '--referer',
        'https://www.youtube.com/',
        ...cookieArgs,
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
  });
}

async function streamViaYtDlp(videoId: string, res: Response) {
  // Anonyme d’abord — cookies optionnels (jamais Premium requis)
  const cookieSets = ytDlpCookieArgSets();
  // Peu de formats : chaque spawn peut coûter ~10 s (first-byte timeout)
  const formats = YTDLP_AUDIO_FORMAT_CANDIDATES.slice(0, 2);

  let lastErr: Error | null = null;
  for (const cookieArgs of cookieSets) {
    for (const format of formats) {
      if (res.headersSent) throw new Error('headers already sent');
      try {
        await spawnYtDlpAudioPipe(videoId, format, cookieArgs, res);
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (res.headersSent) throw lastErr;
      }
    }
  }
  throw lastErr || new Error('yt-dlp audio indisponible');
}

/** Pipe progressif vidéo (fallback quand googlevideo 403 depuis le VPS). */
async function streamViaYtDlpVideo(videoId: string, res: Response) {
  const cookieSets = ytDlpCookieArgSets();
  const formats = [
    '18',
    '22',
    'best[height<=480][acodec!=none][vcodec!=none]',
    'best[height<=720][acodec!=none][vcodec!=none]/best',
  ];
  let lastErr: Error | null = null;
  for (const cookieArgs of cookieSets) {
    for (const format of formats) {
      if (res.headersSent) throw new Error('headers already sent');
      try {
        await spawnYtDlpMediaPipe(videoId, format, cookieArgs, res, 'video/mp4');
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (res.headersSent) throw lastErr;
      }
    }
  }
  throw lastErr || new Error('yt-dlp video indisponible');
}

/** Sert une Range entièrement couverte par la tête RAM (TTFB ≪ 50–100 ms). */
function tryServeRamHead(req: Request, res: Response, videoId: string): boolean {
  const head = peekStreamHead(videoId);
  if (!head) return false;
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
  res.end(slice);
  return true;
}

export async function handleStream(req: Request, res: Response) {
  const videoId = String(req.params.id || '');
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    res.status(400).json({ error: 'ID invalide' });
    return;
  }
  // Lecture réelle : cet id passe devant le batch warm (évite 22 s derrière +2/+3).
  bumpWarmPriority(videoId);
  const wantVideo = String(req.query.type || req.query.media || '') === 'video';
  // ExoPlayer / Media3 ouvre souvent SANS Range ou avec `bytes=0-` (illimité).
  // NE JAMAIS tronquer à 1 MiB pour Android : une coupure mid-mdat → EOFException
  // fatale (~64 s) + SimpleCache empoisonné (buf figé ~64500), même après invalidation.
  // Android : attendre le .m4a disque (jusqu’à 45 s) puis servir entier ; sinon laisser
  // le pipeline normal (relais / GV) sans borne artificielle.
  // Autres clients : tête 1 MiB seulement si disque absent (TTFB web).
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
        /PLM-Android/i.test(String(req.headers['user-agent'] || ''));
      if (diskBytes <= 1024 * 1024) {
        const waitMs = isAndroid ? 45_000 : 0;
        if (waitMs > 0) {
          try {
            await Promise.race([
              downloadTrack(videoId).then(() => true),
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
        req.headers.range = 'bytes=0-1048575';
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
    void downloadTrack(videoId).catch((err) => {
      console.warn(
        '[stream] prefetch downloadTrack KO:',
        String((err as Error).message || err).slice(0, 120),
      );
    });
  }
  // Mid-range : deadline plus longue (yt-dlp peut prendre 30–90 s la 1ʳᵉ fois).
  const midNeedsDisk = !wantVideo && audioRangeStart > 0;
  // Vidéo : resolve + fetch GV souvent plus lent (yt-dlp -g / pipe)
  const deadlineAt = Date.now() + (wantVideo ? 40_000 : midNeedsDisk ? 95_000 : 22_000);
  const ensureTime = (label: string) => {
    if (Date.now() >= deadlineAt) throw new Error(`stream deadline (${label})`);
  };
  const withDeadline = async <T>(label: string, p: Promise<T>): Promise<T> => {
    ensureTime(label);
    const left = Math.max(500, deadlineAt - Date.now());
    return await Promise.race([
      p,
      new Promise<T>((_, rej) =>
        setTimeout(() => rej(new Error(`timeout ${label}`)), left),
      ),
    ]);
  };

  const homeUpstream = resolveStreamUpstream();

  // Tête RAM (lazy warm) — avant disque / upstream
  if (!wantVideo && tryServeRamHead(req, res, videoId)) return;

  // Cache disque AVANT relais maison — mid-range seek (GV coupe souvent après ~1 Mo).
  if (!wantVideo) {
    const cached = cachePath(videoId);
    if (existsSync(cached) && !statSync(cached).size) {
      try {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(cached);
      } catch {
        /* ignore */
      }
    }
    if (midNeedsDisk && (!existsSync(cached) || !statSync(cached).size)) {
      try {
        await withDeadline('downloadTrack', downloadTrack(videoId));
      } catch (err) {
        console.warn(
          '[stream] mid-range downloadTrack KO:',
          String((err as Error).message || err).slice(0, 160),
        );
      }
    }
    if (existsSync(cached) && statSync(cached).size > 0) {
      const size = statSync(cached).size;
      // Vérité disque pour les lectures ; total header ≈ stable (mais bounds toujours sur size).
      const advertised = stableContentTotal(videoId, size);
      rememberAdvertisedTotal(videoId, advertised);
      const totalHdr = Math.min(advertised, size);
      const range = req.headers.range;
      if (range) {
        const bounds = safeDiskRangeBounds(size, String(range));
        if (!bounds.ok) {
          res.status(416);
          res.setHeader('Content-Range', `bytes */${totalHdr}`);
          res.setHeader('Accept-Ranges', 'bytes');
          res.end();
          return;
        }
        const { start, end } = bounds;
        const len = end - start + 1;
        if (start === 0 && len > 0 && len <= 1024 * 1024) {
          try {
            const { openSync, readSync, closeSync } = await import('node:fs');
            const fd = openSync(cached, 'r');
            try {
              const buf = Buffer.alloc(len);
              readSync(fd, buf, 0, len, 0);
              putStreamHead(videoId, buf, { totalSize: totalHdr, contentType: 'audio/mp4' });
              res.status(206);
              res.setHeader('Content-Range', `bytes 0-${len - 1}/${totalHdr}`);
              res.setHeader('Accept-Ranges', 'bytes');
              res.setHeader('Content-Length', len);
              res.setHeader('Content-Type', 'audio/mp4');
              res.setHeader('X-PLM-Stream-Cache', 'disk-ram');
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
            res.setHeader('Content-Range', `bytes */${Math.min(totalHdr, Math.max(0, sizeNow))}`);
            res.setHeader('Accept-Ranges', 'bytes');
            res.end();
            return;
          }
          const start2 = again.start;
          const end2 = again.end;
          const len2 = end2 - start2 + 1;
          const totalNow = Math.min(totalHdr, sizeNow);
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start2}-${end2}/${totalNow}`);
          res.setHeader('Accept-Ranges', 'bytes');
          res.setHeader('Content-Length', len2);
          res.setHeader('Content-Type', 'audio/mp4');
          res.setHeader('X-PLM-Stream-Cache', 'disk');
          const { createReadStream } = await import('node:fs');
          const rs = createReadStream(cached, { start: start2, end: end2 });
          rs.on('error', (err) => {
            console.warn(
              `[stream ${videoId}] disk range KO:`,
              String(err?.message || err).slice(0, 120),
            );
            if (!res.headersSent) {
              res.status(416);
              res.setHeader('Content-Range', `bytes */${totalNow}`);
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
            res.setHeader('Content-Range', `bytes */${totalHdr}`);
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

  // Relais maison (IP résidentielle) — mid-range déjà tenté en local ci-dessus.
  if (homeUpstream) {
    const proxyTimeoutMs = midNeedsDisk ? 130_000 : 52_000;
    try {
      await proxyStreamToHome(req, res, homeUpstream, videoId, proxyTimeoutMs);
      return;
    } catch (err) {
      if (endIfHeadersSent(res)) return;
      const msg = String((err as Error).message || err);
      console.warn('[stream] STREAM_UPSTREAM KO:', msg.slice(0, 180));
      // Toujours tenter les backends VPS (OAuth / cookies / yt-dlp) après un relais maison KO.
      // Avant : sans STREAM_UPSTREAM_FALLBACK=1 on renvoyait 503 → erreurs player sur plein de titres
      // dès que le PC/tunnel était coupé, alors que l’OAuth TV pouvait encore servir le flux.
      // Opt-out explicite : STREAM_UPSTREAM_FALLBACK=0
      const forceHomeOnly =
        process.env.STREAM_UPSTREAM_FALLBACK === '0' ||
        process.env.STREAM_UPSTREAM_FALLBACK === 'false';
      if (forceHomeOnly && !midNeedsDisk) {
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
            ? 'Relais maison KO — sur le PC : bash scripts/deploy/link-home-stream.sh (laisser allumé).'
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

  // (cache disque déjà traité plus haut)

  try {
    ensureTime('format');
    let format = wantVideo
      ? await withDeadline('getVideoFormat', getVideoFormat(videoId))
      : await withDeadline('getAudioFormat', getAudioFormat(videoId, { userId: (req as any).userId }));
    if (format.url) {
      // Clients natifs (Android ExoPlayer) : 302 direct googlevideo = plus rapide.
      // Navigateur web : proxy (CORS / Workbox).
      if (wantsDirectRedirect(req)) {
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
              getAudioFormat(videoId, { userId: (req as any).userId }),
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
          format = await withDeadline('ytDlpUrl', getAudioFormatViaYtDlpOnly(videoId));
          upstream = await withDeadline('fetchGV3', fetchGooglevideo(format.url, rangeHdr));
        } catch {
          /* fallback pipe plus bas */
        }
      }
      // Toujours 403 → laisser les fallbacks yt-dlp / Innertube (log soft, pas d’alarme)
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
      if (res.headersSent) return;
      res.status(upstream.status);
      const ct = upstream.headers.get('content-type');
      const cr = upstream.headers.get('content-range');
      const ar = upstream.headers.get('accept-ranges');
      if (ct) res.setHeader('Content-Type', ct);
      else res.setHeader('Content-Type', wantVideo ? 'video/mp4' : 'audio/mp4');
      if (cr) res.setHeader('Content-Range', cr);
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
          putStreamHead(videoId, Buffer.from(first.value), {
            totalSize,
            contentType: ct || 'audio/mp4',
          });
          if (totalSize != null) rememberAdvertisedTotal(videoId, totalSize);
        }
      }
      if (!res.write(Buffer.from(first.value))) {
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
    if (!/upstream audio 403|upstream audio 401/.test(msg)) {
      console.warn('[stream] format/proxy KO:', msg.slice(0, 160));
    }
  }

  // Fallbacks — vidéo : pipe yt-dlp progressif ; audio : yt-dlp puis Innertube
  if (wantVideo) {
    try {
      ensureTime('ytdlpVideo');
      await withDeadline('ytdlpVideoPipe', streamViaYtDlpVideo(videoId, res));
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
    await withDeadline('ytdlpPipe', streamViaYtDlp(videoId, res));
    return;
  } catch (err) {
    if (endIfHeadersSent(res)) return;
    const msg = String((err as Error).message || err);
    if (!/format is not available|first-byte timeout|stream deadline|timeout /i.test(msg)) {
      console.warn('[stream] yt-dlp KO:', msg.slice(0, 160));
    }
  }

  try {
    await streamViaInnertube(videoId, res);
  } catch (err) {
    if (!res.headersSent) {
      const cookies = resolveYoutubeCookieHeader();
      console.warn('[stream] all backends KO:', String((err as Error).message || err).slice(0, 160));
      res.status(502).json({
        error: 'Impossible de streamer audio',
        detail: String(err),
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

  // VPS → PC maison : chauffe le resolve chez soi, mais renvoie TOUJOURS le proxy API.
  // Les URLs googlevideo sont liées à l’IP du PC maison → 403 depuis navigateur/téléphone.
  const homeUpstream = resolveStreamUpstream();
  if (homeUpstream) {
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
        signal: AbortSignal.timeout(30_000),
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

  try {
    const format = wantVideo ? await getVideoFormat(videoId) : await getAudioFormat(videoId);
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
const warmQueue: string[] = [];
const warmQueued = new Set<string>();
let warmWorkers = 0;
const WARM_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.STREAM_WARM_CONCURRENCY || 1) || 1));
const WARM_BATCH_CAP = Math.max(4, Math.min(24, Number(process.env.STREAM_WARM_BATCH_CAP || 6) || 6));

async function runWarmWorker() {
  if (warmWorkers >= WARM_CONCURRENCY) return;
  warmWorkers += 1;
  try {
    while (warmQueue.length) {
      const id = warmQueue.shift();
      if (!id) break;
      warmQueued.delete(id);
      try {
        const format = await getAudioFormat(id);
        if (format?.url) {
          await warmStreamHead(id, (range) => fetchGooglevideo(format.url, range));
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

function bumpWarmPriority(id: string) {
  if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) return;
  const i = warmQueue.indexOf(id);
  if (i > 0) {
    warmQueue.splice(i, 1);
    warmQueue.unshift(id);
  }
}

function enqueueStreamWarm(ids: string[]) {
  if (!ids.length) return;
  const [first, ...rest] = ids;
  const pushFront = (id: string) => {
    if (warmQueued.has(id)) {
      bumpWarmPriority(id);
      return;
    }
    warmQueued.add(id);
    warmQueue.unshift(id);
  };
  if (first) pushFront(first);
  for (const id of rest) {
    if (warmQueued.has(id)) continue;
    warmQueued.add(id);
    warmQueue.push(id);
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
  // Mode legacy (tests) : attendre les formats si wait=1
  const wait =
    String(req.query.wait || req.body?.wait || '') === '1' ||
    String(req.query.wait || req.body?.wait || '') === 'true';
  if (wait) {
    const results = await Promise.allSettled(ids.map((id: string) => getAudioFormat(id)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    res.json({ ok: true, requested: ids.length, warmed: ok, waited: true });
    warmStreamHeadsLazy(
      ids,
      async (id) => {
        const format = await getAudioFormat(id);
        return (range) => fetchGooglevideo(format.url, range);
      },
      Math.min(6, ids.length),
    );
    return;
  }
  enqueueStreamWarm(ids);
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

export async function downloadTrack(videoId: string): Promise<string> {
  ensureCache();
  const out = cachePath(videoId);
  if (existsSync(out)) {
    const size = statSync(out).size;
    if (size > 0) return out;
    // Fichier 0 octet (yt-dlp interrompu) → ne pas bloquer les retries
    try {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(out);
    } catch {
      /* ignore */
    }
  }
  const pending = downloadInflight.get(videoId);
  if (pending) return pending;

  const job = (async (): Promise<string> => {
    if (existsSync(out) && statSync(out).size > 0) return out;

    if (existsSync(YTDLP)) {
      let lastErr: Error | null = null;
      const cookieSets = ytDlpCookieArgSets({ forDownload: true });
      for (const cookieArgs of cookieSets) {
        for (const format of YTDLP_AUDIO_FORMAT_CANDIDATES) {
          try {
            await new Promise<void>((resolve, reject) => {
              const proc = spawn(
                YTDLP,
                [
                  '-f',
                  format,
                  '-x',
                  '--audio-format',
                  'm4a',
                  '--audio-quality',
                  '0',
                  '-o',
                  out,
                  '--no-playlist',
                  '--quiet',
                  '--no-warnings',
                  ...ytDlpRuntimeArgs(),
                  ...cookieArgs,
                  `https://www.youtube.com/watch?v=${videoId}`,
                ],
                { stdio: 'inherit' },
              );
              proc.on('close', (code) =>
                code === 0 ? resolve() : reject(new Error(`yt-dlp ${code}`)),
              );
              proc.on('error', reject);
            });
            if (existsSync(out) && statSync(out).size > 0) return out;
          } catch (err) {
            lastErr = err instanceof Error ? err : new Error(String(err));
          }
        }
      }
      if (!existsSync(out) || !statSync(out).size) {
        try {
          await downloadTrackViaInnertube(videoId, out);
          if (existsSync(out) && statSync(out).size > 0) return out;
        } catch (innErr) {
          if (lastErr) throw lastErr;
          throw innErr instanceof Error ? innErr : new Error(String(innErr));
        }
        if (lastErr) throw lastErr;
      }
    } else {
      await downloadTrackViaInnertube(videoId, out);
    }

    return out;
  })().finally(() => {
    downloadInflight.delete(videoId);
  });

  downloadInflight.set(videoId, job);
  return job;
}

async function downloadTrackViaInnertube(videoId: string, out: string): Promise<void> {
  const { getSignedStreamYT } = await import('../youtube/streamAuth.js');
  const innertube = (await getSignedStreamYT().catch(() => null)) || (await getYT());
  let stream: ReadableStream<Uint8Array> | null = null;
  let lastErr: unknown;
  for (const client of ['ANDROID_VR', 'TV', 'IOS', 'WEB_EMBEDDED', 'MWEB'] as const) {
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
}

void pipeline;
