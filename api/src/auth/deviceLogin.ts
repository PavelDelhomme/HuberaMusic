import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export type DeviceLoginStatus = 'pending' | 'approved' | 'consumed' | 'expired';

type DeviceLoginSession = {
  id: string;
  /** Code court affiché / dans le QR (base64url court). */
  code: string;
  /** Secret pour le poll côté appareil à connecter. */
  pollSecret: string;
  status: DeviceLoginStatus;
  userId?: string;
  createdAt: number;
  expiresAt: number;
};

const TTL_MS = 2 * 60 * 1000;
const MAX = 200;
const sessions = new Map<string, DeviceLoginSession>();

function purge() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.expiresAt < now || s.status === 'consumed') sessions.delete(id);
  }
  while (sessions.size > MAX) {
    const first = sessions.keys().next().value;
    if (first === undefined) break;
    sessions.delete(first);
  }
}

function isPrivateOrLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0') return true;
    if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
    if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(h)) return true;
    return false;
  } catch {
    return true;
  }
}

const PUBLIC_HOSTS = new Set([
  'plm.delhomme.ovh',
  'ytmusic.delhomme.ovh',
  'pue-la-merde.delhomme.ovh',
  'ytmusic-preprod.delhomme.ovh',
  'music.hubera.cloud',
]);

export function isPublicMusicHost(hostname: string): boolean {
  const h = String(hostname || '').trim().toLowerCase();
  if (!h) return false;
  if (PUBLIC_HOSTS.has(h)) return true;
  if (h === 'hubera.cloud' || h.endsWith('.hubera.cloud')) return true;
  if (h.endsWith('.delhomme.ovh') && /^(plm|ytmusic|pue-la-merde)([.-]|$)/.test(h)) return true;
  return false;
}

/** URL publique pour QR / liens (jamais une IP Docker / localhost). */
function publicBase(): string {
  const candidates = [
    process.env.WEBAUTHN_ORIGIN,
    process.env.DEPLOY_URL,
    process.env.PUBLIC_APP_URL,
    process.env.PROD_APP_URL,
    process.env.APP_URL,
    'https://music.hubera.cloud',
    'https://plm.delhomme.ovh',
  ]
    .map((x) => String(x || '').trim().replace(/\/$/, ''))
    .filter(Boolean);

  for (const c of candidates) {
    if (!isPrivateOrLocalUrl(c)) return c;
  }
  return 'https://music.hubera.cloud';
}

/** Origin de la requête si c’est un alias public connu (Hubera + historiques). */
function resolvePublicOrigin(publicOrigin?: string): string {
  const raw = String(publicOrigin || '').trim().replace(/\/$/, '');
  if (raw && !isPrivateOrLocalUrl(raw)) {
    try {
      const h = new URL(raw).hostname.toLowerCase();
      if (isPublicMusicHost(h)) return `https://${h}`;
    } catch {
      /* ignore */
    }
  }
  return publicBase();
}

/** Origin / Host du navigateur qui a demandé le QR. */
export function publicOriginFromRequest(req: {
  headers: IncomingHttpHeaders;
  body?: { origin?: string };
}): string | undefined {
  const origin = String(req.headers.origin || req.body?.origin || '').trim();
  const xf = String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '');
  const fromHost = xf && !isPrivateOrLocalUrl(`https://${xf}`) ? `https://${xf}` : '';
  return origin || fromHost || undefined;
}

export function startDeviceLogin(publicOrigin?: string): {
  id: string;
  code: string;
  pollSecret: string;
  expiresAt: number;
  approveUrl: string;
} {
  purge();
  const id = randomUUID();
  const code = randomBytes(9).toString('base64url');
  const pollSecret = randomBytes(24).toString('base64url');
  const now = Date.now();
  const expiresAt = now + TTL_MS;
  sessions.set(id, {
    id,
    code,
    pollSecret,
    status: 'pending',
    createdAt: now,
    expiresAt,
  });
  const base = resolvePublicOrigin(publicOrigin);
  const approveUrl = `${base}/login-device?id=${encodeURIComponent(id)}&code=${encodeURIComponent(code)}`;
  return { id, code, pollSecret, expiresAt, approveUrl };
}

