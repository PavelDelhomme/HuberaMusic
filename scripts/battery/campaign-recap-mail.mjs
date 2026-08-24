#!/usr/bin/env node
/**
 * Mail récap campagne tests batterie/perf (Samsung + Nothing + Blackview).
 * Usage:
 *   node --env-file=.env scripts/battery/campaign-recap-mail.mjs
 *   CAMPAIGN=logs/campaigns/20260824-191500 node --env-file=.env scripts/battery/campaign-recap-mail.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function load(p) {
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function latestReport(serial) {
  const dir = join(ROOT, 'logs/endurance');
  if (!existsSync(dir)) return null;
  let best = null;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name, 'report.json');
    if (!existsSync(p)) continue;
    try {
      const r = JSON.parse(readFileSync(p, 'utf8'));
      if (r.device !== serial) continue;
      const m = statSync(p).mtimeMs;
      if (!best || m > best.m) best = { m, p, r };
    } catch {
      /* skip */
    }
  }
  return best;
}

function latestSmoke() {
  const dir = join(ROOT, 'docs/reports');
  if (!existsSync(dir)) return null;
  let best = null;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('dual-smoke-')) continue;
    const p = join(dir, name, 'report.json');
    if (!existsSync(p)) continue;
    const m = statSync(p).mtimeMs;
    if (!best || m > best.m) best = { m, p, r: load(p) };
  }
  return best;
}

const campaignDir = process.env.CAMPAIGN ? join(ROOT, process.env.CAMPAIGN) : null;
const SAM_SERIAL = process.env.DEVICE_SAM || '192.168.1.184:5555';
const NOT_SERIAL = process.env.DEVICE_NOTHING || '';

const SAM_REPORT =
  process.env.SAM_REPORT ||
  (campaignDir && existsSync(join(campaignDir, 'samsung-report.json'))
    ? join(campaignDir, 'samsung-report.json')
    : latestReport(SAM_SERIAL)?.p);
const NOT_REPORT =
  process.env.NOT_REPORT ||
  (campaignDir && existsSync(join(campaignDir, 'nothing-report.json'))
    ? join(campaignDir, 'nothing-report.json')
    : latestReport(NOT_SERIAL || undefined)?.p);
const BV_REPORT =
  process.env.BV_REPORT || latestSmoke()?.p;

function fmtEndurance(label, r, reportPath) {
  if (!r) return `\n=== ${label} ===\n(rapport absent)\n`;
  const ver = r.version || 'p+1.3.68';
  const titles = (r.titles || [])
    .slice(0, 8)
    .map((t) => `  • +${t.t}s — ${(t.title || '?').slice(0, 55)}${t.state ? ` [${t.state}]` : ''}`)
    .join('\n');
  const stuck = (r.stuckEvents || []).length;
  return `
=== ${label} ===
Device: ${r.device}
APK: ${r.pkg} · ${ver}
Durée: ${r.elapsedSec}s (cible ${r.durationMin} min)
Résultat script: ${r.ok ? 'OK' : 'ATTENTION'}
Transitions autoplay: ${r.transitions ?? 0}
Erreurs Exo (logcat): ${r.exoErrors ?? 0}
Événements STUCK/PAUSED: ${stuck}
PSS pic / moyen: ${r.memPeakPssKb ?? '?'} / ${r.memAvgPssKb ?? '?'} Ko
Final: ${JSON.stringify(r.final || {})}

Titres (extrait):
${titles || '  (aucun)'}
Rapport: ${reportPath}
`.trim();
}

function fmtBlackview(r, reportPath) {
  if (!r?.devices?.[0]) return '\n=== Blackview (smoke) ===\n(absent)\n';
  const d = r.devices[0];
  const checks = (d.checks || [])
    .map((c) => {
      const tag = c.ok ? 'PASS' : c.soft ? 'SOFT' : 'FAIL';
      return `  ${tag}  ${c.name}${c.detail ? ` — ${c.detail.slice(0, 60)}` : ''}`;
    })
    .join('\n');
  return `
=== Blackview BV9700 (smoke fonctionnel, USB branché) ===
Serial: ${d.serial} · ${d.pkg}
Résultat global: ${r.ok ? 'OK' : 'ATTENTION'}

Checks:
${checks}

Rapport: ${reportPath}
`.trim();
}

