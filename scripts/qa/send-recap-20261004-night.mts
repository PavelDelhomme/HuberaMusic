/**
 * Récap 4 oct. 2026 — compte perso, ADB Wi‑Fi Samsung, stream 5xx, endurance EOS.
 *
 *   MAIL_TO=pauldelhomme.pro@gmail.com node --import tsx scripts/qa/send-recap-20261004-night.mts
 */
import { createRequire } from 'node:module';
import { config as loadEnv } from 'dotenv';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sendMail } from '../../api/src/platform/mail.ts';

loadEnv({ path: '.env', override: true });

function resolveTo(): string {
  const bags = [
    process.env.MAIL_TO,
    process.env.REPORT_TO,
    process.env.BATTERY_REPORT_TO,
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
  console.error('Aucun destinataire (MAIL_TO / REPORT_TO / BATTERY_REPORT_TO)');
  process.exit(1);
}

const ROOT = process.cwd();
const OUT = join(ROOT, 'tmp/report-2026-10-04-night');
mkdirSync(OUT, { recursive: true });
const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
const dateLabel = '4 octobre 2026 (soir → 08h00)';

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
  if (!existsSync(tmp)) return null;
  const dirs = readdirSync(tmp)
    .filter((d) => d.startsWith('endurance-night-'))
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
  const pdfPath = join(OUT, `Hubera-Music-recap-nuit-${version}.pdf`);
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

  doc.font('BodyBold').fontSize(18).fillColor('#111').text('Hubera Music — Rapport nuit complet');
  doc.moveDown(0.2);
  doc.font('Body').fontSize(11).fillColor('#444').text(`${dateLabel} · version ${version}`);
  doc.font('Body').fontSize(10).fillColor('#666').text(
    'Samsung de test uniquement · volume 0 · alarmes conservées · Nothing non touché · injection paul@ limitée aux téléphones QA',
  );
  doc.moveDown(0.5);

  h1('1. Compte perso vs compte admin (cause principale)');
  p(
    'paul@delhomme.ovh et dev@delhomme.ovh ne sont PAS le même compte Hubera Music. ' +
      'Login paul@ → user c033a13e…, bibliothèque 14 648 titres. Login dev@delhomme.ovh → user 11cfa797…, bibliothèque 0 titre. ' +
      'Le .env SEED_EMAIL=dev@ écrasait l’override SEED_EMAIL=paul@ dans adb-login.sh : les apps de test se reconnectaient sur le compte vide. Corrigé.',
  );
  bullet('Les 4 installs de TEST sont sur paul@ : Blackview Hubera + legacy, Samsung Hubera + legacy, APK p+1.3.341 debug.');
  bullet('Injection session (extras debug) UNIQUEMENT Samsung R5CT7263YJL et Blackview EEA9700PRO0014587.');
  bullet('Nothing et tout appareil inconnu : REFUS (exit 3). Aucune injection sur les apps d’autres personnes.');

  h1('2. ADB Wi‑Fi Samsung — réparation facile');
  p(
    'L’IP 192.168.1.177 est morte. L’IP actuelle est 192.168.1.184:5555. USB encore branché en parallèle (R5CT7263YJL).',
  );
  bullet('Câble 2 s, débogage USB ON, puis : cd products/music && make samsung-wifi');
  bullet('Script : scripts/adb/samsung-wifi-repair.sh (tcpip 5555, écrit logs/adb-wifi/).');
  bullet('Nothing n’est pas déconnecté. Pas de adb kill-server.');

  h1('3. Mails d’erreur dev@delhomme.ovh / BlueMail');
  p(
    'L’outbox prod a bien délivré (delivered=1) les mails [Hubera Music prod] ERROR · stream-5xx vers dev@delhomme.ovh. ' +
      'Titres : Innocent Man (3QfEdzi5wkU), Ride (lV4xtfbEaNQ), Flowers (BkSSOGNeWTM), IMMORTEL (XkibsbU2N1s), Creature, etc. ' +
      'Télémetrie : onPlayerError code=2004 http=504, prefetch_miss, stall 14–56 s. ' +
      'BlueMail Samsung (compte Principal, Réception 64) affichait surtout des CI GitHub (taskflow / Fuel / Jobs) — les mails Music sont dans l’outbox, pas en tête d’inbox. ' +
      'IMAP ssl0.ovh.net / imap.mail.ovh.net refuse le mot de passe de l’app Music (boîte mail ≠ mot de passe Hubera).',
  );

  h1('4. Pourquoi des titres ne partent pas / ne vont pas au bout');
  p(
    'Les 504 ne sont pas « le proxy cassé » à 100 %. C’est le first-byte trop lent (STREAM_UPSTREAM maison souvent offline — normal — puis VPS / yt-dlp / googlevideo). ' +
      'Un GET Range de 12 s timeout sur Innocent Man, Ride, Flowers, IMMORTEL depuis le PC. Le cache disque early n’était pas là pour ces ids. ' +
      'Côté app 1.3.341 : skip après 2–3 5xx (plus 8), prefetch ahead 40, charging ne cap plus à 3, file nextDisk 50. ' +
      'Les coupures en cours de titre = stall pos figée / BUFFERING >20 s / early_cut avant 85 % de la durée.',
  );
  bullet('Correctif test : skip si BUFFERING >20 s ; si PLAYING → laisser aller jusqu’à EOS (≥85 % ou fin naturelle).');
  bullet('Warm POST /api/stream/warm des 40 têtes biblio au démarrage du marathon (réponse immédiate, workers en fond).');
  bullet('Santé API : ok=true, appVersion=p+1.3.341, ytdlp=true.');

  const endu = ctx.endurance as any;
  h1('5. Endurance Samsung (muet) — résultats au moment du PDF');
  if (endu) {
    bullet(`Dossier : ${String(endu.dir || '').split('/').pop()}`);
    bullet(
      `Démarrage lecture : OK=${endu.ok ?? '?'} · FAIL=${endu.fail ?? '?'} · SLOW(>20s)=${endu.slow ?? '?'}`,
    );
    bullet(
      `Lecture jusqu’au bout : EOS_OK=${endu.eos_ok ?? '(session courte avant EOS)'} · EOS_FAIL=${endu.eos_fail ?? '—'}`,
    );
    bullet(`Fenêtre : ${endu.started || '?'} → ${endu.ended || 'en cours jusqu’à 08h00'}`);
    const ev = Array.isArray(endu.events) ? endu.events : [];
    const fails = ev.filter((e: any) => !e.ok).slice(0, 10);
    const oks = ev.filter((e: any) => e.ok).slice(0, 8);
    if (oks.length) {
      p('Titres partis (échantillon) :');
      for (const f of oks) {
        bullet(
          `${f.vid} load=${f.load_s}s « ${(f.title || '').slice(0, 42)} » eos=${f.eos ?? 'n/a'} ${f.eos_reason || ''}`,
        );
      }
    }
    if (fails.length) {
      p('Titres non partis / BUFFERING 20 s (échantillon) :');
      for (const f of fails) {
        bullet(`${f.vid} load=${f.load_s}s ${f.state} « ${(f.title || '').slice(0, 42)} »`);
      }
    }
  } else {
    bullet('Résumé endurance absent au moment du PDF — voir tmp/endurance-night-*.');
  }

  h1('6. Périmètre appareils');
  bullet('Samsung S21 FE R5CT7263YJL : tests nuit Hubera Music cloud.hubera.music, volume_music=0, zen=3 alarmes ON.');
  bullet('Blackview : compte paul@ injecté sur les 2 apps, PAS de shuffle/test lecture (demande porteur).');
  bullet('Nothing : intact, jamais injecté, jamais overlay cette session.');
  bullet('OTA Hubera : forceUpdate false / mandatory false — on ne force pas l’APK.');

  h1('7. Fichiers / commandes utiles');
  bullet('Réparer ADB Wi‑Fi Samsung : make samsung-wifi');
  bullet('Login test (refus hors allowlist) : DEVICE=R5CT7263YJL PKG=cloud.hubera.music SEED_EMAIL=paul@delhomme.ovh bash scripts/adb/adb-login.sh');
  bullet('Marathon EOS : PLAY_TO_END=1 DEVICE=R5CT7263YJL PKG=cloud.hubera.music STOP_AT=\'2026-10-05 08:00\' python3 -u scripts/qa/samsung-night-endurance-20260918.py');

  h1('8. Suite jusqu’à 08h00');
  bullet('Tick agent toutes les 8 min : reconnecter 184:5555 si besoin, mute, health 1.3.341, endurance EOS, pas de clavier Samsung, pas de force OTA.');
  bullet('Objectif : plus de 5xx bloquants, titres qui partent, et ceux qui partent qui vont au bout (≥85 %).');
  bullet('Limite restante : titre jamais en cache VPS + bot-check datacenter → 20 s puis skip (le 2e essai est souvent OK une fois warm).');

  doc.moveDown(0.8);
  doc.font('Body').fontSize(9).fillColor('#666').text(
    `Généré automatiquement — session agent Cursor · ${new Date().toISOString()}`,
  );

  const pages = doc.bufferedPageRange().count;
  for (let i = 0; i < pages; i++) {
    doc.switchToPage(i);
    doc.font('Body').fontSize(8).fillColor('#999').text(
      `Hubera Music ${version} — ${i + 1}/${pages}`,
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
  const pdf = await buildPdf({ endurance });
  const subject = `[Hubera Music] Rapport nuit ${version} — Samsung EOS / compte perso / ADB Wi‑Fi`;
  const html = `
    <p>Rapport PDF joint (nuit ${dateLabel}).</p>
    <ul>
      <li>Compte <b>paul@delhomme.ovh</b> sur les 4 apps de <b>test</b> seulement (Samsung + Blackview). Rien sur Nothing ni sur d’autres téléphones.</li>
      <li><code>dev@</code> est un autre compte Music (0 titre) — ce n’était pas un alias.</li>
      <li>Endurance muette jusqu’à 08h00, skip BUFFERING &gt;20 s, lecture jusqu’au bout si le titre part.</li>
      <li>Réparer ADB Wi‑Fi : <code>make samsung-wifi</code> (IP 192.168.1.184:5555).</li>
    </ul>
  `;
  const result = await sendMail({
    to,
    subject,
    html,
    text: `Hubera Music récap nuit ${version} — PDF joint`,
    attachments: [
      {
        filename: `Hubera-Music-recap-nuit-${version}.pdf`,
        content: readFileSync(pdf.path),
        contentType: 'application/pdf',
      },
    ],
  });
  writeFileSync(
    join(OUT, 'mail-result.json'),
    JSON.stringify({ to, subject, pdf, result, enduranceDir: endurance?.dir }, null, 2),
  );
  console.log(JSON.stringify({ ok: true, to, pdf, enduranceDir: endurance?.dir }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
