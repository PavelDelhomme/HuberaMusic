/**
 * Proxies HTTP pour yt-dlp — contourne les blocages IP datacenter (LOGIN_REQUIRED / 50x)
 * sans dépendre du PC maison (STREAM_UPSTREAM).
 *
 * Ordre :
 *  1. YOUTUBE_HTTP_PROXY (fixe)
 *  2. YOUTUBE_HTTP_PROXY_LIST (csv ou fichier, une URL par ligne)
 *  3. Si YOUTUBE_HTTP_PROXY_FREE=1 : listes publiques (Proxyscrape / Proxy-List) + rotation
 *
 * Proxies morts : éviction + refresh listes + rotation continue pour garder l’écoute.
 * Opt-out : YOUTUBE_HTTP_PROXY_FREE=0 (défaut = activé en production / VPS).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect as netConnect } from 'node:net';

type ProxyEntry = {
  url: string;
  fails: number;
  lastFailAt: number;
  lastOkAt: number;
  /** Soft-probe TCP échoué → skip jusqu’à expiry. */
  deadUntil: number;
};

const MAX_FAILS = 2;
const LIST_TTL_MS = 8 * 60_000;
const COOLDOWN_MS = 4 * 60_000;
const EVICT_AFTER_FAILS = 4;
const LOW_POOL_REFRESH = 12;
const PROBE_TIMEOUT_MS = 1_200;
const BG_REFRESH_MS = 6 * 60_000;

let cachedFree: { at: number; urls: string[] } | null = null;
const pool = new Map<string, ProxyEntry>();
let rr = 0;
let refreshInflight: Promise<void> | null = null;
let bgTimer: ReturnType<typeof setInterval> | null = null;
let lastForceRefreshAt = 0;

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

function ensureEntry(url: string): ProxyEntry {
  let e = pool.get(url);
  if (!e) {
    e = { url, fails: 0, lastFailAt: 0, lastOkAt: 0, deadUntil: 0 };
    pool.set(url, e);
  }
  return e;
}

function pushPool(urls: string[]) {
  for (const u of urls) {
    const n = normalizeProxyUrl(u);
    if (!n) continue;
    ensureEntry(n);
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

async function refreshFreeProxies(force = false): Promise<string[]> {
  if (!force && cachedFree && Date.now() - cachedFree.at < LIST_TTL_MS) return cachedFree.urls;

  const sources = [
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=3000&country=all&ssl=all&anonymity=all',
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=3000&country=all',
    'https://www.proxy-list.download/api/v1/get?type=http',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
    'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt',
    'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
    'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
    'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
  ];

  const urls: string[] = [];
  let listKoLogged = false;
  await Promise.all(
    sources.map(async (src) => {
      try {
        const text = await fetchText(src);
        for (const line of text.split(/\r?\n/)) {
          const n = normalizeProxyUrl(line);
          if (n) urls.push(n);
        }
      } catch (err) {
        if (!listKoLogged) {
          listKoLogged = true;
          console.warn(
            '[youtubeProxy] list KO',
            src.slice(0, 48),
            String((err as Error).message || err).slice(0, 80),
          );
        }
      }
    }),
  );

  const uniq = [...new Set(urls)];
  for (let i = uniq.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [uniq[i], uniq[j]] = [uniq[j], uniq[i]];
  }
  const capped = uniq.slice(0, 220);
  cachedFree = { at: Date.now(), urls: capped };
  if (capped.length > 0) {
    console.info(`[youtubeProxy] free pool refreshed n=${capped.length}`);
  }
  return capped;
}

export function youtubeProxyFreeEnabled(): boolean {
  const appEnv = String(process.env.APP_ENV || process.env.NODE_ENV || '').toLowerCase();
  const isVps =
    appEnv === 'production' ||
    appEnv === 'prod' ||
    appEnv === 'preprod' ||
    appEnv === 'dev';
  return envTruthy(process.env.YOUTUBE_HTTP_PROXY_FREE, isVps);
}

function usableCount(): number {
  return [...pool.values()].filter((e) => usable(e)).length;
}

function evictDead(): void {
  const now = Date.now();
  for (const [url, e] of pool) {
    if (e.fails >= EVICT_AFTER_FAILS && now - e.lastFailAt > COOLDOWN_MS) {
      pool.delete(url);
    }
  }
}

export async function ensureYoutubeProxyPool(force = false): Promise<void> {
  pushPool(loadStaticList());
  if (!youtubeProxyFreeEnabled()) return;

  const thin = usableCount() < LOW_POOL_REFRESH;
  if (force || thin) {
    cachedFree = null;
  }

  if (refreshInflight) {
    await refreshInflight;
    return;
  }
  refreshInflight = (async () => {
    try {
      pushPool(await refreshFreeProxies(force || thin));
      evictDead();
    } catch (err) {
      console.warn('[youtubeProxy] refresh:', String((err as Error).message || err).slice(0, 120));
    } finally {
      refreshInflight = null;
    }
  })();
  await refreshInflight;
}

/** Soft TCP connect — écarte les proxies vraiment morts avant yt-dlp (12 s). */
export function probeProxyReachable(proxyUrl: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const u = new URL(proxyUrl);
      const host = u.hostname;
      const port = Number(u.port) || (u.protocol.startsWith('socks') ? 1080 : 80);
      if (!host || !port) {
        resolve(false);
        return;
      }
      const sock = netConnect({ host, port });
      const done = (ok: boolean) => {
        try {
          sock.destroy();
        } catch {
          /* ignore */
        }
        resolve(ok);
      };
      sock.setTimeout(timeoutMs);
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
    } catch {
      resolve(false);
    }
  });
}

