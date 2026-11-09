/**
 * Catalogue PDF : pourquoi une musique peut ne pas marcher + comment c’est résolu.
 *
 *   node --import tsx scripts/qa/send-play-failure-cases-pdf.mts
 */
import { createRequire } from 'node:module';
import { config as loadEnv } from 'dotenv';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sendMail } from '../../api/src/platform/mail.ts';

loadEnv({ path: '.env', override: true });

function resolveTo(): string {
  const bags = [process.env.MAIL_TO, process.env.REPORT_TO, process.env.BATTERY_REPORT_TO, process.env.PERSONAL_MAIL];
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
const OUT = join(ROOT, 'tmp/report-play-failures');
mkdirSync(OUT, { recursive: true });
const version = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim();
const dateLabel = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

const require = createRequire(import.meta.url);
const PDFDocument = (() => {
  try {
    return require('pdfkit');
  } catch {
    return require('/home/pactivisme/Documents/Dev/Perso/GasoilTracking/scripts/reports/node_modules/pdfkit');
  }
})();
const { bindPdfHelpers } = require(
  '/home/pactivisme/Documents/Dev/Perso/GasoilTracking/scripts/reports/pdfkit-safe.js',
);

type CaseRow = {
  id: string;
  title: string;
  symptom: string;
  example: string;
  cause: string;
  resolve: string;
  status: string;
};

const CASES: CaseRow[] = [
  {
    id: 'A',
    title: 'VideoId mort (supprime / prive / region)',
    symptom: 'Chargement infini, skip, « unavailable », silence apres le clic.',
    example:
      'Laisse Nous Raver (Extended Mix) — Rekkt & NIVK — id mort abVAuW6XTCU ; Radio zzOxVZ8W5pA ; original jouable PcpOcHlHiog.',
    cause:
      'La biblio / pin / file pointe encore vers une adresse YouTube morte. Tous les backends repondent unavailable.',
    resolve:
      'Remplacement seed + auto (trackReplacement) : deadId → replacementId. Stream redirige (302). ensurePlayable / heal. API like/biblio/pin/DL remap (1.3.409). UI « Ca n a pas marche » (1.3.410) force la recherche et reprend la lecture.',
    status: 'Resolu (prod 1.3.410)',
  },
  {
    id: 'B',
    title: 'Actions (j aime / biblio / pin / DL) sur ID mort',
    symptom: 'Le titre joue (via remap) mais j aime / bibliotheque / acces rapide / telechargement echouent ou ne collent pas.',
    example: 'Meme Extended Mix : lecture OK apres heal, menu actions encore sur abVA…',
    cause:
      'Lecture utilise le remplacant ; les actions envoyaient encore le deadId. Pin faisait aussi un getFullLibrary pendant un DL → timeout.',
    resolve:
      'TrackCanonical (seed Android) + withPlayableTrackId (API). Pin via libraryContains leger. Alias liked/library/offline. Overlay dual APK.',
    status: 'Resolu (1.3.409)',
  },
  {
    id: 'C',
    title: 'Conteneur DASH (ftyp=dash)',
    symptom: 'Telechargement hors-ligne refuse ; lecture mobile coupe ; message format incompatible.',
    example: 'DL utilisateur bloque « Format audio incompatible (DASH) » / pas de ftyp progressif.',
    cause:
      'YouTube sert parfois des segments DASH. ExoPlayer et le store offline Hubera exigent du MP4 progressif (itag ~140).',
    resolve:
      'Detection ftyp dash → purge cache → retry ?offline=1&retry=N / format 140. permanentFail session si 4 echecs. Remux ffmpeg .m4a extract hors GET live.',
    status: 'Resolu (pipeline stream + offline)',
  },
  {
    id: 'D',
    title: 'Titre froid / pas d octets (timeout)',
    symptom: 'Chargement long puis echec ; premiere lecture d un titre jamais hot tres lente.',
    example: 'Preuve biblio : titre froid sans octet jusqu au plafond ~60 s → « pas de flux ».',
    cause:
      'Aucun .m4a disque, pas de tete prechauffee, Innertube/yt-dlp lent ou sature (warm trop agressif).',
    resolve:
      'Cache disque .m4a (~2055+), preflight 3 titres, warm prefixe x2, head prefetch Exo, ensurePlayable, extract idle mp4→m4a. Skip soft si rien ne vient (pas remplacer par une autre chanson).',
    status: 'Mitige / en amelioration continue',
  },
  {
    id: 'E',
    title: 'Bot / cookies / 401-403-429 / LOGIN_REQUIRED',
    symptom: 'Stream 401/403/504 ; API instable ; « streaming data not available ».',
    example: 'Flocons bot sur titres non caches apres cooldown VPS.',
    cause:
      'IP VPS YouTube bot-bloquee ; cookies expires ; trop de warm paralleles ; proxies satures.',
    resolve:
      'Cookies yt-dlp + --js-runtimes node ; proxies residentiels (sticky) ; hedged resolve ; ne pas traiter LOGIN_REQUIRED comme « video morte » (looksUnavailable). Circuit soft streamDown puis markStreamOk sur DL user.',
    status: 'Mitige (ops cookies/proxies)',
  },
  {
    id: 'F',
    title: 'Erreur Exo mid-stream / rebuffer',
    symptom: 'Lecture demarre puis ERROR / buffering long / skip auto.',
    example: 'Samsung multi-skip sur titres froids ; streamFailStreak.',
    cause: 'URL signee expiree, DASH servi par erreur, reseau coupe, playerError laisse actif.',
    resolve:
      'streamHeal + findReplacementId avant skip ; clear ERROR avant nouveau play() ; quietPrefetch ; OTA forceUpdate false.',
    status: 'Resolu (heal + client)',
  },
  {
    id: 'G',
    title: 'Hors-ligne / donnees mobiles',
    symptom: 'Pas de lecture sans reseau ; DL opportuniste qui mange la bande.',
    example: 'Ahead DL sur 4G pendant lecture → rebuffer.',
    cause: 'Pas de fichier local ; ahead opportuniste sur metered.',
    resolve:
      'OfflineStore .m4a ; DL user prioritaire ; ahead Wi-Fi only ; file hors-ligne (suite package Hubera ID prevu).',
    status: 'OK lecture locale ; sync commune plus tard',
  },
  {
    id: 'H',
    title: 'Focus audio / appel telephonique',
    symptom: 'Clic lecture sans son ; toast pendant appel.',
    example: 'MODE_IN_CALL / MODE_IN_COMMUNICATION bloque play().',
    cause: 'Android refuse la lecture pendant un appel.',
    resolve: 'Garde AudioManager dans PlayerController + toast clair. Pas de contournement.',
    status: 'Attendu (comportement OS)',
  },
  {
    id: 'I',
    title: 'Mauvais compte / biblio vide',
    symptom: 'App « vide » alors que le compte perso a des milliers de titres.',
    example: 'Login QA/dev@ vs paul@ — deux userId distincts.',
    cause: 'Session injectee / SEED_EMAIL ecrase ; mauvais JWT.',
    resolve:
      'Jamais hardcoder paul@ en UI. Smokes avec QA_EMAIL/LAB_EMAIL. Injection ADB uniquement Samsung/Blackview lab.',
    status: 'Process / garde-fous',
  },
  {
    id: 'J',
    title: 'OTA / APK desynchronisee',
    symptom: 'Serveur a change mais le telephone ne voit pas de MAJ (apkAvailable false).',
    example: 'VERSION API bumpee sans republier les deux APK (cloud.hubera.music + legacy).',
    cause: 'Regle API ↔ dual APK : meme semver des deux cotes.',
    resolve:
      'Bump VERSION + build dual + overlay -r + publish volume. forceUpdate/mandatory toujours false.',
    status: 'Process OTA (1.3.410 live)',
  },
  {
    id: 'K',
    title: 'Age-restricted / contenu sensible',
    symptom: 'Unavailable malgre ID valide ; echec sans remplacement utile.',
    example: 'Titres ages-gated sans cookie session YouTube valide.',
    cause: 'YouTube exige un compte authentifie pour le flux.',
    resolve: 'Cookies serveur ; si vraiment inaccessible → remplacement titre+artiste si score >= 85, sinon signalement.',
    status: 'Partiel (depend cookies)',
  },
  {
    id: 'L',
    title: 'Fichier upload local (pas YouTube)',
    symptom: 'Remplacement refuse ; pas de stream YT.',
    example: 'GET /api/track/:id/replacement → upload: true.',
    cause: 'Contenu utilisateur, pas un videoId catalogue.',
    resolve: 'Servir le fichier local ; ne pas chercher de remplacement YT.',
    status: 'Attendu',
  },
  {
    id: 'M',
    title: 'Mauvais resultat de recherche (pas « mort »)',
    symptom: 'La musique « ne marche pas » au sens utilisateur : ce n est pas le bon titre/artiste.',
    example:
      'Dingga → doit etre MAMAMOO officiel ; Devchonka / Second souffle / She Wants Me Dead : homonymes ou covers en n1.',
    cause: 'Classement recherche (covers, remix, homonymes) avant le titre officiel.',
    resolve:
      'searchRank + feedback recherche + index biblio. Tache Cockpit « meilleur resultat = officiel » encore en cours (pas Fait tant qu il reste des echecs).',
    status: 'En cours (ranking)',
  },
];

function buildPdf(): { path: string; pages: number; bytes: number } {
  const pdfPath = join(OUT, `Hubera-Music-cas-lecture-${version}.pdf`);
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 40, bottom: 46, left: 40, right: 40 },
    bufferPages: true,
    autoFirstPage: true,
    info: {
      Title: `Hubera Music — Cas de lecture qui echouent (${version})`,
      Author: 'Hubera Music',
    },
  });
  const stream = require('fs').createWriteStream(pdfPath);
  doc.pipe(stream);

  const { ACCENT, DARK, LEFT, WIDTH, h2, h3, para, note, bullets, callout, kvList, table, writeFooters } =
    bindPdfHelpers(doc);

  doc.rect(0, 0, doc.page.width, 8).fill(ACCENT);
  doc.moveDown(0.9);
  doc.font('Helvetica-Bold').fontSize(18).fillColor(DARK).text('Hubera Music', LEFT(), doc.y, {
    width: WIDTH(),
  });
  doc
    .font('Helvetica-Bold')
    .fontSize(13)
    .fillColor(ACCENT)
    .text('Quand une musique ne marche pas — catalogue des causes et remedes', LEFT(), doc.y, {
      width: WIDTH(),
    });
  doc.moveDown(0.25);
  para(
    'Document de reference : chaque cas qui peut faire echouer la lecture (ou donner l impression qu elle echoue), ' +
      'avec exemple concret, cause technique, et resolution complete telle qu elle tourne en production.',
  );
  callout(
    `Version live ${version}`,
    'OTA non forcee (forceUpdate / mandatory = false). Dual APK cloud.hubera.music + legacy. Overlay lab Samsung / Blackview.',
    ACCENT,
  );
  kvList([
    ['Date', dateLabel],
    ['Produit', 'Hubera Music (music.hubera.cloud)'],
    ['Repo', 'PavelDelhomme/HuberaMusic (branche prod)'],
    ['Destinataire', to.split(',')[0] || to],
  ]);

  h2('0. Vue d ensemble');
  para(
    'La majorite des « ca ne marche pas » tombe dans trois familles : (1) adresse YouTube morte, ' +
      '(2) flux technique (DASH, froid, bot, reseau), (3) confusion produit (mauvais compte, mauvais resultat de recherche, OTA). ' +
      'On ne remplace jamais silencieusement par une autre chanson : on cherche le meme morceau sous une autre adresse, ou on soigne le flux.',
  );
  table(
    ['Id', 'Cas', 'Statut'],
    CASES.map((c) => [c.id, c.title, c.status]),
    [0.6, 3.2, 2.2],
  );

  h2('1. Fiches detaillees');
  for (const c of CASES) {
    h3(`${c.id}. ${c.title}`);
    para(`Symptome : ${c.symptom}`);
    para(`Exemple : ${c.example}`);
    para(`Cause : ${c.cause}`);
    para(`Resolution : ${c.resolve}`);
    note(`Statut — ${c.status}`);
  }

  h2('2. Parcours utilisateur recommande');
  bullets([
    'Si le titre charge sans fin : attendre le heal auto, ou menu → « Ca n a pas marche ».',
    'Si j aime / biblio / pin echouent pendant un DL : reessayer apres 1.3.409+ (remap ID).',
    'Si DL bloque a « Preparation serveur » : annuler (2e tap) puis relancer ; verifier Wi-Fi.',
    'Si recherche donne un cover : signaler via feedback recherche (web/mobile) pour apprendre.',
    'Ne jamais forcer une OTA : Compte → mise a jour proposee, installation volontaire.',
  ]);

  h2('3. Couches techniques (resume)');
  table(
    ['Couche', 'Role'],
    [
      ['trackReplacement', 'Seed + recherche titre/artiste, score >= 85, memoire SQLite'],
      ['ensurePlayable / streamHeal', 'Disque d abord, sinon download, sinon remplacement'],
      ['stream.ts', 'Cookies, proxies, anti-DASH, warm, redirect 302'],
      ['TrackCanonical (Android)', 'Remap local avant like / pin / DL / lecture'],
      ['OfflineDownloadManager', 'Priorite user, gate 2, remap seed avant enqueue'],
      ['OTA dual APK', 'Meme VERSION API + cloud.hubera.music + legacy'],
    ],
    [2.2, 3.8],
  );

  h2('4. Exemple bout-en-bout — Extended Mix');
  para(
    '1) Pin / biblio historique = abVAuW6XTCU (Extended). 2) Lecture : seed → PcpOcHlHiog, stream 206. ' +
      '3) Avant 1.3.409 : j aime/pin/DL restaient sur abVA → echec percu. 4) Depuis 1.3.409 : actions ciblent PcpOc. ' +
      '5) Depuis 1.3.410 : « Ca n a pas marche » force /api/track/:id/replacement et reprend la file sur l alternative.',
  );

  h2('5. Ce qui reste ouvert');
  bullets([
    'Classement recherche « titre officiel en n1 » (Dingga / Devchonka / Second souffle / She Wants Me Dead) — tache Cockpit en cours.',
    'Package hors-ligne commun Hubera ID (file sync multi-apps) — note backlog, pas ce sprint.',
    'Proxies residentiels sticky supplementaires — ops.',
    'Design system / Admin live — note DA plus tard (pas Music lecture).',
  ]);

  note('Genere automatiquement — Hubera Music scripts/qa/send-play-failure-cases-pdf.mts');
  const pages = writeFooters(`Hubera Music ${version} — cas de lecture`);
  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => {
      const st = require('fs').statSync(pdfPath);
      resolve({ path: pdfPath, pages, bytes: st.size });
    });
    stream.on('error', reject);
  });
}

