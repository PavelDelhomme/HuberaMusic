/**
 * Session YouTube pour les streams prod (VPS), 100 % logiciel :
 * OAuth « TV / appareil » une fois → tokens chiffrés sur le volume → Innertube signé.
 * Pas de PC maison, pas de proxy payant.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Innertube, UniversalCache, ClientType } from 'youtubei.js';
import { getYtmCredentials } from './ytm-account.js';
import { resolveYoutubeCookieHeader } from './youtubeCookies.js';
import { installYoutubeJsEvaluator } from './youtubeiEval.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DATA = join(ROOT, 'data');
const OAUTH_PATH = join(DATA, 'youtube-stream-oauth.enc');

type OauthTokens = Record<string, unknown>;

function keyFromSecret() {
  return createHash('sha256')
    .update(process.env.JWT_SECRET || 'ytmusic-dev-secret-change-me')
    .digest();
}

function encrypt(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFromSecret(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(payload: string) {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', keyFromSecret(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function ensureDataDir() {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
}

export function loadStreamOauthTokens(): OauthTokens | null {
  try {
    if (!existsSync(OAUTH_PATH)) return null;
    const raw = readFileSync(OAUTH_PATH, 'utf8').trim();
    if (!raw) return null;
    return JSON.parse(decrypt(raw)) as OauthTokens;
  } catch {
    return null;
  }
}

export function saveStreamOauthTokens(tokens: OauthTokens) {
  ensureDataDir();
  writeFileSync(OAUTH_PATH, `${encrypt(JSON.stringify(tokens))}\n`, 'utf8');
  signedYt = null;
  signedYtAt = 0;
}

export function clearStreamOauthTokens() {
  try {
    if (existsSync(OAUTH_PATH)) unlinkSync(OAUTH_PATH);
  } catch {
    /* ignore */
  }
  signedYt = null;
  signedYtAt = 0;
}

export function streamOauthConfigured(): boolean {
  return Boolean(loadStreamOauthTokens()?.access_token || loadStreamOauthTokens()?.refresh_token);
}

/** Tokens OAuth « stream » OU compte YTM utilisateur (si déjà lié). */
export function resolveAnyStreamCredentials(userId?: string): {
  oauth?: OauthTokens;
  cookie?: string;
} {
  const file = loadStreamOauthTokens();
  if (file?.access_token || file?.refresh_token) {
    return { oauth: file, cookie: resolveYoutubeCookieHeader() || undefined };
  }
  if (userId) {
    const creds = getYtmCredentials(userId);
    if (creds?.oauth || creds?.cookie) {
      return { oauth: creds.oauth, cookie: creds.cookie || resolveYoutubeCookieHeader() || undefined };
    }
  }
  const cookie = resolveYoutubeCookieHeader();
  return cookie ? { cookie } : {};
}

let signedYt: Innertube | null = null;
let signedYtAt = 0;
const SIGNED_TTL_MS = 25 * 60_000;

type Pending = {
  yt: Innertube;
  verificationUrl: string;
  userCode: string;
  expiresIn: number;
  done: boolean;
  error?: string;
};

let pendingOauth: Pending | null = null;

/** Démarre le code appareil Google TV pour autoriser les streams sur le VPS. */
export async function startStreamDeviceOauth() {
  installYoutubeJsEvaluator();
  pendingOauth = null;
  const yt = await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
    client_type: ClientType.TV,
  });

  const pending: Pending = {
    yt,
    verificationUrl: '',
    userCode: '',
    expiresIn: 0,
    done: false,
  };
  pendingOauth = pending;

  yt.session.on('auth-pending', (data) => {
    pending.verificationUrl = data.verification_url;
    pending.userCode = data.user_code;
    pending.expiresIn = data.expires_in;
  });

  yt.session.on('auth', ({ credentials }) => {
    saveStreamOauthTokens(credentials as unknown as OauthTokens);
    signedYt = yt;
    signedYtAt = Date.now();
    pending.done = true;
  });

  yt.session.on('auth-error', (err) => {
    pending.error = String(err?.message || err);
    pending.done = true;
  });

  void yt.session.signIn().catch((err) => {
    pending.error = String(err?.message || err);
    pending.done = true;
  });

  for (let i = 0; i < 50; i++) {
    if (pending.userCode) break;
    if (pending.error) throw new Error(pending.error);
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!pending.userCode) throw new Error('Impossible d’obtenir le code Google TV');

  return {
    verificationUrl: pending.verificationUrl || 'https://www.google.com/device',
    userCode: pending.userCode,
    expiresIn: pending.expiresIn,
  };
}

export function getStreamDeviceOauthStatus() {
  if (streamOauthConfigured() && (!pendingOauth || pendingOauth.done)) {
    return { status: 'connected' as const };
  }
  const pending = pendingOauth;
  if (!pending) return { status: 'idle' as const };
  if (pending.error) return { status: 'error' as const, error: pending.error };
  if (pending.done) return { status: 'connected' as const };
  return {
    status: 'pending' as const,
    verificationUrl: pending.verificationUrl,
    userCode: pending.userCode,
    expiresIn: pending.expiresIn,
  };
}

/**
 * Innertube signé pour getStreamingData (musique depuis IP datacenter).
 * Retourne null si aucune session — l’appelant retombe sur l’anonyme.
 */
export async function getSignedStreamYT(userId?: string): Promise<Innertube | null> {
  installYoutubeJsEvaluator();
  if (signedYt && Date.now() - signedYtAt < SIGNED_TTL_MS) return signedYt;

  const creds = resolveAnyStreamCredentials(userId);
  if (!creds.oauth && !creds.cookie) return null;

  try {
    const yt = await Innertube.create({
      cache: new UniversalCache(true, join(DATA, 'yt-cache-stream')),
      generate_session_locally: true,
      client_type: ClientType.TV,
      ...(creds.cookie ? { cookie: creds.cookie } : {}),
    });
    if (creds.oauth) {
      await yt.session.signIn(creds.oauth as any);
    }
    signedYt = yt;
    signedYtAt = Date.now();
    console.info('[streamAuth] session signée OK oauth=', Boolean(creds.oauth), 'cookie=', Boolean(creds.cookie));
    return yt;
  } catch (err) {
    console.warn('[streamAuth] session signée KO:', String((err as Error).message || err).slice(0, 160));
    signedYt = null;
    signedYtAt = 0;
    return null;
  }
}
