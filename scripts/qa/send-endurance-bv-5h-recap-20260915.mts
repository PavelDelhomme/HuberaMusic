/**
 * Récap MAX endurance Blackview 5 h + correctifs 1.3.237/238 + PDF densifié.
 *   node --env-file=.env --import tsx scripts/qa/send-endurance-bv-5h-recap-20260915.mts
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sendMail } from '../../api/src/platform/mail.ts';

const to =
  process.env.BATTERY_REPORT_TO?.trim() ||
  process.env.REPORT_TO?.trim() ||
  '';

const ROOT = process.cwd();
const ENDURANCE = join(ROOT, 'logs/endurance/bv-5h-20260914-200128');
const OUT = join(ROOT, 'tmp/report-2026-09-15-endurance-bv-5h');
mkdirSync(OUT, { recursive: true });
const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();

function loadJson(path: string) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

const agg = loadJson(join(ENDURANCE, 'aggregate.json')) || {};
const master = existsSync(join(ENDURANCE, 'master.log'))
  ? readFileSync(join(ENDURANCE, 'master.log'), 'utf8')
  : '';

type SlowRow = { ts: string; ms: number; title: string; phase: 'pre' | 'post' };
const slows: SlowRow[] = [];
const skipOk: { ts: string; ms: number; title: string; phase: 'pre' | 'post' }[] = [];
const CUT = '22:44:00';
for (const line of master.split('\n')) {
  const m = /^(\d{2}:\d{2}:\d{2}) /.exec(line);
  if (!m) continue;
  const ts = m[1];
  const phase: 'pre' | 'post' = ts >= CUT ? 'post' : 'pre';
  const slow = /SLOW_BUFFER (\d+)ms.*?→ (.+)$/.exec(line);
  if (slow) slows.push({ ts, ms: Number(slow[1]), title: slow[2].trim(), phase });
  const ok = /SKIP_OK (\d+)ms → (.+)$/.exec(line);
  if (ok) skipOk.push({ ts, ms: Number(ok[1]), title: ok[2].trim(), phase });
}

function stats(vals: number[]) {
  if (!vals.length) return { n: 0, p50: 0, p95: 0, max: 0, avg: 0 };
  const s = [...vals].sort((a, b) => a - b);
  const p = (pct: number) => s[Math.min(s.length - 1, Math.round((pct / 100) * (s.length - 1)))];
  return {
    n: s.length,
    p50: p(50),
    p95: p(95),
    max: s[s.length - 1],
    avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

const okAll = stats(skipOk.map((x) => x.ms));
const okPre = stats(skipOk.filter((x) => x.phase === 'pre').map((x) => x.ms));
const okPost = stats(skipOk.filter((x) => x.phase === 'post').map((x) => x.ms));
const slowAll = stats(slows.map((x) => x.ms));
const slowPre = stats(slows.filter((x) => x.phase === 'pre').map((x) => x.ms));
const slowPost = stats(slows.filter((x) => x.phase === 'post').map((x) => x.ms));

const userTracks = [
  { name: "L'autre valse d'Amélie", needle: 'amélie' },
  { name: 'Shut Up Crazy Hot', needle: 'crazy hot' },
  { name: 'Mon amazone', needle: 'amazone' },
  { name: 'Je me barre', needle: 'je me barre' },
  { name: 'Hurt', needle: 'hurt' },
  { name: 'Imagine', needle: 'imagine' },
];

function trackHits(needle: string) {
  const low = needle.toLowerCase();
  return {
    slow: slows.filter((s) => s.title.toLowerCase().includes(low)),
    ok: skipOk.filter((s) => s.title.toLowerCase().includes(low)),
    lines: master
      .split('\n')
      .filter((l) => l.toLowerCase().includes(low) && /(SLOW_BUFFER|SKIP_OK|ERROR )/.test(l))
      .length,
  };
}

async function buildPdf(): Promise<{ path: string; pages: number }> {
  const require = createRequire(import.meta.url);
  let PDFDocument: any;
  try {
    PDFDocument = require('pdfkit');
  } catch {
    PDFDocument = require(
      '/home/pactivisme/Documents/Dev/Perso/GasoilTracking/scripts/reports/node_modules/pdfkit',
    );
  }
  const pdfPath = join(OUT, `PLM-endurance-bv-5h-${version}.pdf`);
  const doc = new PDFDocument({ margin: 48, size: 'A4', bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  const BOTTOM = 790;
  const ensure = (n = 50) => {
    if (doc.y + n > BOTTOM) doc.addPage();
  };
  const h1 = (t: string) => {
    ensure(70);
    doc.moveDown(0.3);
    doc.fontSize(13).fillColor('#111').text(t, { underline: true });
    doc.moveDown(0.25);
    doc.fontSize(9.5).fillColor('#222');
  };
  const h2 = (t: string) => {
    ensure(40);
    doc.moveDown(0.2);
    doc.fontSize(11).fillColor('#222').text(t);
    doc.moveDown(0.15);
    doc.fontSize(9.5).fillColor('#333');
  };
  const p = (t: string) => {
    ensure(28);
    doc.fontSize(9.5).fillColor('#333').text(t, { align: 'justify', lineGap: 1.7 });
    doc.moveDown(0.2);
  };
  const bullet = (t: string) => {
    ensure(18);
    doc.fontSize(9.5).fillColor('#333').text(`• ${t}`, { lineGap: 1.4 });
  };
  const mono = (t: string) => {
    ensure(14);
    doc.font('Courier').fontSize(8).fillColor('#111').text(t);
    doc.font('Helvetica').fontSize(9.5).fillColor('#333');
  };

  doc.fontSize(18).fillColor('#111').text('PLM — Rapport endurance Blackview 5 h', { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#444').text(`Version serveur : p+${version} · Généré ${new Date().toISOString()}`);
  doc.text('Appareil : BV9700Pro (EEA9700PRO0014587) · volume 1/15 · Aléatoire biblio');
  doc.text(`Dossier : ${ENDURANCE}`);
  doc.moveDown(0.5);

  h1('1. Objectif du test');
  p(
    'Campagne d’écoute réelle ~5 heures sur Blackview (muet / volume minimal), en Aléatoire sur toute la bibliothèque, avec skips toutes les ~28 s pour forcer la profondeur de file (pas seulement les premiers titres). But : mesurer les chargements lents, les EOF mid-flux (~30 s), les bypass trop lents, et croiser avec la télémétrie / mails d’alerte. Nothing non touché (mise à jour manuelle utilisateur).',
  );

  h1('2. Protocole');
  bullet('8 sessions × ~35 min (pause ~45 s entre sessions)');
  bullet('Skip ~28 s · reshuffle ~7 min · SLOW_BUFFER si readyMs ≥ 3,5 s');
  bullet('APK au départ : p+1.3.236 · correctif serveur 1.3.237 déployé ~22:44 pendant le test');
  bullet('Logs : master.log + session-*.json + aggregate.json + errors.jsonl par session');

  h1('3. Résultats globaux');
  bullet(`Sessions : ${agg.sessions ?? 8}`);
  bullet(`Skips : ${agg.skips ?? skipOk.length + slows.length}`);
  bullet(`Transitions : ${agg.transitions ?? '?'}`);
  bullet(`Titres uniques : ${agg.uniqueTitles ?? '?'}`);
  bullet(`SLOW_BUFFER : ${slows.length} (${((100 * slows.length) / Math.max(1, skipOk.length + slows.length)).toFixed(1)} % des skips chronométrés)`);
  bullet(`Somme errorCount sessions (logcat/app, souvent EOF 2000) : ${agg.errorCountSum ?? '?'}`);
  h2('3.1 Temps de reprise après skip (SKIP_OK)');
  mono(`ALL  n=${okAll.n}  p50=${okAll.p50}ms  p95=${okAll.p95}ms  max=${okAll.max}ms  avg=${okAll.avg}ms`);
  mono(`PRE  n=${okPre.n}  p50=${okPre.p50}ms  p95=${okPre.p95}ms  max=${okPre.max}ms`);
  mono(`POST n=${okPost.n} p50=${okPost.p50}ms p95=${okPost.p95}ms max=${okPost.max}ms`);
  h2('3.2 Chargements trop longs (SLOW_BUFFER ≥ 3,5 s)');
  mono(`ALL  n=${slowAll.n}  p50=${slowAll.p50}ms  p95=${slowAll.p95}ms  max=${slowAll.max}ms  avg=${slowAll.avg}ms`);
  mono(`PRE  n=${slowPre.n}  p50=${slowPre.p50}ms  (avant 1.3.237)`);
  mono(`POST n=${slowPost.n} p50=${slowPost.p50}ms (après 1.3.237 — taux encore élevé : problème distinct)`);
  p(
    'Lecture clé : la médiane des skips OK reste ~1,3 s (bon). Le cluster SLOW est quasi toujours ~22–23 s (froid / mid-range / attente disque), pas un léger ralentissement. Le correctif 1.3.237 cible surtout la coupure mid-titre (~30 s de tête puis reprise), pas forcément le cold-start au skip.',
  );

  h1('4. Titres signalés par l’utilisateur');
  for (const t of userTracks) {
    const h = trackHits(t.needle);
    h2(t.name);
    bullet(`Occurrences log (SLOW/SKIP/ERROR) : ${h.lines}`);
    bullet(`SLOW_BUFFER : ${h.slow.length}${h.slow.length ? ' — ' + h.slow.map((s) => `${s.ts} ${s.ms}ms`).join(' ; ') : ''}`);
    bullet(`SKIP_OK : ${h.ok.length}${h.ok[0] ? ` — ex. ${h.ok[0].ts} ${h.ok[0].ms}ms` : ''}`);
  }

  h1('5. Liste complète des SLOW_BUFFER (73 titres)');
  p('Horodatage · durée · titre. Ces titres ont été « bypassés » ou sont restés BUFFERING trop longtemps au skip.');
  for (const s of slows) {
    mono(`${s.ts}  ${String(s.ms).padStart(5)}ms  [${s.phase}]  ${s.title.slice(0, 70)}`);
  }

  h1('6. Ce qui a marché');
  bullet('Endurance 5 h complète sans crash app bloquant le runner');
  bullet('~81 % des skips chronométrés en SKIP_OK (médiane ~1,3 s)');
  bullet('File Aléatoire profonde (q≈80) · 400+ titres uniques croisés');
  bullet('Télémétrie + digest lecture actifs (prefetch_miss, stall, cold_next, EOF)');
  bullet('Déploiement 1.3.237 à chaud sans arrêter le test BV');

  h1('7. Ce qui n’a pas marché / reste fragile');
  bullet('~19 % de skips en SLOW_BUFFER ~23 s (titres froids — mid-range / disque pas prêt)');
  bullet('EOF Source error code=2000 fréquent mid-flux (souvent récupéré par rebind)');
  bullet('Après 1.3.237 le taux SLOW reste élevé : autre cause que le Content-Range partiel');
  bullet('Warm serveur = surtout des têtes ; la continuité bout-en-bout dépend du .m4a complet');
  bullet('Prefetch miss / cold_next très présents dans le digest 24 h');

  h1('8. Causes techniques (diagnostiquées)');
  h2('8.1 Coupure ~30 s / reprise de flux (favoris)');
  p(
    'Open Android froid forçait une tête Range 512 KiB (~30 s d’AAC). La suite exige un mid-range. Si un .m4a partiel était servi, le Content-Range annonçait la taille partielle (Math.min / shrink) → Exo croyait à la fin du titre → rebind. Correctif 1.3.237 : total stable, jamais rétréci pendant downloadInflight ; attente de croissance du fichier ; warm favoris jusqu’à 200 J’aime en disque.',
  );
  h2('8.2 SLOW_BUFFER ~23 s au skip');
  p(
    'Titre suivant pas encore chaud (pas de .m4a complet, GV mid-range 403, budget attente disque). Le lecteur reste BUFFERING jusqu’au timeout de mesure (~20–23 s). Distinct du bug Content-Range. Atténué par warm disque plus agressif (1.3.238 : seuil 3 MiB, rejet partiels <512 KiB).',
  );
  h2('8.3 EOF 2000 mid-flux');
  p(
    'Souvent EOFException sur Source error pendant la lecture (relais / fin de plage). Recovery client : rebind. À surveiller après intégrité disque.',
  );

  h1('9. Correctifs livrés');
  bullet('1.3.236 — prefetch file ~16 titres + replace-before-skip + warm sweep');
  bullet('1.3.237 — Content-Range stable (plus de fin fantôme ~30 s) + likes disk warm 200');
  bullet('1.3.238 — .m4a partiel ≠ complet ; needsDisk / warm à 3 MiB ; purge têtes <512 KiB');

  h1('10. Ce qui reste à améliorer');
  bullet('Réduire le cluster SLOW ~23 s (continuité mid-range sans attendre 20 s)');
  bullet('Open Android : moins dépendre du forçage 512 KiB si disque pas prêt');
  bullet('Mesure « écoute jusqu’au bout » (pas seulement readyMs au skip) dans le runner');
  bullet('Repasse Nothing manuelle utilisateur sur favoris après MAJ notes / serveur');

  h1('11. Repasse de vérification');
  p(
    'Serveur prod ciblé p+1.3.238 après ce rapport. Vérifications automatiques : health, digest playback, kick library-warm. Vérif humaine recommandée sur Nothing : 3–5 favoris connus (Amélie, Crazy Hot, Mon amazone) écoutés >1 min sans reprise de flux.',
  );

  h1('12. Annexes');
  bullet(`aggregate.json : sessions=${agg.sessions} skips=${agg.skips} slowBufferEvents=${agg.slowBufferEvents}`);
  const sessions = readdirSync(ENDURANCE).filter((f) => /^session-\d+\.json$/.test(f));
  bullet(`Fichiers session : ${sessions.join(', ')}`);
  p('Fin du rapport densifié — toutes les lignes SLOW sont listées en §5.');

  doc.end();
  await new Promise<void>((resolve) => doc.on('end', () => resolve()));
  const buf = Buffer.concat(chunks);
  writeFileSync(pdfPath, buf);
  const pages = doc.bufferedPageRange().count;
  return { path: pdfPath, pages };
}

const { path: pdfPath, pages } = await buildPdf();
const pdfBuf = readFileSync(pdfPath);

const subject = `[PLM] Rapport endurance BV 5h — p+${version} · ${slows.length} SLOW · 417 skips`;
const html = `
<div style="font-family:system-ui,sans-serif;line-height:1.45;color:#111">
  <h2 style="margin:0 0 8px">Endurance Blackview 5 h — récap densifié</h2>
  <p>Version <strong>p+${version}</strong>. PDF joint (${pages} pages) : protocole, stats pré/post 1.3.237, tous les titres SLOW, titres utilisateur (Amélie, Crazy Hot, Mon amazone…), causes, correctifs 237/238, restes.</p>
  <ul>
    <li>Skips chronométrés OK : médiane ~${okAll.p50} ms</li>
    <li>SLOW_BUFFER : <strong>${slows.length}</strong> (~23 s cluster) — ${slowPre.n} avant / ${slowPost.n} après 1.3.237</li>
    <li>Titres uniques : ${agg.uniqueTitles}</li>
    <li>Fix ~30 s Content-Range : <strong>1.3.237</strong> · intégrité disque : <strong>1.3.238</strong></li>
  </ul>
  <p style="color:#555;font-size:13px">Nothing non piloté pendant le test. Logs : <code>logs/endurance/bv-5h-20260914-200128/</code></p>
</div>
`;

const text = [
  `PLM endurance BV 5h p+${version}`,
  `SLOW=${slows.length} SKIP_OK p50=${okAll.p50}ms unique=${agg.uniqueTitles}`,
  `PDF: ${pdfPath}`,
  `Correctifs: 1.3.237 Content-Range, 1.3.238 disk integrity`,
].join('\n');

const r = await sendMail({
  to,
  subject,
  html,
  text,
  attachments: [
    {
      filename: `PLM-endurance-bv-5h-${version}.pdf`,
      content: pdfBuf,
      contentType: 'application/pdf',
    },
  ],
});

writeFileSync(join(OUT, 'mail-result.json'), JSON.stringify({ to, subject, pages, pdfPath, r }, null, 2));
console.log('mail →', r);
console.log('pdf →', pdfPath, 'pages', pages);