function usable(e: ProxyEntry): boolean {
  const now = Date.now();
  if (e.deadUntil > now) return false;
  if (e.fails >= MAX_FAILS && now - e.lastFailAt < COOLDOWN_MS) return false;
  if (e.fails >= MAX_FAILS && now - e.lastFailAt >= COOLDOWN_MS) {
    e.fails = 0;
  }
  return true;
}

/** Prochain proxy à essayer (null = direct, sans proxy). */
export async function nextYoutubeProxy(exclude: Set<string> = new Set()): Promise<string | null> {
  await ensureYoutubeProxyPool();
  let candidates = [...pool.values()].filter((e) => usable(e) && !exclude.has(e.url));
  if (!candidates.length) {
    if (youtubeProxyFreeEnabled() && Date.now() - lastForceRefreshAt > 15_000) {
      lastForceRefreshAt = Date.now();
      cachedFree = null;
      await ensureYoutubeProxyPool(true);
    }
    candidates = [...pool.values()].filter((e) => usable(e) && !exclude.has(e.url));
    if (!candidates.length) return null;
  }
  // Préférer ceux déjà OK récemment, puis round-robin
  candidates.sort((a, b) => (b.lastOkAt || 0) - (a.lastOkAt || 0));
  const pick = candidates[rr++ % candidates.length]!;
  return pick.url;
}

function shuffleArray<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Liste de proxies à tenter.
 * `refill` : si le pool s’amincit en cours de requête, recharge et complète.
 */
