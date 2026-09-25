/**
 * Récap session 2026-09-15 — correctif lecture (yt-dlp player_client / formats).
 * Destinataires : REPORT_TO || MAIL_TO || BATTERY_REPORT_TO || ADMIN_EMAILS (env only).
 *
 *   node --import tsx scripts/qa/send-recap-20260915-stream-fix.mts
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
const OUT = join(ROOT, 'tmp/report-2026-09-15-stream-fix');
mkdirSync(OUT, { recursive: true });
const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
const branch = 'fix/ytdlp-format-player-client';
const dateLabel = '15 septembre 2026';

const FONT_REG = existsSync('/usr/share/fonts/noto/NotoSans-Regular.ttf')
  ? '/usr/share/fonts/noto/NotoSans-Regular.ttf'
  : '/usr/share/fonts/liberation/LiberationSans-Regular.ttf';
const FONT_BOLD = existsSync('/usr/share/fonts/noto/NotoSans-Bold.ttf')
  ? '/usr/share/fonts/noto/NotoSans-Bold.ttf'
  : '/usr/share/fonts/liberation/LiberationSans-Bold.ttf';

const verifiedIds = [
  '4D7u5KF7SP8',
  'sYJs5fWm2yE',
  'WpvS4K7t2Uk',
  '09-MB0uiI2U',
  'oL_puB4w9NM',
  'dQw4w9WgXcQ',
  'kJQP7kiw5Fk',
  'oMfMUfgjiLg',
  'eRHZB2gdFkA',
];

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
  const pdfPath = join(OUT, `PLM-recap-stream-fix-${version}.pdf`);
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
    'Les erreurs de lancement de musique (« Requested format is not available », prefetch yt-dlp 0, mid-range / budget disque) sont corrigées en local. Les titres qui plantaient répondent en HTTP 206. PLM Dev est installé sur Samsung branché sur l’API LAN.',
  );

  h1('Cause racine');
  bullet(
    'yt-dlp forçait player_client=android_vr,tv,ios,web_embedded,web — depuis yt-dlp 2026.08, android_vr exige un GVS PO Token ; sans token les itags 140/251 disparaissent.',
  );
  bullet(
    'Résultat : « Requested format is not available » en boucle sur prefetch / downloadTrack.',
  );
  bullet(
    'Effet collatéral : Innertube pouvait laisser un .m4a vide (write-stream non fermé) → messages « yt-dlp 0 » et cache inutilisable.',
  );

  h1('Correctifs (API)');
  bullet('youtubeCookies.ts — ytDlpExtractorArgSets() : défaut yt-dlp d’abord, puis web_embedded/web, puis legacy android_vr.');
  bullet('YTDLP_AUDIO_FORMAT_CANDIDATES — ajout du fallback 18/bestaudio/best ; extraction audio (-x) si format 18 pour éviter des caches vidéo ~80 Mo.');
  bullet('stream.ts + yt.ts — boucles proxy × extractor × cookies × formats ; plus de player_client figé.');
  bullet('downloadTrackViaInnertube — destroy + unlink du fichier en cas d’erreur ; purge .m4a incomplets avant yt-dlp ; clients Innertube réordonnés (TV / WEB d’abord).');

  h1('Vérifications');
  bullet('API locale :8787 redémarrée (checkout Cloudity products/YTMusic + sync des 3 fichiers).');
  bullet(`Stream Range bytes=0-65535 → HTTP 206 pour : ${verifiedIds.join(', ')}.`);
  bullet('Cache disque .m4a rempli (plusieurs Mo) après offline/prefetch sur titres froids.');
  bullet(`Samsung R5CT7263YJL : PLM Dev d+${version} installé, API_BASE_URL=http://192.168.1.134:8787.`);
  bullet('Pas de promo prod cette nuit — correctif à merger vers dev puis gates Nothing / preprod.');

  h1('Fichiers touchés');
  bullet('api/src/youtube/youtubeCookies.ts');
  bullet('api/src/media/stream.ts');
  bullet('api/src/youtube/yt.ts');

  h1('À faire demain');
  bullet('Relancer quelques titres sur PLM Dev (Samsung) → API LAN pour confirmer au feeling.');
  bullet(`Commit / PR ${branch} → merge dev → redeploy image :dev → gate Nothing.`);
  bullet('Ensuite seulement preprod / promo prod (le p+ actuel n’a pas encore ce fix serveur).');
  bullet('Optionnel : pousser cookies YouTube Netscape si botcheck VPS (scripts/deploy/push-youtube-cookies.sh).');

  doc.moveDown(0.8);
  doc
    .font('Body')
    .fontSize(9)
    .fillColor('#666')
    .text(
      `Généré automatiquement · ${new Date().toISOString()} · destinataires via variables d’environnement uniquement.`,
    );

  doc.end();
  await new Promise<void>((resolve) => doc.on('end', () => resolve()));
  const buf = Buffer.concat(chunks);
  const pageCount = doc.bufferedPageRange().count;
  writeFileSync(pdfPath, buf);
  return { path: pdfPath, pages: pageCount, bytes: buf.length };
}

const { path: pdfPath, pages, bytes } = await buildPdf();
const pdfBuf = readFileSync(pdfPath);

const subject = `[Hubera Music] Récap ${dateLabel} — lecture OK (yt-dlp formats) · ${version}`;

const text = `PLM — Récap session ${dateLabel}
Version: ${version}
Branche: ${branch}

Verdict
Les erreurs de lancement (« format not available », yt-dlp 0, mid-range) sont corrigées en local.
Streams vérifiés en HTTP 206. PLM Dev Samsung → API LAN http://192.168.1.134:8787.

Cause
player_client=android_vr… sans PO Token → plus d’itags 140/251.
+ write-stream Innertube laissant des .m4a vides.

Correctifs
- ytDlpExtractorArgSets (défaut yt-dlp d’abord)
- fallback format 18 + extract audio
- cleanup Innertube / purge cache incomplet
- boucles extractor dans stream.ts et yt.ts

Demain
1) Smoke PLM Dev Samsung
2) PR ${branch} → merge dev → :dev → Nothing
3) Pas de promo prod tant que non validé

PDF joint: ${pdfPath}
`;

const html = `<div style="font-family:system-ui,sans-serif;line-height:1.5;max-width:720px;color:#111">
  <h1 style="font-size:1.3rem;margin:0 0 6px">PLM — Récap session</h1>
  <p style="color:#555;margin:0 0 18px">${dateLabel} · <code>${version}</code> · <code>${branch}</code></p>

  <h2 style="font-size:1.05rem">Verdict</h2>
  <p>Les erreurs de lancement de musique sont <b>corrigées en local</b>.
  Titres précédemment KO → <b>HTTP 206</b>. Samsung en <b>PLM Dev</b> branché sur l’API LAN.</p>

  <h2 style="font-size:1.05rem">Cause</h2>
  <ul>
    <li><code>player_client=android_vr…</code> sans PO Token → itags 140/251 absents (« Requested format is not available »).</li>
    <li>Innertube laissait parfois un <code>.m4a</code> vide → messages « yt-dlp 0 ».</li>
  </ul>

  <h2 style="font-size:1.05rem">Correctifs</h2>
  <ul>
    <li><code>ytDlpExtractorArgSets()</code> — défaut yt-dlp d’abord, puis fallbacks</li>
    <li>Format <code>18</code> en secours + <code>-x --audio-format m4a</code></li>
    <li>Cleanup Innertube + purge cache incomplet avant yt-dlp</li>
    <li>Fichiers : <code>youtubeCookies.ts</code>, <code>stream.ts</code>, <code>yt.ts</code></li>
  </ul>

  <h2 style="font-size:1.05rem">Demain</h2>
  <ol>
    <li>Smoke lecture sur PLM Dev (Samsung / LAN)</li>
    <li>PR → merge <code>dev</code> → redeploy <code>:dev</code> → gate Nothing</li>
    <li>Preprod / prod seulement après validation (le p+ actuel n’a pas encore le fix serveur)</li>
  </ol>

  <p style="color:#666;font-size:13px">PDF joint · bonne nuit.</p>
</div>`;

const r = await sendMail({
  to,
  subject,
  text,
  html,
  attachments: [
    {
      filename: `PLM-recap-stream-fix-${version}.pdf`,
      content: pdfBuf,
      contentType: 'application/pdf',
    },
  ],
});

const result = {
  toDomains: to.split(/[,;]/).map((s) => s.trim().split('@')[1] || '?'),
  toCount: to.split(/[,;]/).filter(Boolean).length,
  subject,
  pages,
  bytes,
  pdfPath,
  r,
};
writeFileSync(join(OUT, 'mail-result.json'), JSON.stringify(result, null, 2));
console.log('pdf →', pdfPath, `(${pages} p, ${bytes} o)`);
console.log('mail →', r);
console.log('destinataires:', result.toCount, 'domaine(s):', result.toDomains.join(', '));
