import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request, Response } from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', '..', '..', 'data', 'img-cache');
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

const ALLOWED =
  /^(https?:\/\/)?([a-z0-9.-]+\.)?(googleusercontent\.com|ggpht\.com|ytimg\.com|youtube\.com|yt3\.ggpht\.com)\//i;

/** Préfère maxres / hq720 quand dispo (pochette carrée moins « piliers »). */
const YTIMG_SAFE = ['maxresdefault.jpg', 'hq720.jpg', 'sddefault.jpg', 'hqdefault.jpg', 'mqdefault.jpg', 'default.jpg'] as const;

function ytimgChain(videoId: string): string[] {
  return YTIMG_SAFE.map((f) => `https://i.ytimg.com/vi/${videoId}/${f}`);
}

async function fetchImage(url: string): Promise<{ buf: Buffer; type: string } | null> {
  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: 'https://music.youtube.com/',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) return null;
    const buf = Buffer.from(await upstream.arrayBuffer());
    // Placeholder YouTube 120×90 parfois servi en 200 — trop petit = inutile
    if (buf.length < 2000) return null;
    const type = upstream.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(type) && !type.includes('octet-stream')) return null;
    return { buf, type: type.includes('octet-stream') ? 'image/jpeg' : type };
  } catch {
    return null;
  }
}

function cacheGet(key: string): { buf: Buffer; type: string } | null {
  const file = join(CACHE_DIR, key);
  const meta = join(CACHE_DIR, `${key}.meta`);
  if (!existsSync(file) || !existsSync(meta)) return null;
  const age = Date.now() - statSync(file).mtimeMs;
  if (age >= 7 * 24 * 3600 * 1000) return null;
  return { buf: readFileSync(file), type: readFileSync(meta, 'utf8') || 'image/jpeg' };
}

function cachePut(key: string, buf: Buffer, type: string) {
  writeFileSync(join(CACHE_DIR, key), buf);
  writeFileSync(join(CACHE_DIR, `${key}.meta`), type);
}

function sendImage(res: Response, buf: Buffer, type: string, hit: string) {
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  res.setHeader('X-YTM-Img', hit);
  res.send(buf);
}

/**
 * Proxy image :
 * - `?u=<url>` : une URL (ggpht / ytimg…)
 * - `?v=<videoId>` : chaîne ytimg fiable + fallback SVG (jamais 404 navigateur)
 * - les deux : essaie `u` puis la chaîne `v`
 */
export async function handleImageProxy(req: Request, res: Response) {
  try {
    const rawU = String(req.query.u || '');
    const videoId = String(req.query.v || '').trim();
    const candidates: string[] = [];

    if (rawU) {
      let url: string;
      try {
        url = decodeURIComponent(rawU);
      } catch {
        url = rawU;
      }
      if (!/^https?:\/\//i.test(url)) {
        res.status(400).json({ error: 'URL invalide' });
        return;
      }
      if (!ALLOWED.test(url) && !/i\.ytimg\.com|yt3\.|ggpht|googleusercontent|lh3\.google/i.test(url)) {
        res.status(403).json({ error: 'domaine non autorisé' });
        return;
      }
      // Réécrit les tailles ytimg fragiles vers hqdefault
      const vi = url.match(/i\.ytimg\.com\/vi(?:_webp)?\/([^/]+)\//i);
      if (vi) {
        candidates.push(...ytimgChain(vi[1]));
      } else {
        candidates.push(url);
      }
    }

    if (/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      for (const u of ytimgChain(videoId)) {
        if (!candidates.includes(u)) candidates.push(u);
      }
    }

    if (!candidates.length) {
      res.status(400).json({ error: 'u ou v requis' });
      return;
    }

    // Cache clé = première URL + id vidéo
    const cacheKey = createHash('sha1').update(`v2:${videoId}|${candidates.join('|')}`).digest('hex');
    const cached = cacheGet(cacheKey);
    if (cached) {
      sendImage(res, cached.buf, cached.type, 'cache');
      return;
    }

    for (const url of candidates) {
      const got = await fetchImage(url);
      if (!got) continue;
      cachePut(cacheKey, got.buf, got.type);
      sendImage(res, got.buf, got.type, 'ok');
      return;
    }

    // Pas de SVG 200 « sticky » : CoverImage/Coil doivent avancer au candidat suivant
    res.setHeader('X-YTM-Img', 'miss');
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).json({ error: 'image unavailable' });
  } catch (err) {
    res.setHeader('X-YTM-Img', 'error');
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'image proxy error' });
    void err;
  }
}
