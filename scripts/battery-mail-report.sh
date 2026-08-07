#!/usr/bin/env bash
# Envoie le dernier rapport batterie par email (SMTP .env → BATTERY_REPORT_TO / SEED_EMAIL).
# Usage :
#   make battery-report-mail
#   SESSION=logs/battery-session/20260806-230322 bash scripts/battery-mail-report.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env" 2>/dev/null || true
  set +a
fi

API="${API_BASE_URL:-http://127.0.0.1:8787}"
API="${API%/}"
SESSION="${SESSION:-}"
if [[ -z "$SESSION" ]]; then
  if [[ -L "$ROOT/logs/battery-session/latest" ]]; then
    SESSION="$(readlink -f "$ROOT/logs/battery-session/latest")"
  else
    SESSION="$(ls -1dt "$ROOT"/logs/battery-session/*/ 2>/dev/null | head -1 | sed 's:/*$::')"
  fi
fi
[[ -n "$SESSION" && -d "$SESSION" ]] || { echo "Aucune session battery"; exit 1; }

EMAIL="${SEED_EMAIL:-${VITE_DEV_EMAIL:-}}"
PASS="${SEED_PASSWORD:-${VITE_DEV_PASSWORD:-}}"
[[ -n "$EMAIL" && -n "$PASS" ]] || { echo "SEED_EMAIL/PASSWORD manquants"; exit 1; }

echo "==> session=$SESSION api=$API"

# Zip compact (csv + report + logcat head + batterystats head)
ZIP="/tmp/plm-battery-$(basename "$SESSION").zip"
rm -f "$ZIP"
(
  cd "$SESSION"
  zip -qr "$ZIP" REPORT.md session.log devices/*/meta.txt devices/*/battery.csv 2>/dev/null || true
  # logcat tronqué pour rester <1.8Mo
  for d in devices/*; do
    [[ -d "$d" ]] || continue
    id="$(basename "$d")"
    if [[ -f "$d/logcat.txt" ]]; then
      tail -c 400000 "$d/logcat.txt" >"/tmp/logcat-$id.txt"
      zip -qj "$ZIP" "/tmp/logcat-$id.txt" 2>/dev/null || true
    fi
    if [[ -f "$d/batterystats.txt" ]]; then
      head -c 120000 "$d/batterystats.txt" >"/tmp/bstats-$id.txt"
      zip -qj "$ZIP" "/tmp/bstats-$id.txt" 2>/dev/null || true
    fi
  done
)
ZSIZE=$(wc -c <"$ZIP" | tr -d ' ')
echo "==> zip=$ZIP (${ZSIZE} bytes)"
if (( ZSIZE > 1800000 )); then
  echo "Zip trop gros — on envoie sans PJ complète (stats JSON seulement)"
  USE_ZIP=0
else
  USE_ZIP=1
fi

node --input-type=module <<NODE
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const api = process.env.API;
const email = process.env.EMAIL;
const pass = process.env.PASS;
const session = process.env.SESSION;
const zipPath = process.env.ZIP;
const useZip = process.env.USE_ZIP === '1';

const login = await fetch(api + '/api/auth/login', {
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
  ? readdirSync(devicesDir).map((n) => join(devicesDir, n)).filter((p) => existsSync(join(p, 'battery.csv')))
  : [];

function parseCsv(path) {
  const lines = readFileSync(path, 'utf8').trim().split('\\n');
  if (lines.length < 2) return null;
  const h = lines[0].split(',');
  const first = lines[1].split(',');
  const last = lines[lines.length - 1].split(',');
  const obj = (row) => Object.fromEntries(h.map((k, i) => [k, row[i]]));
  return { first: obj(first), last: obj(last), n: lines.length - 1 };
}

const payloads = [];
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
      .split('\\n')
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf('=');
        return i > 0 ? [l.slice(0, i), l.slice(i + 1)] : [l, ''];
      }),
  );
  payloads.push({
    device: {
      model: metaMap.model,
      serial: metaMap.serial,
      android: metaMap.android,
      name: metaMap.model,
      transport: metaMap.wifi === 'yes' ? 'wifi' : 'usb',
    },
    app: {
      versionName: (meta.match(/versionName=(\\S+)/) || [])[1],
      package: metaMap.pkg || 'ovh.delhomme.ytmusic',
      apiBase: api,
    },
    session: {
      stamp: session.split('/').pop(),
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
      'Rapport session make battery-go. Comparer mAh/h et %/h ; Wi‑Fi + ExoPlayer = principaux postes.',
    samples: {
      'REPORT.md': reportMd.slice(0, 8000),
      'battery.csv.head': readFileSync(join(dir, 'battery.csv'), 'utf8').split('\\n').slice(0, 8).join('\\n'),
      'battery.csv.tail': readFileSync(join(dir, 'battery.csv'), 'utf8').split('\\n').slice(-6).join('\\n'),
    },
  });
}

const zipBase64 = useZip ? readFileSync(zipPath).toString('base64') : undefined;
for (const body of payloads) {
  if (zipBase64) {
    body.zipBase64 = zipBase64;
    body.zipFilename = zipPath.split('/').pop();
  }
  const r = await fetch(api + '/api/telemetry/battery-report', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  console.log(r.status, j);
  if (!r.ok) process.exit(1);
}
console.log('OK mailed', payloads.length, 'device report(s)');
NODE
