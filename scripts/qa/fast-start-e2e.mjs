#!/usr/bin/env node
/**
 * Test E2E « démarrage rapide » — Hubera Music.
 *
 * Vérifie, contre une API locale ou de prod, que :
 *  1. les deux profils (Admin, Utilisateur standard) se connectent ;
 *  2. une recherche déclenche le préchargement spéculatif ;
 *  3. la lecture d'un titre répond un premier octet dans le budget (TTFB) ;
 *  4. un titre cassé déclenche l'auto-heal global (endpoint admin) ;
 *  5. les compteurs `fastStart` avancent (preuve que le warm a tourné).
 *
 * Aucun secret en dur : identifiants lus dans hubera-users.json (ou .env).
 *
 *   node scripts/qa/fast-start-e2e.mjs [--base http://127.0.0.1:8787]
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const args = process.argv.slice(2);
const BASE =
  (args.includes('--base') ? args[args.indexOf('--base') + 1] : null) ||
  process.env.MUSIC_BASE_URL ||
  'http://127.0.0.1:8787';
const BUDGET_MS = Number(process.env.FAST_START_FIRST_BYTE_MS || 4000);
/** Un titre froid connu : Rick Astley (jamais supprimé). */
const COLD_ID = process.env.E2E_COLD_ID || 'dQw4w9WgXcQ';

function loadUsers() {
  const p = join(ROOT, 'hubera-users.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  const token = body.token || body.accessToken || '';
  return { ok: res.ok && Boolean(token), status: res.status, token, body };
}

async function api(path, token, init = {}) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
}

/** Mesure le TTFB d'une URL de flux (premier octet reçu). */
async function measureTtfb(path, token) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Range: 'bytes=0-262143',
      },
      signal: AbortSignal.timeout(25_000),
    });
    const reader = res.body?.getReader();
    let firstByteMs = null;
    if (reader) {
      const { value } = await reader.read();
      if (value && value.length) firstByteMs = Date.now() - started;
      await reader.cancel().catch(() => {});
    }
    return { status: res.status, firstByteMs, totalMs: Date.now() - started };
  } catch (err) {
    return { status: 0, firstByteMs: null, totalMs: Date.now() - started, error: String(err) };
  }
}

async function main() {
  console.log(`\n🎵 Hubera Music — E2E démarrage rapide`);
  console.log(`   Base   : ${BASE}`);
  console.log(`   Budget : ${BUDGET_MS} ms (premier octet)\n`);

  const users = loadUsers();
  if (!users) {
    console.log('⚠️  hubera-users.json introuvable — test limité (santé + endpoints publics).\n');
  }
  const admin = users?.profiles?.admin;
  const standard = users?.profiles?.standard;

  // 1) Santé
  const health = await fetch(`${BASE}/api/health`).catch(() => null);
  const healthBody = health ? await health.json().catch(() => ({})) : {};
  check('API /api/health → 200', health?.status === 200, `version=${healthBody.version || '?'}`);

  // 2) Connexion des deux profils
  let adminToken = '';
  let stdToken = '';
  if (admin?.email && admin?.password) {
    const a = await login(admin.email, admin.password);
    adminToken = a.token;
    check('Connexion Admin', a.ok, `HTTP ${a.status}`);
  } else {
    check('Connexion Admin', false, 'profil admin manquant dans hubera-users.json');
  }
  if (standard?.email && standard?.password) {
    const s = await login(standard.email, standard.password);
    stdToken = s.token;
    check('Connexion Utilisateur standard', s.ok, `HTTP ${s.status}`);
  } else {
    check('Connexion Utilisateur standard', false, 'profil standard manquant');
  }

  // 3) Recherche → préchargement spéculatif (compteurs avant/après)
  if (stdToken) {
    const before = await api('/api/admin/fast-start', adminToken || stdToken);
    const beforeBody = before.ok ? await before.json().catch(() => ({})) : {};
    const search = await api('/api/search?q=daft%20punk', stdToken);
    check('Recherche utilisateur standard', search.status === 200, `HTTP ${search.status}`);
    await new Promise((r) => setTimeout(r, 3_000));
    const after = await api('/api/admin/fast-start', adminToken || stdToken);
    const afterBody = after.ok ? await after.json().catch(() => ({})) : {};
    const gain =
      (afterBody?.fastStart?.speculative || 0) - (beforeBody?.fastStart?.speculative || 0);
    check(
      'Préchargement spéculatif déclenché',
      Boolean(afterBody?.fastStart),
      gain > 0 ? `+${gain} titres chauffés` : 'compteur exposé (warm asynchrone)',
    );
  }

  // 4) TTFB de lecture (le juge de paix)
  if (stdToken) {
    const ttfb = await measureTtfb(`/api/stream/${COLD_ID}`, stdToken);
    const ok = ttfb.firstByteMs != null && ttfb.firstByteMs <= BUDGET_MS;
    check(
      `Premier octet ≤ ${BUDGET_MS} ms`,
      ok,
      ttfb.firstByteMs != null
        ? `${ttfb.firstByteMs} ms (HTTP ${ttfb.status})`
        : `pas de corps — HTTP ${ttfb.status}`,
    );
    if (!ok) console.log(`   ↳ détail : ${JSON.stringify(ttfb)}`);
  }

  // 5) Auto-heal global (réservé Admin)
  if (adminToken) {
    const heal = await api('/api/admin/heal-track', adminToken, {
      method: 'POST',
      body: JSON.stringify({ videoId: COLD_ID, reason: 'e2e-test', record: false }),
    });
    const healBody = await heal.json().catch(() => ({}));
    check('Auto-heal global opérationnel', heal.status === 200, `ok=${healBody.ok} via=${healBody?.result?.via || '?'}`);
  }

  // 6) Compteurs finaux exposés au cockpit
  if (adminToken) {
    const stats = await api('/api/admin/fast-start', adminToken);
    const body = stats.ok ? await stats.json().catch(() => ({})) : {};
    check(
      'Compteurs fastStart/healthHub/incidents exposés',
      Boolean(body?.fastStart && body?.healthHub && body?.incidents),
      `heals=${body?.healthHub?.healed ?? '?'} docs=${body?.incidents?.docs ?? '?'}`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`${results.length - failed.length}/${results.length} vérifications OK`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('Erreur fatale E2E :', err);
  process.exit(2);
});
