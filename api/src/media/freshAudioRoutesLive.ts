/**
 * Exécution réelle des routes neuves : InnerTube (autre client / itag) puis relais JSON.
 * Sonde HEAD ou 64 octets. Aucun lecteur, aucun pipe vers un appareil.
 */
import { fileURLToPath } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import type { Innertube } from 'youtubei.js';
import type { FreshAudioHit, FreshRouteSpec } from './freshAudioRoutes.js';
import { safeRouteError, tryFreshAudioRoutes } from './freshAudioRoutes.js';

const ROUTE_MS = 8_000;
const UA_ANDROID = 'com.google.android.youtube/19.29.37 (Linux; U; Android 14) gzip';
const UA_VR =
  'com.google.android.apps.youtube.vr.oculus/1.57.29 (Linux; U; Android 12; vr_oculus) gzip';
const UA_WEB =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sessions = new Map<string, Promise<Innertube>>();

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

function probeUserAgent(url: string): string {
  try {
    const c = new URL(url).searchParams.get('c') || '';
    if (/ANDROID_VR/i.test(c)) return UA_VR;
    if (/ANDROID/i.test(c)) return UA_ANDROID;
  } catch {
    /* ignore */
  }
  return UA_WEB;
}

/** HEAD d’abord. Si YouTube le refuse, 64 octets puis abandon — pas un flux. */
export async function silentProbeUrl(url: string): Promise<'HEAD' | 'RANGE'> {
  const headers: Record<string, string> = {
    'User-Agent': probeUserAgent(url),
    Accept: '*/*',
    Origin: 'https://www.youtube.com',
    Referer: 'https://www.youtube.com/',
  };
  const head = await fetch(url, {
    method: 'HEAD',
    redirect: 'follow',
    headers,
    signal: AbortSignal.timeout(ROUTE_MS),
  }).catch(() => null);
  if (head && (head.status === 200 || head.status === 206)) {
    const ct = (head.headers.get('content-type') || '').toLowerCase();
    if (ct && /text\/html|application\/json/.test(ct) && !/audio|video|mp4|octet-stream/.test(ct)) {
      throw new Error('head-html');
    }
    return 'HEAD';
  }
  const ranged = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: { ...headers, Range: 'bytes=0-63' },
    signal: AbortSignal.timeout(ROUTE_MS),
  });
  const buf = await readPrefix(ranged, 64);
  if (ranged.status !== 200 && ranged.status !== 206) {
    throw new Error(`range-${ranged.status || 'net'}`);
  }
  if (buf.length < 16 || looksHtml(buf)) throw new Error('range-pas-audio');
  return 'RANGE';
}

function itagOf(url: string): string | null {
  try {
    return new URL(url).searchParams.get('itag');
  } catch {
    return null;
  }
}

/** Session propre au client. `client` dans le corps d’une session WEB renvoie 400. */
async function clientSession(client: 'ANDROID' | 'MWEB' | 'ANDROID_VR'): Promise<Innertube> {
  const hit = sessions.get(client);
  if (hit) return hit;
  const pending = (async () => {
    const { Innertube, ClientType } = await import('youtubei.js');
    const { installYoutubeJsEvaluator } = await import('../youtube/youtubeiEval.js');
    const { resolveYoutubeCookieHeader } = await import('../youtube/youtubeCookies.js');
    installYoutubeJsEvaluator();
    const cookie = resolveYoutubeCookieHeader();
    const client_type =
      client === 'ANDROID' ? ClientType.ANDROID : client === 'MWEB' ? ClientType.MWEB : ClientType.ANDROID_VR;
    return Innertube.create({
      generate_session_locally: true,
      client_type,
      ...(cookie ? { cookie } : {}),
    });
  })();
  sessions.set(client, pending);
  pending.catch(() => sessions.delete(client));
  return pending;
}

async function attemptInnertube(
  videoId: string,
  client: 'ANDROID' | 'MWEB' | 'ANDROID_VR',
  itag: number,
): Promise<FreshAudioHit> {
  const innertube = await clientSession(client);
  const format = await Promise.race([
    innertube.getStreamingData(videoId, {
      type: 'audio',
      quality: 'best',
      itag,
    }),
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`innertube ${client} itag ${itag} timeout`)), ROUTE_MS),
    ),
  ]);
  const url = format?.url || (await format?.decipher?.(innertube.session.player));
  if (!url) throw new Error('pas de format');
  const probe = await silentProbeUrl(url);
  return {
    url,
    mimeType: format.mime_type,
    bitrate: format.bitrate,
    contentLength: format.content_length,
    probe,
    itag: itagOf(url) || String(itag),
  };
}

async function attemptRelay(videoId: string): Promise<FreshAudioHit> {
  let resolveStreamUpstream: () => string | null;
  try {
    ({ resolveStreamUpstream } = await import('./stream.js'));
  } catch (err) {
    throw new Error(`relay-import ${safeRouteError(err)}`);
  }
  const base = resolveStreamUpstream();
  if (!base) throw new Error('relay-absent');
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-YTM-Stream-Relay': '1',
  };
  const token = (process.env.STREAM_RELAY_TOKEN || '').trim();
  if (token) headers['X-YTM-Stream-Relay-Token'] = token;
  const health = await fetch(`${base}/api/health`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(1_500),
  });
  if (!health.ok) throw new Error(`relay-health-${health.status}`);
  const upstream = await fetch(`${base}/api/stream/${videoId}/url`, {
    headers,
    signal: AbortSignal.timeout(ROUTE_MS),
  });
  if (!upstream.ok) throw new Error(`relay-http-${upstream.status}`);
  const body = (await upstream.json()) as { url?: string; mimeType?: string; expiresAt?: number };
  const url = String(body?.url || '');
  if (!/^https?:\/\//.test(url) || /\/api\/stream\//.test(url)) {
    throw new Error('relay-pas-url-audio');
  }
  const probe = await silentProbeUrl(url);
  return {
    url,
    mimeType: body.mimeType,
    expiresAt: body.expiresAt,
    probe,
    itag: itagOf(url),
  };
}

export async function attemptProductionFreshRoute(
  route: FreshRouteSpec,
  videoId: string,
): Promise<FreshAudioHit | null> {
  if (route.kind === 'relay') return attemptRelay(videoId);
  return attemptInnertube(videoId, route.client, route.itag);
}

export async function rememberFreshAudio(videoId: string, hit: FreshAudioHit): Promise<void> {
  const { rememberAudioFormat } = await import('../youtube/yt.js');
  rememberAudioFormat(videoId, {
    url: hit.url,
    mimeType: hit.mimeType,
    bitrate: hit.bitrate,
    contentLength: hit.contentLength,
    expiresAt: hit.expiresAt,
    viaProxy: hit.viaProxy,
  });
}

const isMain =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]!);

if (isMain) {
  const videoId = process.argv[2] || 'Bo644plDuYM';
  tryFreshAudioRoutes(videoId, attemptProductionFreshRoute, rememberFreshAudio)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 2);
    })
    .catch((err) => {
      console.log(JSON.stringify({ videoId, ok: false, route: null, detail: String(err).slice(0, 160) }));
      process.exit(1);
    });
}
