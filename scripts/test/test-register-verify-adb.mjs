#!/usr/bin/env node
/**
 * Recrée un compte, envoie l’email de validation, ouvre le lien sur Android (ADB).
 *
 *   TEST_EMAIL=toi@email.com TEST_PASSWORD='…' DEVICE=… \
 *     node scripts/test/test-register-verify-adb.mjs
 */
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
loadEnv({ path: join(ROOT, '.env') });
const DEVICE = process.env.DEVICE || '';
const EMAIL = (process.env.TEST_EMAIL || process.env.SEED_EMAIL || '').toLowerCase();
const PASS = (process.env.TEST_PASSWORD || process.env.SEED_PASSWORD || '').replace(/^['"]|['"]$/g, '');
const NAME = process.env.TEST_NAME || 'Dev';
const API = process.env.API_URL || 'http://127.0.0.1:8787';
const APP = (process.env.APP_URL || 'http://127.0.0.1:5173').replace(/\/$/, '');

if (!EMAIL) {
  console.error('TEST_EMAIL ou SEED_EMAIL requis');
  process.exit(1);
}
if (!PASS) {
  console.error('TEST_PASSWORD ou SEED_PASSWORD requis');
  process.exit(1);
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    console.error(r.stderr || r.stdout || `${cmd} failed`);
    process.exit(r.status || 1);
  }
  return r;
}

console.log('▶ Santé API…');
const health = await fetch(`${API}/api/health`);
if (!health.ok) {
  console.error('API down — make dev');
  process.exit(1);
}

console.log('▶ adb reverse 5173 / 8787…');
sh('adb', ['devices']);
const devices = sh('adb', ['devices']).stdout || '';
if (!devices.split('\n').some((l) => l.startsWith(DEVICE) && l.includes('device'))) {
  console.error(`Device ${DEVICE} introuvable`);
  process.exit(1);
}
sh('adb', ['-s', DEVICE, 'reverse', 'tcp:5173', 'tcp:5173']);
sh('adb', ['-s', DEVICE, 'reverse', 'tcp:8787', 'tcp:8787']);

console.log(`▶ Reset user ${EMAIL}…`);
const db = new Database(join(ROOT, 'data', 'ytmusic.db'));
const u = db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL);
if (u) {
  db.prepare('DELETE FROM email_tokens WHERE user_id = ?').run(u.id);
  try {
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(u.id);
  } catch {
    /* */
  }
  try {
    db.prepare('DELETE FROM user_prefs WHERE user_id = ?').run(u.id);
  } catch {
    /* */
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  console.log('  deleted');
} else {
  console.log('  (nouveau)');
}
db.close();

console.log('▶ Inscription…');
const reg = await fetch(`${API}/api/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASS, name: NAME }),
});
const data = await reg.json();
if (!reg.ok) {
  console.error(data);
  process.exit(1);
}

let verifyUrl = data.verifyUrl;
if (verifyUrl) {
  // Force host téléphone (adb reverse)
  const token = new URL(verifyUrl).searchParams.get('token');
  verifyUrl = `${APP}/verify-email?token=${encodeURIComponent(token || '')}`;
} else {
  console.warn('  Pas de verifyUrl (production) — utilise le mail reçu');
}

console.log('  user:', data.user?.email);
console.log('  verifyUrl:', verifyUrl || '(voir boîte mail)');
if (verifyUrl) {
  writeFileSync('/tmp/ytm-verify-url.txt', verifyUrl);
  console.log('▶ Chrome sur le téléphone…');
  sh(
    'adb',
    [
      '-s',
      DEVICE,
      'shell',
      'am',
      'start',
      '-a',
      'android.intent.action.VIEW',
      '-d',
      verifyUrl,
      '-n',
      'com.android.chrome/com.google.android.apps.chrome.Main',
    ],
    { allowFail: true },
  );
}

console.log(`
✅ Compte créé : ${EMAIL}
   Email SMTP envoyé + lien ouvert sur Android (si ADB OK)
   Sur le téléphone : page « Validation email » → Accueil
   Puis make mobile-install-adb pour installer la PWA
`);
