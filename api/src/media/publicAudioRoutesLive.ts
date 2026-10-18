/**
 * Exécution des routes publiques. Session Innertube par client, sans cookie.
 * Sonde 64 octets puis abandon si ce n’est pas de l’audio. Pas de yt-dlp.
 * Une URL déjà obtenue est réutilisée : le titre connu ne refait pas le tour lecteur.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Innertube, ClientType } from 'youtubei.js';
import type { PublicAudioClient, PublicAudioRoute } from './publicAudioRoutes.js';
import {
  isPlayablePublicAudioUrl,
  publicAudioRoutesForRetry,
} from './publicAudioRoutes.js';
import { installYoutubeJsEvaluator } from '../youtube/youtubeiEval.js';
import {
  boundProxyFetch,
  loadHotPoolFromDisk,
  markYoutubeProxyFailure,
  pickHotProxies,
  reviveSharedEgress,
} from '../youtube/youtubeProxy.js';

const ROUTE_MS = 6_000;
const CACHE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'public-audio-url-cache.json');
const CACHE_MAX = 400;

type CachedHit = PublicAudioHit & { expiresAt: number };

const urlCache = new Map<string, CachedHit>();
let cacheLoaded = false;
let cacheTimer: ReturnType<typeof setTimeout> | null = null;

function expiresAtOf(url: string): number {
  try {
    const raw = new URL(url).searchParams.get('expire');
    const sec = raw ? Number(raw) : 0;
    if (sec > 1_000_000_000) return sec * 1000;
  } catch {
    /* ignore */
  }
  return Date.now() + 90 * 60_000;
}

function loadUrlCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    if (!existsSync(CACHE_PATH)) return;
    const rows = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Array<CachedHit & { videoId?: string }>;
    const now = Date.now();
    for (const row of rows) {
      if (!row?.videoId || !/^[a-zA-Z0-9_-]{11}$/.test(row.videoId)) continue;
      if (!row.url || !row.expiresAt || row.expiresAt < now + 60_000) continue;
      urlCache.set(row.videoId, row);
    }
  } catch {
    /* cache illisible : on repart à vide */
  }
}

function scheduleCacheWrite() {
  if (cacheTimer) return;
  cacheTimer = setTimeout(() => {
    cacheTimer = null;
    try {
      const dir = dirname(CACHE_PATH);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const rows = [...urlCache.entries()].slice(-CACHE_MAX).map(([videoId, hit]) => ({ videoId, ...hit }));
      writeFileSync(CACHE_PATH, JSON.stringify(rows));
    } catch {
      /* volume indisponible */
    }
  }, 400);
}

export function forgetPublicAudio(videoId: string) {
  if (!videoId) return;
  loadUrlCache();
  if (!urlCache.delete(videoId)) return;
  scheduleCacheWrite();
}

function rememberPublicAudio(videoId: string, hit: PublicAudioHit) {
  const expiresAt = expiresAtOf(hit.url);
  if (expiresAt < Date.now() + 60_000) return;
  loadUrlCache();
  urlCache.set(videoId, { ...hit, expiresAt });
  while (urlCache.size > CACHE_MAX) {
    const oldest = urlCache.keys().next().value;
    if (!oldest) break;
    urlCache.delete(oldest);
  }
  scheduleCacheWrite();
}

function peekPublicAudio(videoId: string): PublicAudioHit | null {
  loadUrlCache();
  const hit = urlCache.get(videoId);
  if (!hit) return null;
  if (hit.expiresAt < Date.now() + 60_000) {
    urlCache.delete(videoId);
    scheduleCacheWrite();
    return null;
  }
  return hit;
}

const sessions = new Map<PublicAudioClient, Promise<Innertube>>();

function clientTypeOf(client: PublicAudioClient): ClientType {
  switch (client) {
    case 'ANDROID':
      return ClientType.ANDROID;
    case 'MWEB':
      return ClientType.MWEB;
    case 'IOS':
      return ClientType.IOS;
    case 'TV':
      return ClientType.TV;
    case 'WEB_EMBEDDED':
      return ClientType.WEB_EMBEDDED;
    default:
      return ClientType.ANDROID;
  }
}

function userAgentFor(client: PublicAudioClient): string {
  if (client === 'ANDROID') {
    return 'com.google.android.youtube/19.29.37 (Linux; U; Android 14) gzip';
  }
  if (client === 'IOS') {
    return 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)';
  }
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
}

