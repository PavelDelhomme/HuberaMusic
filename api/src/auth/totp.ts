import * as OTPAuth from 'otpauth';
import { findUserById } from '../library/db.js';
import { setTotpSecret } from '../platform/platform.js';

export function generateTotpSetup(userEmail: string) {
  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({
    issuer: 'PLM',
    label: userEmail,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });
  return {
    secret: secret.base32,
    otpauthUrl: totp.toString(),
  };
}

export function verifyTotp(secretBase32: string, token: string) {
  const totp = new OTPAuth.TOTP({
    issuer: 'PLM',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
  const delta = totp.validate({ token: String(token).replace(/\s/g, ''), window: 1 });
  return delta !== null;
}

export function enableTotpForUser(userId: string, secret: string, code: string) {
  if (!verifyTotp(secret, code)) throw new Error('Code 2FA invalide');
  setTotpSecret(userId, secret, true);
}

export function disableTotpForUser(userId: string, code: string) {
  const user = findUserById(userId) as any;
  if (!user?.totp_secret || !user.totp_enabled) throw new Error('2FA non activée');
  if (!verifyTotp(user.totp_secret, code)) throw new Error('Code 2FA invalide');
  setTotpSecret(userId, null, false);
}

export function userRequiresTotp(userId: string) {
  const user = findUserById(userId) as any;
  return Boolean(user?.totp_enabled && user?.totp_secret);
}

export function checkUserTotp(userId: string, code?: string) {
  const user = findUserById(userId) as any;
  if (!user?.totp_enabled || !user?.totp_secret) return true;
  if (!code) return false;
  return verifyTotp(user.totp_secret, code);
}