export function getDeviceLogin(id: string): DeviceLoginSession | null {
  purge();
  const s = sessions.get(id);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    s.status = 'expired';
    return s;
  }
  return s;
}

export function approveDeviceLogin(
  id: string,
  code: string,
  userId: string,
): { ok: true } | { ok: false; error: string } {
  const s = getDeviceLogin(id);
  if (!s) return { ok: false, error: 'Session introuvable ou expirée' };
  if (s.status === 'expired' || s.expiresAt < Date.now()) {
    s.status = 'expired';
    return { ok: false, error: 'QR expiré — régénère-en un sur l’autre appareil' };
  }
  if (s.status === 'consumed') return { ok: false, error: 'Déjà utilisé' };
  if (s.code !== code) return { ok: false, error: 'Code invalide' };
  if (s.status === 'approved' && s.userId && s.userId !== userId) {
    return { ok: false, error: 'Déjà approuvé par un autre compte' };
  }
  s.status = 'approved';
  s.userId = userId;
  return { ok: true };
}

/** Poll côté appareil à connecter. Si approved → consomme et renvoie userId. */
export function pollDeviceLogin(
  id: string,
  pollSecret: string,
):
  | { status: 'pending' | 'expired' }
  | { status: 'approved'; userId: string }
  | { status: 'error'; error: string } {
  const s = getDeviceLogin(id);
  if (!s) return { status: 'error', error: 'Session introuvable' };
  if (s.pollSecret !== pollSecret) return { status: 'error', error: 'Secret invalide' };
  if (s.status === 'expired' || s.expiresAt < Date.now()) {
    s.status = 'expired';
    return { status: 'expired' };
  }
  if (s.status === 'pending') return { status: 'pending' };
  if (s.status === 'consumed') return { status: 'error', error: 'Déjà consommé' };
  if (s.status === 'approved' && s.userId) {
    s.status = 'consumed';
    return { status: 'approved', userId: s.userId };
  }
  return { status: 'error', error: 'État inconnu' };
}

/** Invite depuis un compte déjà connecté : session pré-approuvée, claim one-shot. */
export function inviteDeviceLogin(
  userId: string,
  publicOrigin?: string,
): {
  id: string;
  claimToken: string;
  expiresAt: number;
  claimUrl: string;
} {
  purge();
  const id = randomUUID();
  const code = randomBytes(9).toString('base64url');
  const pollSecret = randomBytes(24).toString('base64url');
  const now = Date.now();
  const expiresAt = now + TTL_MS;
  sessions.set(id, {
    id,
    code,
    pollSecret,
    status: 'approved',
    userId,
    createdAt: now,
    expiresAt,
  });
  const base = resolvePublicOrigin(publicOrigin);
  const claimUrl = `${base}/login-device?claim=${encodeURIComponent(id)}.${encodeURIComponent(pollSecret)}`;
  return { id, claimToken: `${id}.${pollSecret}`, expiresAt, claimUrl };
}

export function claimDeviceLogin(
  claim: string,
): { ok: true; userId: string } | { ok: false; error: string } {
  const [id, secret] = String(claim || '').split('.');
  if (!id || !secret) return { ok: false, error: 'Lien invalide' };
  const r = pollDeviceLogin(id, secret);
  if (r.status === 'approved') return { ok: true, userId: r.userId };
  if (r.status === 'pending') return { ok: false, error: 'Pas encore prêt' };
  if (r.status === 'expired') return { ok: false, error: 'Lien expiré' };
  if (r.status === 'error') return { ok: false, error: r.error };
  return { ok: false, error: 'Échec' };
}
