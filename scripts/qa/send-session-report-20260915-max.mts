/**
 * Rapport PDF MAX densifié UTF-8 (Noto Sans) — session endurance + correctifs 236→239.
 *   REPORT_TO='dev@…, pavel…' node --env-file=.env --import tsx scripts/qa/send-session-report-20260915-max.mts
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sendMail } from '../../api/src/platform/mail.ts';

const to =
  process.env.REPORT_TO?.trim() ||
  'dev@delhomme.ovh, [SET_VIA_ENV]';

const ROOT = process.cwd();
const ENDURANCE = join(ROOT, 'logs/endurance/bv-5h-20260914-200128');
const OUT = join(ROOT, 'tmp/report-2026-09-15-session-max');
mkdirSync(OUT, { recursive: true });
const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();

const FONT_REG =
  existsSync('/usr/share/fonts/noto/NotoSans-Regular.ttf')
    ? '/usr/share/fonts/noto/NotoSans-Regular.ttf'
    : '/usr/share/fonts/liberation/LiberationSans-Regular.ttf';
const FONT_BOLD =
  existsSync('/usr/share/fonts/noto/NotoSans-Bold.ttf')
    ? '/usr/share/fonts/noto/NotoSans-Bold.ttf'
    : '/usr/share/fonts/liberation/LiberationSans-Bold.ttf';

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
  const pdfPath = join(OUT, `PLM-rapport-complet-${version}.pdf`);
  const doc = new PDFDocument({ margin: 48, size: 'A4', bufferPages: true, autoFirstPage: true });
  doc.registerFont('Body', FONT_REG);
  doc.registerFont('BodyBold', FONT_BOLD);
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  const BOTTOM = 790;
  const ensure = (n = 50) => {
    if (doc.y + n > BOTTOM) doc.addPage();
  };
  const h1 = (t: string) => {
    ensure(70);
    doc.moveDown(0.35);
    doc.font('BodyBold').fontSize(13).fillColor('#111').text(t, { underline: true });
    doc.moveDown(0.2);
    doc.font('Body').fontSize(9.5).fillColor('#222');
  };
  const h2 = (t: string) => {
    ensure(40);
    doc.moveDown(0.2);
    doc.font('BodyBold').fontSize(11).fillColor('#222').text(t);
    doc.moveDown(0.12);
    doc.font('Body').fontSize(9.5).fillColor('#333');
  };
  const p = (t: string) => {
    ensure(28);
    doc.font('Body').fontSize(9.5).fillColor('#333').text(t, { align: 'justify', lineGap: 1.6 });
    doc.moveDown(0.18);
  };
  const bullet = (t: string) => {
    ensure(18);
    doc.font('Body').fontSize(9.5).fillColor('#333').text(`• ${t}`, { lineGap: 1.3 });
  };
  const mono = (t: string) => {
    ensure(13);
    doc.font('Body').fontSize(8).fillColor('#111').text(t, { width: 500, lineGap: 0.5 });
    doc.moveDown(0.08);
  };

  doc.font('BodyBold').fontSize(17).fillColor('#111').text('PLM — Rapport complet session lecture');
  doc.moveDown(0.25);
  doc.font('Body').fontSize(10).fillColor('#444');
  doc.text(`Version déployée : p+${version} · Généré ${new Date().toISOString()}`);
  doc.text('Appareils : Blackview BV9700Pro (tests/install) · Nothing = MAJ manuelle utilisateur');
  doc.text(`Police PDF UTF-8 : ${FONT_REG}`);
  doc.text(`Logs endurance : ${ENDURANCE}`);
  doc.moveDown(0.4);

  h1('1. Contexte et demande produit');
  p(
    'L’utilisateur signalait encore des chargements trop longs, des titres coupés vers ~30 s (reprise de flux), des mails d’erreurs, et le sentiment que le warm serveur ne préparait que le début des titres (têtes) et non la suite. Exigence forte : ne jamais résoudre un problème de lecture en passant automatiquement au titre suivant — toujours rendre le titre disponible (rebind, warm disque, remplacement vidéo morte). Aussi : retour Compte → Biblio ne doit pas recharger inutilement ; possibilité de mise hors ligne playlist/album.',
  );

  h1('2. Chronologie des versions');
  bullet('1.3.236 — Prefetch file ~16 titres + replace-before-skip + warm sweep multi-comptes');
  bullet('1.3.237 — Content-Range : ne plus annoncer une taille partielle de .m4a (cause EOF ~30 s)');
  bullet('1.3.238 — Intégrité cache : .m4a < 512 KiB = incomplet ; needsDisk / warm à 3 MiB');
  bullet(
    '1.3.239 — Resolve-not-skip (plus d’auto-skip dernier recours) ; file disque J’aime dédiée (jusqu’à 1500) ; TTL Biblio 10 min ; hors-ligne album dans le hero',
  );

  h1('3. Campagne endurance Blackview ~5 h (14→15 sept.)');
  bullet('Protocole : Aléatoire biblio, skip ~28 s, sessions ~35 min × 8, volume minimal');
  bullet(`Sessions : ${agg.sessions ?? 8}`);
  bullet(`Skips : ${agg.skips ?? '—'} · Transitions : ${agg.transitions ?? '—'} · Titres uniques : ${agg.uniqueTitles ?? '—'}`);
  bullet(`SLOW_BUFFER (≥ 3,5 s) : ${slows.length} (${((100 * slows.length) / Math.max(1, skipOk.length + slows.length)).toFixed(1)} %)`);
  bullet(`Somme errorCount sessions (souvent EOF Source error 2000) : ${agg.errorCountSum ?? '—'}`);
  h2('3.1 SKIP_OK (skips rapides)');
  mono(`ALL   n=${okAll.n}  p50=${okAll.p50} ms  p95=${okAll.p95} ms  max=${okAll.max} ms  avg=${okAll.avg} ms`);
  mono(`PRE   n=${okPre.n}  p50=${okPre.p50} ms  (avant deploy Content-Range ~22:44)`);
  mono(`POST  n=${okPost.n} p50=${okPost.p50} ms  (après 1.3.237 pendant le test)`);
  h2('3.2 SLOW_BUFFER (cluster ~22–23 s)');
  mono(`ALL   n=${slowAll.n}  p50=${slowAll.p50} ms  p95=${slowAll.p95} ms  max=${slowAll.max} ms`);
  mono(`PRE   n=${slowPre.n}  p50=${slowPre.p50} ms`);
  mono(`POST  n=${slowPost.n} p50=${slowPost.p50} ms — le taux reste élevé : cause distincte du bug Content-Range`);
  p(
    'Lecture : médiane des skips OK ~1,3 s = bon. Les SLOW forment un plateau ~23 s = titre suivant froid (mid-range / disque pas prêt / attente), pas un micro-ralentissement. Le correctif 237 cible la coupure mid-titre (~30 s de tête), pas entièrement le cold-start au skip — d’où 238/239 (intégrité disque + file J’aime).',
  );

  h1('4. Titres signalés explicitement par l’utilisateur');
  for (const t of userTracks) {
    const h = trackHits(t.needle);
    h2(t.name);
    bullet(`Occurrences log (SLOW / SKIP / ERROR) : ${h.lines}`);
    bullet(
      `SLOW_BUFFER : ${h.slow.length}${
        h.slow.length ? ' — ' + h.slow.map((s) => `${s.ts} ${s.ms} ms`).join(' ; ') : ''
      }`,
    );
    bullet(
      `SKIP_OK : ${h.ok.length}${h.ok[0] ? ` — ex. ${h.ok[0].ts} ${h.ok[0].ms} ms` : ''}`,
    );
  }

  h1('5. Liste complète des SLOW_BUFFER');
  p('Horodatage · durée · phase (pre/post 237) · titre. Ces titres ont été trop lents au skip (BUFFERING prolongé).');
  for (const s of slows) {
    mono(`${s.ts}  ${String(s.ms).padStart(5)} ms  [${s.phase}]  ${s.title.slice(0, 72)}`);
  }

  h1('6. Diagnostic technique (causes)');
  h2('6.1 Coupure ~30 s / reprise de flux');
  p(
    'Open Android froid forçait une Range bytes=0-524287 (~30 s d’AAC). La suite exige un mid-range. Si un .m4a partiel était servi, Content-Range annonçait Math.min(total, taille_partielle) → Exo croyait à la fin du titre → rebind. Correctif 1.3.237 : total stable, jamais rétréci pendant downloadInflight.',
  );
  h2('6.2 « Compressé » côté serveur = têtes RAM, pas la piste entière');
  p(
    'Le cache mémoire (streamHeadCache) garde ~1 MiB de tête par titre (déjà compressé AAC, non recompressé). Le warm historique chauffait surtout ces têtes + une file disque trop petite (~60) avec 1 worker. Résultat : démarrage rapide possible, suite froide. Correctif 1.3.239 : file likesDiskWarm dédiée (cap ~800, limite 1500 likes/compte) + TASTE_WARM_DISK_QUEUE relevé.',
  );
  h2('6.3 SLOW ~23 s au skip');
  p(
    'Titre suivant pas encore en .m4a complet ; GV mid-range fragile ; budget attente disque. Le runner mesure jusqu’à ~20–23 s de BUFFERING. Atténué par warm disque plus agressif + bump priorité lecture, pas par auto-skip.',
  );
  h2('6.4 Auto-skip vs resolve');
  p(
    'Avant 239 : plusieurs chemins finissaient en skipNext / advance (buffer stuck UI, early_end give-up, replaceOrAdvance sans remplacement). Exigence produit : jamais. 1.3.239 : replaceOrAdvance → replace sinon rebind+warm disque (resolve-keep) ; PlayerController dernier recours → resolveCurrentKeep ; early_end → resolve.',
  );
  h2('6.5 Reload Biblio au retour Compte');
  p(
    'Remount LibraryScreen + LaunchedEffect(libraryEpoch) forçait ensureLoaded(force=true) dès epoch>0, même sans changement. TTL stale 45 s trop court. Fix : ne forcer que si epoch change ; TTL 10 min.',
  );
  h2('6.6 Hors-ligne playlist / album');
  p(
    'Playlist : déjà « Télécharger la playlist » (hero + ⋯) via enqueueMany. Album : existait surtout dans le menu ⋯ — bouton « Mise hors ligne » ajouté dans le hero album (1.3.239). Libellés clarifiés « Mise hors ligne ».',
  );

  h1('7. Ce qui a marché');
  bullet('Endurance 5 h complète sur Blackview sans crash runner');
  bullet('~81 % des skips chronométrés en SKIP_OK (médiane ~1,3 s)');
  bullet('Déploiements successifs 237→239 sans couper l’endurance (237 à chaud)');
  bullet('APK p+1.3.239 installée sur Blackview uniquement ; Nothing non touché ADB');
  bullet('Serveur plm.delhomme.ovh + ytmusic.delhomme.ovh : appVersion p+1.3.239');
  bullet('Warm : likesLimit=1500, diskQueue likes+generic active après kick admin');
  bullet('UI BV : Biblio / Titres / Playlists / Enregistré récemment accessibles');

  h1('8. Ce qui reste fragile / à surveiller');
  bullet('Télémétrie encore vue (appareils pas encore tous en 239) : stall give-up → next — le client 239 ne doit plus skipper ainsi');
  bullet('Cluster SLOW ~23 s peut encore arriver tant que le .m4a n’est pas prêt (warm progressif)');
  bullet('EOF 2000 mid-flux : recovery rebind ; surveiller après intégrité disque');
  bullet('Prefetch_miss / cold_next dans le digest 24 h : continue de baisser avec la file likes');
  bullet('Nothing : mise à jour manuelle via QR Admin /api/deploy/apk (p+1.3.239)');

  h1('9. Correctifs livrés (détail fichiers)');
  bullet('api/src/media/streamHeadCache.ts — rememberAdvertisedTotal / stableContentTotal sans shrink');
  bullet('api/src/media/stream.ts — disk partiel, enqueueLikesDiskWarm, bumpWarmPriority likes');
  bullet('api/src/media/libraryWarmSweep.ts — likes jusqu’à LIBRARY_WARM_LIKES_LIMIT');
  bullet('api/src/library/shuffleHeads.ts — needsDisk < 3 MiB');
  bullet('PlaybackService.kt — resolve-keep / resolveCurrentKeep');
  bullet('PlayerController.kt — plus de skipNext en dernier recours buffer stuck');
  bullet('LibraryRepository.kt / LibraryScreen.kt — TTL 10 min + epoch remount');
  bullet('CollectionDetailScreen.kt — hors-ligne album hero + libellés');

  h1('10. Déploiement');
  bullet('PRs : #485–#490 (dev + promo prod)');
  bullet('Redeploy VPS image GHCR :latest');
  bullet('make android-prod DEVICE=EEA9700PRO0014587 → Success + publish /api/deploy/apk');
  bullet('versionName Blackview : p+1.3.239');

  h1('11. Vérifications effectuées (Blackview)');
  bullet('dumpsys versionName=p+1.3.239');
  bullet('Health API p+1.3.239');
  bullet('Warm admin : likesLimit 1500, diskQueue busy avec likes>0');
  bullet('UI : Accueil → Biblio → filtres Titres / Playlists / Enregistré récemment');
  bullet('Volume musique index 1/15 pendant tests');

  h1('12. Annexes — échantillon titres uniques endurance');
  const sample = (agg.titlesSample as string[]) || [];
  for (const t of sample.slice(0, 40)) mono(t);
  const sessions = existsSync(ENDURANCE)
    ? readdirSync(ENDURANCE).filter((f) => /^session-\d+\.json$/.test(f))
    : [];
  bullet(`Fichiers session : ${sessions.join(', ') || '—'}`);
  p('Fin du rapport densifié UTF-8 — toutes les entrées SLOW sont listées en §5.');

  const pageCount = await new Promise<number>((resolve, reject) => {
    doc.on('end', () => {
      try {
        resolve(Math.max(1, doc.bufferedPageRange().count));
      } catch {
        resolve(1);
      }
    });
    doc.on('error', reject);
    doc.end();
  });
  const buf = Buffer.concat(chunks);
  writeFileSync(pdfPath, buf);
  return { path: pdfPath, pages: pageCount, bytes: buf.length };
}

const { path: pdfPath, pages, bytes } = await buildPdf();
const pdfBuf = readFileSync(pdfPath);

// Sanity UTF-8 titles in PDF stream
const raw = pdfBuf.toString('latin1');
const utfOk =
  raw.includes("Am") || pdfBuf.includes(Buffer.from("Amélie", "utf8")) || slows.some((s) => s.title.includes('é'));
console.log('pdf bytes', bytes, 'pages', pages, 'font', FONT_REG);

const subject = `[Hubera Music] Rapport COMPLET session — p+${version} · endurance 5h · ${slows.length} SLOW · resolve-not-skip`;
const html = `
<div style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">
  <h2 style="margin:0 0 8px">Rapport complet densifié (UTF-8)</h2>
  <p>PDF joint (<strong>${pages}</strong> pages, ${(bytes / 1024).toFixed(0)} Ko) : endurance BV 5 h, tous les SLOW, titres utilisateur (Amélie, Crazy Hot, Mon amazone…), causes, correctifs <strong>1.3.236→1.3.239</strong>, déploiement, vérifs Blackview, restes.</p>
  <ul>
    <li>Skips OK médiane ~${okAll.p50} ms · SLOW ${slows.length} (~23 s)</li>
    <li>Prod : <code>p+${version}</code> · BV installé · Nothing = MAJ manuelle QR</li>
    <li>Principe : <strong>résoudre le titre</strong>, pas auto-skip</li>
  </ul>
</div>
`;

const r = await sendMail({
  to,
  subject,
  html,
  text: `PLM rapport complet p+${version} — PDF UTF-8 joint (${pages} p / ${bytes} o)`,
  attachments: [
    {
      filename: `PLM-rapport-complet-${version}.pdf`,
      content: pdfBuf,
      contentType: 'application/pdf',
    },
  ],
});

writeFileSync(
  join(OUT, 'mail-result.json'),
  JSON.stringify({ to, subject, pages, bytes, pdfPath, font: FONT_REG, r }, null, 2),
);
console.log('mail →', r);
console.log('pdf →', pdfPath);
