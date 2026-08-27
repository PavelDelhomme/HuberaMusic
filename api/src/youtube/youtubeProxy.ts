/**
 * Proxies HTTP pour yt-dlp — contourne les blocages IP datacenter (LOGIN_REQUIRED / 50x)
 * sans dépendre du PC maison (STREAM_UPSTREAM).
 *
 * Ordre :
 *  1. YOUTUBE_HTTP_PROXY (fixe)
 *  2. YOUTUBE_HTTP_PROXY_LIST (csv ou fichier, une URL par ligne)
 *  3. Si YOUTUBE_HTTP_PROXY_FREE=1 : listes publiques (Proxyscrape / Proxy-List) + rotation
 *
 * Opt-out : YOUTUBE_HTTP_PROXY_FREE=0 (défaut = activé en production).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type ProxyEntry = { url: string; fails: number; lastFailAt: number };

const MAX_FAILS = 3;
const LIST_TTL_MS = 12 * 60_000;
const COOLDOWN_MS = 8 * 60_000;

let cachedFree: { at: number; urls: string[] } | null = null;
const pool = new Map<string, ProxyEntry>();
let rr = 0;

function envTruthy(v: string | undefined, defaultTrue: boolean): boolean {
  if (v == null || v === '') return defaultTrue;
  return !(v === '0' || v === 'false' || v === 'no');
}

function normalizeProxyUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.startsWith('#')) return null;
  if (/^https?:\/\//i.test(s) || /^socks5?:\/\//i.test(s)) return s.replace(/\/$/, '');
  // host:port → http
  if (/^[\w.[\]:-]+:\d+$/.test(s)) return `http://${s}`;
  return null;
}

function pushPool(urls: string[]) {
  for (const u of urls) {
    const n = normalizeProxyUrl(u);
    if (!n) continue;
    if (!pool.has(n)) pool.set(n, { url: n, fails: 0, lastFailAt: 0 });
  }
}

function loadStaticList(): string[] {
  const out: string[] = [];
  const single = (process.env.YOUTUBE_HTTP_PROXY || process.env.HTTPS_PROXY || '').trim();
  if (single) out.push(single);

  const listEnv = (process.env.YOUTUBE_HTTP_PROXY_LIST || '').trim();
  if (listEnv) {
    if (existsSync(listEnv)) {
      try {
        out.push(
          ...readFileSync(listEnv, 'utf8')
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean),
        );
      } catch {
        /* ignore */
      }
    } else {
      out.push(...listEnv.split(/[\s,;]+/).filter(Boolean));
    }
  }

  // Fichier volume optionnel
  try {
    const root = join(process.cwd(), 'data', 'youtube-proxies.txt');
    if (existsSync(root)) {
      out.push(
        ...readFileSync(root, 'utf8')
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean),
      );
    }
  } catch {
    /* ignore */
  }
  return out;
}

async function fetchText(url: string, timeoutMs = 8_000): Promise<string> {
  const ctrl = AbortSignal.timeout(timeoutMs);
  const res = await fetch(url, {
    signal: ctrl,
    headers: { 'User-Agent': 'PLM-stream/1.0', Accept: 'text/plain,*/*' },
  });
  if (!res.ok) throw new Error(`proxy list HTTP ${res.status}`);
  return await res.text();
}

async function refreshFreeProxies(): Promise<string[]> {
  if (cachedFree && Date.now() - cachedFree.at < LIST_TTL_MS) return cachedFree.urls;

  const sources = [
    // HTTP anonymes, timeout court — Proxyscrape v2
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=3000&country=all&ssl=all&anonymity=all',
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=3000&country=all',
    'https://www.proxy-list.download/api/v1/get?type=http',
  ];

  const urls: string[] = [];
  await Promise.all(
    sources.map(async (src) => {
      try {
        const text = await fetchText(src);
        for (const line of text.split(/\r?\n/)) {
          const n = normalizeProxyUrl(line);
          if (n) urls.push(n);
        }
      } catch (err) {
        console.warn(
          '[youtubeProxy] list KO',
          src.slice(0, 48),
          String((err as Error).message || err).slice(0, 80),
        );
      }
    }),
  );

  // Dédup + shuffle léger
  const uniq = [...new Set(urls)];
  for (let i = uniq.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [uniq[i], uniq[j]] = [uniq[j], uniq[i]];
  }
  // Cap pour éviter un pool monstrueux
  const capped = uniq.slice(0, 80);
  cachedFree = { at: Date.now(), urls: capped };
  console.info(`[youtubeProxy] free pool refreshed n=${capped.length}`);
  return capped;
}

