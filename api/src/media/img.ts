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

/** hq/mq d’abord : maxres/hq720 404 souvent → 8 s chacun = pochettes vides. */
const YTIMG_FAST = [
  'hqdefault.jpg',
  'mqdefault.jpg',
  'hq720.jpg',
  'sddefault.jpg',
  'maxresdefault.jpg',
  'default.jpg',
] as const;

const DISK_TTL_MS = 90 * 24 * 3600 * 1000;
const STALE_TTL_MS = 365 * 24 * 3600 * 1000;
const MEM_MAX = 240;
const HTTP_MAX_AGE = 30 * 24 * 3600;

type ImgHit = { buf: Buffer; type: string };

const mem = new Map<string, { hit: ImgHit; at: number }>();

function ytimgChain(videoId: string): string[] {
  return YTIMG_FAST.map((f) => `https://i.ytimg.com/vi/${videoId}/${f}`);
}

function memGet(key: string): ImgHit | null {
  const row = mem.get(key);
  if (!row) return null;
  mem.delete(key);
  mem.set(key, row);
  return row.hit;
}

function memPut(key: string, hit: ImgHit) {
  if (mem.has(key)) mem.delete(key);
  mem.set(key, { hit, at: Date.now() });
  while (mem.size > MEM_MAX) {
    const first = mem.keys().next().value;
    if (!first) break;
    mem.delete(first);
  }
}

async function fetchImage(url: string): Promise<ImgHit | null> {
  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: 'https://music.youtube.com/',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
    });
    if (!upstream.ok) return null;
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length < 2000) return null;
    const type = upstream.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(type) && !type.includes('octet-stream')) return null;
    return { buf, type: type.includes('octet-stream') ? 'image/jpeg' : type };
  } catch {
    return null;
  }
}

async function fetchFirst(urls: string[]): Promise<ImgHit | null> {
  if (!urls.length) return null;
  const first = urls.slice(0, 2);
  const pair = await Promise.all(first.map(fetchImage));
  const hit = pair.find(Boolean);
  if (hit) return hit;
  for (const url of urls.slice(2)) {
    const got = await fetchImage(url);
    if (got) return got;
  }
  return null;
}

function diskGet(key: string): { hit: ImgHit; stale: boolean } | null {
  const file = join(CACHE_DIR, key);
  const meta = join(CACHE_DIR, `${key}.meta`);
  if (!existsSync(file) || !existsSync(meta)) return null;
  const age = Date.now() - statSync(file).mtimeMs;
  if (age >= STALE_TTL_MS) return null;
  try {
    const hit = { buf: readFileSync(file), type: readFileSync(meta, 'utf8') || 'image/jpeg' };
    return { hit, stale: age >= DISK_TTL_MS };
  } catch {
    return null;
  }
}

function diskPut(key: string, hit: ImgHit) {
  try {
    writeFileSync(join(CACHE_DIR, key), hit.buf);
    writeFileSync(join(CACHE_DIR, `${key}.meta`), hit.type);
  } catch {
    /* disque plein */
  }
}

function sendImage(res: Response, buf: Buffer, type: string, hit: string) {
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', `public, max-age=${HTTP_MAX_AGE}, stale-while-revalidate=86400`);
  res.setHeader('X-YTM-Img', hit);
  res.send(buf);
}

function refreshInBackground(cacheKey: string, candidates: string[]) {
  void fetchFirst(candidates).then((got) => {
    if (!got) return;
    memPut(cacheKey, got);
    diskPut(cacheKey, got);
  });
}

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

    const cacheKey = createHash('sha1').update(`v3:${videoId}|${candidates[0] || ''}`).digest('hex');
    const ram = memGet(cacheKey);
    if (ram) {
      sendImage(res, ram.buf, ram.type, 'mem');
      return;
    }
    const disk = diskGet(cacheKey);
    if (disk) {
      memPut(cacheKey, disk.hit);
      sendImage(res, disk.hit.buf, disk.hit.type, disk.stale ? 'stale' : 'disk');
      if (disk.stale) refreshInBackground(cacheKey, candidates);
      return;
    }

    const got = await fetchFirst(candidates);
    if (got) {
      memPut(cacheKey, got);
      diskPut(cacheKey, got);
      sendImage(res, got.buf, got.type, 'ok');
      return;
    }

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