const sam = load(SAM_REPORT);
const not = NOT_REPORT ? load(NOT_REPORT) : null;
const bv = BV_REPORT ? load(BV_REPORT) : null;

const globalOk = Boolean(sam?.ok && not?.ok && bv?.ok);
const now = new Date();
const stamp = now.toISOString().slice(0, 10);

const to =
  process.env.BATTERY_REPORT_TO ||
  process.env.SEED_EMAIL ||
  'dev@delhomme.ovh';

const subject = `[PLM] Récap campagne batterie/perf ${stamp} — ${globalOk ? 'OK' : 'ATTENTION'}`;

const text = `Récap campagne tests PLM — ${now.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })} (UTC+2)

Appareils: Samsung S21 FE (débranché) · Nothing Phone 3a (débranché) · Blackview (USB, smoke seul)
Build: p+1.3.68 · API prod ytmusic.delhomme.ovh
Harness: tap play UI + recover PAUSED/BUFFERING + battery.csv

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ CE QUI MARCHE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Samsung — transitions: ${sam?.transitions ?? '?'} · ok=${sam?.ok ?? '?'}
• Samsung — PSS moy ${sam?.memAvgPssKb ?? '?'} Ko (pic ${sam?.memPeakPssKb ?? '?'} Ko)
• Nothing — transitions: ${not?.transitions ?? '?'} · ok=${not?.ok ?? '?'}
• Nothing — PSS moy ${not?.memAvgPssKb ?? '?'} Ko · Exo ${not?.exoErrors ?? '?'}
• Blackview smoke — ok=${bv?.ok ?? '?'}
• battery.csv: ${sam?.batteryCsv ? 'Samsung oui' : 'Samsung non'} / ${not?.batteryCsv ? 'Nothing oui' : 'Nothing non'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ CE QUI NE MARCHE PAS (ou partiel)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${sam?.ok ? '• Samsung — OK' : `• Samsung — ATTENTION (${sam?.exoErrors ?? 0} Exo, final ${JSON.stringify(sam?.final?.state ?? '?')})`}
${not?.ok ? '• Nothing — OK' : `• Nothing — ATTENTION (${not?.transitions ?? 0} trans, final ${JSON.stringify(not?.final?.state ?? '?')})`}
${bv?.ok ? '• Blackview — OK' : '• Blackview — voir checks ci-dessous'}

${fmtEndurance('Samsung S21 FE — endurance', sam, SAM_REPORT || '(absent)')}

${fmtEndurance('Nothing Phone 3a — endurance', not, NOT_REPORT || '(absent)')}

${fmtBlackview(bv, BV_REPORT || '(absent)')}

---
Scripts: scripts/battery/multi-device-campaign.sh · scripts/android/prod-endurance-1h.py
`;

const html = `<pre style="font-family:ui-monospace,monospace;font-size:13px;line-height:1.45">${text
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')}</pre>`;

const host = process.env.SMTP_HOST || '';
const port = Number(process.env.SMTP_PORT || 465);
const user = process.env.SMTP_USER || '';
const pass = process.env.SMTP_PASS || '';
const fromRaw = process.env.SMTP_FROM || `PLM <${user}>`;

if (!host) {
  console.log(text);
  console.error('SMTP_HOST vide — mail non envoyé');
  process.exit(0);
}

const attachments = [];
for (const [name, p] of [
  ['samsung-endurance.json', SAM_REPORT],
  ['nothing-endurance.json', NOT_REPORT],
  ['blackview-smoke.json', BV_REPORT],
]) {
  if (p && existsSync(p)) {
    attachments.push({
      filename: name,
      content: readFileSync(p),
      contentType: 'application/json',
    });
  }
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
  attachments,
});

console.log('==> mail envoyé', info.messageId, '→', to);
