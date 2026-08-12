import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { db } from '../library/db.js';

const ALGO = 'aes-256-gcm';

function keyFromSecret() {
  return createHash('sha256')
    .update(process.env.JWT_SECRET || 'ytmusic-dev-secret-change-me')
    .digest();
}

function encrypt(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, keyFromSecret(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(payload: string) {
  const buf = Buffer.from(payload, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv(ALGO, keyFromSecret(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function ensureYtmAccountSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ytm_accounts (
      user_id TEXT PRIMARY KEY,
      cookie_enc TEXT,
      oauth_enc TEXT,
      connected_at INTEGER NOT NULL,
      last_sync_at INTEGER,
      last_sync_summary TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

ensureYtmAccountSchema();

export type YtmAccountPublic = {
  connected: boolean;
  /** true seulement si cookies navigateur présents (requis pour getLibrary YTM). */
  canSyncLibrary: boolean;
  hasCookie: boolean;
  hasOauth: boolean;
  connectedAt: number | null;
  lastSyncAt: number | null;
  lastSyncSummary: string | null;
  hint: string | null;
};

export function getYtmAccountPublic(userId: string): YtmAccountPublic {
  const row = db.prepare('SELECT * FROM ytm_accounts WHERE user_id = ?').get(userId) as
    | {
        cookie_enc: string | null;
        oauth_enc: string | null;
        connected_at: number;
        last_sync_at: number | null;
        last_sync_summary: string | null;
      }
    | undefined;
  if (!row) {
    return {
      connected: false,
      canSyncLibrary: false,
      hasCookie: false,
      hasOauth: false,
      connectedAt: null,
      lastSyncAt: null,
      lastSyncSummary: null,
      hint: null,
    };
  }
  const hasCookie = Boolean(row.cookie_enc);
  const hasOauth = Boolean(row.oauth_enc);
  return {
    connected: hasCookie || hasOauth,
    canSyncLibrary: hasCookie,
    hasCookie,
    hasOauth,
    connectedAt: row.connected_at,
    lastSyncAt: row.last_sync_at,
    lastSyncSummary: row.last_sync_summary,
    hint:
      hasOauth && !hasCookie
        ? 'OAuth seul ne suffit plus pour la bibliothèque YouTube Music (Google renvoie 400). Colle les cookies depuis music.youtube.com.'
        : null,
  };
}

export function getYtmCredentials(userId: string): {
  cookie?: string;
  oauth?: Record<string, unknown>;
} | null {
  const row = db.prepare('SELECT cookie_enc, oauth_enc FROM ytm_accounts WHERE user_id = ?').get(userId) as
    | { cookie_enc: string | null; oauth_enc: string | null }
    | undefined;
  if (!row || (!row.cookie_enc && !row.oauth_enc)) return null;
  return {
    cookie: row.cookie_enc ? decrypt(row.cookie_enc) : undefined,
    oauth: row.oauth_enc ? (JSON.parse(decrypt(row.oauth_enc)) as Record<string, unknown>) : undefined,
  };
}

/**
 * Accepte une ligne Cookie=… ou un collage d’en-têtes HTTP (ytmusicapi style).
 */
export function normalizeYtmCookiePaste(raw: string): string {
  let text = raw.replace(/\r/g, '').trim();
  if (!text) return '';

  // Bloc d’en-têtes : extraire la ligne Cookie
  const headerMatch = text.match(/^[Cc]ookie:\s*(.+)$/m);
  if (headerMatch) {
    text = headerMatch[1].trim();
  } else if (/^[A-Za-z0-9-]+:\s*/m.test(text) && /cookie\s*:/i.test(text)) {
    const line = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => /^cookie\s*:/i.test(l));
    if (line) text = line.replace(/^cookie\s*:\s*/i, '').trim();
  }

  // Une seule ligne, espaces → ;
  text = text.replace(/\n+/g, ' ').replace(/\s*;\s*/g, '; ').trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

export function saveYtmCookie(userId: string, cookie: string) {
  const cleaned = normalizeYtmCookiePaste(cookie);
  if (!cleaned || cleaned.length < 20) {
    throw new Error('Cookie YTM invalide ou trop court');
  }

  const hasSapisid = /(?:^|;\s*)SAPISID=/.test(cleaned);
  const hasSecurePsId =
    /(?:^|;\s*)__Secure-1PSID=/.test(cleaned) || /(?:^|;\s*)__Secure-3PSID=/.test(cleaned);
  const classic = ['SID', 'HSID', 'SSID', 'APISID'].filter((k) =>
    new RegExp(`(?:^|;\\s*)${k}=`).test(cleaned),
  );

  if (!hasSapisid && !hasSecurePsId) {
    throw new Error(
      'Cookie incomplet : il faut SAPISID (ou __Secure-1PSID). Sur music.youtube.com connecté → F12 → Réseau → filtre « browse » → Requête → En-tête Cookie → copie toute la valeur.',
    );
  }
  if (!hasSapisid && classic.length < 2 && !hasSecurePsId) {
    throw new Error(
      'Cookie incomplet. Copie l’en-tête Cookie entier d’une requête browse sur music.youtube.com (pas seulement un fragment).',
    );
  }

  const now = Date.now();
  // Garde l’oauth éventuel : les cookies priment pour la sync biblio
  db.prepare(
    `INSERT INTO ytm_accounts (user_id, cookie_enc, oauth_enc, connected_at)
     VALUES (?, ?, COALESCE((SELECT oauth_enc FROM ytm_accounts WHERE user_id = ?), NULL), ?)
     ON CONFLICT(user_id) DO UPDATE SET
       cookie_enc = excluded.cookie_enc,
       connected_at = excluded.connected_at`,
  ).run(userId, encrypt(cleaned), userId, now);
}

export function saveYtmOauth(userId: string, tokens: Record<string, unknown>) {
  const now = Date.now();
  // Ne pas écraser un cookie déjà présent (utile pour la biblio)
  db.prepare(
    `INSERT INTO ytm_accounts (user_id, cookie_enc, oauth_enc, connected_at)
     VALUES (?, NULL, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       oauth_enc = excluded.oauth_enc,
       connected_at = excluded.connected_at`,
  ).run(userId, encrypt(JSON.stringify(tokens)), now);
}

export function disconnectYtm(userId: string) {
  db.prepare('DELETE FROM ytm_accounts WHERE user_id = ?').run(userId);
}

export function markYtmSynced(userId: string, summary: string) {
  db.prepare(
    `UPDATE ytm_accounts SET last_sync_at = ?, last_sync_summary = ? WHERE user_id = ?`,
  ).run(Date.now(), summary, userId);
}
