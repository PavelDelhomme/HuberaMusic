/**
 * Balayage jouabilité de TOUTE la biblio d’un compte — fire-and-forget.
 * Relance des lots tant qu’il reste des titres non OK / non balayés.
 *
 *   node scripts/qa/run-library-playability-full.mjs
 *   USER_EMAIL=paul@delhomme.ovh BATCH=40 node scripts/qa/run-library-playability-full.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
loadEnv({ path: join(ROOT, '.env'), override: true });

const API = (process.env.API_BASE_URL || process.env.PUBLIC_API_URL || 'https://music.hubera.cloud').replace(/\/$/, '');
const EMAIL = process.env.USER_EMAIL || process.env.SEED_EMAIL_SECONDARY || 'paul@delhomme.ovh';
const PASS = process.env.USER_PASSWORD || process.env.SEED_PASSWORD || process.env.ADMIN_PASSWORD || '';
const BATCH = Math.max(8, Math.min(40, Number(process.env.BATCH || 40)));
const OUT = join(ROOT, 'tmp/library-playability-full');
mkdirSync(OUT, { recursive: true });

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(line);
  writeFileSync(join(OUT, 'live.log'), `${line}\n`, { flag: 'a' });
}

async function login() {
  const adminTok = process.env.ADMIN_TOKEN || process.env.YTM_ADMIN_TOKEN || '';
  if (adminTok) return adminTok;
  if (!PASS) throw new Error('USER_PASSWORD / SEED_PASSWORD / ADMIN_TOKEN manquant');
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-YTM-Client': 'android' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  const j = await r.json();
  const tok = j.token || j.accessToken || j.access_token;
  if (!tok) throw new Error(`login fail ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return tok;
}

async function adminFetch(tok, path, opts = {}) {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${tok}`,
      'Content-Type': 'application/json',
      'X-YTM-Client': 'android',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let j = {};
  try {
    j = JSON.parse(text);
  } catch {
    j = { raw: text.slice(0, 300) };
  }
  if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(j).slice(0, 240)}`);
  return j;
}

async function main() {
  log('start', API, 'user=', EMAIL, 'batch=', String(BATCH));
  const tok = await login();
  let rounds = 0;
  let totalChecked = 0;
  let totalReplaced = 0;
  let totalFail = 0;
  let stagnant = 0;
  let lastChecked = -1;

  while (rounds < 500) {
    rounds++;
    const st = await adminFetch(tok, '/api/admin/playability');
    log(
      `status ok=${st.ok} fail=${st.fail} replaced=${st.replaced} running=${st.running}`,
    );
    const body = {
      limit: BATCH,
      recover: true,
      user: EMAIL,
    };
    const summary = await adminFetch(tok, '/api/admin/playability/sweep', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const checked = Number(summary.checked || 0);
    const replaced = Number(summary.replaced || 0);
    const fail = Number(summary.fail || 0);
    totalChecked += checked;
    totalReplaced += replaced;
    totalFail += fail;
    writeFileSync(
      join(OUT, 'last-summary.json'),
      JSON.stringify({ at: new Date().toISOString(), rounds, totalChecked, totalReplaced, totalFail, summary }, null, 2),
    );
    log(
      `round=${rounds} checked=${checked} ok=${summary.ok} fail=${fail} replaced=${replaced} totals c=${totalChecked} r=${totalReplaced} f=${totalFail}`,
    );
    if (checked === 0) {
      log('done — plus rien à balayer pour ce lot');
      break;
    }
    if (checked === lastChecked && replaced === 0 && fail === 0) {
      stagnant++;
    } else {
      stagnant = 0;
    }
    lastChecked = checked;
    if (stagnant >= 5) {
      log('stop — stagnation (5 lots sans progrès)');
      break;
    }
    // Laisse respirer le stream live
    await new Promise((r) => setTimeout(r, 2_500));
  }
  log('finished', `rounds=${rounds} checked=${totalChecked} replaced=${totalReplaced} fail=${totalFail}`);
}

main().catch((e) => {
  console.error(e);
  writeFileSync(join(OUT, 'error.txt'), String(e?.stack || e));
  process.exit(1);
});
