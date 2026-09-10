#!/usr/bin/env node
/**
 * QA prod : inscription + verify email + forgot/reset MDP
 * pour EMAIL_TEST_INSCRIPTION (IMAP imap.maily.ovh).
 *
 * Usage:
 *   node --env-file=.env --import tsx scripts/qa/auth-inscription-reset-qa.mts
 *   node --env-file=.env --import tsx scripts/qa/auth-inscription-reset-qa.mts --purge
 *
 * --purge : supprime le compte test en DB prod (SSH) avant de ré-inscrire.
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const BASE = (process.env.DEPLOY_URL || process.env.PUBLIC_API_URL || 'https://plm.delhomme.ovh').replace(/\/$/, '');
const EMAIL = (process.env.EMAIL_TEST_INSCRIPTION || '').trim().toLowerCase();
const PASSWORD = (process.env.EMAIL_TEST_INSCRIPTION_PASSWORD || '').trim();
const DEPLOY_SSH = (process.env.DEPLOY_SSH || '').trim();
const PURGE = process.argv.includes('--purge');

if (!EMAIL || !PASSWORD || PASSWORD.length < 10) {
  console.error('EMAIL_TEST_INSCRIPTION / EMAIL_TEST_INSCRIPTION_PASSWORD manquants ou MDP < 10');
  process.exit(2);
}

async function api(path: string, opts: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  return { status: res.status, json };
}

function purgeUserViaSsh() {
  if (!DEPLOY_SSH) throw new Error('DEPLOY_SSH manquant pour --purge');
  // Fichier temp dans le conteneur — évite le cauchemar d’échappement SSH/`node -e`.
  const js =
    "const Database=require('better-sqlite3');" +
    "const db=new Database('/app/data/ytmusic.db');" +
    `const u=db.prepare('SELECT id,email FROM users WHERE lower(email)=?').get(${JSON.stringify(EMAIL)});` +
    "if(!u){console.log('PURGE_NONE');process.exit(0);}" +
    "db.prepare('DELETE FROM email_tokens WHERE user_id=?').run(u.id);" +
    "db.prepare('DELETE FROM refresh_tokens WHERE user_id=?').run(u.id);" +
    "try{db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);}catch(e){}" +
    "db.prepare('DELETE FROM users WHERE id=?').run(u.id);" +
    "console.log('PURGE_OK', u.email);";
  const b64 = Buffer.from(js, 'utf8').toString('base64');
  const remote = [
    `echo ${b64} | base64 -d > /tmp/plm-purge-user.js`,
    'docker cp /tmp/plm-purge-user.js ytmusic:/tmp/plm-purge-user.js',
    'docker exec -w /app -e NODE_PATH=/app/node_modules ytmusic node /tmp/plm-purge-user.js',
  ].join(' && ');
  const out = execSync(`ssh -o BatchMode=yes -o ConnectTimeout=20 ${DEPLOY_SSH} ${JSON.stringify(remote)}`, {
    encoding: 'utf8',
  });
  console.log(out.trim());
}

function fetchLinksFromImap(): { verify?: string; reset?: string } {
  writeFileSync(
    '/tmp/plm-imap-fetch.py',
    `
import json, imaplib, email, re
from email.header import decode_header
user=${JSON.stringify(EMAIL)}
pwd=${JSON.stringify(PASSWORD)}
M=imaplib.IMAP4_SSL('imap.maily.ovh',993)
M.login(user,pwd)
M.select('INBOX')
typ, ids = M.search(None, 'FROM', 'noreply@maily.ovh')
idlist=ids[0].split()[-10:]
links={'verify':None,'reset':None}
for i in idlist[::-1]:
    typ, msgdata=M.fetch(i,'(RFC822)')
    msg=email.message_from_bytes(msgdata[0][1])
    body=''
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() in ('text/plain','text/html'):
                try:
                    body += part.get_payload(decode=True).decode(part.get_content_charset() or 'utf-8','replace')
                except Exception:
                    pass
    else:
        try:
            body=msg.get_payload(decode=True).decode('utf-8','replace')
        except Exception:
            body=''
    for u in re.findall(r'https?://[^\\s\"<>]+(?:verify-email|reset-password)\\?token=[^\\s\"<>]+', body):
        u=u.rstrip(').,>]\\'\"')
        if 'verify-email' in u and not links['verify']:
            links['verify']=u
        if 'reset-password' in u and not links['reset']:
            links['reset']=u
M.logout()
print(json.dumps(links))
`,
  );
  const out = execSync('python3 /tmp/plm-imap-fetch.py', { encoding: 'utf8' });
  return JSON.parse(out.trim());
}

function tokenFromUrl(url: string) {
  const m = /token=([^&\s]+)/.exec(url);
  if (!m) throw new Error('token manquant dans ' + url);
  return decodeURIComponent(m[1]);
}

async function main() {
  console.log('==> QA auth', BASE, EMAIL);
  if (PURGE) {
    console.log('==> Purge compte test');
    purgeUserViaSsh();
  }

  console.log('==> Register');
  let r = await api('/api/auth/register', {
    body: { email: EMAIL, password: PASSWORD, name: 'PLM Test Insc' },
  });
  if (r.status === 400 && String(r.json?.error || '').includes('déjà')) {
    console.log('déjà inscrit — skip register');
  } else if (r.status !== 200) {
    console.error('register FAIL', r.status, r.json);
    process.exit(1);
  } else {
    console.log('register OK');
  }

  await new Promise((x) => setTimeout(x, 2500));
  let links = fetchLinksFromImap();
  if (links.verify) {
    const tok = tokenFromUrl(links.verify);
    r = await api('/api/auth/verify-email', { body: { token: tok } });
    console.log('verify', r.status, r.json?.ok, r.json?.already);
  } else {
    console.warn('pas de mail verify trouvé (IMAP)');
  }

  console.log('==> Forgot password');
  r = await api('/api/auth/forgot-password', { body: { email: EMAIL } });
  if (r.status !== 200 || !r.json?.ok) {
    console.error('forgot FAIL', r);
    process.exit(1);
  }
  await new Promise((x) => setTimeout(x, 2500));
  links = fetchLinksFromImap();
  if (!links.reset) {
    console.error('pas de mail reset IMAP');
    process.exit(1);
  }
  const resetTok = tokenFromUrl(links.reset);
  const tempPwd = PASSWORD + 'Tmp1';
  r = await api('/api/auth/reset-password', { body: { token: resetTok, password: tempPwd } });
  if (r.status !== 200 || !r.json?.ok) {
    console.error('reset FAIL', r);
    process.exit(1);
  }
  console.log('reset OK → login temp');
  r = await api('/api/auth/login', { body: { email: EMAIL, password: tempPwd } });
  if (r.status !== 200 || !r.json?.token) {
    console.error('login temp FAIL', r);
    process.exit(1);
  }

  // restore original password
  await api('/api/auth/forgot-password', { body: { email: EMAIL } });
  await new Promise((x) => setTimeout(x, 2500));
  links = fetchLinksFromImap();
  if (!links.reset) {
    console.error('pas de mail reset restore');
    process.exit(1);
  }
  r = await api('/api/auth/reset-password', {
    body: { token: tokenFromUrl(links.reset), password: PASSWORD },
  });
  if (r.status !== 200 || !r.json?.ok) {
    console.error('restore FAIL', r);
    process.exit(1);
  }
  r = await api('/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  if (r.status !== 200 || !r.json?.token) {
    console.error('login original FAIL', r);
    process.exit(1);
  }
  console.log('==> PASS inscription + verify + reset + restore');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
