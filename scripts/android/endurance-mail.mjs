#!/usr/bin/env node
/**
 * Envoie un récap endurance mobile via SMTP (.env).
 * Usage: REPORT=logs/endurance/XXX/report.json node --env-file=.env scripts/android/endurance-mail.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let reportPath = process.env.REPORT || '';
if (!reportPath) {
  const base = join(ROOT, 'logs/endurance');
  const dirs = readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
  for (const d of dirs) {
    const p = join(base, d, 'report.json');
    if (existsSync(p)) {
      reportPath = p;
      break;
    }
  }
}
if (!reportPath || !existsSync(reportPath)) {
  console.error('Pas de report.json');
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const to =
  process.env.BATTERY_REPORT_TO ||
  process.env.SEED_EMAIL ||
  'dev@delhomme.ovh';

const titles = (report.titles || [])
  .slice(0, 25)
  .map((t) => `• +${t.t}s — ${t.title}`)
  .join('\n');
const net = (report.networkEvents || [])
  .map((e) => `• t=${e.t}s ${e.event} state=${e.state || ''} title=${(e.title || '').slice(0, 40)}`)
  .join('\n');

const ok = report.ok ? 'OK' : 'ATTENTION';
const subject = `[PLM] Endurance mobile 1h — ${ok} — ${report.transitions || 0} transitions`;
const text = `Récap test endurance production (Nothing)

Résultat: ${ok}
Device: ${report.device}
Package: ${report.pkg}
Durée: ${report.elapsedSec}s (cible ${report.durationMin} min)
Transitions titres: ${report.transitions}
Erreurs ExoPlayer: ${report.exoErrors}
STATE_ENDED logs: ${report.stateEndedLogs}
Fatals: ${(report.fatals || []).length}
Stuck events: ${(report.stuckEvents || []).length}

Mémoire:
- PSS peak: ${report.memPeakPssKb} Ko
- PSS moyen: ${report.memAvgPssKb} Ko

Batterie (secteur → peu significatif):
${JSON.stringify(report.battery || {}, null, 2)}

Réseau (proxy cut mid-track):
${net || '(aucun)'}

Titres (échantillon):
${titles}

Final: ${JSON.stringify(report.final || {})}

Rapport: ${reportPath}
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
  console.error('SMTP_HOST vide — mail non envoyé (dump console)');
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
      filename: 'endurance-report.json',
      content: readFileSync(reportPath),
      contentType: 'application/json',
    },
  ],
});

console.log('==> mail envoyé', info.messageId, '→', to);
