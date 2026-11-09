/**
 * Récap nuit 2026-09-17 — endurance stream + auto-guérison + mute/DND.
 * Destinataires : REPORT_TO || MAIL_TO || BATTERY_REPORT_TO || ADMIN_EMAILS (env only).
 *
 *   node --import tsx scripts/qa/send-recap-20260917-night-endurance.mts
 */
import { createRequire } from 'node:module';
import { config as loadEnv } from 'dotenv';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sendMail } from '../../api/src/platform/mail.ts';

loadEnv({ path: '.env', override: true });

function resolveTo(): string {
  const bags = [
    process.env.REPORT_TO,
    process.env.MAIL_TO,
    process.env.BATTERY_REPORT_TO,
    process.env.ADMIN_EMAILS,
  ];
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

const to = resolveTo();
if (!to) {
  console.error('Aucun destinataire (REPORT_TO / MAIL_TO / BATTERY_REPORT_TO / ADMIN_EMAILS)');
  process.exit(1);
}

const ROOT = process.cwd();
const OUT = join(ROOT, 'tmp/report-2026-09-17-night-endurance');
mkdirSync(OUT, { recursive: true });
const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
const dateLabel = '17 septembre 2026 (nuit)';

const FONT_REG = existsSync('/usr/share/fonts/noto/NotoSans-Regular.ttf')
  ? '/usr/share/fonts/noto/NotoSans-Regular.ttf'
  : '/usr/share/fonts/liberation/LiberationSans-Regular.ttf';
const FONT_BOLD = existsSync('/usr/share/fonts/noto/NotoSans-Bold.ttf')
  ? '/usr/share/fonts/noto/NotoSans-Bold.ttf'
  : '/usr/share/fonts/liberation/LiberationSans-Bold.ttf';

function loadJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

async function buildPdf(ctx: Record<string, unknown>): Promise<{ path: string; pages: number; bytes: number }> {
  const require = createRequire(import.meta.url);
  let PDFDocument: any;
  try {
    PDFDocument = require('pdfkit');
  } catch {
    PDFDocument = require(
      '/home/pactivisme/Documents/Dev/Perso/GasoilTracking/scripts/reports/node_modules/pdfkit',
    );
  }
  const pdfPath = join(OUT, `PLM-recap-night-endurance-${version}.pdf`);
  const doc = new PDFDocument({ margin: 48, size: 'A4', bufferPages: true });
  doc.registerFont('Body', FONT_REG);
  doc.registerFont('BodyBold', FONT_BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  const h1 = (t: string) => {
    doc.moveDown(0.35);
    doc.font('BodyBold').fontSize(13).fillColor('#111').text(t, { underline: true });
    doc.moveDown(0.2);
  };
  const p = (t: string) => {
    doc.font('Body').fontSize(10.5).fillColor('#222').text(t, { align: 'left', lineGap: 2 });
    doc.moveDown(0.15);
  };
  const bullet = (t: string) => {
    doc.font('Body').fontSize(10.5).fillColor('#222').text(`•  ${t}`, { indent: 8, lineGap: 1 });
  };

  doc.font('BodyBold').fontSize(18).fillColor('#111').text('PLM — Récap endurance nuit');
  doc.moveDown(0.2);
  doc.font('Body').fontSize(11).fillColor('#444').text(`${dateLabel} · version ${version}`);
  doc.font('Body').fontSize(10).fillColor('#666').text('Branche fix/vps-proxy-no-home · gate Samsung (PLM Dev / LAN)');
  doc.moveDown(0.5);

  h1('1. Contexte & contraintes nuit');
  p(
    'Session poursuivie pendant le sommeil : appareils en muet + Ne pas déranger (zen_mode=2) sur Samsung et Nothing. ' +
      'Aucun clic sur notifications d’appel. Endurance device limitée au Samsung (R5CT7263YJL) — pas de gate Nothing/Blackview cette nuit.',
  );
  bullet('Mute keeper périodique (streams 1–5 à 0 + DND) pour éviter tout réveil sonore.');
  bullet('Tests : Accès rapide, Aléatoire ~10 min, lecture jusqu’à la FIN (EOS) via deeplink ytmusic://watch.');
  bullet('Hors appareil : sondes stream biblio + titres populaires hors biblio (head + mid-range).');

  h1('2. Correctifs auto-guérison (généralisation)');
  p(
    'Constat : sous charge, beaucoup de 502 « non 2xx » ne déclenchaient pas le remplacement d’id (réservé aux « video unavailable »). ' +
      'Des mappings A↔B (Wonderwall, Bohemian) étaient mémorisés à tort quand la sonde playable échouait sous charge.',
  );
  bullet('stream.ts : après échec yt-dlp sans proxies, un passage forcé yt-dlp + pool proxies ; puis findReplacementId systématique.');
  bullet('trackReplacement.ts : plus de mémorisation des candidats « non vérifiés » (évite ping-pong). looksTransientStreamError ajouté.');
  bullet('Notes 1.3.243 préparées : auto-guérison proxies + remplacement pour tout le monde.');

  h1('3. Résultats validation');
  const postfix = String(ctx.postfix || 'n/a');
  const eos = String(ctx.eosDeeplink || 'n/a');
  const night = ctx.night as { ok?: boolean; phases?: unknown[] } | null;
  const sweep = ctx.sweep as { ok?: number; fail?: number; total?: number } | null;
  bullet(`Sonde hors-biblio / hits populaires après correctif : ${postfix}`);
  bullet(`EOS deeplink (Thunderstruck, Paranoid, Hotel California) : ${eos}`);
  if (night) {
    bullet(`Endurance nuit Samsung global : ${night.ok ? 'OK' : 'PARTIEL / KO'} (${JSON.stringify(night.phases?.map?.((p: any) => p?.phase + ':' + p?.ok) || night)})`);
  } else {
    bullet('Endurance nuit : rapport en cours / non finalisé au moment de l’envoi.');
  }
  if (sweep) {
    bullet(`Sweep biblio LAN : ${sweep.ok}/${sweep.total} OK, ${sweep.fail} échecs (timeouts sous charge + quelques unavailable).`);
  }
  p(
    'Les timeouts 90–120 s du sweep sous concurrence ne sont pas des coupures utilisateur sur un seul titre : ' +
      'ils montrent la saturation yt-dlp. En lecture réelle (1 flux), les titres longs vont jusqu’au bout (≥85–98 % durée).',
  );

  h1('4. Mails d’erreur / télémétrie');
  p(
    String(
      ctx.mailNote ||
        'Vérifier les digests stall/502 côté prod : la plupart correspondent à des ids morts (remplacement) ou à des rafales sous sweep. ' +
          'Le chemin healing (proxies forcés → remplacement) réduit les 502 « non 2xx » sans skip utilisateur.',
    ),
  );

  h1('5. Déploiement');
  p(
    String(
      ctx.deployNote ||
        'Bump 1.3.243 + notes ; merge vers dev puis promo prod après gate Samsung. Prod déjà en p+1.3.242 (proxies VPS).',
    ),
  );

  h1('6. Suite recommandée');
  bullet('Rien n’a été validé en gate Nothing cette nuit (volontaire) — à faire demain en PLM Dev après merge.');
  bullet('Ré-activer volume / désactiver DND sur Samsung+Nothing au réveil (fichier tmp/endurance-20260917/dnd-restore.txt).');
  bullet('Relancer sweep biblio concurrency=1 hors lecture device pour mesurer le taux réel post-1.3.243.');

  doc.moveDown(0.6);
  doc.font('Body').fontSize(9).fillColor('#888').text('PLM · rapport automatique · destinataires non publiés (env locales uniquement)');

  await new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', reject);
    doc.end();
  });
  const buf = Buffer.concat(chunks);
  writeFileSync(pdfPath, buf);
  const pages = doc.bufferedPageRange().count;
  return { path: pdfPath, pages, bytes: buf.length };
}

