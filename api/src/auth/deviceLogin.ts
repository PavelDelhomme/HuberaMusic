import { randomBytes, randomUUID } from 'node:crypto';

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

/** URL publique pour QR / liens (jamais une IP Docker / localhost). */
function publicBase(): string {
  const candidates = [
    process.env.WEBAUTHN_ORIGIN,
    process.env.DEPLOY_URL,
    process.env.PUBLIC_APP_URL,
    process.env.PROD_APP_URL,
    process.env.APP_URL,
    'https://ytmusic.delhomme.ovh',
  ]
    .map((x) => String(x || '').trim().replace(/\/$/, ''))
    .filter(Boolean);

  for (const c of candidates) {
    if (!isPrivateOrLocalUrl(c)) return c;
  }
  return 'https://ytmusic.delhomme.ovh';
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
  const base =
    publicOrigin && !isPrivateOrLocalUrl(publicOrigin)
      ? publicOrigin.replace(/\/$/, '')
      : publicBase();
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
  const base =
    publicOrigin && !isPrivateOrLocalUrl(publicOrigin)
      ? publicOrigin.replace(/\/$/, '')
      : publicBase();
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
