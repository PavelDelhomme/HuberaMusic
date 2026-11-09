#!/usr/bin/env node
/**
 * Vérifie les endpoints admin d'agrégation (user-cases Mermaid + bugs).
 * Aucun secret affiché : seuls les statuts et les comptes sont imprimés.
 *
 *   node scripts/qa/admin-aggregates-check.mjs [--base http://127.0.0.1:8787]
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const BASE =
  (args.includes('--base') ? args[args.indexOf('--base') + 1] : null) ||
  process.env.MUSIC_BASE_URL ||
  'http://127.0.0.1:8787';

function users() {
  const p = join(ROOT, 'hubera-users.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

let ok = true;
function check(name, passed, detail = '') {
  if (!passed) ok = false;
  console.log(`${passed ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const u = users();
if (!u?.profiles?.admin) {
  console.log('❌ hubera-users.json (profil admin) introuvable');
  process.exit(1);
}

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: u.profiles.admin.email, password: u.profiles.admin.password }),
});
const token = (await login.json().catch(() => ({})))?.token || '';
check('Connexion Admin', login.ok && Boolean(token), `HTTP ${login.status}`);

const call = (p) =>
  fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${token}` } });

// /api/admin/user-cases
try {
  const res = await call('/api/admin/user-cases');
  const body = await res.json().catch(() => ({}));
  const first = body?.apps?.[0];
  check(
    'GET /api/admin/user-cases',
    res.ok && Array.isArray(body?.apps),
    `${body?.count ?? 0} app(s)`,
  );
  check(
    'Diagramme Mermaid généré',
    Boolean(first?.mermaid?.startsWith('flowchart TD')),
    `${first?.app || '?'} · ${first?.cases ?? 0} cas (admin ${first?.admin ?? 0} / std ${first?.standard ?? 0})`,
  );
} catch (err) {
  check('GET /api/admin/user-cases', false, String(err));
}

// /api/admin/bugs
try {
  const res = await call('/api/admin/bugs?limit=5');
  const body = await res.json().catch(() => ({}));
  check(
    'GET /api/admin/bugs',
    res.ok && body?.mail && body?.docs,
    `mail=${body?.mail?.ok ? body.mail.count : `KO(${body?.mail?.error || '?'})`} docs=${
      body?.docs?.ok ? body.docs.count : `KO(${body?.docs?.error || '?'})`
    }`,
  );
} catch (err) {
  check('GET /api/admin/bugs', false, String(err));
}

// Permissions : un compte standard ne doit pas passer
const std = u?.profiles?.standard;
if (std?.email) {
  const sLogin = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: std.email, password: std.password }),
  });
  const sToken = (await sLogin.json().catch(() => ({})))?.token || '';
  if (sToken) {
    const forbidden = await fetch(`${BASE}/api/admin/user-cases`, {
      headers: { Authorization: `Bearer ${sToken}` },
    });
    check('Standard refusé sur /api/admin/*', forbidden.status === 401 || forbidden.status === 403, `HTTP ${forbidden.status}`);
  }
}

console.log(ok ? '\n✅ Agrégats admin OK' : '\n❌ Agrégats admin en échec');
process.exit(ok ? 0 : 1);
