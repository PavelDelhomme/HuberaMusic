import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { randomUUID } from 'node:crypto';
import { db } from '../library/db.js';

const RP_NAME = 'PLM';
const challenges = new Map<string, { challenge: string; userId?: string; expires: number }>();

function cleanChallenges() {
  const now = Date.now();
  for (const [k, v] of challenges) {
    if (v.expires < now) challenges.delete(k);
  }
}

export function getRpID(host?: string) {
  if (process.env.WEBAUTHN_RP_ID) return process.env.WEBAUTHN_RP_ID.split(':')[0];
  const h = (host || 'localhost').split(':')[0];
  // Les IP ne sont pas des RP ID WebAuthn valides → fallback localhost
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h === '127.0.0.1') return 'localhost';
  return h;
}

export function getOrigin(reqHost?: string, proto?: string) {
  if (process.env.WEBAUTHN_ORIGIN) return process.env.WEBAUTHN_ORIGIN;
  const host = reqHost || 'localhost:5173';
  const p = proto || 'http';
  return `${p}://${host}`;
}

/** Origines Android Credential Manager (apk-key-hash) + web. */
export function expectedOrigins(primary: string): string | string[] {
  const extras = (process.env.WEBAUTHN_ANDROID_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const all = [primary, ...extras].filter(Boolean);
  return all.length === 1 ? all[0]! : all;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    credential_id TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    device_type TEXT,
    backed_up INTEGER DEFAULT 0,
    name TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

export type PasskeyRow = {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number;
  name: string | null;
  created_at: number;
  last_used_at: number | null;
};

export function listPasskeys(userId: string) {
  return db
    .prepare(
      `SELECT id, name, device_type, backed_up, created_at, last_used_at, credential_id
       FROM passkeys WHERE user_id = ? ORDER BY created_at DESC`,
    )
    .all(userId) as Omit<PasskeyRow, 'public_key' | 'counter' | 'transports' | 'user_id'>[];
}

export function deletePasskey(userId: string, passkeyId: string) {
  const r = db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(passkeyId, userId);
  return r.changes > 0;
}

function credsForUser(userId: string) {
  return (
    db.prepare('SELECT * FROM passkeys WHERE user_id = ?').all(userId) as PasskeyRow[]
  ).map((p) => ({
    id: p.credential_id,
    transports: p.transports ? (JSON.parse(p.transports) as AuthenticatorTransportFuture[]) : undefined,
  }));
}

export async function beginRegistration(userId: string, userName: string, userDisplayName: string, rpID: string) {
  cleanChallenges();
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName,
    userDisplayName,
    userID: new TextEncoder().encode(userId),
    attestationType: 'none',
    excludeCredentials: credsForUser(userId),
    authenticatorSelection: {
      // Pas de `authenticatorAttachment: 'platform'` : laisse aussi Bitwarden /
      // 1Password / gestionnaires (cross-platform) + biométrie appareil.
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    // Encourage les transports hybrides / managers (Android Credential Manager)
    supportedAlgorithmIDs: [-7, -257],
  });
  challenges.set(`reg:${userId}`, {
    challenge: options.challenge,
    userId,
    expires: Date.now() + 5 * 60 * 1000,
  });
  return options;
}

export async function finishRegistration(
  userId: string,
  response: RegistrationResponseJSON,
  rpID: string,
  origin: string,
  name?: string,
) {
  const expected = challenges.get(`reg:${userId}`);
  if (!expected) throw new Error('Challenge expiré — réessaie');
  challenges.delete(`reg:${userId}`);

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: expected.challenge,
    expectedOrigin: expectedOrigins(origin),
    expectedRPID: rpID,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Vérification passkey échouée');
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up, name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    credential.id,
    Buffer.from(credential.publicKey).toString('base64url'),
    credential.counter,
    JSON.stringify(credential.transports || []),
    credentialDeviceType,
    credentialBackedUp ? 1 : 0,
    name || 'Cet appareil',
    Date.now(),
  );
  return { id, name: name || 'Cet appareil' };
}

export async function beginAuthentication(rpID: string, email?: string) {
  cleanChallenges();
  let allowCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] | undefined;
  let userId: string | undefined;

  if (email) {
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase()) as
      | { id: string }
      | undefined;
    if (user) {
      userId = user.id;
      const creds = credsForUser(user.id);
      // Tableau vide = « aucune créd. autorisée » → casse Bitwarden / discoverable.
      // On omet allowCredentials pour laisser le gestionnaire proposer les passkeys du RP.
      allowCredentials = creds.length > 0 ? creds : undefined;
    }
  }

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    allowCredentials,
  });
  const key = `auth:${options.challenge}`;
  challenges.set(key, {
    challenge: options.challenge,
    userId,
    expires: Date.now() + 5 * 60 * 1000,
  });
  return options;
}

export async function finishAuthentication(
  response: AuthenticationResponseJSON,
  rpID: string,
  origin: string,
) {
  const credId = response.id;
  const row = db.prepare('SELECT * FROM passkeys WHERE credential_id = ?').get(credId) as
    | PasskeyRow
    | undefined;
  if (!row) throw new Error('Passkey inconnue');

  // Find challenge — SimpleWebAuthn stores challenge in clientDataJSON; we match any auth challenge
  let expectedChallenge: string | undefined;
  for (const [k, v] of challenges) {
    if (k.startsWith('auth:') && v.expires > Date.now()) {
      // We'll verify against the one that matches in verifyAuthenticationResponse
      expectedChallenge = v.challenge;
      // Prefer exact: try all
    }
  }

  // Use challenge from map keyed loosely: verify with each recent auth challenge if needed
  let verification;
  let matchedKey: string | null = null;
  for (const [k, v] of challenges) {
    if (!k.startsWith('auth:') || v.expires < Date.now()) continue;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: v.challenge,
        expectedOrigin: expectedOrigins(origin),
        expectedRPID: rpID,
        credential: {
          id: row.credential_id,
          publicKey: Buffer.from(row.public_key, 'base64url'),
          counter: row.counter,
          transports: row.transports
            ? (JSON.parse(row.transports) as AuthenticatorTransportFuture[])
            : undefined,
        },
      });
      if (verification.verified) {
        matchedKey = k;
        expectedChallenge = v.challenge;
        break;
      }
    } catch {
      /* try next */
    }
  }

  if (!verification?.verified || !matchedKey) {
    throw new Error('Authentification passkey échouée');
  }
  challenges.delete(matchedKey);

  db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(
    verification.authenticationInfo.newCounter,
    Date.now(),
    row.id,
  );

  return row.user_id;
}
