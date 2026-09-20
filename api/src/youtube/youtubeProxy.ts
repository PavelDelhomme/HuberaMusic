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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { connect as netConnect } from 'node:net';
import { Readable } from 'node:stream';

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
      pool.delete(url);
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
    pool.delete(e.url);
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
  // Préférer googlevideo 206 récents, puis lastOk, round-robin dans le top.
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
  const pick = top[rr++ % top.length]!;
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
  const max = Math.max(1, Math.min(opts?.max ?? 4, 16));
  const includeDirect = opts?.includeDirect !== false;
  const directLast = Boolean(opts?.directLast);
  const doProbe = opts?.probe !== false && youtubeProxyFreeEnabled();
  const used = new Set<string>();
  const proxies: string[] = [];
  const raw: string[] = [];

  const fixed = (process.env.YOUTUBE_HTTP_PROXY || '').trim();
  const fixedN = fixed ? normalizeProxyUrl(fixed) : null;
  if (fixedN) {
    raw.push(fixedN);
    used.add(fixedN);
  }

  let guard = 0;
  const want = Math.max(max * 3, 16);
  while (raw.length < want && guard++ < want * 2) {
    if (usableCount() < LOW_POOL_REFRESH && youtubeProxyFreeEnabled()) {
      void ensureYoutubeProxyPool(true);
    }
    const p = await nextYoutubeProxy(used);
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

  if (fixedN && !proxies.includes(fixedN)) proxies.unshift(fixedN);

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
  if (e.fails >= EVICT_AFTER_FAILS) {
    pool.delete(proxy);
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
  if (kind === 'gv') e.gvHits = (e.gvHits || 0) + 1;
}

export function youtubeProxyStats(): {
  enabled: boolean;
  poolSize: number;
  usable: number;
  freeEnabled: boolean;
  gvWinners: number;
} {
  let gvWinners = 0;
  for (const e of pool.values()) {
    if ((e.gvHits || 0) > 0 && usable(e)) gvWinners += 1;
  }
  return {
    enabled: Boolean((process.env.YOUTUBE_HTTP_PROXY || '').trim()) || youtubeProxyFreeEnabled(),
    poolSize: pool.size,
    usable: usableCount(),
    freeEnabled: youtubeProxyFreeEnabled(),
    gvWinners,
  };
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

/**
 * GET/HEAD HTTPS via proxy HTTP CONNECT (googlevideo est toujours TLS).
 * SOCKS : non géré ici (yt-dlp --proxy s’en charge).
 */
export function fetchUrlViaProxy(
  targetUrl: string,
  proxyUrl: string | null,
  init: {
    method?: string;
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<globalThis.Response> {
  const timeoutMs = init.timeoutMs ?? 10_000;
  if (!proxyUrl) {
    return fetch(targetUrl, {
      method: init.method || 'GET',
      headers: init.headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  if (!isHttpProxy(proxyUrl)) {
    return Promise.reject(new Error('SOCKS fetch unsupported'));
  }

  const target = new URL(targetUrl);
  const proxy = new URL(proxyUrl);
  const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
  const destPort = Number(target.port) || 443;

  return new Promise((resolve, reject) => {
    let settled = false;
    const connectReq = http.request({
      host: proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${destPort}`,
      headers: { Host: `${target.hostname}:${destPort}` },
    });
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        connectReq.destroy();
      } catch {
        /* ignore */
      }
      reject(err);
    };
    connectReq.setTimeout(Math.min(timeoutMs, 5_000), () => fail(new Error('proxy CONNECT timeout')));
    connectReq.on('error', (err) => fail(err instanceof Error ? err : new Error(String(err))));
    connectReq.on('connect', (res, socket) => {
      if (settled) {
        socket.destroy();
        return;
      }
      if ((res.statusCode || 500) !== 200) {
        socket.destroy();
        fail(new Error(`proxy CONNECT ${res.statusCode}`));
        return;
      }
      const tlsReq = https.request(
        {
          host: target.hostname,
          servername: target.hostname,
          port: destPort,
          path: `${target.pathname}${target.search}`,
          method: init.method || 'GET',
          headers: { ...(init.headers || {}), Host: target.host },
          timeout: timeoutMs,
          createConnection: (_opts, cb) => {
            const ts = tls.connect({ socket, servername: target.hostname }, () => {
              cb(null, ts);
            });
            ts.on('error', (e) => cb(e));
            return ts;
          },
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
      tlsReq.end();
    });
    connectReq.end();
  });
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
