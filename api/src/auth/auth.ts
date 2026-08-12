import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { OAuth2Client } from 'google-auth-library';
import type { Request, Response, NextFunction } from 'express';
import {
  createUser,
  findUserByEmail,
  findUserByGoogleId,
  findUserById,
  publicUser,
  promoteAdminIfNeeded,
  updateUserPasswordHash,
  type UserRow,
} from '../library/db.js';
import { createEmailToken, createRefreshToken, markEmailVerified } from '../platform/platform.js';
import { sendVerificationEmail } from '../platform/mail.js';
import { checkUserTotp, userRequiresTotp } from './totp.js';

const rawJwtSecret = process.env.JWT_SECRET || '';
const appEnv = process.env.APP_ENV || 'local';
if (
  (appEnv === 'production' || appEnv === 'preprod') &&
  (!rawJwtSecret || rawJwtSecret === 'ytmusic-dev-secret-change-me')
) {
  throw new Error('JWT_SECRET fort requis quand APP_ENV=production|preprod');
}
const JWT_SECRET = new TextEncoder().encode(rawJwtSecret || 'ytmusic-dev-secret-change-me');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

/** Access token court ; refresh token très long (mobile / desktop / web) */
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || (appEnv === 'local' ? '14d' : '24h');
const COOKIE_MAX_MS = Number(process.env.AUTH_COOKIE_MS || 400 * 24 * 3600 * 1000);

export type AuthUser = ReturnType<typeof publicUser>;

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      userId?: string;
    }
  }
}

function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const next = scryptSync(password, salt, 64);
  const prev = Buffer.from(hash, 'hex');
  return prev.length === next.length && timingSafeEqual(prev, next);
}

export async function signToken(user: UserRow) {
  return new SignJWT({
    sub: user.id,
    email: user.email,
    name: user.name,
    typ: 'access',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ACCESS_TTL)
    .sign(JWT_SECRET);
}

export async function issueSession(user: UserRow, deviceLabel?: string) {
  const token = await signToken(user);
  const refresh = createRefreshToken(user.id, deviceLabel);
  return { user: publicUser(user), token, refreshToken: refresh.token };
}

export function sessionCookieOptions() {
  const env = process.env.APP_ENV || 'local';
  const secure =
    process.env.NODE_ENV === 'production' ||
    process.env.COOKIE_SECURE === '1' ||
    env === 'production' ||
    env === 'preprod';
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    maxAge: COOKIE_MAX_MS,
    path: '/',
  };
}

export async function verifyToken(token: string) {
  const { payload } = await jwtVerify(token, JWT_SECRET);
  const id = String(payload.sub || '');
  const user = findUserById(id);
  if (!user) throw new Error('Utilisateur introuvable');
  return user;
}

export function authOptional(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const cookie = (req as any).cookies?.ytm_token as string | undefined;
  const q =
    typeof req.query?.access_token === 'string'
      ? req.query.access_token
      : typeof req.query?.token === 'string'
        ? req.query.token
        : undefined;
  // Query token : lecteurs média (ExoPlayer / <audio>) qui n’envoient pas Authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7) : cookie || q;
  if (!token) return next();
  verifyToken(token)
    .then((user) => {
      req.user = publicUser(user);
      req.userId = user.id;
      next();
    })
    .catch(() => next());
}

export function authRequired(req: Request, res: Response, next: NextFunction) {
  authOptional(req, res, () => {
    if (!req.userId) {
      res.status(401).json({ error: 'Authentification requise' });
      return;
    }
    next();
  });
}

export function isGuestEmail(email?: string | null) {
  return Boolean(email && email.includes('@local.ytmusic'));
}