export async function youtubeProxyAttempts(opts?: {
  max?: number;
  includeDirect?: boolean;
  directLast?: boolean;
  shuffle?: boolean;
  /** Soft-probe TCP avant d’inclure (évite 12 s yt-dlp sur proxy mort). */
  probe?: boolean;
}): Promise<(string | null)[]> {
  const max = Math.max(1, Math.min(opts?.max ?? 4, 12));
  const includeDirect = opts?.includeDirect !== false;
  const directLast = Boolean(opts?.directLast);
  const doProbe = opts?.probe !== false && youtubeProxyFreeEnabled();
  const used = new Set<string>();
  const proxies: string[] = [];

  const fixed = (process.env.YOUTUBE_HTTP_PROXY || '').trim();
  if (fixed) {
    const n = normalizeProxyUrl(fixed);
    if (n) {
      proxies.push(n);
      used.add(n);
    }
  }

  let guard = 0;
  while (proxies.length + (includeDirect ? 1 : 0) < max && guard++ < max * 4) {
    if (usableCount() < LOW_POOL_REFRESH && youtubeProxyFreeEnabled()) {
      void ensureYoutubeProxyPool(true);
    }
    const p = await nextYoutubeProxy(used);
    if (!p) {
      // Plus rien → force refresh une fois puis repars
      if (youtubeProxyFreeEnabled() && Date.now() - lastForceRefreshAt > 8_000) {
        lastForceRefreshAt = Date.now();
        cachedFree = null;
        await ensureYoutubeProxyPool(true);
        continue;
      }
      break;
    }
    used.add(p);
    if (doProbe) {
      const ok = await probeProxyReachable(p);
      if (!ok) {
        const e = ensureEntry(p);
        e.fails += 1;
        e.lastFailAt = Date.now();
        e.deadUntil = Date.now() + Math.min(COOLDOWN_MS, 90_000);
        continue;
      }
    }
    proxies.push(p);
  }

  let ordered: (string | null)[];
  // Si trop peu de proxies vivants après probe → refresh forcé + 2e passe
  if (doProbe && proxies.length < 2 && youtubeProxyFreeEnabled()) {
    cachedFree = null;
    lastForceRefreshAt = Date.now();
    await ensureYoutubeProxyPool(true);
    let guard2 = 0;
    while (proxies.length + (includeDirect ? 1 : 0) < max && guard2++ < max * 3) {
      const p = await nextYoutubeProxy(used);
      if (!p) break;
      used.add(p);
      const ok = await probeProxyReachable(p);
      if (!ok) {
        const e = ensureEntry(p);
        e.fails += 1;
        e.lastFailAt = Date.now();
        e.deadUntil = Date.now() + Math.min(COOLDOWN_MS, 90_000);
        continue;
      }
      proxies.push(p);
    }
  }

  if (directLast) {
    ordered = [...proxies, ...(includeDirect ? [null] : [])];
  } else {
    ordered = [...(includeDirect ? [null] : []), ...proxies];
  }

  if (opts?.shuffle) {
    const direct = ordered.filter((x) => x == null);
    const px = shuffleArray(ordered.filter((x): x is string => x != null));
    ordered = directLast ? [...px, ...direct] : shuffleArray([...direct, ...px]);
  }

  return ordered.length ? ordered : [null];
}

export function markYoutubeProxyFailure(proxy: string | null): void {
  if (!proxy) return;
  const e = ensureEntry(proxy);
  e.fails += 1;
  e.lastFailAt = Date.now();
  // Proxy mort → quarantine courte puis éviction si récidive
  if (e.fails >= MAX_FAILS) {
    e.deadUntil = Date.now() + COOLDOWN_MS;
  }
  if (e.fails >= EVICT_AFTER_FAILS) {
    pool.delete(proxy);
    // Recharge en fond pour remplacer
    if (youtubeProxyFreeEnabled()) {
      void ensureYoutubeProxyPool(true);
    }
  }
}

export function markYoutubeProxySuccess(proxy: string | null): void {
  if (!proxy) return;
  const e = ensureEntry(proxy);
  e.fails = 0;
  e.lastFailAt = 0;
  e.deadUntil = 0;
  e.lastOkAt = Date.now();
}

export function youtubeProxyStats(): {
  enabled: boolean;
  poolSize: number;
  usable: number;
  freeEnabled: boolean;
} {
  return {
    enabled: Boolean((process.env.YOUTUBE_HTTP_PROXY || '').trim()) || youtubeProxyFreeEnabled(),
    poolSize: pool.size,
    usable: usableCount(),
    freeEnabled: youtubeProxyFreeEnabled(),
  };
}

/** Démarre le refresh périodique (appelé au listen API). */
export function startYoutubeProxyBackgroundRefresh(): void {
  if (bgTimer || !youtubeProxyFreeEnabled()) return;
  bgTimer = setInterval(() => {
    void ensureYoutubeProxyPool(true).catch(() => {
      /* ignore */
    });
  }, BG_REFRESH_MS);
  if (typeof bgTimer === 'object' && bgTimer && 'unref' in bgTimer) {
    try {
      (bgTimer as NodeJS.Timeout).unref();
    } catch {
      /* ignore */
    }
  }
}

/** Erreur typique qui mérite un retry via un autre proxy. */
export function isProxyWorthRetry(err: unknown): boolean {
  const msg = String((err as Error)?.message || err || '');
  return /LOGIN_REQUIRED|Sign in|bot|unavailable|403|429|50[234]|timed? ?out|ECONN|ENOTFOUND|proxy|Tunnel|SOCKS|first-byte|format is not available|Requested format|HTTP Error|unable to download|certificate|SSL|TLS/i.test(
    msg,
  );
}