async function sessionFor(client: PublicAudioClient): Promise<Innertube> {
  const hit = sessions.get(client);
  if (hit) return hit;
  const pending = (async () => {
    installYoutubeJsEvaluator();
    return Innertube.create({
      generate_session_locally: true,
      client_type: clientTypeOf(client),
    });
  })();
  sessions.set(client, pending);
  pending.catch(() => sessions.delete(client));
  return pending;
}

async function readPrefix(res: Response, max = 64): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done || !value?.byteLength) break;
      chunks.push(value);
      n += value.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  const out = new Uint8Array(Math.min(n, max));
  let o = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, out.length - o);
    if (take <= 0) break;
    out.set(c.subarray(0, take), o);
    o += take;
  }
  return out;
}

function looksHtml(buf: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, 48)).trim().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('<head');
}

async function probeAudio(
  url: string,
  client: PublicAudioClient,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const headers: Record<string, string> = {
    'User-Agent': userAgentFor(client),
    Accept: '*/*',
    Origin: 'https://www.youtube.com',
    Referer: 'https://www.youtube.com/',
    Range: 'bytes=0-63',
  };
  const ranged = await fetchImpl(url, {
    method: 'GET',
    redirect: 'follow',
    headers,
    signal: AbortSignal.timeout(ROUTE_MS),
  });
  const buf = await readPrefix(ranged, 64);
  if (ranged.status !== 200 && ranged.status !== 206) {
    throw new Error(`range-${ranged.status || 'net'}`);
  }
  if (buf.length < 16 || looksHtml(buf)) throw new Error('range-pas-audio');
}

export type PublicAudioHit = {
  url: string;
  mimeType?: string;
  bitrate?: number;
  contentLength?: number;
  itag: string;
  route: string;
  /** Sortie partagée (tous les comptes). Les octets doivent repartir par la même adresse. */
  viaProxy?: string | null;
};

async function readFormat(
  videoId: string,
  route: PublicAudioRoute,
  innertube: Innertube,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicAudioHit> {
  const format = await Promise.race([
    innertube.getStreamingData(videoId, {
      type: 'audio',
      quality: 'best',
      itag: route.itag,
    }),
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`${route.name} timeout`)), ROUTE_MS),
    ),
  ]);
  const url = format?.url || (await format?.decipher?.(innertube.session.player));
  if (!url || !isPlayablePublicAudioUrl(url, String(format?.mime_type || ''))) {
    throw new Error(`${route.name} pas audio`);
  }
  await probeAudio(url, route.client, fetchImpl);
  const itag = (() => {
    try {
      return new URL(url).searchParams.get('itag') || String(route.itag);
    } catch {
      return String(route.itag);
    }
  })();
  return {
    url,
    mimeType: format?.mime_type,
    bitrate: format?.bitrate,
    contentLength: format?.content_length,
    itag,
    route: route.name,
  };
}

async function oneRoute(videoId: string, route: PublicAudioRoute): Promise<PublicAudioHit> {
  return readFormat(videoId, route, await sessionFor(route.client));
}

const AUDIO_ITAGS = [140, 139, 141, 251, 250, 249];
const iosSessions = new Map<string, Promise<Innertube>>();
let sharedGate: Promise<void> = Promise.resolve();

/** Un seul appel à la fois : une rafale vide la seule sortie qui renvoie encore une URL. */
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const run = sharedGate.then(job, job);
  sharedGate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Le script du lecteur reste sur l’adresse du serveur (rapide).
 * La requête lecteur et les octets googlevideo passent par la même sortie partagée,
 * sinon l’URL est refusée. Pas de cookie.
 */
function splitFetch(egress: string): typeof fetch {
  const via = boundProxyFetch(egress) as typeof fetch;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/\/youtubei\/v1\/player|googlevideo\.com/i.test(url)) return via(input, init);
    return fetch(input, init);
  }) as typeof fetch;
}

function iosSession(egress: string): Promise<Innertube> {
  const hit = iosSessions.get(egress);
  if (hit) return hit;
  const pending = (async () => {
    installYoutubeJsEvaluator();
    return Innertube.create({
      generate_session_locally: true,
      client_type: ClientType.IOS,
      fetch: splitFetch(egress),
    });
  })();
  iosSessions.set(egress, pending);
  pending.catch(() => iosSessions.delete(egress));
  return pending;
}

/**
 * iOS via une sortie du pool commun. Le client anonyme du datacenter n’a pas
 * de streamingData ; cette sortie en a, avec une URL sur les itags 140/139.
 */
