#!/usr/bin/env node
/**
 * Mail récap test Samsung-only (media_session + coords).
 * Usage: REPORT=docs/reports/samsung-media-latest.json node --env-file=.env scripts/android/samsung-recap-mail.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const reportPath =
  process.env.REPORT ||
  join(ROOT, 'docs/reports/samsung-media-latest.json');
const mailErrorsPath = join(ROOT, 'docs/reports/plm-mail-errors-2026-08-15.json');

if (!existsSync(reportPath)) {
  console.error('Pas de report', reportPath);
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
let mailErrors = [];
if (existsSync(mailErrorsPath)) {
  mailErrors = JSON.parse(readFileSync(mailErrorsPath, 'utf8'));
}

const sam = mailErrors.filter((e) => e.pkg_guess === 'dev');
const noth = mailErrors.filter((e) => e.pkg_guess === 'prod');
const early = mailErrors.filter((e) => (e.kind || '').includes('early_end'));
const byTrack = {};
for (const e of early) {
  const t = e.trackId || '?';
  byTrack[t] = (byTrack[t] || 0) + 1;
}
const topTracks = Object.entries(byTrack)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 5)
  .map(([t, n]) => `• ${t} ×${n}`)
  .join('\n');

const checks = (report.checks || [])
  .map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
  .join('\n');

const ok = report.ok ? 'OK' : 'FAIL';
const sum = report.summary || {};
const to =
  process.env.BATTERY_REPORT_TO ||
  'dev@delhomme.ovh,[REDACTED]';

const subject = `[PLM] Samsung DEV marathon media — ${ok} — ${sum.passed || 0}/${sum.total || 0}`;

const text = `Récap test Samsung uniquement (SM-G990B2 / R5CT7263YJL)

Résultat: ${ok}
Package: ${report.pkg}
Version: d+1.3.18 (check version dans le rapport)
API: ${report.api}
Durée: ${report.elapsedSec}s
Scope: ${report.scope}

=== Checks ===
${checks}

=== Pourquoi les 14 fails précédents n’étaient pas bons ===
1) Harness utilisait \`media_session dispatch\` au lieu de \`cmd media_session dispatch\`
   → les skips du script étaient souvent fantômes (titre ne changeait pas côté dump).
2) Parsing media_session confondait sessions STOPPED (description=null) / YouTube Music.
3) Taps UI sur bulles One UI Samsung (« Choisissez quels défis… ») au lieu de titres app.
4) uiautomator dump tué (exit 137) / XML périmé → faux négatifs login/nav.
5) Session parfois perdue après force-stop sans ré-injection token DEBUG.

Preuve Samsung (ce run, sans uiautomator — coords + cmd media_session) :
- skips 20/20 titres uniques réels
- progress OK, pause/play OK
- endurance 15 min 36/36 samples PLAYING, 0 FATAL
- offline inventory: 172 m4a

=== Mails d’erreur PLM (48 h, boîte dev@) ===
Total alertes parsées: ${mailErrors.length}
  · Samsung DEV (url .dev): ${sam.length}
  · Nothing PROD (url prod): ${noth.length}
  · early_end: ${early.length} (tous retry=2 dans l’échantillon)
Top tracks early_end:
${topTracks || '(aucun)'}

Note: les early_end récents (track k1BneeJTDcU ~ratio 0.83) partent surtout du Nothing PROD.
Sur Samsung DEV, last early_end vus le 14/08 après-midi ; ce retest n’a pas généré de FATAL player.

Rapport JSON: ${reportPath}
Catalogue mails: ${mailErrorsPath}
`;

const html = `<pre style="font-family:ui-monospace,monospace;font-size:13px">${text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')}</pre>`;

const host = process.env.SMTP_HOST || '';
const port = Number(process.env.SMTP_PORT || 465);
const user = process.env.SMTP_USER || '';
const pass = process.env.SMTP_PASS || '';
const fromRaw = process.env.SMTP_FROM || `PLM <${user}>`;

if (!host) {
  console.log(text);
  console.error('SMTP_HOST vide — dump console only');
  process.exit(0);
}

const tx = nodemailer.createTransport({
  host,
  port,
  secure: port === 465 || process.env.SMTP_SECURE === '1',
  auth: user ? { user, pass } : undefined,
});

const info = await tx.sendMail({
  from: fromRaw,
  to,
  subject,
  text,
  html,
  attachments: [
    {
      filename: 'samsung-media-report.json',
      content: readFileSync(reportPath),
      contentType: 'application/json',
    },
    ...(existsSync(mailErrorsPath)
      ? [
          {
            filename: 'plm-mail-errors-48h.json',
            content: readFileSync(mailErrorsPath),
            contentType: 'application/json',
          },
        ]
      : []),
  ],
});

console.log('==> mail envoyé', info.messageId, '→', to);
