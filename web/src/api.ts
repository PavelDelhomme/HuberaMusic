import { Capacitor } from '@capacitor/core';

export type Track = {
  id: string;
  title: string;
  artists: { name: string; id?: string }[];
  album?: { name: string; id?: string };
  duration?: string;
  durationSeconds?: number;
  thumbnails: { url: string; width?: number; height?: number }[];
  type: 'song' | 'video' | 'album' | 'playlist' | 'artist' | 'mix' | 'unknown';
};

export type Shelf = {
  title: string;
  items: Track[];
};

export type LibraryPlaylist = {
  id: string;
  name: string;
  description: string;
  coverUrl?: string;
  createdAt: number;
  updatedAt: number;
  tracks: Track[];
  trackCount?: number;
};

export type LibraryData = {
  /** Titres enregistrés dans la bibliothèque (≠ J’aime). */
  songs: Track[];
  liked: Track[];
  likedPlaylists: any[];
  albums: any[];
  artists: any[];
  /** Mix radios enregistrés. */
  mixes: Track[];
  playlists: LibraryPlaylist[];
  history: Track[];
  /** Playlists / albums / mixes lancés récemment. */
  recentEntities: Track[];
  downloaded: string[];
};

export type User = {
  id: string;
  email: string;
  name: string;
  picture?: string | null;
  hasGoogle?: boolean;
  isGuest?: boolean;
  isAdmin?: boolean;
  emailVerified?: boolean;
  totpEnabled?: boolean;
  ytmLinked?: boolean;
};

const TOKEN_KEY = 'ytm_token';
const DEVICE_KEY = 'ytm_device';
const REFRESH_KEY = 'ytm_refresh';

/**
 * Origine API absolue (APK Capacitor / build natif).
 * Vide = chemins relatifs (web / Vite proxy).
 */
export function apiOrigin(): string {
  const env = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.replace(/\/$/, '');
  if (env) return env;
  try {
    if (Capacitor.isNativePlatform()) {
      const stored = localStorage.getItem('ytm_api_origin')?.replace(/\/$/, '');
      return stored || 'https://ytmusic.delhomme.ovh';
    }
  } catch {
    /* web */
  }
  return '';
}

/** Préfixe une route `/api/...` avec l’origine si besoin. */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = apiOrigin();
  const p = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${p}` : p;
}

function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function setRefreshToken(token: string | null) {
  if (token) localStorage.setItem(REFRESH_KEY, token);
  else localStorage.removeItem(REFRESH_KEY);
}
export function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY);
}

/** Upscale / normalize CDN thumbnail URLs for crisp display */
export function resizeThumbUrl(url: string, size = 200): string {
  if (!url) return '';
  let u = url;

  if (/=w\d+-h\d+/.test(u)) {
    u = u.replace(/=w\d+-h\d+(-[^=?#]*)?/, `=w${size}-h${size}$1`);
  } else if (/=s\d+/.test(u)) {
    u = u.replace(/=s\d+(-[^=?#]*)?/, `=s${size}$1`);
  } else if (/googleusercontent\.com|ggpht\.com|yt3\.ggpht\.com|lh3\.googleusercontent/.test(u)) {
    const base = u.split('=')[0];
    u = `${base}=s${size}-c-k-c0x00ffffff-no-rj`;
  }

  // ytimg : uniquement tailles quasi toujours présentes (hq720/maxres/sd → 404 fréquents)
  const vi = u.match(/i\.ytimg\.com\/vi(?:_webp)?\/([^/]+)\//i);
  if (vi) {
    const id = vi[1];
    if (size >= 320) return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  }

  return u;
}

/** true si URL ytimg connue pour 404 souvent */
function isFragileYtimg(url: string): boolean {
  return /\/(hq720|maxresdefault|sddefault|maxresdefault_live)\.(jpg|webp)/i.test(url);
}

/** Proxy : ggpht + ytimg via /api/img (chaîne serveur, jamais 404 navigateur) */
export function proxiedThumbUrl(url: string, size = 200): string {
  const resized = resizeThumbUrl(url, size);
  if (!resized) return '';
  const vi = resized.match(/i\.ytimg\.com\/vi(?:_webp)?\/([^/]+)\//i);
  if (vi) {
    return apiUrl(`/api/img?v=${encodeURIComponent(vi[1])}&s=${size}`);
  }
  if (/googleusercontent|ggpht|yt3\./.test(resized)) {
    return apiUrl(`/api/img?u=${encodeURIComponent(resized)}`);
  }
  if (isFragileYtimg(url)) {
    const id = url.match(/\/vi(?:_webp)?\/([^/]+)\//i)?.[1];
    if (id) return apiUrl(`/api/img?v=${encodeURIComponent(id)}&s=${size}`);
  }
  return resized;
}

/**
 * Candidats cover : 1) thumbs API (ggpht) 2) proxy ytimg multi-fallback.
 * Pas de maxres/hq720/sd en direct → plus de spam 404 console.
 */
export function thumbCandidates(
  track: Track | { thumbnails?: Track['thumbnails']; id?: string },
  size = 200,
): string[] {
  const list = [...(track.thumbnails || [])].sort((a, b) => (b.width || 0) - (a.width || 0));
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (u: string) => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  const id = (track as Track).id;

  // ID vidéo → ytimg proxy/direct d’abord (fiable pour mosaïques « Mixés pour toi »)
  if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) {
    push(apiUrl(`/api/img?v=${encodeURIComponent(id)}&s=${size}`));
    push(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
    push(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`);
  }

  // Thumbs API (ggpht / yt3) ensuite — souvent 60–120px et flaky via proxy serveur
  for (const t of list) {
    if (!t?.url) continue;
    if (isFragileYtimg(t.url)) continue;
    if (/i\.ytimg\.com/i.test(t.url)) continue; // déjà couvert via ?v= / direct
    push(proxiedThumbUrl(t.url, size));
  }

  if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) {
    push(`https://i.ytimg.com/vi/${id}/default.jpg`);
  }

  return out;
}

