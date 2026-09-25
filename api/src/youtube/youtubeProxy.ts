/**
 * Proxies HTTP pour yt-dlp **et** le relais googlevideo.
 * Contourne les 5xx / LOGIN_REQUIRED de l’IP datacenter VPS — pas le PC maison.
 *
 * Ordre :
 *  1. YOUTUBE_HTTP_PROXY (fixe)
 *  2. YOUTUBE_HTTP_PROXY_LIST (csv ou fichier, une URL par ligne)
 *  3. Si YOUTUBE_HTTP_PROXY_FREE=1 : listes publiques (plusieurs sources) + score
 *
 * Intelligence : TCP probe, canary Google 204, score googlevideo 206 vs 5xx,
 * éviction des morts, refresh fond. Direct VPS en dernier si pool free ON.
 * Opt-out : YOUTUBE_HTTP_PROXY_FREE=0
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { connect as netConnect } from 'node:net';
import { Readable } from 'node:stream';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

type ProxyEntry = {
  url: string;
  fails: number;
  lastFailAt: number;
  lastOkAt: number;
  /** Soft-probe TCP/CONNECT échoué → skip jusqu’à expiry. */
  deadUntil: number;
  /** Relais googlevideo 206/200 réussis (score). */
  gvHits: number;
  gvMiss: number;
  /** CONNECT google:443 OK jusqu’à cette date. */
  connectOkUntil: number;
};

const MAX_FAILS = 2;
const LIST_TTL_MS = 8 * 60_000;
const COOLDOWN_MS = 4 * 60_000;
const EVICT_AFTER_FAILS = 4;
const LOW_POOL_REFRESH = 18;
const PROBE_TIMEOUT_MS = 1_200;
const BG_REFRESH_MS = 5 * 60_000;
const POOL_CAP = 600;
const CANARY_URL = 'https://www.google.com/generate_204';

let cachedFree: { at: number; urls: string[] } | null = null;
/** Source de liste publique → dernier log KO (anti-spam). */
const sourceKoAt = new Map<string, number>();
const pool = new Map<string, ProxyEntry>();
/** url → userId (lease exclusif). */
const proxyLease = new Map<string, string>();
/** userId → urls louées. */
const userLeases = new Map<string, Set<string>>();
let stewardLoaded = false;
let rr = 0;
let refreshInflight: Promise<void> | null = null;
let bgTimer: ReturnType<typeof setInterval> | null = null;
let lastForceRefreshAt = 0;

const USER_POOL_SIZE = Math.max(
  8,
  Math.min(48, Number(process.env.YOUTUBE_PROXY_USER_POOL || 24) || 24),
);

/** Volume Docker `data/` — pas process.cwd() (sinon perdu au restart). */
const HOT_POOL_PATH = join(ROOT, 'data', 'hot_pool.json');
const HOT_CAP = 30;
const HOT_EXPIRE_MS = 6 * 60 * 60 * 1000;
const HOT_MIN = 15;
let hotLoaded = false;
let hotPersistTimer: ReturnType<typeof setTimeout> | null = null;

