#!/usr/bin/env node
/**
 * Crée / met à jour les comptes locaux (email déjà vérifié).
 *
 *   node scripts/dev/seed-users.mjs
 *   # lit SEED_* dans .env
 *
 * Comptes typiques :
 *   SEED_EMAIL=dev@…              → admin / test (ADMIN_EMAILS)
 *   SEED_EMAIL_SECONDARY=pavel@…  → perso prod (mdp distinct via SEED_PASSWORD_SECONDARY)
 */
import 'dotenv/config';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import Database from 'better-sqlite3';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const dataDir = join(ROOT, 'data');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
const dbPath = process.env.DB_PATH || join(dataDir, 'ytmusic.db');

const primaryPassword = process.env.SEED_PASSWORD;
if (!primaryPassword) {
  console.error('SEED_PASSWORD manquant (dans .env ou l’environnement)');
  process.exit(1);
}

const primaryEmail = (process.env.SEED_EMAIL || '').trim().toLowerCase();
if (!primaryEmail) {
  console.error('SEED_EMAIL manquant (dans .env ou l’environnement)');
  process.exit(1);
}
const primaryName = (process.env.SEED_NAME || 'Dev').trim() || 'Dev';
const secondaryEmail = (process.env.SEED_EMAIL_SECONDARY || '').trim().toLowerCase();
const secondaryName = (process.env.SEED_NAME_SECONDARY || 'User').trim() || 'User';
/** Mot de passe distinct pour le secondaire (sinon SEED_PASSWORD — déconseillé en prod). */
const secondaryPassword = (
  process.env.SEED_PASSWORD_SECONDARY ||
  process.env.SEED_PASSWORD ||
  ''
).trim();

const users = [{ email: primaryEmail, name: primaryName, password: primaryPassword }];
if (secondaryEmail && secondaryEmail !== primaryEmail) {
  if (!secondaryPassword) {
    console.error('SEED_PASSWORD_SECONDARY (ou SEED_PASSWORD) requis pour le compte secondaire');
    process.exit(1);
  }
  if (
    secondaryPassword === primaryPassword &&
    process.env.SEED_PASSWORD_SECONDARY
  ) {
    console.warn(
      '!! SEED_PASSWORD_SECONDARY identique à SEED_PASSWORD — préfère un mdp distinct pour pavel@',
    );
  }
  if (!process.env.SEED_PASSWORD_SECONDARY) {
    console.warn(
      '!! SEED_PASSWORD_SECONDARY absent — le secondaire réutilise SEED_PASSWORD (à éviter pour pavel@)',
    );
  }
  users.push({ email: secondaryEmail, name: secondaryName, password: secondaryPassword });
}

function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

const db = new Database(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    picture TEXT,
    google_id TEXT,
    password_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
try {
  db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0');
} catch {
  /* exists */
}
try {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
} catch {
  /* exists */
}

const adminEmails = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const now = Date.now();

for (const u of users) {
  const email = u.email.toLowerCase();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  const isAdmin = adminEmails.includes(email) ? 1 : 0;
  const ph = hashPassword(u.password);
  if (existing) {
    db.prepare(
      `UPDATE users SET password_hash = ?, name = ?, email_verified = 1, is_admin = ?, updated_at = ? WHERE email = ?`,
    ).run(ph, u.name, isAdmin, now, email);
    console.log(`updated  ${email}${isAdmin ? ' (admin)' : ''}`);
  } else {
    db.prepare(
      `INSERT INTO users (id, email, name, picture, google_id, password_hash, created_at, updated_at, email_verified, is_admin)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, 1, ?)`,
    ).run(randomUUID(), email, u.name, ph, now, now, isAdmin);
    console.log(`created  ${email}${isAdmin ? ' (admin)' : ''}`);
  }
}

console.log(`DB → ${dbPath}`);
console.log(`OK — connecte-toi avec ${users.map((u) => u.email).join(' / ')}`);
db.close();