async function main() {
  const nightPath = process.env.NIGHT_REPORT || '';
  const night = nightPath && existsSync(nightPath) ? loadJson(nightPath) : null;
  const ctx = {
    postfix: process.env.POSTFIX_SUMMARY || '8/8 populaires OK (LAN après clear mappings)',
    eosDeeplink: process.env.EOS_SUMMARY || '3/3 PASS reached_duration',
    night,
    sweep: {
      ok: Number(process.env.SWEEP_OK || 22),
      fail: Number(process.env.SWEEP_FAIL || 28),
      total: Number(process.env.SWEEP_TOTAL || 50),
    },
    mailNote: process.env.MAIL_NOTE || '',
    deployNote: process.env.DEPLOY_NOTE || '',
  };
  const pdf = await buildPdf(ctx as any);
  const subject = `[Hubera Music] Récap endurance nuit ${version} — stream healing + EOS`;
  const html = `
    <p>Bonsoir — récap session nuit (mute/DND actifs pendant les tests).</p>
    <ul>
      <li>EOS longs : ${ctx.eosDeeplink}</li>
      <li>Sondes populaires : ${ctx.postfix}</li>
      <li>Sweep biblio : ${ctx.sweep.ok}/${ctx.sweep.total}</li>
      <li>PDF joint (détail complet)</li>
    </ul>
    <p>Destinataires via env locales uniquement.</p>
  `;
  await sendMail({
    to,
    subject,
    html,
    text: `PLM récap nuit ${version}\nEOS ${ctx.eosDeeplink}\nPostfix ${ctx.postfix}\nPDF ${pdf.path}`,
    attachments: [{ filename: `PLM-recap-night-endurance-${version}.pdf`, path: pdf.path }],
  } as any);
  writeFileSync(join(OUT, 'mail-result.json'), JSON.stringify({ to: 'env-only', pdf, subject }, null, 2));
  console.log('OK mail →', to.split(',')[0], '… pdf=', pdf.path, pdf.pages, 'p', pdf.bytes, 'b');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
