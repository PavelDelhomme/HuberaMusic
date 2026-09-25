/**
 * Vérifie Admin → Inscription ouverte / fermée sur prod.
 * Usage: node --env-file=.env --import tsx scripts/qa/verify-inscription-toggle.mts
 *
 * Restaure toujours l’état initial allowRegister en finally.
 */
const BASE = (process.env.DEPLOY_URL || process.env.PUBLIC_API_URL || 'https://plm.delhomme.ovh').replace(
  /\/$/,
  '',
);
const ADMIN_EMAIL = process.env.SEED_EMAIL || process.env.VITE_DEV_EMAIL || 'dev@delhomme.ovh';
const ADMIN_PASSWORD = process.env.SEED_PASSWORD || process.env.VITE_DEV_PASSWORD || '';
const TEST_EMAIL =
  process.env.EMAIL_TEST_INSCRIPTION ||
  `qa-inscript-${Date.now()}@delhomme.ovh`;
const TEST_PASSWORD =
  process.env.EMAIL_TEST_INSCRIPTION_PASSWORD || `QaTest${Date.now()}!LongEnough`;

type Json = Record<string, unknown>;

async function api(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; json: Json }> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let json: Json = {};
  try {
    json = (await res.json()) as Json;
  } catch {
    json = {};
  }
  return { status: res.status, json };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const results: { step: string; ok: boolean; detail: string }[] = [];

function log(step: string, ok: boolean, detail: string) {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step} — ${detail}`);
}

async function main() {
  console.log(`BASE=${BASE}`);
  console.log(`admin=${ADMIN_EMAIL}`);
  console.log(`testEmail=${TEST_EMAIL}`);
  assert(ADMIN_PASSWORD, 'SEED_PASSWORD / VITE_DEV_PASSWORD manquant');

  const health = await api('/api/health');
  log(
    'health',
    health.status === 200 && health.json.ok === true,
    `appVersion=${(health.json as any).appVersion} allowRegister=${(health.json as any)?.auth?.allowRegister}`,
  );

  const login = await api('/api/auth/login', {
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, deviceLabel: 'qa-inscription' },
  });
  assert(login.status === 200 && typeof login.json.token === 'string', `login admin: ${login.status} ${JSON.stringify(login.json)}`);
  const token = String(login.json.token);
  log('admin-login', true, 'OK');

  const settings0 = await api('/api/admin/settings', { token });
  assert(settings0.status === 200, `settings GET ${settings0.status}`);
  const initialAllow = Boolean(settings0.json.allowRegister);
  log('settings-initial', true, `allowRegister=${initialAllow} override=${settings0.json.allowRegisterOverride}`);

  const restore = async () => {
    const r = await api('/api/admin/settings', {
      method: 'PUT',
      token,
      body: { allowRegister: initialAllow },
    });
    log('restore', r.status === 200 && Boolean(r.json.allowRegister) === initialAllow, `allowRegister→${initialAllow}`);
  };

  try {
    // 1) Fermer
    const close = await api('/api/admin/settings', {
      method: 'PUT',
      token,
      body: { allowRegister: false },
    });
    assert(close.status === 200 && close.json.allowRegister === false, `close failed: ${JSON.stringify(close.json)}`);
    log('close-register', true, 'allowRegister=false');

    const cfgClosed = await api('/api/auth/config');
    log(
      'config-closed',
      cfgClosed.json.allowRegister === false,
      `public allowRegister=${cfgClosed.json.allowRegister}`,
    );

    const regClosed = await api('/api/auth/register', {
      body: {
        email: `closed-${Date.now()}@delhomme.ovh`,
        password: TEST_PASSWORD,
        name: 'QA Closed',
      },
    });
    const closedMsg = String(regClosed.json.error || '');
    const closedOk =
      regClosed.status === 400 && /inscription désactivée|instance privée/i.test(closedMsg);
    log('register-while-closed', closedOk, `${regClosed.status} ${closedMsg || 'no error'}`);

    // 2) Ouvrir
    const open = await api('/api/admin/settings', {
      method: 'PUT',
      token,
      body: { allowRegister: true },
    });
    assert(open.status === 200 && open.json.allowRegister === true, `open failed: ${JSON.stringify(open.json)}`);
    log('open-register', true, `allowRegister=true apkTicket=${Boolean((open.json as any).apkTicket)}`);

    const cfgOpen = await api('/api/auth/config');
    log('config-open', cfgOpen.json.allowRegister === true, `public allowRegister=${cfgOpen.json.allowRegister}`);

    // Email de test : si déjà pris, on en génère un unique
    let email = TEST_EMAIL;
    let regOpen = await api('/api/auth/register', {
      body: { email, password: TEST_PASSWORD, name: 'QA Inscription' },
    });
    if (regOpen.status === 400 && /déjà utilisé|already/i.test(String(regOpen.json.error || ''))) {
      email = `qa-inscript-${Date.now()}@delhomme.ovh`;
      regOpen = await api('/api/auth/register', {
        body: { email, password: TEST_PASSWORD, name: 'QA Inscription' },
      });
    }
    const openOk = regOpen.status === 200 && Boolean(regOpen.json.token || regOpen.json.user);
    log(
      'register-while-open',
      openOk,
      openOk
        ? `créé ${email} needsVerify=${regOpen.json.needsEmailVerification}`
        : `${regOpen.status} ${JSON.stringify(regOpen.json)}`,
    );

    // 3) Refermer et re-vérifier refus
    const close2 = await api('/api/admin/settings', {
      method: 'PUT',
      token,
      body: { allowRegister: false },
    });
    assert(close2.json.allowRegister === false, 're-close failed');
    log('reclose-register', true, 'allowRegister=false');

    const regAgain = await api('/api/auth/register', {
      body: {
        email: `again-${Date.now()}@delhomme.ovh`,
        password: TEST_PASSWORD,
        name: 'QA Again',
      },
    });
    const againOk =
      regAgain.status === 400 &&
      /inscription désactivée|instance privée/i.test(String(regAgain.json.error || ''));
    log('register-after-reclose', againOk, `${regAgain.status} ${regAgain.json.error || ''}`);
  } finally {
    await restore();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n---');
  console.log(`TOTAL ${results.length}  PASS ${results.length - failed.length}  FAIL ${failed.length}`);
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
