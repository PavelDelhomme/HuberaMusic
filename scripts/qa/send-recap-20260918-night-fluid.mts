/**
 * Récap nuit 2026-09-18→19 — fluidité stream 1.3.258 + endurance Samsung.
 * Destinataires : REPORT_TO || MAIL_TO || BATTERY_REPORT_TO || ADMIN_EMAILS (env only).
 *
 *   node --import tsx scripts/qa/send-recap-20260918-night-fluid.mts
 */
import { createRequire } from 'node:module';
import { config as loadEnv } from 'dotenv';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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
const OUT = join(ROOT, 'tmp/report-2026-09-18-night-fluid');
mkdirSync(OUT, { recursive: true });
const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
const dateLabel = '18–19 septembre 2026 (nuit → 02h)';

const FONT_REG = existsSync('/usr/share/fonts/noto/NotoSans-Regular.ttf')
  ? '/usr/share/fonts/noto/NotoSans-Regular.ttf'
  : '/usr/share/fonts/liberation/LiberationSans-Regular.ttf';
const FONT_BOLD = existsSync('/usr/share/fonts/noto/NotoSans-Bold.ttf')
  ? '/usr/share/fonts/noto/NotoSans-Bold.ttf'
  : '/usr/share/fonts/liberation/LiberationSans-Bold.ttf';

function loadJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function latestEndurance(): any {
  const tmp = join(ROOT, 'tmp');
  const dirs = readdirSync(tmp)
    .filter((d) => d.startsWith('endurance-night-20260918') || d.startsWith('endurance-night-20260919'))
    .map((d) => join(tmp, d))
    .filter((d) => existsSync(join(d, 'SUMMARY.json')));
  dirs.sort();
  const last = dirs.at(-1);
  return last ? { dir: last, ...(loadJson(join(last, 'SUMMARY.json')) || {}) } : null;
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
  const pdfPath = join(OUT, `PLM-recap-night-fluid-${version}.pdf`);
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

  doc.font('BodyBold').fontSize(18).fillColor('#111').text('PLM — Récap nuit fluidité stream');
  doc.moveDown(0.2);
  doc.font('Body').fontSize(11).fillColor('#444').text(`${dateLabel} · version ${version}`);
  doc.font('Body').fontSize(10).fillColor('#666').text(
    'Branche fix/stream-live-warm-247 → prod · gate Samsung (pas Nothing)',
  );
  doc.moveDown(0.5);

  h1('1. Contexte nuit & contraintes sonores');
  p(
    'Tu dors ; tests jusqu’à 02h00 sur Samsung uniquement (Nothing non sollicité). ' +
      'Volume musique = 0 ; mode Ne pas déranger = ALARMS ONLY (zen_mode=3) pour que les alarmes sonnent absolument. ' +
      'Mute-keeper périodique + restauration prévue au réveil (scripts/qa/restore-dnd-after-qa.sh).',
  );
  bullet('Appareil : Samsung R5CT7263YJL · APK cible p+1.3.258 (OTA)');
  bullet('Pas de test Nothing cette nuit (réveil 3h).');

  h1('2. Depuis le dernier PDF (17/09 endurance + VPS proxy)');
  p(
    'Les PDF du 17/09 (night-endurance 1.3.243, vps-proxy 1.3.241) avaient posé : proxies gratuits, auto-guérison, mute/DND. ' +
      'Cette session attaque le vrai pain point utilisateur : « Chargement… » 40–50 s / skips auto sur plein de titres (mails ERROR, multi-skip 6/9).',
  );
  bullet('Cause A — soft-fail maison : après 2–3 timeouts, le VPS skippait la maison 15–25 s alors que le .m4a était déjà sur disque (50 ms).');
  bullet('Cause B — commentaire « servir disque » sans code : le fichier existait mais on attendait warm/ensure → abort relais.');
  bullet('Cause C — DASH googlevideo rejeté → yt-dlp pipe 12 s timeout sous charge.');
  bullet('Cause D — remplacement Brisa ↔ Brisa Salada (ping-pong mapping inverse).');

  h1('3. Correctifs livrés en 1.3.258');
  bullet('stream.ts : early disk serve (X-PLM-Stream-Cache=disk-early) dès que .m4a complet.');
  bullet('stream.ts : soft-fail → first-byte maison court (2 s), plus de markHomeDead qui coupait le cache.');
  bullet('stream.ts : anti-DASH Android = URL yt-dlp (-g) + fetch avant pipe (budgets hors deadline globale).');
  bullet('trackReplacement.ts : refuse boucle A↔B ; MIN_SCORE 70 ; accepte score sans playable() sous charge.');
  bullet('Player 256 déjà : cold grace ~42 s, quietPrefetch 12 s, AHEAD_WIFI=6.');
  bullet('Prod : ALLOW_STREAM_UPSTREAM=0 par défaut ; YOUTUBE_HTTP_PROXY_FREE ON en production ; cache VPS préchauffé (sync .m4a).');

  h1('4. Architecture lecture (autonome + filet)');
  p(
    'Objectif : ne plus dépendre du PC allumé. Chemin nominal = cache disque VPS (early) → Innertube/OAuth → proxies HTTP gratuits → yt-dlp progressif. ' +
      'Relais maison = filet optionnel (link-home-stream) si titres froids hors cache — réactivé cette nuit pour l’aléatoire biblio, désactivable.',
  );
  bullet('Sondes sans maison après sync cache : Brisa/Réplika/known en disk-early 0.8–4 s.');
  bullet('Limite restante : titre jamais vu + VPS bot-check → besoin cookies frais / proxy / ou 1ère écoute plus lente.');

  const endu = ctx.endurance as any;
  h1('5. Endurance Samsung (aléatoire biblio + cold fail-mail)');
  if (endu) {
    bullet(`Dossier : ${String(endu.dir || '').split('/').pop()}`);
    bullet(`OK=${endu.ok ?? '?'} · FAIL=${endu.fail ?? '?'} · SLOW(>20s)=${endu.slow ?? '?'} · pass=${endu.pass}`);
    bullet(`Fenêtre : ${endu.started || '?'} → ${endu.ended || '(en cours / coupé 02h)'}`);
    const ev = Array.isArray(endu.events) ? endu.events : [];
    const fails = ev.filter((e: any) => !e.ok).slice(0, 12);
    if (fails.length) {
      p('Échecs notables (échantillon) :');
      for (const f of fails) {
        bullet(`${f.vid} [${f.kind}] load=${f.load_s}s ${f.state} « ${(f.title || '').slice(0, 40)} »`);
      }
    }
  } else {
    bullet('Résumé endurance non trouvé au moment de la génération — voir tmp/endurance-night-*.');
  }

  h1('6. Multi-skip fail-mail (après-midi → soir)');
  bullet('Avant correctifs : 6/9 puis 9/13 — cold BUFFERING 40–45 s, Brisa KO.');
  bullet('Après : Brisa OK ~7–10 s ; multi-skip failmail3 = 9/12 ; hdmL OK 1.1 s.');
  bullet('Encore fragile : certains known longs / skip Exo (métadonnées file d’attente) — stream API souvent OK.');

  h1('7. Ce qui marche / pas encore');
  p('Marche :');
  bullet('Titres déjà en cache VPS/maison : démarrage <2–5 s typique (disk-early).');
  bullet('Remplacement sans ping-pong ; anti-DASH URL path.');
  bullet('OTA 1.3.258 + notes utilisateur.');
  p('Pas encore parfait :');
  bullet('Titre 100 % froid (jamais cache) sur IP datacenter : risque 20–40 s ou 502 si proxies saturés / bot.');
  bullet('Prefetch agressif peut encore saturer yt-dlp — d’où quietPrefetch.');
  bullet('Mails ERROR : throttle 4 min déjà ; viser encore moins via moins de stalls.');

  h1('8. Déploiement effectué');
  bullet(`Commit push prod : version ${version} (stream + trackReplacement + player + notes).`);
  bullet('Hot-patch VPS appliqué (disk-early) même avant rebuild GHCR complet.');
  bullet(`APK OTA : ${String(ctx.apk || 'voir data/public/android/manifest.json')}`);
  bullet('Home tunnel : filet nuit (stoppable) ; ALLOW_STREAM_UPSTREAM=0 sans fichier = autonome.');

  h1('9. Au réveil (3h)');
  bullet('bash scripts/qa/restore-dnd-after-qa.sh  (remet zen + volume musique raisonnable)');
  bullet('OTA Samsung / Nothing → p+1.3.258 si pas déjà fait.');
  bullet('Si un titre charge longtemps : noter l’id + mail ERROR ; le cache warm le résout souvent au 2e essai.');
  bullet('PC allumé optionnel : pour autonomie totale, laisser tourner le warm disque / proxies.');

  h1('10. Prochaines améliorations prioritaires');
  bullet('Warm bibliothèque périodique sur VPS via proxies+cookies (précharger les « jamais écoutés »).');
  bullet('Cap concurrence yt-dlp + file prioritaire titre courant.');
  bullet('Mesure TTFB p50/p95 exposée admin (détecter régression avant mails).');

  doc.moveDown(0.8);
  doc.font('Body').fontSize(9).fillColor('#666').text(
    `Généré automatiquement — session agent Cursor · ${new Date().toISOString()}`,
  );

  const pages = doc.bufferedPageRange().count;
  for (let i = 0; i < pages; i++) {
    doc.switchToPage(i);
    doc.font('Body').fontSize(8).fillColor('#999').text(
      `PLM ${version} — ${i + 1}/${pages}`,
      48,
      doc.page.height - 36,
      { align: 'left' },
    );
  }
  doc.end();
  await new Promise<void>((res) => doc.on('end', () => res()));
  const buf = Buffer.concat(chunks);
  writeFileSync(pdfPath, buf);
  return { path: pdfPath, pages, bytes: buf.length };
}