export function thumb(track: Track | { thumbnails?: Track['thumbnails']; id?: string }, size = 200) {
  return thumbCandidates(track, size)[0] || '';
}

export function artistNames(track: Track) {
  const names = track.artists
    ?.map((a) => a.name)
    .filter((n) => n && !/^(artiste|artist|inconnu|unknown|n\/a)$/i.test(n.trim()));
  return names?.length ? names.join(', ') : 'Artiste';
}

type ReqInit = RequestInit & { timeoutMs?: number };

async function req<T>(url: string, init?: ReqInit, retried = false): Promise<T> {
  const fullUrl = apiUrl(url);
  const timeoutMs = init?.timeoutMs ?? 25_000;
  const { timeoutMs: _ignored, ...fetchInit } = init || {};
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Device-Id': deviceId(),
    ...(fetchInit.headers as Record<string, string> | undefined),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  // Respect caller abort if any
  const onAbort = () => ctrl.abort();
  fetchInit.signal?.addEventListener('abort', onAbort);

  let res: Response;
  try {
    res = await fetch(fullUrl, {
      ...fetchInit,
      headers,
      credentials: 'include',
      signal: ctrl.signal,
    });
  } catch (e) {
    window.clearTimeout(timer);
    fetchInit.signal?.removeEventListener('abort', onAbort);
    if ((e as Error)?.name === 'AbortError') {
      throw new Error('API ne répond pas (timeout) — vérifie que le serveur :8787 tourne (make ensure-api)');
    }
    throw new Error(
      `Impossible de joindre l’API (${(e as Error)?.message || e}). Lance make ensure-api.`,
    );
  }
  window.clearTimeout(timer);
  fetchInit.signal?.removeEventListener('abort', onAbort);

  if (res.status === 401 && !retried && !fullUrl.includes('/auth/')) {
    const refreshed = await tryRefresh();
    if (refreshed) return req<T>(url, init, true);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg =
      body.error ||
      (res.status === 502
        ? 'Bad Gateway — API indisponible (make ensure-api)'
        : res.statusText);
    const err = new Error(msg) as Error & { needs2fa?: boolean; status?: number };
    if (body.needs2fa) err.needs2fa = true;
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

/** Un seul refresh à la fois (évite course multi-onglets / appels parallèles). */
let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const refreshToken = getRefreshToken();
    const attempt = async (body: Record<string, unknown>) => {
      const r = await fetch(apiUrl('/api/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId() },
        body: JSON.stringify(body),
      });
      if (!r.ok) return null;
      return r.json() as Promise<{ token?: string; refreshToken?: string }>;
    };
    try {
      // 1) localStorage + cookies ; 2) cookies seuls si le refresh local est périmé
      let data = await attempt(refreshToken ? { refreshToken } : {});
      if (!data && refreshToken) {
        data = await attempt({});
      }
      if (!data) return false;
      if (data.token) setToken(data.token);
      if (data.refreshToken) setRefreshToken(data.refreshToken);
      return true;
    } catch {
      return false;
    }
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

export const api = {
  health: () => req<{ ok: boolean; auth: { googleEnabled: boolean; googleClientId: string | null } }>('/api/health'),
  authConfig: () =>
    req<{
      googleEnabled: boolean;
      googleClientId: string | null;
      allowRegister: boolean;
      privateMode: boolean;
    }>('/api/auth/config'),
  me: () => req<{ user: User | null }>('/api/auth/me'),
  register: (email: string, password: string, name: string) =>
    req<{ user: User; token: string; refreshToken?: string; needsEmailVerification?: boolean }>(
      '/api/auth/register',
      {
        method: 'POST',
        body: JSON.stringify({ email, password, name }),
      },
    ),
  login: (email: string, password: string, totp?: string) =>
    req<{ user: User; token: string; refreshToken?: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, totp }),
    }),
  google: (credential: string) =>
    req<{ user: User; token: string; refreshToken?: string }>('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ credential }),
    }),
  logout: () => req<{ ok: boolean }>('/api/auth/logout', { method: 'POST', body: '{}' }),
  refresh: (refreshToken?: string) =>
    req<{ user: User; token: string; refreshToken: string }>('/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({
        // undefined → localStorage ; '' → cookies httpOnly seuls
        refreshToken: refreshToken !== undefined ? refreshToken : getRefreshToken(),
      }),
    }),
  verifyEmail: (token: string) =>
    req<{ ok: boolean; user: User }>('/api/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  resendVerification: () =>
    req<{ ok: boolean }>('/api/auth/resend-verification', { method: 'POST', body: '{}' }),
  totpSetup: () => req<{ secret: string; otpauthUrl: string }>('/api/auth/2fa/setup', { method: 'POST', body: '{}' }),
  totpEnable: (secret: string, code: string) =>
    req<{ ok: boolean; user: User }>('/api/auth/2fa/enable', {
      method: 'POST',
      body: JSON.stringify({ secret, code }),
    }),
  totpDisable: (code: string) =>
    req<{ ok: boolean; user: User }>('/api/auth/2fa/disable', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  telemetry: (payload: Record<string, unknown>) =>
    req<{ ok: boolean }>('/api/telemetry', { method: 'POST', body: JSON.stringify(payload) }),
  adminTelemetry: (level?: string) =>
    req<{ stats: any; events: any[] }>(
      `/api/admin/telemetry${level ? `?level=${encodeURIComponent(level)}` : ''}`,
    ),
  adminMailOutbox: () => req<{ mails: any[] }>('/api/admin/mail-outbox'),
  adminSmtp: () => req<{ smtp: any; env: string; appUrl: string | null }>('/api/admin/smtp'),
  adminSmtpTest: (to?: string) =>
    req<{ ok: boolean; mode?: string; error?: string; config?: any; sent?: any }>(
      '/api/admin/smtp/test',
      { method: 'POST', body: JSON.stringify({ to }) },
    ),
  updateProfile: (patch: { name?: string; email?: string; picture?: string | null }) =>
    req<{ user: User }>('/api/auth/profile', { method: 'PATCH', body: JSON.stringify(patch) }),
  passkeys: () => req<{ passkeys: any[] }>('/api/auth/passkeys'),
  passkeyRegisterOptions: () => req<any>('/api/auth/passkeys/register/options', { method: 'POST', body: '{}' }),
  passkeyRegisterVerify: (credential: unknown, name?: string) =>
    req<{ ok: boolean; passkeys: any[] }>('/api/auth/passkeys/register/verify', {
      method: 'POST',
      body: JSON.stringify({ credential, name }),
    }),
  passkeyDelete: (id: string) =>
    req<{ ok: boolean; passkeys: any[] }>(`/api/auth/passkeys/${id}`, { method: 'DELETE' }),
  passkeyLoginOptions: (email?: string) =>
    req<any>('/api/auth/passkeys/login/options', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  passkeyLoginVerify: (credential: unknown) =>
    req<{ user: User; token: string }>('/api/auth/passkeys/login/verify', {
      method: 'POST',
      body: JSON.stringify({ credential }),
    }),
  deviceLoginStart: () =>
    req<{
      id: string;
      code: string;
      pollSecret: string;
      expiresAt: number;
      approveUrl: string;
    }>('/api/auth/device-login/start', { method: 'POST', body: '{}' }),
  deviceLoginPoll: (id: string, pollSecret: string) =>
    req<{
      status: 'pending' | 'approved' | 'expired' | 'error';
      error?: string;
      user?: User;
      token?: string;
      refreshToken?: string;
    }>('/api/auth/device-login/poll', {
      method: 'POST',
      body: JSON.stringify({ id, pollSecret }),
    }),
  deviceLoginApprove: (id: string, code: string) =>
    req<{ ok: boolean }>('/api/auth/device-login/approve', {
      method: 'POST',
      body: JSON.stringify({ id, code }),
    }),
  deviceLoginPeek: (id: string) =>
    req<{ status: string; expiresAt: number; expired: boolean }>(
      `/api/auth/device-login/peek?id=${encodeURIComponent(id)}`,
    ),
  deviceLoginInvite: () =>
    req<{ id: string; claimToken: string; expiresAt: number; claimUrl: string }>(
      '/api/auth/device-login/invite',
      { method: 'POST', body: '{}' },
    ),
  deviceLoginClaim: (claim: string) =>
    req<{ user: User; token: string; refreshToken?: string }>(
      '/api/auth/device-login/claim',
      { method: 'POST', body: JSON.stringify({ claim }) },
    ),
  deployInfo: () =>
    req<{ urls: string[]; lan: { address: string; iface: string }[]; port: number; built: boolean }>(
      '/api/deploy/info',
    ),
  adminStatus: () => req<any>('/api/admin/status'),
  adminBuild: () => req<any>('/api/admin/build', { method: 'POST', body: '{}' }),
  adminBuildStatus: () => req<any>('/api/admin/build'),
  adminDeploy: () => req<any>('/api/admin/deploy'),
  adminDeployStart: (mode: 'web' | 'apk' | 'all') =>
    req<any>('/api/admin/deploy', { method: 'POST', body: JSON.stringify({ mode }) }),
  adminYoutubeCookies: () => req<any>('/api/admin/youtube-cookies'),
  adminYoutubeCookiesSave: (cookie: string) =>
    req<any>('/api/admin/youtube-cookies', {
      method: 'POST',
      body: JSON.stringify({ cookie }),
    }),
  adminYoutubeCookiesClear: () =>
    req<any>('/api/admin/youtube-cookies', { method: 'DELETE', body: '{}' }),
  adminApk: () => req<any>('/api/admin/apk'),
  adminApkTicket: (reason: 'download' | 'register' = 'download') =>
    req<{ ok: boolean; url: string; expiresAt: number; reason: string }>(
      '/api/admin/apk/ticket',
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),
  adminSettings: () =>
    req<{
      allowRegister: boolean;
      allowRegisterOverride: boolean | null;
      privateMode: boolean;
    }>('/api/admin/settings'),
  adminSetSettings: (allowRegister: boolean) =>
    req<{ ok: boolean; allowRegister: boolean; apkTicket?: { url: string } }>(
      '/api/admin/settings',
      { method: 'PUT', body: JSON.stringify({ allowRegister }) },
    ),
  adminUsers: () =>
    req<{
      users: Array<{
        id: string;
        email: string;
        name: string;
        ytmLinked: boolean;
        isAdmin: boolean;
        createdAt: number;
      }>;
      missingGoogle: number;
    }>('/api/admin/users'),
  adminApkBuild: (target: string = 'auto') =>
    req<any>('/api/admin/apk/build', {
      method: 'POST',
      body: JSON.stringify({ target }),
    }),
  /** Upload APK déjà compilée (Portainer / sans SDK). */
  adminApkUpload: async (
    file: Blob,
    meta: { apiBaseUrl: string; versionName?: string; versionCode?: number },
  ) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/vnd.android.package-archive',
      'X-Device-Id': deviceId(),
      'X-Apk-Api-Base-Url': meta.apiBaseUrl.replace(/\/$/, ''),
    };
    if (meta.versionName) headers['X-Apk-Version-Name'] = meta.versionName;
    if (meta.versionCode != null) headers['X-Apk-Version-Code'] = String(meta.versionCode);
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(apiUrl('/api/admin/apk/upload'), {
      method: 'POST',
      headers,
      credentials: 'include',
      body: file,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Upload APK ${res.status}`);
    }
    return res.json();
  },

  home: () =>
    req<{
      shelves: Shelf[];
      seeds?: string[];
      hasMore?: boolean;
      page?: number;
      needsOnboarding?: boolean;
      radios?: { id: string; title: string }[];
    }>('/api/home'),
  homeMore: (page: number, seeds: string[] = []) =>
    req<{ shelves: Shelf[]; hasMore: boolean; page: number }>(
      `/api/home/more?page=${page}&seeds=${encodeURIComponent(seeds.join(','))}`,
    ),
  explore: () =>
    req<{
      shelves: Shelf[];
      needsOnboarding?: boolean;
      radios?: { id: string; title: string }[];
    }>('/api/explore'),
  exploreSpoken: (kind: 'podcast' | 'audiobook' = 'podcast') =>
    req<{ title: string; items: Track[] }>(
      `/api/explore/spoken?kind=${encodeURIComponent(kind)}`,
    ),
  mood: (id: string, title?: string) => {
    const params = new URLSearchParams();
    if (title) params.set('title', title);
    const q = params.toString();
    return req<{ title: string; shelves: Shelf[] }>(
      `/api/mood/${encodeURIComponent(id)}${q ? `?${q}` : ''}`,
    );
  },
  search: (q: string, filter = 'all', opts?: { noHistory?: boolean }) => {
    const params = new URLSearchParams({ q, filter });
    if (opts?.noHistory) params.set('noHistory', '1');
    return req<{
      topResult: Track | null;
      songs: Track[];
      videos: Track[];
      albums: Track[];
      artists: Track[];
      playlists: Track[];
    }>(`/api/search?${params.toString()}`);
  },
  suggestions: (q: string) =>
    req<{ suggestions: string[] }>(`/api/search/suggestions?q=${encodeURIComponent(q)}`),
  identifySearch: (body: { audioBase64: string; mimeType?: string; mode?: 'listen' | 'hum' }) =>
    req<{
      ok: boolean;
      query?: string;
      title?: string;
      artist?: string;
      error?: string;
      hint?: string;
    }>('/api/search/identify', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  searchHistory: () => req<{ history: any[] }>('/api/search/history'),
  recordSearch: (q: string) =>
    req<{ ok: boolean }>('/api/search/history', {
      method: 'POST',
      body: JSON.stringify({ query: q }),
    }).catch(() => ({ ok: false })),
  recordSearchClick: (q: string, track: { id: string; type?: string }) =>
    req<{ ok: boolean }>('/api/search/history', {
      method: 'POST',
      body: JSON.stringify({ query: q, clickedId: track.id, clickedKind: track.type || 'song' }),
    }).catch(() => ({ ok: false })),
  prefs: () => req<{ prefs: any; follows: any[] }>('/api/prefs'),
  savePrefs: (patch: Record<string, unknown>) =>
    req<{ prefs: any }>('/api/prefs', { method: 'PUT', body: JSON.stringify(patch) }),
  onboarding: (payload: Record<string, unknown>) =>
    req<{ prefs: any; follows: any[] }>('/api/prefs/onboarding', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  pins: () => req<{ pins: any[] }>('/api/pins'),
  addPin: (payload: Record<string, unknown>) =>
    req<{ pins: any[] }>('/api/pins', { method: 'POST', body: JSON.stringify(payload) }),
  /** Upsert multi-appareils — union serveur, pas d’écrasement. */
  syncPins: (pins: Record<string, unknown>[]) =>
    req<{ ok: boolean; pins: any[]; upserted?: number; total?: number }>('/api/pins/sync', {
      method: 'POST',
      body: JSON.stringify({ pins }),
    }),
  removePin: (id: string) => req<{ pins: any[] }>(`/api/pins/${id}`, { method: 'DELETE' }),
  publishSessionState: (state: Record<string, unknown>) =>
    req<{ devices: any[]; activePlayerId: string | null; state: any }>('/api/session/state', {
      method: 'PUT',
      body: JSON.stringify(state),
    }),
  sessionSnapshot: () =>
    req<{ devices: any[]; activePlayerId: string | null; state: any }>('/api/session'),
  sessionTransfer: (targetId: string, state?: Record<string, unknown>) =>
    req<{ devices: any[]; activePlayerId: string | null; state: any }>('/api/session/transfer', {
      method: 'POST',
      body: JSON.stringify({ targetId, state }),
    }),
  sessionSetActive: (targetId: string) =>
    req<{ devices: any[]; activePlayerId: string | null; state: any }>('/api/session/active', {
      method: 'POST',
      body: JSON.stringify({ targetId }),
    }),
  listen: (payload: {
    trackId: string;
    event: 'start' | 'progress' | 'complete' | 'skip';
    progressPct?: number;
    durationMs?: number;
    seedId?: string;
    track?: Track;
  }) => req<{ ok: boolean }>('/api/listen', { method: 'POST', body: JSON.stringify(payload) }),
  followArtist: (id: string, name?: string) =>
    req<{ ok: boolean; follows: any[] }>(`/api/artists/${id}/follow`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  unfollowArtist: (id: string) =>
    req<{ ok: boolean; follows: any[] }>(`/api/artists/${id}/follow`, { method: 'DELETE' }),
  recoSimilar: (trackId: string) =>
    req<{ tracks: Track[]; related: Track[]; radio: Track[] }>(`/api/reco/similar/${trackId}`),
  recoRadio: (category: string, opts?: { preview?: boolean }) =>
    req<{
      category: any;
      tracks: Track[];
      seed: Track | null;
      cached?: boolean;
      target?: number;
      generatedAt?: number;
    }>(`/api/reco/radio/${category}${opts?.preview ? '?preview=1' : ''}`, {
      timeoutMs: opts?.preview ? 20_000 : 70_000,
    }),
  recoRadios: () => req<{ radios: { id: string; title: string }[] }>('/api/reco/radios'),
  recoFeedback: (payload: {
    trackId: string;
    verdict: 'good' | 'bad';
    seedId?: string;
    context?: string;
  }) => req<{ ok: boolean }>('/api/reco/feedback', { method: 'POST', body: JSON.stringify(payload) }),
  adminReco: () => req<any>('/api/admin/reco'),
  adminRecoWeights: (mode: string, weights: Record<string, number>) =>
    req<any>('/api/admin/reco/weights', {
      method: 'PUT',
      body: JSON.stringify({ mode, ...weights }),
    }),
  track: (id: string) =>
    req<{ track: Track; streamUrl: string; cached: boolean }>(`/api/track/${id}`),
  upNext: (id: string) => req<{ tracks: Track[] }>(`/api/track/${id}/upnext`),
  related: (id: string, opts?: { fast?: boolean; full?: boolean }) => {
    const q = new URLSearchParams();
    if (opts?.fast) q.set('fast', '1');
    if (opts?.full === false) q.set('full', '0');
    if (opts?.full === true) q.set('full', '1');
    const qs = q.toString();
    return req<{
      related: Track[];
      radio: Track[];
      tracks?: Track[];
      fast?: boolean;
      cached?: boolean;
      target?: number;
      generatedAt?: number;
    }>(`/api/track/${id}/related${qs ? `?${qs}` : ''}`);
  },
  albumRadio: (id: string, opts?: { full?: boolean }) => {
    const q = opts?.full ? '?full=1' : '';
    return req<{ tracks: Track[]; cached?: boolean; target?: number; generatedAt?: number; preview?: boolean }>(
      `/api/album/${id}/radio${q}`,
    );
  },
  artistRadio: (id: string, opts?: { full?: boolean }) => {
    const q = opts?.full ? '?full=1' : '';
    return req<{ tracks: Track[]; cached?: boolean; target?: number; generatedAt?: number; preview?: boolean }>(
      `/api/artist/${id}/radio${q}`,
    );
  },
  artistSongs: (id: string, limit?: number) =>
    req<{
      artist: { id: string; name: string; subscribers?: string; thumbnails: Track['thumbnails']; description?: string };
      tracks: Track[];
    }>(`/api/artist/${id}/songs${limit ? `?limit=${limit}` : ''}`),
  lyrics: (id: string) =>
    req<{
      lyrics: string | null;
      timed?: { startMs: number; text: string }[] | null;
      source?: 'youtube' | 'lrclib' | 'lrc' | null;
      syncOffsetMs?: number;
    }>(`/api/track/${id}/lyrics`),
  streamUrl: (id: string, type: 'audio' | 'video' = 'audio') =>
    req<{ url: string; expiresAt: number; mimeType: string | null; kind?: string }>(
      `/api/stream/${id}/url${type === 'video' ? '?type=video' : ''}`,
    ),
  /** Clip multimédia : même ID ou fallback recherche titre+artiste. */
  trackVisual: (
    id: string,
    hints?: { title?: string; artist?: string; durationSeconds?: number },
  ) => {
    const q = new URLSearchParams();
    if (hints?.title) q.set('title', hints.title);
    if (hints?.artist) q.set('artist', hints.artist);
    if (hints?.durationSeconds != null) q.set('durationSeconds', String(hints.durationSeconds));
    const qs = q.toString();
    return req<{
      ok: boolean;
      audioId: string;
      visualId: string | null;
      source: 'same' | 'search' | 'none';
      title?: string;
      artist?: string;
      streamPath: string | null;
    }>(`/api/track/${id}/visual${qs ? `?${qs}` : ''}`);
  },
  artist: (id: string) =>
    req<{
      artist: { id: string; name: string; subscribers?: string; thumbnails: Track['thumbnails']; description?: string };
      songs: Track[];
      albums: Track[];
      singles: Track[];
      videos: Track[];
      featured: Track[];
      similar: Track[];
      playlists: Track[];
    }>(`/api/artist/${id}`),
  album: (id: string) =>
    req<{
      album: {
        id: string;
        title: string;
        year?: string;
        releaseType?: 'Album' | 'EP' | 'Single';
        artists: Track['artists'];
        thumbnails: Track['thumbnails'];
      };
      tracks: Track[];
    }>(`/api/album/${id}`),
  playlist: (id: string) =>
    req<{
      playlist: { id: string; title: string; author?: string; trackCount?: number; thumbnails: Track['thumbnails']; description?: string };
      tracks: Track[];
    }>(`/api/playlist/${id}`),
  download: (id: string, opts?: { ack?: boolean }) =>
    req<{ ok: boolean; path?: string; streamUrl?: string; ack?: boolean }>(
      `/api/download/${id}${opts?.ack ? '?ack=1' : ''}`,
      { method: 'POST' },
    ),
  playlistsContaining: (trackId: string) =>
    req<{ playlistIds: string[] }>(
      `/api/library/playlists/containing/${encodeURIComponent(trackId)}`,
    ),
  recordHistory: (track: Track) =>
    req<{ ok: boolean; history: Track[] }>('/api/history', {
      method: 'POST',
      body: JSON.stringify(track),
    }),
  history: () =>
    req<{ history: Track[]; entities?: Track[] }>('/api/history'),
  recordEntityPlay: (entity: {
    id: string;
    kind: 'playlist' | 'album' | 'artist' | 'mix';
    title?: string;
    name?: string;
    thumbnails?: Track['thumbnails'];
    artists?: Track['artists'];
    type?: string;
    covers?: string[];
  }) =>
    req<{ ok: boolean; entities: Track[] }>('/api/history/entity', {
      method: 'POST',
      body: JSON.stringify(entity),
    }),
  library: () => req<LibraryData>('/api/library'),
  like: (track: Track) =>
    req<{ liked: boolean; library: LibraryData }>('/api/library/like', {
      method: 'POST',
      body: JSON.stringify(track),
    }),
  /** Enregistre / retire un titre de la biblio (sans toucher aux J’aime). */
  toggleLibrarySong: (track: Track) =>
    req<{ saved: boolean; library: LibraryData }>('/api/library/songs', {
      method: 'POST',
      body: JSON.stringify(track),
    }),
  removeLibrarySong: (id: string) =>
    req<{ ok: boolean; saved: boolean; library: LibraryData }>(`/api/library/songs/${id}`, {
      method: 'DELETE',
    }),
  likePlaylist: (playlist: Record<string, unknown>) =>
    req<{ liked: boolean; library: LibraryData }>('/api/library/like-playlist', {
      method: 'POST',
      body: JSON.stringify(playlist),
    }),
  saveAlbum: (album: Record<string, unknown>) =>
    req<{ library: LibraryData }>('/api/library/albums', {
      method: 'POST',
      body: JSON.stringify(album),
    }),
  removeAlbum: (id: string) =>
    req<{ library: LibraryData }>(`/api/library/albums/${id}`, { method: 'DELETE' }),
  saveArtist: (artist: Record<string, unknown>) =>
    req<{ library: LibraryData }>('/api/library/artists', {
      method: 'POST',
      body: JSON.stringify(artist),
    }),
  removeArtist: (id: string) =>
    req<{ library: LibraryData }>(`/api/library/artists/${id}`, { method: 'DELETE' }),
  saveMix: (mix: { id: string; title: string; tracks?: Track[]; covers?: Track[] }) =>
    req<{ mix: Track; saved: boolean; library: LibraryData }>('/api/library/mixes', {
      method: 'POST',
      body: JSON.stringify(mix),
    }),
  removeMix: (id: string) =>
    req<{ ok: boolean; library: LibraryData }>(`/api/library/mixes/${id}`, { method: 'DELETE' }),
  createPlaylist: (name: string, description = '') =>
    req<LibraryPlaylist>('/api/library/playlists', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    }),
  updatePlaylist: (id: string, patch: { name?: string; description?: string }) =>
    req<LibraryPlaylist>(`/api/library/playlists/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deletePlaylist: (id: string) =>
    req<{ ok: boolean; library: LibraryData }>(`/api/library/playlists/${id}`, { method: 'DELETE' }),
  addToPlaylist: (playlistId: string, track: Track) =>
    req<LibraryPlaylist>(`/api/library/playlists/${encodeURIComponent(playlistId)}/tracks`, {
      method: 'POST',
      body: JSON.stringify(track),
    }),
  removeFromPlaylist: (playlistId: string, trackId: string) =>
    req<LibraryPlaylist>(
      `/api/library/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(trackId)}`,
      {
        method: 'DELETE',
      },
    ),
  reorderPlaylist: (playlistId: string, trackIds: string[]) =>
    req<LibraryPlaylist>(`/api/library/playlists/${encodeURIComponent(playlistId)}/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ trackIds }),
    }),
  import: (payload: {
    url?: string;
    query?: string;
    kind?: string;
    id?: string;
    options?: { likePlaylist?: boolean; createLocalCopy?: boolean };
  }) =>
    req<{ title: string; kind: string; added: Record<string, unknown>; library: LibraryData }>('/api/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  ytmStatus: () =>
    req<{ account: any; oauth: any }>('/api/ytm/status'),
  ytmConnectCookie: (cookie: string) =>
    req<{ ok: boolean; account: any }>('/api/ytm/connect/cookie', {
      method: 'POST',
      body: JSON.stringify({ cookie }),
    }),
  ytmConnectOauth: () =>
    req<{ ok: boolean; verificationUrl: string; userCode: string; expiresIn: number }>(
      '/api/ytm/connect/oauth',
      { method: 'POST', body: '{}' },
    ),
  ytmOauthStatus: () => req<{ status: string; error?: string; userCode?: string }>('/api/ytm/oauth/status'),
  ytmSync: () =>
    req<{ ok: boolean; running?: boolean; stats?: any; library?: LibraryData; account: any }>('/api/ytm/sync', {
      method: 'POST',
      body: '{}',
    }),
  ytmDisconnect: () => req<{ ok: boolean; account: any }>('/api/ytm/disconnect', { method: 'DELETE' }),
  offlineStart: (kind: string, targetId: string) =>
    req<{ jobId: string; total: number }>('/api/offline/start', {
      method: 'POST',
      body: JSON.stringify({ kind, targetId }),
    }),
  offlineJobs: () => req<{ jobs: any[] }>('/api/offline'),
  offlineDownloads: () => req<{ downloads: any[] }>('/api/offline/downloads'),
};