function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** SSRF : localhost, RFC1918, link-local, metadata, *.internal / *.local. */
export function isBlockedProxyHost(host: string): boolean {
  const h = String(host || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '::' || h === '[::1]') return true;
  if (h === 'metadata.google.internal' || h === 'metadata') return true;
  if (h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h === '0:0:0:0:0:0:0:1' || h === 'https://example.net/id/garnet') return true;
  if (h.includes(':') && (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd'))) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

/** Destinations autorisées via CONNECT (anti open-relay). */
export function isAllowedProxyTarget(hostname: string): boolean {
  const h = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!h || isBlockedProxyHost(h)) return false;
  const roots = [
    'google.com',
    'googleapis.com',
    'gstatic.com',
    'googlevideo.com',
    'youtube.com',
    'youtu.be',
    'ytimg.com',
    'ggpht.com',
    'genius.com',
    'musixmatch.com',
    'azlyrics.com',
    'lrclib.net',
    'lyrics.ovh',
    'textyl.co',
    'chartlyrics.com',
    'lyrist.vercel.app',
  ];
  return roots.some((d) => h === d || h.endsWith(`.${d}`));
}

function dropFromPool(url: string): void {
  pool.delete(url);
  const uid = proxyLease.get(url);
  if (uid) {
    proxyLease.delete(url);
    userLeases.get(uid)?.delete(url);
  }
}

function envTruthy(v: string | undefined, defaultTrue: boolean): boolean {
  if (v == null || v === '') return defaultTrue;
  return !(v === '0' || v === 'false' || v === 'no');
}

function normalizeProxyUrl(raw: string, opts?: { allowAuth?: boolean }): string | null {
  const s = raw.trim();
  if (!s || s.startsWith('#')) return null;
  let n: string;
  if (/^https?:\/\//i.test(s) || /^socks5?:\/\//i.test(s)) n = s.replace(/\/$/, '');
  else if (/^[\w.[\]:-]+:\d+$/.test(s)) n = `http://${s}`;
  else return null;
  try {
    const u = new URL(n);
    if (isBlockedProxyHost(u.hostname)) return null;
    // Listes publiques avec user:pass = appât. On ne garde que host:port.
    if (!opts?.allowAuth && (u.username || u.password)) {
      u.username = '';
      u.password = '';
    }
    const proto = u.protocol.toLowerCase();
    const port = u.port || (proto === 'https:' ? '443' : proto.startsWith('socks') ? '1080' : '80');
    if (opts?.allowAuth && (u.username || u.password)) {
      const auth = `${encodeURIComponent(u.username)}:${encodeURIComponent(u.password)}@`;
      return `${proto}//${auth}${u.hostname}:${port}`;
    }
    return `${proto}//${u.hostname}:${port}`;
  } catch {
    return null;
  }
}

function ensureEntry(url: string): ProxyEntry {
  let e = pool.get(url);
  if (!e) {
    e = { url, fails: 0, lastFailAt: 0, lastOkAt: 0, deadUntil: 0, gvHits: 0, gvMiss: 0, connectOkUntil: 0 };
    pool.set(url, e);
  }
  return e;
}

export function isUpstream5xx(status: number): boolean {
  return status === 502 || status === 503 || status === 504 || status === 520 || status === 521 || status === 522 || status === 523;
}

export function isHttpProxy(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function pushPool(urls: string[]) {
  for (const u of urls) {
    const n = normalizeProxyUrl(u);
    if (!n) continue;
    ensureEntry(n);
  }
}

type HotFileEntry = {
  url: string;
  lastSuccess206?: number;
  gvHits?: number;
  failCount?: number;
  deadUntil?: number;
};

function persistHotPool(): void {
  try {
    const now = Date.now();
    const entries: HotFileEntry[] = [...pool.values()]
      .filter((e) => (e.gvHits || 0) > 0 && now - (e.lastOkAt || 0) < HOT_EXPIRE_MS)
      .sort((a, b) => (b.gvHits || 0) - (a.gvHits || 0) || (b.lastOkAt || 0) - (a.lastOkAt || 0))
      .slice(0, HOT_CAP)
      .map((e) => ({
        url: e.url,
        lastSuccess206: e.lastOkAt,
        gvHits: e.gvHits,
        failCount: e.gvMiss || 0,
        deadUntil: e.deadUntil || 0,
      }));
    mkdirSync(join(ROOT, 'data'), { recursive: true });
    writeFileSync(HOT_POOL_PATH, JSON.stringify(entries), 'utf8');
  } catch {
    /* volume RO */
  }
}

function persistHotSoon(): void {
  if (hotPersistTimer) return;
  hotPersistTimer = setTimeout(() => {
    hotPersistTimer = null;
    persistHotPool();
  }, 2_000);
  if (typeof hotPersistTimer === 'object' && hotPersistTimer && 'unref' in hotPersistTimer) {
    try {
      hotPersistTimer.unref();
    } catch {
      /* ignore */
    }
  }
}

export function loadHotPoolFromDisk(): void {
  if (hotLoaded) return;
  hotLoaded = true;
  try {
    const legacy = join(process.cwd(), 'data', 'hot_pool.json');
    const path = existsSync(HOT_POOL_PATH)
      ? HOT_POOL_PATH
      : existsSync(legacy)
        ? legacy
        : '';
    if (!path) return;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as HotFileEntry[];
    if (!Array.isArray(raw)) return;
    const now = Date.now();
    let n = 0;
    for (const row of raw) {
      const url = normalizeProxyUrl(String(row?.url || ''));
      if (!url) continue;
      const last = Number(row.lastSuccess206 || 0);
      if (last && now - last > HOT_EXPIRE_MS) continue;
      if (Number(row.deadUntil || 0) > now) continue;
      const e = ensureEntry(url);
      e.gvHits = Math.max(e.gvHits || 0, Number(row.gvHits || 1) || 1);
      e.lastOkAt = Math.max(e.lastOkAt || 0, last || now);
      e.fails = 0;
      e.deadUntil = 0;
      n += 1;
      if (n >= HOT_CAP) break;
    }
    if (n) {
      console.info(`[youtubeProxy] hot pool chargé n=${n} path=${path === HOT_POOL_PATH ? 'volume' : 'cwd-legacy'}`);
      persistHotSoon();
    }
  } catch (err) {
    console.warn('[youtubeProxy] hot_pool.json', String((err as Error).message || err).slice(0, 80));
  }
}

/** 15–30 proxies avec 206 googlevideo récent. Rotation : YouTube bloque si toujours la même IP. */
let hotRr = 0;
/** Dernier usage Innertube/résolution — exclure ~25 s pour ne pas coller à une IP. */
const recentResolveAt = new Map<string, number>();
const RESOLVE_COOLDOWN_MS = 25_000;

export function pickHotProxies(n = 2, exclude: Set<string> = new Set()): string[] {
  const now = Date.now();
  const hot = [...pool.values()]
    .filter(
      (e) =>
        usable(e) &&
        isHttpProxy(e.url) &&
        (e.gvHits || 0) > 0 &&
        now - (e.lastOkAt || 0) < HOT_EXPIRE_MS &&
        !exclude.has(e.url),
    )
    .sort((a, b) => (b.gvHits || 0) - (a.gvHits || 0) || (b.lastOkAt || 0) - (a.lastOkAt || 0));
  const window = hot.slice(0, Math.min(hot.length, Math.max(12, n * 6)));
  const extra = [...pool.values()]
    .filter((e) => usable(e) && isHttpProxy(e.url) && !exclude.has(e.url) && !window.some((h) => h.url === e.url))
    .sort((a, b) => (b.connectOkUntil > now ? 1 : 0) - (a.connectOkUntil > now ? 1 : 0) || (b.lastOkAt || 0) - (a.lastOkAt || 0));
  // Ne jamais réduire le pool à 1 gagnant gv — YouTube bannit cette IP.
  const poolList = [...window];
  for (const e of extra) {
    if (poolList.length >= Math.max(12, n * 6)) break;
    poolList.push(e);
  }
  if (!poolList.length) {
    return extra.slice(0, n).map((e) => e.url);
  }
  const cooled = poolList.filter((e) => (recentResolveAt.get(e.url) || 0) + RESOLVE_COOLDOWN_MS < now);
  const src = cooled.length >= Math.min(n, poolList.length) ? cooled : poolList;
  const rot = hotRr % src.length;
  hotRr = (hotRr + 1) >>> 0;
  const rotated = [...src.slice(rot), ...src.slice(0, rot)];
  const out: string[] = [];
  for (const e of rotated) {
    if (exclude.has(e.url) || out.includes(e.url)) continue;
    out.push(e.url);
    if (out.length >= n) break;
  }
  if (out.length < n) {
    for (const e of extra) {
      if (out.includes(e.url) || exclude.has(e.url)) continue;
      out.push(e.url);
      if (out.length >= n) break;
    }
  }
  const picked = out.slice(0, n);
  for (const url of picked) recentResolveAt.set(url, now);
  if (recentResolveAt.size > 80) {
    for (const [u, t] of recentResolveAt) {
      if (now - t > RESOLVE_COOLDOWN_MS * 4) recentResolveAt.delete(u);
    }
  }
  return picked;
}

function loadStaticList(): string[] {
  const out: string[] = [];
  const single = (process.env.YOUTUBE_HTTP_PROXY || process.env.HTTPS_PROXY || '').trim();
  if (single) {
    const n = normalizeProxyUrl(single, { allowAuth: true });
    if (n) out.push(n);
  }

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

  try {
    const live = join(process.cwd(), 'data', 'proxy-steward', 'live.json');
    if (existsSync(live)) {
      const j = JSON.parse(readFileSync(live, 'utf8')) as {
        updated?: number;
        proxies?: Array<{ url?: string; score?: number }>;
      };
      stewardLoaded = Array.isArray(j.proxies);
      const ranked = [...(j.proxies || [])]
        .filter((p) => p?.url)
        .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
      for (const p of ranked) {
        if (p.url) out.push(p.url);
      }
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
    // proxy-list.download : 502 en boucle — retiré (spam logs, 0 proxy).
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
    'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
    'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt',
    'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
    'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
    'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
    'https://raw.githubusercontent.com/mmpx12/proxy-list/master/https.txt',
    'https://raw.githubusercontent.com/zevtyardt/proxy-list/main/http.txt',
    'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt',
    'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/generated/http_proxies.txt',
    'https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt',
    'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt',
    'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt',
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
        const prev = sourceKoAt.get(src) || 0;
        if (Date.now() - prev > 30 * 60_000) {
          sourceKoAt.set(src, Date.now());
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
  const capped = uniq.slice(0, POOL_CAP);
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
      dropFromPool(url);
    }
  }
  if (pool.size <= POOL_CAP) return;
  const ranked = [...pool.values()].sort((a, b) => {
    const sa = (a.gvHits || 0) * 50 + (a.lastOkAt || 0) / 1e6 - (a.fails || 0) * 4;
    const sb = (b.gvHits || 0) * 50 + (b.lastOkAt || 0) / 1e6 - (b.fails || 0) * 4;
    return sb - sa;
  });
  for (const e of ranked.slice(POOL_CAP)) {
    if ((e.gvHits || 0) > 0) continue;
    dropFromPool(e.url);
  }
}

export async function ensureYoutubeProxyPool(force = false): Promise<void> {
  loadHotPoolFromDisk();
  pushPool(loadStaticList());
  if (!youtubeProxyFreeEnabled()) return;

  const thin = usableCount() < LOW_POOL_REFRESH;
  // Ne pas relancer les listes publiques toutes les 8–15 s : ça spammait 502
  // et saturait le titre en cours. Pool déjà fourni → refresh au TTL seulement.
  if (force && !thin && Date.now() - lastForceRefreshAt < 60_000) {
    force = false;
  }
  if (force || thin) {
    cachedFree = null;
    lastForceRefreshAt = Date.now();
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
      if (!host || !port || isBlockedProxyHost(host)) {
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

/** HTTP CONNECT vers google:443 — un port 80 ouvert (CDN) n’est pas un proxy. */
export function probeHttpConnect(proxyUrl: string, timeoutMs = 2_400): Promise<boolean> {
  const e = ensureEntry(proxyUrl);
  if (e.connectOkUntil > Date.now()) return Promise.resolve(true);
  if (!isHttpProxy(proxyUrl)) return probeProxyReachable(proxyUrl, timeoutMs);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      if (ok) e.connectOkUntil = Date.now() + 12 * 60_000;
      resolve(ok);
    };
    try {
      const proxy = new URL(proxyUrl);
      if (isBlockedProxyHost(proxy.hostname)) {
        finish(false);
        return;
      }
      const port = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
      const req = http.request({
        host: proxy.hostname,
        port,
        method: 'CONNECT',
        path: 'www.google.com:443',
        headers: { Host: 'www.google.com:443' },
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        finish(false);
      });
      req.on('error', () => finish(false));
      req.on('connect', (res, socket) => {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        finish((res.statusCode || 0) === 200);
      });
      req.end();
    } catch {
      finish(false);
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

function rankPick(candidates: ProxyEntry[]): ProxyEntry {
  candidates.sort((a, b) => {
    const sa =
      (a.gvHits || 0) * 20 +
      (a.connectOkUntil > Date.now() ? 15 : 0) +
      (a.lastOkAt || 0) / 1e7 -
      (a.fails || 0) * 5 -
      (a.gvMiss || 0) * 8;
    const sb =
      (b.gvHits || 0) * 20 +
      (b.connectOkUntil > Date.now() ? 15 : 0) +
      (b.lastOkAt || 0) / 1e7 -
      (b.fails || 0) * 5 -
      (b.gvMiss || 0) * 8;
    return sb - sa;
  });
  const top = candidates.slice(0, Math.min(48, Math.max(8, Math.ceil(candidates.length / 8))));
  return top[rr++ % top.length]!;
}

function leasePoolForUser(userId: string): string[] {
  let set = userLeases.get(userId);
  if (!set) {
    set = new Set();
    userLeases.set(userId, set);
  }
  for (const url of [...set]) {
    const e = pool.get(url);
    if (!e || !usable(e)) {
      set.delete(url);
      if (proxyLease.get(url) === userId) proxyLease.delete(url);
    }
  }
  if (set.size < USER_POOL_SIZE) {
    const unused = [...pool.values()].filter((e) => {
      if (!usable(e)) return false;
      if (set.has(e.url)) return false;
      const owner = proxyLease.get(e.url);
      if (owner && owner !== userId) return false;
      return true;
    });
    unused.sort((a, b) => {
      const sa = (a.gvHits || 0) * 1000 + (hash32(`${userId}\0${a.url}`) % 10_000);
      const sb = (b.gvHits || 0) * 1000 + (hash32(`${userId}\0${b.url}`) % 10_000);
      return sb - sa;
    });
    for (const e of unused) {
      if (set.size >= USER_POOL_SIZE) break;
      proxyLease.set(e.url, userId);
      set.add(e.url);
    }
  }
  // Overflow partagé seulement si le pool perso reste < 6 (pénurie).
  if (set.size < 6) {
    const shared = [...pool.values()]
      .filter((e) => usable(e) && !set.has(e.url))
      .sort((a, b) => (b.gvHits || 0) - (a.gvHits || 0));
    for (const e of shared) {
      if (set.size >= 6) break;
      set.add(e.url);
    }
  }
  return [...set];
}

/** Prochain proxy à essayer (null = direct, sans proxy). */
export async function nextYoutubeProxy(
  exclude: Set<string> = new Set(),
  userId?: string,
): Promise<string | null> {
  await ensureYoutubeProxyPool();

  const pickFrom = (preferUnleased: boolean): ProxyEntry[] => {
    if (userId) {
      return leasePoolForUser(userId)
        .filter((u) => !exclude.has(u))
        .map((u) => pool.get(u))
        .filter((e): e is ProxyEntry => Boolean(e && usable(e)));
    }
    return [...pool.values()].filter((e) => {
      if (!usable(e) || exclude.has(e.url)) return false;
      if (preferUnleased && proxyLease.has(e.url)) return false;
      return true;
    });
  };

  let candidates = pickFrom(true);
  if (!candidates.length) {
    if (youtubeProxyFreeEnabled() && Date.now() - lastForceRefreshAt > 15_000) {
      lastForceRefreshAt = Date.now();
      cachedFree = null;
      await ensureYoutubeProxyPool(true);
    }
    candidates = pickFrom(true);
    if (!candidates.length) candidates = pickFrom(false);
    if (!candidates.length) return null;
  }
  return rankPick(candidates).url;
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
  userId?: string;
}): Promise<(string | null)[]> {
  const max = Math.max(1, Math.min(opts?.max ?? 4, 16));
  const includeDirect = opts?.includeDirect !== false;
  const directLast = Boolean(opts?.directLast);
  const doProbe = opts?.probe !== false && youtubeProxyFreeEnabled();
  const used = new Set<string>();
  const proxies: string[] = [];
  const raw: string[] = [];
  const userId = opts?.userId;

  const fixed = (process.env.YOUTUBE_HTTP_PROXY || '').trim();
  const fixedN = fixed ? normalizeProxyUrl(fixed, { allowAuth: true }) : null;
  // Proxy fixe partagé : pas en tête des pools perso (évite de brûler une seule IP).
  if (fixedN && !userId) {
    raw.push(fixedN);
    used.add(fixedN);
  }

  let guard = 0;
  const want = Math.max(max * 3, 16);
  while (raw.length < want && guard++ < want * 2) {
    if (usableCount() < LOW_POOL_REFRESH && youtubeProxyFreeEnabled()) {
      void ensureYoutubeProxyPool(true);
    }
    const p = await nextYoutubeProxy(used, userId);
    if (!p) break;
    used.add(p);
    raw.push(p);
  }

  const markDead = (p: string) => {
    const e = ensureEntry(p);
    e.fails += 1;
    e.lastFailAt = Date.now();
    e.deadUntil = Date.now() + Math.min(COOLDOWN_MS, 90_000);
  };

  if (doProbe) {
    const batch = 8;
    for (let i = 0; i < raw.length && proxies.length < max; i += batch) {
      const slice = raw.slice(i, i + batch);
      const probed = await Promise.all(
        slice.map(async (p) => ({ p, ok: await probeHttpConnect(p) })),
      );
      for (const row of probed) {
        if (row.ok) {
          if (!proxies.includes(row.p)) proxies.push(row.p);
        } else {
          markDead(row.p);
        }
        if (proxies.length >= max) break;
      }
    }
  } else {
    for (const p of raw) {
      if (!proxies.includes(p)) proxies.push(p);
      if (proxies.length >= max) break;
    }
  }

  if (fixedN && !userId && !proxies.includes(fixedN)) proxies.unshift(fixedN);

  let ordered: (string | null)[];
  if (doProbe && proxies.length < 2 && youtubeProxyFreeEnabled() && Date.now() - lastForceRefreshAt > 8_000) {
    cachedFree = null;
    lastForceRefreshAt = Date.now();
    await ensureYoutubeProxyPool(true);
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

export function markYoutubeProxyFailure(proxy: string | null, kind: 'tcp' | 'gv' = 'tcp'): void {
  if (!proxy) return;
  const e = ensureEntry(proxy);
  e.fails += 1;
  e.lastFailAt = Date.now();
  if (kind === 'gv') e.gvMiss = (e.gvMiss || 0) + 1;
  // Proxy mort → quarantine courte puis éviction si récidive
  if (e.fails >= MAX_FAILS) {
    e.deadUntil = Date.now() + COOLDOWN_MS;
  }
  // Hot pool : 3× 403/timeout googlevideo → quarantaine exponentielle + jitter
  if (kind === 'gv' && (e.gvHits || 0) > 0 && (e.gvMiss || 0) >= 3) {
    const exp = Math.min(5, (e.gvMiss || 3) - 3);
    const base = 15 * 60_000 * Math.pow(2, exp);
    e.deadUntil = Date.now() + base + Math.floor(Math.random() * 60_000);
    persistHotSoon();
  }
  if (e.fails >= EVICT_AFTER_FAILS) {
    dropFromPool(proxy);
    // Recharge en fond pour remplacer
    if (youtubeProxyFreeEnabled()) {
      void ensureYoutubeProxyPool(true);
    }
  }
}

export function markYoutubeProxySuccess(proxy: string | null, kind: 'tcp' | 'gv' = 'tcp'): void {
  if (!proxy) return;
  const e = ensureEntry(proxy);
  e.fails = 0;
  e.lastFailAt = 0;
  e.deadUntil = 0;
  e.lastOkAt = Date.now();
  if (kind === 'gv') {
    e.gvHits = (e.gvHits || 0) + 1;
    e.gvMiss = 0;
    persistHotSoon();
  }
}

export function youtubeProxyStats(): {
  enabled: boolean;
  poolSize: number;
  usable: number;
  freeEnabled: boolean;
  gvWinners: number;
  hotPool: number;
  users: number;
  leased: number;
  stewardLoaded: boolean;
} {
  let gvWinners = 0;
  let hotPool = 0;
  const now = Date.now();
  for (const e of pool.values()) {
    if ((e.gvHits || 0) > 0 && usable(e)) gvWinners += 1;
    if ((e.gvHits || 0) > 0 && usable(e) && now - (e.lastOkAt || 0) < HOT_EXPIRE_MS) hotPool += 1;
  }
  return {
    enabled: Boolean((process.env.YOUTUBE_HTTP_PROXY || '').trim()) || youtubeProxyFreeEnabled(),
    poolSize: pool.size,
    usable: usableCount(),
    freeEnabled: youtubeProxyFreeEnabled(),
    gvWinners,
    hotPool: Math.min(HOT_CAP, hotPool),
    users: userLeases.size,
    leased: proxyLease.size,
    stewardLoaded,
  };
}

export function userProxyPoolStats(userId: string): { size: number; usable: number } {
  const set = userLeases.get(userId);
  if (!set) return { size: 0, usable: 0 };
  let n = 0;
  for (const url of set) {
    const e = pool.get(url);
    if (e && usable(e)) n += 1;
  }
  return { size: set.size, usable: n };
}

/** 3 proxies distincts du pool user pour une course de résolution. */
export function youtubeProxyStripe(userId: string | undefined, n = 3) {
  return youtubeProxyAttempts({
    max: n,
    userId,
    includeDirect: false,
    probe: true,
    shuffle: false,
    directLast: true,
  });
}

function headersToWeb(raw: http.IncomingHttpHeaders): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const item of v) h.append(k, item);
    } else {
      h.set(k, v);
    }
  }
  return h;
}

/** Agent HTTPS keepAlive par proxy : réutilise CONNECT+TLS vers googlevideo (même IP). */
const proxyAgents = new Map<string, https.Agent>();

function agentForProxy(proxyUrl: string): https.Agent {
  const hit = proxyAgents.get(proxyUrl);
  if (hit) return hit;
  const proxy = new URL(proxyUrl);
  const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
  const agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 8,
    maxFreeSockets: 4,
    rejectUnauthorized: true,
  });
  agent.createConnection = ((options: tls.ConnectionOptions, callback?: (err: Error | null, socket?: tls.TLSSocket) => void) => {
    const destHost = String(options.servername || options.host || '');
    const destPort = Number(options.port) || 443;
    const fail = (err: Error) => {
      callback?.(err);
    };
    if (!destHost || !isAllowedProxyTarget(destHost) || isBlockedProxyHost(proxy.hostname)) {
      fail(new Error('proxy target blocked'));
      return undefined as unknown as tls.TLSSocket;
    }
    const connectReq = http.request({
      host: proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${destHost}:${destPort}`,
      headers: { Host: `${destHost}:${destPort}` },
    });
    connectReq.setTimeout(5_000, () => {
      connectReq.destroy();
      fail(new Error('proxy CONNECT timeout'));
    });
    connectReq.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
    connectReq.on('connect', (res, socket) => {
      if ((res.statusCode || 0) !== 200) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        fail(new Error(`proxy CONNECT ${res.statusCode}`));
        return;
      }
      const ts = tls.connect(
        {
          socket,
          servername: destHost,
          rejectUnauthorized: true,
        },
        () => callback?.(null, ts),
      );
      ts.on('error', (e) => callback?.(e));
    });
    connectReq.end();
    return undefined as unknown as tls.TLSSocket;
  }) as typeof agent.createConnection;
  proxyAgents.set(proxyUrl, agent);
  return agent;
}

/**
 * GET/HEAD HTTPS via proxy HTTP CONNECT (googlevideo est toujours TLS).
 * SOCKS : non géré ici (yt-dlp --proxy s’en charge).
 * Tunnel keepAlive : plusieurs Range sur le même boundProxy réutilisent le TLS Google.
 */
export function fetchUrlViaProxy(
  targetUrl: string,
  proxyUrl: string | null,
  init: {
    method?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
    body?: Buffer | Uint8Array | string;
  } = {},
): Promise<globalThis.Response> {
  const timeoutMs = init.timeoutMs ?? 10_000;
  const bodyBuf =
    init.body == null
      ? undefined
      : typeof init.body === 'string'
        ? Buffer.from(init.body)
        : Buffer.from(init.body);
  if (!proxyUrl) {
    return fetch(targetUrl, {
      method: init.method || 'GET',
      headers: init.headers,
      body: bodyBuf,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  if (!isHttpProxy(proxyUrl)) {
    return Promise.reject(new Error('SOCKS fetch unsupported'));
  }

  const target = new URL(targetUrl);
  if (!isAllowedProxyTarget(target.hostname)) {
    return Promise.reject(
      new Error(`proxy target not allowed: ${target.hostname}`),
    );
  }
  if (isBlockedProxyHost(new URL(proxyUrl).hostname)) {
    return Promise.reject(new Error(`blocked proxy host: ${new URL(proxyUrl).hostname}`));
  }
  const destPort = Number(target.port) || (target.protocol === 'http:' ? 80 : 443);
  const headers: Record<string, string> = { ...(init.headers || {}), Host: target.host };
  if (bodyBuf && !headers['Content-Length'] && !headers['content-length']) {
    headers['Content-Length'] = String(bodyBuf.length);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const tlsReq = https.request(
      {
        agent: agentForProxy(proxyUrl),
        host: target.hostname,
        servername: target.hostname,
        port: destPort,
        path: `${target.pathname}${target.search}`,
        method: init.method || 'GET',
        headers,
        timeout: timeoutMs,
        rejectUnauthorized: true,
      },
        (ires) => {
          if (settled) {
            ires.resume();
            return;
          }
          settled = true;
          const status = ires.statusCode || 502;
          const noBody = status === 204 || status === 205 || status === 304;
          if (noBody) {
            ires.resume();
            resolve(new Response(null, { status, headers: headersToWeb(ires.headers) }));
            return;
          }
          const body = Readable.toWeb(ires) as ReadableStream<Uint8Array>;
          resolve(
            new Response(body, {
              status,
              headers: headersToWeb(ires.headers),
            }),
          );
        },
      );
      tlsReq.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
      tlsReq.setTimeout(timeoutMs, () => {
        tlsReq.destroy();
        fail(new Error('proxy TLS timeout'));
      });
      if (bodyBuf) tlsReq.end(bodyBuf);
      else tlsReq.end();
  });
}

/** fetch() Innertube / youtubei.js collé à un boundProxy (même IP que googlevideo). */
export function boundProxyFetch(proxyUrl: string): (input: any, init?: any) => Promise<Response> {
  return async (input, init) => {
    const req = input instanceof Request ? input : null;
    const url = req
      ? req.url
      : typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : String(input?.url || input);
    const method = String(init?.method || req?.method || 'GET');
    const headers: Record<string, string> = {};
    const src = init?.headers || req?.headers;
    if (src && typeof src.forEach === 'function') {
      src.forEach((v: string, k: string) => {
        headers[k] = v;
      });
    } else if (src && typeof src === 'object') {
      for (const [k, v] of Object.entries(src as Record<string, string>)) {
        if (v != null) headers[k] = String(v);
      }
    }
    let body: Buffer | undefined;
    const raw = init?.body;
    if (raw != null && typeof raw !== 'undefined') {
      if (typeof raw === 'string') body = Buffer.from(raw);
      else if (raw instanceof Uint8Array) body = Buffer.from(raw);
      else if (raw instanceof ArrayBuffer) body = Buffer.from(new Uint8Array(raw));
    } else if (req) {
      try {
        const ab = await req.arrayBuffer();
        if (ab.byteLength) body = Buffer.from(ab);
      } catch {
        /* GET */
      }
    }
    return fetchUrlViaProxy(url, proxyUrl, {
      method,
      headers,
      timeoutMs: 18_000,
      body,
    });
  };
}

/** Canary Google 204 — détecte un proxy qui atteint vraiment Google (pas seulement TCP ouvert). */
export async function probeGoogleCanary(proxyUrl: string, timeoutMs = 2_800): Promise<boolean> {
  if (!isHttpProxy(proxyUrl)) return false;
  try {
    const res = await fetchUrlViaProxy(CANARY_URL, proxyUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'PLM-stream/1.0' },
      timeoutMs,
    });
    await res.arrayBuffer().catch(() => undefined);
    return res.status === 204 || res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Sonde googlevideo en amont (Range 0-1) : 206/200 = OK, 5xx = changer de proxy
 * **avant** de piper le flux au client.
 */
export async function probeGooglevideoUpstream(
  url: string,
  proxyUrl: string | null,
  headers: Record<string, string>,
  timeoutMs = 4_000,
): Promise<{ status: number; ok: boolean }> {
  const h = { ...headers, Range: headers.Range || 'bytes=0-1' };
  try {
    const res = await fetchUrlViaProxy(url, proxyUrl, { method: 'GET', headers: h, timeoutMs });
    const status = res.status;
    try {
      await res.body?.cancel();
    } catch {
      /* ignore */
    }
    return { status, ok: status === 200 || status === 206 };
  } catch {
    return { status: 0, ok: false };
  }
}

async function canaryWarmSample(): Promise<void> {
  const httpProxies = [...pool.values()]
    .filter((e) => usable(e) && isHttpProxy(e.url) && (e.gvHits || 0) === 0)
    .slice(0, 24)
    .map((e) => e.url);
  const batch = 6;
  for (let i = 0; i < httpProxies.length; i += batch) {
    const slice = httpProxies.slice(i, i + batch);
    await Promise.all(
      slice.map(async (url) => {
        const ok = await probeGoogleCanary(url);
        if (ok) markYoutubeProxySuccess(url, 'tcp');
        else markYoutubeProxyFailure(url, 'tcp');
      }),
    );
  }
}

/** Démarre le refresh périodique (appelé au listen API). */
export function startYoutubeProxyBackgroundRefresh(): void {
  loadHotPoolFromDisk();
  if (bgTimer || !youtubeProxyFreeEnabled()) return;
  bgTimer = setInterval(() => {
    void ensureYoutubeProxyPool(true)
      .then(() => canaryWarmSample())
      .catch(() => {
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
  void ensureYoutubeProxyPool(true)
    .then(() => canaryWarmSample())
    .catch(() => {
      /* ignore */
    });
}

/** Erreur typique qui mérite un retry via un autre proxy. */
export function isProxyWorthRetry(err: unknown): boolean {
  const msg = String((err as Error)?.message || err || '');
  return /LOGIN_REQUIRED|Sign in|bot|unavailable|403|429|50[234]|timed? ?out|ECONN|ENOTFOUND|proxy|Tunnel|SOCKS|first-byte|format is not available|Requested format|HTTP Error|unable to download|certificate|SSL|TLS/i.test(
    msg,
  );
}
