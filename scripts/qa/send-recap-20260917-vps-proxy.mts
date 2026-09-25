/**
 * Récap 2026-09-17 — VPS autonome (proxies) + anti-stall suite.
 * Destinataires : REPORT_TO || MAIL_TO || BATTERY_REPORT_TO || ADMIN_EMAILS (env only).
 *
 *   node --import tsx scripts/qa/send-recap-20260917-vps-proxy.mts
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
const OUT = join(ROOT, 'tmp/report-2026-09-17-vps-proxy');
mkdirSync(OUT, { recursive: true });
const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
const branch = 'fix/vps-proxy-no-home';
const dateLabel = '17 septembre 2026';

const FONT_REG = existsSync('/usr/share/fonts/noto/NotoSans-Regular.ttf')
  ? '/usr/share/fonts/noto/NotoSans-Regular.ttf'
  : '/usr/share/fonts/liberation/LiberationSans-Regular.ttf';
const FONT_BOLD = existsSync('/usr/share/fonts/noto/NotoSans-Bold.ttf')
  ? '/usr/share/fonts/noto/NotoSans-Bold.ttf'
  : '/usr/share/fonts/liberation/LiberationSans-Bold.ttf';

async function buildPdf(): Promise<{ path: string; pages: number; bytes: number }> {
  const require = createRequire(import.meta.url);
  let PDFDocument: any;
  try {
    PDFDocument = require('pdfkit');
  } catch {
    PDFDocument = require(
      '/home/pactivisme/Documents/Dev/Perso/GasoilTracking/scripts/reports/node_modules/pdfkit',
    );
  }
  const pdfPath = join(OUT, `PLM-recap-vps-proxy-${version}.pdf`);
  const doc = new PDFDocument({ margin: 48, size: 'A4', bufferPages: true });
  doc.registerFont('Body', FONT_REG);
  doc.registerFont('BodyBold', FONT_BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  const h1 = (t: string) => {
    doc.moveDown(0.4);
    doc.font('BodyBold').fontSize(13).fillColor('#111').text(t, { underline: true });
    doc.moveDown(0.25);
  };
  const p = (t: string) => {
    doc.font('Body').fontSize(10.5).fillColor('#222').text(t, { align: 'left', lineGap: 2 });
    doc.moveDown(0.2);
  };
  const bullet = (t: string) => {
    doc.font('Body').fontSize(10.5).fillColor('#222').text(`•  ${t}`, { indent: 8, lineGap: 1 });
  };

  doc.font('BodyBold').fontSize(18).fillColor('#111').text('PLM — Récap session');
  doc.moveDown(0.2);
  doc
    .font('Body')
    .fontSize(11)
    .fillColor('#444')
    .text(`${dateLabel} · version ${version} · branche ${branch}`);
  doc.moveDown(0.6);

  h1('Verdict');
  p(
    'Le VPS ne dépend plus du PC maison pour tenter de streamer : si le tunnel est éteint, skip immédiat + rotation de proxies HTTP/SOCKS gratuits (yt-dlp --proxy + --no-check-certificates). Anti-DASH renforcé. Smoke local 1.3.241 : 4/4 titres en HTTP 206 brand=isom. Samsung (R5CT7263YJL) absent ADB — aucune install Dev laissée (tentative Makefile tombée sur Blackview puis désinstallée). Nothing / prod : à valider de ton côté sur 1.3.240 avant la prochaine promo.',
  );

  h1('Contexte (déjà en prod 1.3.240)');
  bullet('Rejet DASH (ftypdash) + clients yt-dlp sûrs → stalls « Histoire sans fin » / auth-or-blocked.');
  bullet('Avec maison OFF, prod 1.3.240 restait souvent en 502 ~50–60 s (IP datacenter / pas assez de proxies).');

  h1('Nouveaux correctifs (1.3.241)');
  bullet('Proxies gratuits élargis (sources GitHub + Proxyscrape) ; pool jusqu’à 180 ; warm au démarrage API.');
  bullet('Maison offline / VPS : preferProxies → proxies avant IP directe ; YOUTUBE_HTTP_PROXY_FREE ON aussi en APP_ENV=dev|preprod.');
  bullet('ytDlpProxyCliArgs : --proxy + --no-check-certificates (MITM fréquent des free proxies).');
  bullet('Timeouts relais maison plafonnés (~8–20 s) ; skipHome Android open-ended réactivé (first-byte 3,5 s).');
  bullet('Warm /api/stream/:id/url : sonde health, plus d’attente 30 s sur PC éteint.');
  bullet('Rejet DASH aussi sur relais maison + Innertube dernier recours.');
  bullet('Partiels disque morts purgés (plus servis à Exo) ; Content-Range GV stabilisé.');
  bullet('Télémétrie : 403 mid-range Exo → family stream-midrange-403 (plus auth-or-blocked à tort).');

  h1('Tests');
  bullet('Local API d+1.3.241 : wjYMjZxl27g / dQw4w9WgXcQ / Nnax5cjaPxA / 4D7u5KF7SP8 → 206 isom.');
  bullet('ADB : Samsung (R5CT7263YJL) absent ; Blackview/Nothing présents — install Dev Samsung reportée (Blackview désinstallé après fallback Makefile).');
  bullet('Prod Nothing : à ne pas pousser tant que tu n’as pas validé 1.3.240 (demande explicite).');

  h1('Suite');
  bullet('Brancher Samsung → make android-install (FLAVOR=dev, API LAN) pour gate.');
  bullet('Après OK Samsung : merge → :dev VPS, puis Nothing en PLM Dev.');
  bullet('Promo prod seulement après ton feu vert sur la 1.3.240 actuelle.');

  doc.moveDown(0.8);
  doc.font('Body').fontSize(9).fillColor('#666').text(`Généré automatiquement · PLM ${version} · ${branch}`);

  const done = new Promise<Buffer>((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
  doc.end();
  const buf = await done;
  const pageCount = doc.bufferedPageRange().count;
  writeFileSync(pdfPath, buf);
  return { path: pdfPath, pages: pageCount, bytes: buf.length };
}

const { path: pdfPath, pages, bytes } = await buildPdf();
const pdfBuf = readFileSync(pdfPath);

const subject = `[Hubera Music] Récap ${version} — VPS autonome (proxies) + anti-stall`;
const text = `PLM récap ${dateLabel}
Version : ${version} (branche ${branch})

Verdict
- VPS autonome si PC maison éteint : proxies gratuits + skip tunnel immédiat
- Anti-DASH / partiels / timeouts maison / mails 403 mid-range
- Smoke local 206 isom OK
- Samsung non ADB → pas d’install Dev (Blackview fallback annulé)
- Nothing / prod : tu valides d’abord la 1.3.240 déjà déployée

Nouveaux correctifs (1.3.241)
- Pool proxies élargi + warm démarrage + preferProxies
- yt-dlp --no-check-certificates sur proxies
- Timeouts maison courts ; warm /url sans 30 s morts
- Rejet DASH maison + Innertube ; purge partiels
- Content-Range GV stable ; télémétrie stream-midrange-403

PDF joint: ${pdfPath}
`;

const html = `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;line-height:1.45;color:#222">
<h2>PLM — Récap ${version}</h2>
<p><strong>${dateLabel}</strong> · branche <code>${branch}</code></p>
<p><strong>Verdict :</strong> le VPS peut streamer sans PC maison (proxies gratuits + skip tunnel). Anti-stall renforcé. Smoke local OK (206 / isom). Samsung pas branché — pas d’install Dev (fallback Blackview annulé). Prod Nothing : à valider de ton côté sur <strong>1.3.240</strong> avant la prochaine promo.</p>
<h3>Nouveaux correctifs</h3>
<ul>
<li>Proxies gratuits élargis, warm pool, preferProxies si maison offline</li>
<li>yt-dlp <code>--proxy</code> + <code>--no-check-certificates</code></li>
<li>Timeouts maison plafonnés ; warm <code>/url</code> sans 30&nbsp;s morts</li>
<li>Rejet DASH maison + Innertube ; purge partiels disque</li>
<li>Content-Range GV stable ; mails 403 mid-range ≠ auth</li>
</ul>
<p>PDF joint (${pages} p, ${bytes} o).</p>
</body></html>`;

const result = await sendMail({
  to,
  subject,
  text,
  html,
  attachments: [
    {
      filename: `PLM-recap-vps-proxy-${version}.pdf`,
      content: pdfBuf,
      contentType: 'application/pdf',
    },
  ],
});

writeFileSync(join(OUT, 'mail-result.json'), JSON.stringify({ to: '[redacted]', subject, result, pdfPath, pages, bytes }, null, 2));
console.log('mail →', result);
console.log('pdf →', pdfPath, `(${pages} p, ${bytes} o)`);
