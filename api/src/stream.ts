import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import { getAudioFormat, getAudioFormatViaYtDlpOnly, getVideoFormat, getYT, invalidateAudioFormat } from './yt.js';
import {
  ytDlpCookieArgSets,
  resolveYoutubeCookieHeader,
  YTDLP_AUDIO_FORMAT_CANDIDATES,
} from './youtubeCookies.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
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
    if (/ANDROID/i.test(c)) return GV_UA_ANDROID;
    if (/IOS|TVHTML5/i.test(c)) return GV_UA_IOS;
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

/** Base URL de l’API maison (env ou fichier volume). */
export function resolveStreamUpstream(): string | null {
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

/** Relais stream vers l’API maison (évite le blocage IP datacenter YouTube). */
async function proxyStreamToHome(
  req: Request,
  res: Response,
  homeBase: string,
  videoId: string,
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
    signal: AbortSignal.timeout(45_000),
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
  if (cr) res.setHeader('Content-Range', cr);
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
  const stream = await innertube.download(videoId, {
    type: 'audio',
    quality: 'best',
    format: 'any',
  });

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
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      reject(err);
    };

    proc.stdout.once('data', (chunk: Buffer) => {
      if (settled) return;
      try {
        if (res.headersSent) {
          fail(new Error('headers already sent'));
          return;
        }
        started = true;
        res.status(200);
        res.setHeader('Content-Type', 'audio/mp4');
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

  let lastErr: Error | null = null;
  for (const cookieArgs of cookieSets) {
    for (const format of YTDLP_AUDIO_FORMAT_CANDIDATES) {
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

export async function handleStream(req: Request, res: Response) {
  const videoId = String(req.params.id || '');
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    res.status(400).json({ error: 'ID invalide' });
    return;
  }
  const wantVideo = String(req.query.type || req.query.media || '') === 'video';

  // Cache disque = audio only — ne pas servir .m4a pour ?type=video
  if (!wantVideo) {
    const cached = cachePath(videoId);
    if (existsSync(cached)) {
      const size = statSync(cached).size;
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        const start = m ? Number(m[1]) : 0;
        const end = m && m[2] ? Number(m[2]) : size - 1;
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', end - start + 1);
        res.setHeader('Content-Type', 'audio/mp4');
        const { createReadStream } = await import('node:fs');
        createReadStream(cached, { start, end }).pipe(res);
        return;
      }
      res.setHeader('Content-Type', 'audio/mp4');
      res.setHeader('Content-Length', size);
      res.setHeader('Accept-Ranges', 'bytes');
      const { createReadStream } = await import('node:fs');
      createReadStream(cached).pipe(res);
      return;
    }
  }

  // VPS → PC maison (IP résidentielle) : STREAM_UPSTREAM ou data/stream-upstream.url
  const homeUpstream = resolveStreamUpstream();
  if (homeUpstream) {
    try {
      await proxyStreamToHome(req, res, homeUpstream, videoId);
      return;
    } catch (err) {
      if (endIfHeadersSent(res)) return;
      console.warn('[stream] STREAM_UPSTREAM KO, fallback local VPS:', (err as Error).message);
      // continue → résolution VPS (yt-dlp/Innertube, cookies optionnels)
    }
  }

  try {
    let format = wantVideo ? await getVideoFormat(videoId) : await getAudioFormat(videoId);
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
      let upstream = await fetchGooglevideo(format.url, rangeHdr);
      // URL morte / anti-bot → invalide le cache format et retente 1× avant fallbacks
      if (upstream.status === 403 || upstream.status === 401 || upstream.status === 404) {
        invalidateAudioFormat(videoId);
        format = wantVideo ? await getVideoFormat(videoId) : await getAudioFormat(videoId);
        if (!format.url) throw new Error(`upstream ${wantVideo ? 'video' : 'audio'} ${upstream.status}`);
        upstream = await fetchGooglevideo(format.url, rangeHdr);
      }
      // Innertube toujours 403 → URL yt-dlp (souvent OK sans cookies fichier)
      if (
        !wantVideo &&
        (upstream.status === 403 || upstream.status === 401 || upstream.status === 404)
      ) {
        try {
          format = await getAudioFormatViaYtDlpOnly(videoId);
          upstream = await fetchGooglevideo(format.url, rangeHdr);
        } catch {
          /* fallback pipe plus bas */
        }
      }
      // Toujours 403 → laisser les fallbacks yt-dlp / Innertube (log soft, pas d’alarme)
      if (upstream.status >= 400) {
        invalidateAudioFormat(videoId);
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

  // Fallbacks audio-only — yt-dlp avant Innertube download (souvent « No valid URL to decipher »)
  if (wantVideo) {
    if (!res.headersSent) {
      res.status(502).json({
        error: 'Impossible de streamer la vidéo',
        hint: 'Format progressif indisponible pour ce titre',
      });
    }
    return;
  }

  try {
    await streamViaYtDlp(videoId, res);
    return;
  } catch (err) {
    if (endIfHeadersSent(res)) return;
    const msg = String((err as Error).message || err);
    if (!/format is not available/i.test(msg)) {
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
  } catch (err) {
    res.status(502).json({
      error: wantVideo ? 'Impossible de résoudre la vidéo' : 'Impossible de résoudre le stream',
      detail: String(err),
    });
  }
}

/** Warm batch : déchiffre plusieurs formats en parallèle (prefetch file d’attente). */
export async function handleStreamWarm(req: Request, res: Response) {
  const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const ids = [
    ...new Set(
      raw
        .map((x: unknown) => String(x || ''))
        .filter((id: string): id is string => /^[a-zA-Z0-9_-]{11}$/.test(id)),
    ),
  ].slice(0, 32) as string[];
  if (!ids.length) {
    res.status(400).json({ error: 'ids requis' });
    return;
  }
  const results = await Promise.allSettled(ids.map((id: string) => getAudioFormat(id)));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  res.json({ ok: true, requested: ids.length, warmed: ok });
}

/**
 * Redirect 302 vers googlevideo — uniquement si demandé explicitement (?redirect=1).
 * Ne pas auto-rediriger ExoPlayer/OkHttp : l’URL CDN est liée à l’IP du serveur API,
 * donc un client sur une autre IP reçoit 403.
 */
function wantsDirectRedirect(req: Request): boolean {
  return String(req.query.redirect || '') === '1';
}

export async function downloadTrack(videoId: string): Promise<string> {
  ensureCache();
  const out = cachePath(videoId);
  if (existsSync(out) && statSync(out).size > 0) {
    return out;
  }

  if (existsSync(YTDLP)) {
    let lastErr: Error | null = null;
    const cookieSets = ytDlpCookieArgSets();
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
      if (lastErr) throw lastErr;
    }
  } else {
    const innertube = await getYT();
    const stream = await innertube.download(videoId, {
      type: 'audio',
      quality: 'best',
    });
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

  return out;
}

void pipeline;
