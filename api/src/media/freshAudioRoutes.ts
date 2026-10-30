/**
 * Titres sans URL audio (LOGIN_REQUIRED, pas de format, deadline).
 * Routes neuves, courtes, avant le balayage quotidien — jamais une lecture.
 */

export type FreshInnertubeRoute = {
  name: string;
  kind: 'innertube';
  client: 'ANDROID' | 'MWEB' | 'ANDROID_VR';
  itag: number;
};

export type FreshRelayRoute = {
  name: string;
  kind: 'relay';
};

export type FreshRouteSpec = FreshInnertubeRoute | FreshRelayRoute;

/** Clients / itags absents du chemin rapide (TV, WEB_EMBEDDED, IOS, itag 140). */
export const FRESH_ROUTE_PLAN: readonly FreshRouteSpec[] = [
  { name: 'innertube:ANDROID:251', kind: 'innertube', client: 'ANDROID', itag: 251 },
  { name: 'innertube:MWEB:250', kind: 'innertube', client: 'MWEB', itag: 250 },
  { name: 'innertube:ANDROID_VR:139', kind: 'innertube', client: 'ANDROID_VR', itag: 139 },
  { name: 'relay:stream-upstream', kind: 'relay' },
];

const MISSING_AUDIO_URL =
  /LOGIN_REQUIRED|sign in to confirm|not a bot|no-stream-url|streaming data not available|format is not available|requested format|pas de format|empty stream url|getAudioFormat deadline|resolve-timeout|audio format indisponible|yt-dlp audio URL indisponible|yt-dlp format timeout/i;

/** Vidéo réellement morte : le job quotidien cherche un autre id, pas une autre route. */
const DEAD_VIDEO =
  /this video is unavailable|video unavailable|private video|removed by the uploader|no longer available|has been removed|copyright/i;

export function isMissingAudioUrlFailure(message: string | null | undefined): boolean {
  const m = String(message || '');
  if (!m || DEAD_VIDEO.test(m)) return false;
  return MISSING_AUDIO_URL.test(m);
}

export function redactStreamLocator(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    const itag = u.searchParams.get('itag') || '';
    const tokenish = [...u.searchParams.keys()].some((k) =>
      /sig|lsig|token|n=|expire|ei|cpn|ip|id|source|requiressl|ratebypass/i.test(k),
    );
    if (tokenish || /googlevideo\.com|videoplayback/i.test(`${u.hostname}${u.pathname}`)) {
      return `${u.origin}${u.pathname}?redacted=1${itag ? `&itag=${itag}` : ''}`;
    }
    return `${u.origin}${u.pathname}`;
  } catch {
    return 'url-non-absolue';
  }
}

export function safeRouteError(err: unknown): string {
  return String((err as Error)?.message || err)
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
}

export type FreshAudioHit = {
  url: string;
  mimeType?: string;
  bitrate?: number;
  contentLength?: number;
  expiresAt?: number;
  viaProxy?: string | null;
  probe?: 'HEAD' | 'RANGE' | 'JSON';
  itag?: string | null;
};

export type FreshRouteAttempt = {
  name: string;
  ok: boolean;
  detail: string;
};

export type FreshRouteResult = {
  videoId: string;
  ok: boolean;
  route: string | null;
  tried: FreshRouteAttempt[];
};

export async function tryFreshAudioRoutes(
  videoId: string,
  attempt: (route: FreshRouteSpec, videoId: string) => Promise<FreshAudioHit | null>,
  onSuccess?: (videoId: string, hit: FreshAudioHit) => void | Promise<void>,
): Promise<FreshRouteResult> {
  const tried: FreshRouteAttempt[] = [];
  for (const route of FRESH_ROUTE_PLAN) {
    try {
      const hit = await attempt(route, videoId);
      if (!hit?.url) throw new Error('pas de format');
      await onSuccess?.(videoId, hit);
      const itag = hit.itag ? ` itag=${hit.itag}` : '';
      const probe = hit.probe ? ` probe=${hit.probe}` : '';
      tried.push({ name: route.name, ok: true, detail: `url-audio${probe}${itag}`.trim() });
      return { videoId, ok: true, route: route.name, tried };
    } catch (err) {
      tried.push({ name: route.name, ok: false, detail: safeRouteError(err) });
    }
  }
  return { videoId, ok: false, route: null, tried };
}

export async function runMissingAudioRecoveryThenDaily<T>(opts: {
  videoIds: string[];
  attempt: (route: FreshRouteSpec, videoId: string) => Promise<FreshAudioHit | null>;
  onSuccess?: (videoId: string, hit: FreshAudioHit) => void | Promise<void>;
  daily: () => Promise<T>;
}): Promise<{ recoveries: FreshRouteResult[]; daily: T }> {
  const recoveries: FreshRouteResult[] = [];
  for (const videoId of opts.videoIds) {
    recoveries.push(await tryFreshAudioRoutes(videoId, opts.attempt, opts.onSuccess));
  }
  const daily = await opts.daily();
  return { recoveries, daily };
}
