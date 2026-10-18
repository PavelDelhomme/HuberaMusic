/**
 * Routes audio pour n’importe quel compte connecté.
 * Pas de cookie, pas de proxy, pas de header personnel, pas de tunnel maison.
 * Une lecture qui échoue (bot, itag, délai) prend la route suivante.
 */

export type PublicAudioClient = 'ANDROID' | 'MWEB' | 'IOS' | 'TV' | 'WEB_EMBEDDED';

export type PublicAudioRoute = {
  name: string;
  client: PublicAudioClient;
  itag: number;
};

/** Ordre fixe. Deux routes par essai, pas la liste entière. */
export const PUBLIC_AUDIO_ROUTES: readonly PublicAudioRoute[] = [
  { name: 'public:ANDROID:251', client: 'ANDROID', itag: 251 },
  { name: 'public:MWEB:250', client: 'MWEB', itag: 250 },
  { name: 'public:IOS:140', client: 'IOS', itag: 140 },
  { name: 'public:TV:139', client: 'TV', itag: 139 },
  { name: 'public:WEB_EMBEDDED:249', client: 'WEB_EMBEDDED', itag: 249 },
];

export function publicAudioRoutesForRetry(retryN = 0): PublicAudioRoute[] {
  const n = PUBLIC_AUDIO_ROUTES.length;
  const start = ((Math.trunc(retryN) % n) + n) % n;
  return [PUBLIC_AUDIO_ROUTES[start]!, PUBLIC_AUDIO_ROUTES[(start + 1) % n]!];
}

/** AAC progressif ou Opus/WebM. Pas un flux DASH. */
export function isPlayablePublicAudioUrl(url: string, mime = ''): boolean {
  if (!url || !/^https?:\/\//.test(url)) return false;
  if (/dash|ftypdash/i.test(mime) || /\/dash\b/i.test(url)) return false;
  if (/[?&]itag=(139|140|141|249|250|251)\b/.test(url)) return true;
  return /audio\/(mp4|webm)/i.test(mime);
}
