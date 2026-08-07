#!/usr/bin/env node
/**
 * Envoie le dernier rapport batterie par email via API locale/prod.
 * Usage:
 *   node --env-file=.env scripts/battery-mail-report.mjs
 *   SESSION=logs/battery-session/XXX node --env-file=.env scripts/battery-mail-report.mjs
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = (process.env.API_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const email = process.env.SEED_EMAIL || process.env.VITE_DEV_EMAIL || '';
const pass = process.env.SEED_PASSWORD || process.env.VITE_DEV_PASSWORD || '';

let session = process.env.SESSION || '';
if (!session) {
  const latest = join(ROOT, 'logs/battery-session/latest');
  try {
    session = execSync(`readlink -f "${latest}"`, { encoding: 'utf8' }).trim();
  } catch {
    const dirs = readdirSync(join(ROOT, 'logs/battery-session'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'latest')
      .map((d) => join(ROOT, 'logs/battery-session', d.name))
      .sort()
      .reverse();
    session = dirs[0] || '';
  }
}
if (!session || !existsSync(session)) {
  console.error('Aucune session battery');
  process.exit(1);
}
if (!email || !pass) {
  console.error('SEED_EMAIL / SEED_PASSWORD manquants');
  process.exit(1);
}

console.log('==> session=', session, 'api=', api);

const zipPath = `/tmp/plm-battery-${basename(session)}.zip`;
try {
  unlinkSync(zipPath);
} catch {
  /* */
}
try {
  execSync(
    `cd "${session}" && zip -qr "${zipPath}" REPORT.md session.log devices/*/meta.txt devices/*/battery.csv 2>/dev/null || true`,
    { shell: '/bin/bash' },
  );
  for (const id of readdirSync(join(session, 'devices'))) {
    const d = join(session, 'devices', id);
    const logcat = join(d, 'logcat.txt');
    if (existsSync(logcat)) {
      const buf = readFileSync(logcat);
      const slim = buf.subarray(Math.max(0, buf.length - 400_000));
      const tmp = `/tmp/logcat-${id}.txt`;
      writeFileSync(tmp, slim);
      execSync(`zip -qj "${zipPath}" "${tmp}"`, { shell: '/bin/bash' });
    }
    const bs = join(d, 'batterystats.txt');
    if (existsSync(bs)) {
      const slim = readFileSync(bs).subarray(0, 120_000);
      const tmp = `/tmp/bstats-${id}.txt`;
      writeFileSync(tmp, slim);
      execSync(`zip -qj "${zipPath}" "${tmp}"`, { shell: '/bin/bash' });
    }
  }
} catch (e) {
  console.warn('zip soft-fail', e.message);
}

const zsize = existsSync(zipPath) ? readFileSync(zipPath).length : 0;
const useZip = zsize > 0 && zsize <= 1_800_000;
console.log('==> zip', zipPath, zsize, 'useZip=', useZip);

const login = await fetch(`${api}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password: pass }),
});
const loginJson = await login.json();
if (!login.ok) {
  console.error('login fail', login.status, loginJson);
  process.exit(1);
}
const token = loginJson.accessToken || loginJson.token;
if (!token) {
  console.error('no token', loginJson);
  process.exit(1);
}

const reportMd = existsSync(join(session, 'REPORT.md'))
  ? readFileSync(join(session, 'REPORT.md'), 'utf8')
  : '';
const devicesDir = join(session, 'devices');
const deviceDirs = existsSync(devicesDir)
  ? readdirSync(devicesDir)
      .map((n) => join(devicesDir, n))
      .filter((p) => existsSync(join(p, 'battery.csv')))
  : [];

function parseCsv(path) {
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  if (lines.length < 2) return null;
  const h = lines[0].split(',');
  const obj = (row) => Object.fromEntries(h.map((k, i) => [k, row[i]]));
  return {
    first: obj(lines[1].split(',')),
    last: obj(lines[lines.length - 1].split(',')),
    n: lines.length - 1,
  };
}

const zipBase64 = useZip ? readFileSync(zipPath).toString('base64') : undefined;

for (const dir of deviceDirs) {
  const meta = existsSync(join(dir, 'meta.txt')) ? readFileSync(join(dir, 'meta.txt'), 'utf8') : '';
  const csv = parseCsv(join(dir, 'battery.csv'));
  if (!csv) continue;
  const l0 = Number(csv.first.level);
  const l1 = Number(csv.last.level);
  const c0 = Number(csv.first.charge_counter);
  const c1 = Number(csv.last.charge_counter);
  const t0 = Number(csv.first.ts);
  const t1 = Number(csv.last.ts);
  const mins = Math.max(1, (t1 - t0) / 60);
  const mah = (c0 - c1) / 1000;
  const metaMap = Object.fromEntries(
    meta
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf('=');
        return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l, ''];
      }),
  );
  const body = {
    device: {
      model: metaMap.model,
      serial: metaMap.serial,
      android: metaMap.android,
      name: metaMap.model,
      transport: metaMap.wifi === 'yes' ? 'wifi' : 'usb',
    },
    app: {
      versionName: (meta.match(/versionName=(\S+)/) || [])[1],
      package: metaMap.pkg || 'ovh.delhomme.ytmusic',
      apiBase: api,
    },
    session: {
      stamp: basename(session),
      durationSec: Math.round(t1 - t0),
      sampleSec: 15,
      unplugged: true,
    },
    stats: {
      levelStart: l0,
      levelEnd: l1,
      levelDelta: l0 - l1,
      tempStartC: Number(csv.first.temp_raw) / 10,
      tempEndC: Number(csv.last.temp_raw) / 10,
      chargeCounterStart: c0,
      chargeCounterEnd: c1,
      mAhDelta: Math.round(mah * 10) / 10,
      mAhPerHour: Math.round((mah / (mins / 60)) * 10) / 10,
      percentPerHour: Math.round(((l0 - l1) / (mins / 60)) * 10) / 10,
    },
    notes:
      'Rapport session make battery-go. Postes typiques : ExoPlayer wake + Wi‑Fi + related/full. Comparer %/h à YTM.',
    samples: {
      'REPORT.md': reportMd.slice(0, 8000),
      'battery.csv.head': readFileSync(join(dir, 'battery.csv'), 'utf8').split('\n').slice(0, 8).join('\n'),
      'battery.csv.tail': readFileSync(join(dir, 'battery.csv'), 'utf8').split('\n').slice(-6).join('\n'),
    },
  };
  if (zipBase64) {
    body.zipBase64 = zipBase64;
    body.zipFilename = basename(zipPath);
  }
  const r = await fetch(`${api}/api/telemetry/battery-report`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  console.log(r.status, j);
  if (!r.ok) process.exit(1);
}
console.log('OK mailed', deviceDirs.length, 'device report(s) → BATTERY_REPORT_TO / SEED_EMAIL');