/** Mode perso : un seul (ou une liste) d’emails, pas d’invités / pas d’inscription ouverte. */
export function authPrivateMode() {
  const flag = (process.env.AUTH_PRIVATE || '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  if (flag === '1' || flag === 'true' || flag === 'on') return true;
  const env = process.env.APP_ENV || 'local';
  return env === 'production' || env === 'preprod';
}

export function authAllowRegister() {
  if (!authPrivateMode()) {
    const v = (process.env.AUTH_ALLOW_REGISTER || '1').trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off');
  }
  const v = (process.env.AUTH_ALLOW_REGISTER || '0').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export function authAllowGuest() {
  if (!authPrivateMode()) {
    const v = (process.env.AUTH_ALLOW_GUEST || '1').trim().toLowerCase();
    return !(v === '0' || v === 'false' || v === 'off');
  }
  const v = (process.env.AUTH_ALLOW_GUEST || '0').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Emails autorisés à se connecter (AUTH_ALLOWED_EMAILS sinon ADMIN_EMAILS). */
export function allowedEmails(): Set<string> {
  const raw = process.env.AUTH_ALLOWED_EMAILS || process.env.ADMIN_EMAILS || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function assertEmailAllowed(email: string) {
  if (!authPrivateMode()) return;
  const set = allowedEmails();
  if (!set.size) {
    throw new Error('AUTH_ALLOWED_EMAILS / ADMIN_EMAILS requis en mode privé');
  }
  if (!set.has(String(email || '').trim().toLowerCase())) {
    throw new Error('Accès réservé — compte non autorisé');
  }
}

/** Compte réel obligatoire (pas d’invité) pour prefs / reco / biblio. */
export function accountRequired(req: Request, res: Response, next: NextFunction) {
  authRequired(req, res, () => {
    if (!req.user || req.user.isGuest || isGuestEmail(req.user.email)) {
      res.status(401).json({ error: 'Compte requis — connecte-toi' });
      return;
    }
    next();
  });
}

export function ensureUser(req: Request, res: Response, next: NextFunction) {
  authOptional(req, res, () => {
    if (req.userId) return next();
    if (!authAllowGuest()) {
      res.status(401).json({ error: 'Authentification requise' });
      return;
    }

    const device =
      String(req.headers['x-device-id'] || '') ||
      String((req as any).cookies?.ytm_device || '') ||
      createHash('sha256').update(req.ip || 'local').digest('hex').slice(0, 24);

    const email = `guest-${device}@local.ytmusic`;
    let user = findUserByEmail(email);
    if (!user) {
      user = createUser({
        email,
        name: 'Invité',
        passwordHash: hashPassword(randomBytes(8).toString('hex')),
      });
    }
    req.user = publicUser(user);
    req.userId = user.id;
    res.cookie('ytm_device', device, { maxAge: 365 * 24 * 3600 * 1000, httpOnly: false });
    next();
  });
}

export async function registerLocal(email: string, password: string, name: string) {
  if (!authAllowRegister()) {
    throw new Error('Inscription désactivée — instance privée');
  }
  assertEmailAllowed(email);
  if (!password || String(password).length < 10) {
    throw new Error('Mot de passe trop court (10 caractères minimum)');
  }
  if (findUserByEmail(email)) throw new Error('Email déjà utilisé');
  const user = createUser({
    email,
    name: name || email.split('@')[0],
    passwordHash: hashPassword(password),
  });
  promoteAdminIfNeeded(email);
  const refreshed = findUserByEmail(email) || user;

  const verifyRaw = createEmailToken(refreshed.id, 'verify');
  await sendVerificationEmail(refreshed.email, refreshed.name, verifyRaw).catch((e) =>
    console.error('mail verify', e),
  );

  const session = await issueSession(refreshed, 'register');
  const { appUrl } = await import('../platform/mail.js');
  const verifyUrl = `${appUrl()}/verify-email?token=${encodeURIComponent(verifyRaw)}`;
  const env = process.env.APP_ENV || 'local';
  return {
    ...session,
    needsEmailVerification: true,
    message: 'Compte créé — vérifie ton email (lien aussi dans la console admin / logs en local).',
    // Lien exposé seulement hors production (tests ADB / local)
    ...(env !== 'production'
      ? { verifyUrl, verifyToken: verifyRaw }
      : {}),
  };
}

export async function loginLocal(
  email: string,
  password: string,
  opts?: { totp?: string; deviceLabel?: string },
) {
  assertEmailAllowed(email);
  const user = findUserByEmail(email);
  if (!user?.password_hash || !verifyPassword(password, user.password_hash)) {
    throw new Error('Identifiants invalides');
  }
  if (userRequiresTotp(user.id)) {
    if (!opts?.totp) {
      const err = new Error('2FA_REQUIRED');
      (err as any).code = '2FA_REQUIRED';
      throw err;
    }
    if (!checkUserTotp(user.id, opts.totp)) throw new Error('Code 2FA invalide');
  }
  return issueSession(user, opts?.deviceLabel || 'web');
}

export async function loginGoogle(idToken: string, deviceLabel?: string) {
  if (!googleClient || !GOOGLE_CLIENT_ID) {
    throw new Error('Google OAuth non configuré (GOOGLE_CLIENT_ID manquant)');
  }
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.email || !payload.sub) throw new Error('Token Google invalide');
  assertEmailAllowed(payload.email);

  let user = findUserByGoogleId(payload.sub) || findUserByEmail(payload.email);
  if (!user) {
    user = createUser({
      email: payload.email,
      name: payload.name || payload.email.split('@')[0],
      picture: payload.picture,
      googleId: payload.sub,
    });
    markEmailVerified(user.id);
  } else if (!user.google_id) {
    const { db } = await import('../library/db.js');
    db.prepare(
      'UPDATE users SET google_id = ?, picture = COALESCE(?, picture), email_verified = 1, updated_at = ? WHERE id = ?',
    ).run(payload.sub, payload.picture || null, Date.now(), user.id);
    user = findUserById(user.id)!;
  } else {
    markEmailVerified(user.id);
  }

  return issueSession(user, deviceLabel || 'google');
}

export function authConfig() {
  return {
    googleClientId: GOOGLE_CLIENT_ID || null,
    googleEnabled: Boolean(GOOGLE_CLIENT_ID),
    accessTtl: ACCESS_TTL,
    appEnv: process.env.APP_ENV || (process.env.NODE_ENV === 'production' ? 'production' : 'local'),
    privateMode: authPrivateMode(),
    allowRegister: authAllowRegister(),
    allowGuest: authAllowGuest(),
  };
}

/**
 * Aligne le compte SEED_EMAIL sur SEED_PASSWORD (source de vérité env).
 * Instance perso : évite « Identifiants invalides » quand le mdp Portainer ≠ inscription initiale.
 * Désactiver avec AUTH_SEED_SYNC=0.
 */
export function syncSeedCredentials() {
  const flag = (process.env.AUTH_SEED_SYNC || '1').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return;

  const email = (process.env.SEED_EMAIL || process.env.VITE_DEV_EMAIL || '').trim().toLowerCase();
  const password = (process.env.SEED_PASSWORD || process.env.VITE_DEV_PASSWORD || '').trim();
  const name = (process.env.SEED_NAME || email.split('@')[0] || 'Admin').trim();
  if (!email || !password || password.length < 6) return;

  try {
    assertEmailAllowed(email);
  } catch {
    return;
  }

  let user = findUserByEmail(email);
  if (!user) {
    user = createUser({
      email,
      name,
      passwordHash: hashPassword(password),
    });
    promoteAdminIfNeeded(email);
    console.log(`[auth] seed user créé: ${email}`);
    return;
  }

  if (user.password_hash && verifyPassword(password, user.password_hash)) {
    promoteAdminIfNeeded(email);
    return;
  }

  updateUserPasswordHash(user.id, hashPassword(password));
  promoteAdminIfNeeded(email);
  console.log(`[auth] seed password synchronisé: ${email}`);
}