async function sharedIosOnce(videoId: string, egress: string): Promise<PublicAudioHit> {
    const fetchImpl = splitFetch(egress);
    const innertube = await iosSession(egress);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const res = await Promise.race([
      innertube.session.actions.execute('/player', {
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        playbackContext: {
          contentPlaybackContext: {
            signatureTimestamp: innertube.session.player?.signature_timestamp || 0,
          },
        },
      }).finally(() => {
        if (timer) clearTimeout(timer);
      }),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => {
          iosSessions.delete(egress);
          rej(new Error('ios-partage timeout'));
        }, 18_000);
      }),
    ]);
    const data = (res as { data?: Record<string, any> }).data || {};
    const status = String(data.playabilityStatus?.status || '');
    if (status && status !== 'OK') {
      iosSessions.delete(egress);
      throw new Error(String(data.playabilityStatus?.reason || status).slice(0, 80));
    }
    const formats = [
      ...(data.streamingData?.formats || []),
      ...(data.streamingData?.adaptiveFormats || []),
    ].filter(
      (f) =>
        String(f.mimeType || '').startsWith('audio/') && (f.url || f.signatureCipher || f.cipher),
    );
    const pick =
      AUDIO_ITAGS.map((itag) => formats.find((f) => f.itag === itag)).find(Boolean) || formats[0];
    if (!pick || !innertube.session.player) throw new Error('pas de format audio');
    const url = await innertube.session.player.decipher(pick.url, pick.signatureCipher, pick.cipher);
    if (!url || !isPlayablePublicAudioUrl(url, String(pick.mimeType || ''))) {
      throw new Error('ios-partage pas audio');
    }
    await probeAudio(url, 'IOS', fetchImpl);
    return {
      url,
      mimeType: pick.mimeType,
      bitrate: pick.bitrate,
      contentLength: pick.contentLength ? Number(pick.contentLength) : undefined,
      itag: String(pick.itag || ''),
      route: 'public:IOS+partage',
      viaProxy: egress,
    };
}

async function sharedIosAudio(videoId: string): Promise<PublicAudioHit> {
  return oneAtATime(async () => {
    const exclude = new Set<string>();
    let last = 'pas de sortie partagée';
    for (let attempt = 0; attempt < 2; attempt++) {
      loadHotPoolFromDisk();
      const egress = pickHotProxies(1, exclude)[0] || (attempt === 0 ? reviveSharedEgress() : '');
      if (!egress) break;
      try {
        return await sharedIosOnce(videoId, egress);
      } catch (err) {
        last = String((err as Error)?.message || err).replace(/https?:\/\/\S+/gi, '[url]').slice(0, 140);
        exclude.add(egress);
        iosSessions.delete(egress);
        if (
          !/streaming data not available/i.test(last) &&
          /this video is not available|video unavailable|private video|removed by the uploader/i.test(last)
        ) {
          throw err;
        }
        if (/timeout|bot|sign in|403|429/i.test(last)) {
          markYoutubeProxyFailure(egress, 'gv');
          continue;
        }
        break;
      }
    }
    throw new Error(last);
  });
}

/** Sortie partagée d’abord (elle a une URL), puis deux clients directs. */
export async function resolvePublicAudioUrl(videoId: string, retryN = 0): Promise<PublicAudioHit> {
  if (retryN <= 0) {
    const cached = peekPublicAudio(videoId);
    if (cached) return cached;
  } else {
    forgetPublicAudio(videoId);
  }
  let last = 'aucune route publique';
  try {
    const hit = await sharedIosAudio(videoId);
    rememberPublicAudio(videoId, hit);
    console.info(`[public-audio] ${videoId} ${hit.route} itag=${hit.itag}`);
    return hit;
  } catch (err) {
    last = String((err as Error)?.message || err).replace(/https?:\/\/\S+/gi, '[url]').slice(0, 140);
    console.info(`[public-audio] ${videoId} partage ${last}`);
    if (
      !/streaming data not available/i.test(last) &&
      /this video is not available|video unavailable|private video|removed by the uploader/i.test(last)
    ) {
      throw new Error(`${last} id=${videoId}`);
    }
  }
  const routes = publicAudioRoutesForRetry(retryN);
  for (const route of routes) {
    try {
      const hit = await oneRoute(videoId, route);
      rememberPublicAudio(videoId, hit);
      console.info(`[public-audio] ${videoId} ${hit.route} itag=${hit.itag}`);
      return hit;
    } catch (err) {
      last = String((err as Error)?.message || err).replace(/https?:\/\/\S+/gi, '[url]').slice(0, 140);
      console.info(`[public-audio] ${videoId} ${route.name} ${last}`);
      if (/timeout|400|login|bot/i.test(last)) sessions.delete(route.client);
    }
  }
  throw new Error(`${last} id=${videoId}`);
}