async function main() {
  const endurance = latestEndurance();
  let apk = 'n/a';
  try {
    const m = loadJson(join(ROOT, 'data/public/android/manifest.json'));
    if (m) apk = `${m.versionName} code=${m.versionCode} env=${m.appEnv}`;
  } catch {
    /* ignore */
  }
  const pdf = await buildPdf({ endurance, apk });
  const subject = `[PLM] Récap nuit fluidité ${version} — Samsung → 02h`;
  const html = `
    <p>Bonjour — récap session nuit (musique muette, <b>alarmes autorisées</b> zen=3).</p>
    <ul>
      <li>Version <b>${version}</b> : disk-early + anti-DASH + anti-ping-pong + proxies autonomes</li>
      <li>Endurance Samsung jusqu’à 02h (pas Nothing)</li>
      <li>PDF joint — détail causes / fixes / limites</li>
    </ul>
    <p>Au réveil : <code>bash scripts/qa/restore-dnd-after-qa.sh</code></p>
  `;
  const result = await sendMail({
    to,
    subject,
    html,
    text: `PLM récap nuit ${version} — PDF joint`,
    attachments: [
      {
        filename: `PLM-recap-night-fluid-${version}.pdf`,
        content: readFileSync(pdf.path),
        contentType: 'application/pdf',
      },
    ],
  });
  writeFileSync(
    join(OUT, 'mail-result.json'),
    JSON.stringify({ to, subject, pdf, result, endurance }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, to, pdf, enduranceDir: endurance?.dir }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
