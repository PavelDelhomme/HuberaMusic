/**
 * Exécution des routes publiques. Session Innertube par client, sans cookie.
 * Sonde 64 octets puis abandon si ce n’est pas de l’audio. Pas de yt-dlp.
 */
import { Innertube, ClientType } from 'youtubei.js';
import type { PublicAudioClient, PublicAudioRoute } from './publicAudioRoutes.js';
import {
  isPlayablePublicAudioUrl,
  publicAudioRoutesForRetry,
} from './publicAudioRoutes.js';
import { installYoutubeJsEvaluator } from '../youtube/youtubeiEval.js';

const ROUTE_MS = 6_000;

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

async function probeAudio(url: string, client: PublicAudioClient): Promise<void> {
  const headers: Record<string, string> = {
    'User-Agent': userAgentFor(client),
    Accept: '*/*',
    Origin: 'https://www.youtube.com',
    Referer: 'https://www.youtube.com/',
    Range: 'bytes=0-63',
  };
  const ranged = await fetch(url, {
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
};

async function oneRoute(videoId: string, route: PublicAudioRoute): Promise<PublicAudioHit> {
  const innertube = await sessionFor(route.client);
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
  await probeAudio(url, route.client);
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

/** Deux clients / itags. Le retry suivant commence plus loin dans la liste. */
export async function resolvePublicAudioUrl(videoId: string, retryN = 0): Promise<PublicAudioHit> {
  const routes = publicAudioRoutesForRetry(retryN);
  let last = 'aucune route publique';
  for (const route of routes) {
    try {
      const hit = await oneRoute(videoId, route);
      console.info(`[public-audio] ${videoId} ${hit.route} itag=${hit.itag}`);
      return hit;
    } catch (err) {
      last = String((err as Error)?.message || err).replace(/https?:\/\/\S+/gi, '[url]').slice(0, 140);
      console.info(`[public-audio] ${videoId} ${route.name} ${last}`);
      if (/timeout|400|login|bot/i.test(last)) sessions.delete(route.client);
    }
  }
  throw new Error(last);
}