async function main() {
  const pdf = await buildPdf();
  const subject = `[Hubera Music] Cas de lecture qui echouent — catalogue ${version}`;
  const html = `
    <div style="font-family:system-ui,sans-serif;line-height:1.45;color:#1a1a2e">
      <h2 style="margin:0 0 8px">Hubera Music — quand une musique ne marche pas</h2>
      <p style="margin:0 0 12px;color:#475569">PDF joint · version <b>p+${version}</b> · ${dateLabel}</p>
      <p>Catalogue des causes (ID mort, DASH, froid, bot, compte, OTA, recherche…) avec <b>exemples</b> et <b>resolution complete</b>.</p>
      <ul>
        <li><b>A–B</b> — Extended Mix Rekkt : deadId → original + like/biblio/pin/DL</li>
        <li><b>C–F</b> — DASH, cache froid, cookies/bot, heal mid-stream</li>
        <li><b>G–L</b> — hors-ligne, appel, compte, OTA, age-gate, uploads</li>
        <li><b>M</b> — mauvais resultat de recherche (encore en cours)</li>
      </ul>
      <p style="color:#475569;font-size:13px">OTA non forcee. Menu titre : action « Ca n a pas marche » depuis 1.3.410.</p>
    </div>
  `;
  const result = await sendMail({
    to,
    subject,
    html,
    text:
      `Hubera Music — cas de lecture qui echouent (p+${version}). PDF joint.\n` +
      CASES.map((c) => `${c.id}. ${c.title} — ${c.status}`).join('\n'),
    attachments: [
      {
        filename: `Hubera-Music-cas-lecture-${version}.pdf`,
        content: readFileSync(pdf.path),
        contentType: 'application/pdf',
      },
    ],
  });
  writeFileSync(
    join(OUT, 'mail-result.json'),
    JSON.stringify({ to, subject, pdf, result }, null, 2),
  );
  // Copie aussi sous Docs content/reports pour Cockpit
  const docsReport = join(
    '/home/pactivisme/Documents/Dev/Perso/HuberaDocs/content/reports',
    `2026-10-30-music-cas-lecture-${version}.pdf`,
  );
  try {
    writeFileSync(docsReport, readFileSync(pdf.path));
  } catch {
    /* ignore */
  }
  console.log(JSON.stringify({ ok: true, to, pdf, result, docsReport: existsSync(docsReport) ? docsReport : null }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
