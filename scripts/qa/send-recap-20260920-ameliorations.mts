/**
 * Récap 2026-09-20 — Music & Fuel, changements fluidité / économie / UI.
 * Destinataires : REPORT_TO || MAIL_TO || ADMIN_EMAILS (env only).
 *
 *   node --import tsx scripts/qa/send-recap-20260920-ameliorations.mts
 */
import { config as loadEnv } from 'dotenv';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sendMail } from '../../api/src/platform/mail.ts';

loadEnv({ path: '.env', override: true });

function resolveTo(): string {
  const bags = [process.env.REPORT_TO, process.env.MAIL_TO, process.env.ADMIN_EMAILS];
  const parts: string[] = [];
  for (const raw of bags) {
    if (!raw?.trim()) continue;
    for (const s of raw.split(/[,;]/)) {
      const e = s.trim();
      if (e.includes('@') && !e.includes('[')) parts.push(e);
    }
  }
  return [...new Set(parts)].join(', ');
}

function maskAddr(addr: string): string {
  const [local, domain] = addr.split('@');
  if (!domain) return '***';
  const head = local.slice(0, 1) || '*';
  return `${head}***@${domain}`;
}

function maskList(to: string): string {
  return to
    .split(',')
    .map((s) => maskAddr(s.trim()))
    .join(', ');
}

const to = resolveTo();
const PDF = '/home/pactivisme/Documents/Dev/Perso/Hubera/docs/reports/recap-ameliorations-music-fuel-2026-09-20.pdf';
const smtpHost = (process.env.SMTP_HOST || '').trim();

async function main() {
  if (!existsSync(PDF)) {
    console.error(`PDF manquant : ${PDF}`);
    process.exit(1);
  }
  const pdfBuf = readFileSync(PDF);
  if (!to) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          mail: 'failed',
          reason: 'Aucun destinataire (REPORT_TO / MAIL_TO / ADMIN_EMAILS)',
          smtpConfigured: Boolean(smtpHost),
          pdf: PDF,
          bytes: pdfBuf.length,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  if (!smtpHost) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          mail: 'failed',
          reason: 'SMTP_HOST absent — sendMail irait en outbox seulement, on n’envoie pas le recap ops',
          toMasked: maskList(to),
          pdf: PDF,
          bytes: pdfBuf.length,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  const subject = '[Hubera] Music & Fuel — changements fluidité 20 sept. 2026';
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.45;color:#1a2330">
      <p>Bonjour,</p>
      <p>Récap <strong>changements à apporter</strong> (fluidité, économie, UI) — Music &amp; Fuel, 20 septembre 2026.</p>
      <ul>
        <li>Live actuel : Music <b>p+1.3.265</b>, Fuel <b>1.4.142</b> — git propre / déjà poussé</li>
        <li>Safe maintenant : cap 400 « Tout lire », listes virtualisées, 1 refresh login, Fuel maps 2 + timeline courte</li>
        <li>Reporté : virtualisation RAM 14k, LIMIT SQL getTrips, polling GPS / trip live</li>
      </ul>
      <p>PDF joint (≥ 8 pages A4). Pas de <code>down -v</code>, pas de changement d’applicationId.</p>
      <p style="color:#5a6878;font-size:12px">— Hubera</p>
    </div>
  `;
  const result = await sendMail({
    to,
    subject,
    html,
    text:
      'Hubera Music & Fuel — changements fluidité 20 sept. 2026. Live p+1.3.265 / 1.4.142. PDF joint. Safe vs reporté dans le document.',
    attachments: [
      {
        filename: 'recap-ameliorations-music-fuel-2026-09-20.pdf',
        content: pdfBuf,
        contentType: 'application/pdf',
      },
    ],
  });
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        mail: result.mode === 'smtp' ? 'sent' : result.mode,
        toMasked: maskList(to),
        mode: result.mode,
        messageId: (result as { messageId?: string }).messageId || null,
        pdf: PDF,
        bytes: pdfBuf.length,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
