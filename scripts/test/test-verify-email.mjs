#!/usr/bin/env node
/**
 * Teste le flux validation email (local) sans divulguer de secrets.
 *
 *   node scripts/test/test-verify-email.mjs
 *
 * Vérifie : création token → GET landing (ne consomme pas) → POST 2× (idempotent).
 */
import 'dotenv/config';

const API = (process.env.API_ORIGIN || process.env.APP_URL || 'http://127.0.0.1:8787').replace(
  /\/$/,
  '',
);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  console.log(`API → ${API}`);

  const health = await fetch(`${API}/api/health`).then((r) => r.json());
  assert(health?.ok, 'API health KO');
  console.log('✅ health');

  const email = `verify-test-${Date.now()}@delhomme.ovh`;
  const password = `Test-${Date.now()}!Aa1`;
  const reg = await fetch(`${API}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'VerifyTest' }),
  });
  const regBody = await reg.json();
  assert(reg.ok, `register failed: ${regBody.error || reg.status}`);
  assert(regBody.verifyToken || regBody.verifyUrl, 'verifyToken manquant hors prod');
  const token = regBody.verifyToken;
  const verifyUrl = regBody.verifyUrl || `${API}/verify-email?token=${encodeURIComponent(token)}`;
  console.log('✅ register + verifyUrl');

  // GET ne doit PAS consommer
  const get1 = await fetch(verifyUrl);
  assert(get1.ok, `GET landing ${get1.status}`);
  const html = await get1.text();
  assert(html.includes('/api/auth/verify-email'), 'landing sans POST JS');
  assert(html.includes('Validation'), 'landing HTML inattendue');
  console.log('✅ GET /verify-email (landing, pas de conso)');

  // POST #1
  const post1 = await fetch(`${API}/api/auth/verify-email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const p1 = await post1.json();
  assert(post1.ok, `POST1: ${p1.error}`);
  assert(p1.ok && p1.user?.emailVerified, 'user non vérifié après POST1');
  assert(p1.already === false, 'already devrait être false au 1er POST');
  console.log('✅ POST verify #1');

  // POST #2 idempotent (StrictMode / double-clic)
  const post2 = await fetch(`${API}/api/auth/verify-email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const p2 = await post2.json();
  assert(post2.ok, `POST2: ${p2.error}`);
  assert(p2.already === true, 'already devrait être true au 2e POST');
  console.log('✅ POST verify #2 idempotent');

  // Mauvais token
  const bad = await fetch(`${API}/api/auth/verify-email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'not-a-real-token' }),
  });
  assert(bad.status === 400, 'mauvais token devrait 400');
  console.log('✅ POST token invalide → 400');

  console.log('\nOK — flux validation email prêt pour local / préprod / prod');
  console.log(`   APP_URL actuel (liens mails) : ${process.env.APP_URL || '(défaut)'}`);
  console.log('   local   : APP_URL=http://127.0.0.1:8787  (+ adb reverse pour mobile)');
  console.log('   preprod : APP_URL=https://ytmusic-preprod.delhomme.ovh');
  console.log('   prod    : APP_URL=https://ytmusic.delhomme.ovh');
}

main().catch((e) => {
  console.error('❌', e.message || e);
  process.exit(1);
});