export function youtubeProxyFreeEnabled(): boolean {
  const appEnv = String(process.env.APP_ENV || process.env.NODE_ENV || '').toLowerCase();
  const isProd = appEnv === 'production' || appEnv === 'prod';
  // Prod : ON par défaut (contourne 50x DC). Dev : OFF sauf opt-in.
  return envTruthy(process.env.YOUTUBE_HTTP_PROXY_FREE, isProd);
}

export async function ensureYoutubeProxyPool(): Promise<void> {
  pushPool(loadStaticList());
  if (youtubeProxyFreeEnabled()) {
    try {
      pushPool(await refreshFreeProxies());
    } catch (err) {
      console.warn('[youtubeProxy] refresh:', String((err as Error).message || err).slice(0, 120));
    }
  }
}

function usable(e: ProxyEntry): boolean {
  if (e.fails >= MAX_FAILS && Date.now() - e.lastFailAt < COOLDOWN_MS) return false;
  if (e.fails >= MAX_FAILS && Date.now() - e.lastFailAt >= COOLDOWN_MS) {
    e.fails = 0;
  }
  return true;
}

/** Prochain proxy à essayer (null = direct, sans proxy). */
export async function nextYoutubeProxy(exclude: Set<string> = new Set()): Promise<string | null> {
  await ensureYoutubeProxyPool();
  const candidates = [...pool.values()].filter((e) => usable(e) && !exclude.has(e.url));
  if (!candidates.length) {
    // Force refresh free list once if empty
    if (youtubeProxyFreeEnabled()) {
      cachedFree = null;
      await ensureYoutubeProxyPool();
    }
    const retry = [...pool.values()].filter((e) => usable(e) && !exclude.has(e.url));
    if (!retry.length) return null;
    const pick = retry[rr++ % retry.length]!;
    return pick.url;
  }
  const pick = candidates[rr++ % candidates.length]!;
  return pick.url;
}

/** Liste de proxies à tenter. Direct VPS d’abord (rapide si OK), puis proxies (bypass 50x). */
export async function youtubeProxyAttempts(opts?: {
  max?: number;
  includeDirect?: boolean;
}): Promise<(string | null)[]> {
  const max = Math.max(1, Math.min(opts?.max ?? 4, 8));
  const includeDirect = opts?.includeDirect !== false;
  const used = new Set<string>();
  const out: (string | null)[] = [];

  if (includeDirect) out.push(null);

  // Proxy fixe prioritaire ensuite (souvent le plus fiable si fourni)
  const fixed = (process.env.YOUTUBE_HTTP_PROXY || '').trim();
  if (fixed) {
    const n = normalizeProxyUrl(fixed);
    if (n) {
      out.push(n);
      used.add(n);
    }
  }

  while (out.length < max) {
    const p = await nextYoutubeProxy(used);
    if (!p) break;
    used.add(p);
    out.push(p);
  }

  return out.length ? out : [null];
}

export function markYoutubeProxyFailure(proxy: string | null): void {
  if (!proxy) return;
  const e = pool.get(proxy) || { url: proxy, fails: 0, lastFailAt: 0 };
  e.fails += 1;
  e.lastFailAt = Date.now();
  pool.set(proxy, e);
}

export function markYoutubeProxySuccess(proxy: string | null): void {
  if (!proxy) return;
  const e = pool.get(proxy);
  if (!e) return;
  e.fails = 0;
  e.lastFailAt = 0;
}

export function youtubeProxyStats(): {
  enabled: boolean;
  poolSize: number;
  freeEnabled: boolean;
} {
  return {
    enabled: Boolean((process.env.YOUTUBE_HTTP_PROXY || '').trim()) || youtubeProxyFreeEnabled(),
    poolSize: pool.size,
    freeEnabled: youtubeProxyFreeEnabled(),
  };
}

/** Erreur typique qui mérite un retry via un autre proxy. */
export function isProxyWorthRetry(err: unknown): boolean {
  const msg = String((err as Error)?.message || err || '');
  return /LOGIN_REQUIRED|Sign in|bot|unavailable|403|429|50[234]|timed? ?out|ECONN|ENOTFOUND|proxy|Tunnel|SOCKS|first-byte|format is not available|Requested format|HTTP Error|unable to download/i.test(
    msg,
  );
}
