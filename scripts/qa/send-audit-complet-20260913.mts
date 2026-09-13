/**
 * Audit complet PLM — checklist + PDF densifié + e-mail
 *   node --env-file=.env --import tsx scripts/qa/send-audit-complet-20260913.mts
 *
 * Polices Liberation Sans (accents FR lisibles — pas Helvetica).
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { sendMail } from '../../api/src/platform/mail.ts';

const to =
  process.env.AUDIT_REPORT_TO?.trim() ||
  process.env.REPORT_TO?.trim() ||
  process.env.BATTERY_REPORT_TO?.trim() ||
  'dev@delhomme.ovh, paveldelhomme@gmail.com';

const OUT_DIR = join(process.cwd(), 'tmp', 'report-2026-09-13-audit-complet');
mkdirSync(OUT_DIR, { recursive: true });

const iso = new Date().toISOString();
const version = readFileSync(join(process.cwd(), 'VERSION'), 'utf8').trim();
const checklistPath = join(
  process.cwd(),
  'docs/audits/CHECKLIST-AMELIORATIONS-2026-09-13.md',
);
const checklistMd = existsSync(checklistPath)
  ? readFileSync(checklistPath, 'utf8')
  : '(checklist absente)';

const FONT_REG = '/usr/share/fonts/liberation/LiberationSans-Regular.ttf';
const FONT_BOLD = '/usr/share/fonts/liberation/LiberationSans-Bold.ttf';

async function buildPdf(): Promise<{ path: string; pages: number }> {
  const require = createRequire(import.meta.url);
  const PDFDocument = require(
    '/home/pactivisme/Documents/Dev/Perso/GasoilTracking/scripts/reports/node_modules/pdfkit',
  );
  const pdfPath = join(OUT_DIR, `PLM-audit-complet-${version}.pdf`);
  const doc = new PDFDocument({
    margin: 48,
    size: 'A4',
    bufferPages: false,
    autoFirstPage: true,
    info: {
      Title: 'PLM — Audit complet UI, batterie, mobile, web, API',
      Author: 'PLM / Cursor',
      Subject: `13 sept. 2026 · baseline p+${version}`,
      Keywords: 'PLM, batterie, UI, Android, API, checklist',
    },
  });
  doc.registerFont('Body', FONT_REG);
  doc.registerFont('Bold', FONT_BOLD);

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  const LEFT = () => doc.page.margins.left;
  const WIDTH = () => doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const BOTTOM = () => doc.page.height - doc.page.margins.bottom - 8;

  const ensure = (need = 52) => {
    if (doc.y + need > BOTTOM()) doc.addPage();
    doc.x = LEFT();
  };
  const h1 = (t: string) => {
    ensure(64);
    doc.moveDown(0.25);
    doc.font('Bold').fontSize(12.5).fillColor('#111111').text(t, LEFT(), doc.y, {
      width: WIDTH(),
      underline: true,
    });
    doc.moveDown(0.28);
    doc.font('Body').fontSize(9.35).fillColor('#222222');
  };
  const h2 = (t: string) => {
    ensure(40);
    doc.moveDown(0.16);
    doc.font('Bold').fontSize(10.2).fillColor('#1a1a1a').text(t, LEFT(), doc.y, { width: WIDTH() });
    doc.moveDown(0.18);
    doc.font('Body').fontSize(9.35).fillColor('#333333');
  };
  const p = (t: string) => {
    ensure(26);
    doc.font('Body').fontSize(9.35).fillColor('#333333').text(t, LEFT(), doc.y, {
      width: WIDTH(),
      align: 'justify',
      lineGap: 1.65,
    });
    doc.moveDown(0.26);
  };
  const bullet = (t: string) => {
    ensure(16);
    doc.font('Body').fontSize(9.2).fillColor('#333333').text(`•  ${t}`, LEFT(), doc.y, {
      width: WIDTH(),
      indent: 4,
      lineGap: 1.35,
    });
  };
  const tag = (label: string, t: string) => {
    ensure(16);
    doc
      .font('Bold')
      .fontSize(9.1)
      .fillColor('#b91c1c')
      .text(`[${label}] `, LEFT(), doc.y, { continued: true, width: WIDTH() });
    doc.font('Body').fillColor('#333333').text(t, { width: WIDTH() - 8, lineGap: 1.3 });
  };

  // ——— Garde ———
  doc.font('Bold').fontSize(17).fillColor('#000000').text('PLM — Audit technique complet', LEFT(), doc.y, {
    width: WIDTH(),
  });
  doc.moveDown(0.25);
  doc
    .font('Body')
    .fontSize(10.4)
    .fillColor('#444444')
    .text('UI · Mouvements · Batterie · Mobile Android · Web · API serveur · Processus', {
      width: WIDTH(),
    });
  doc.moveDown(0.35);
  doc.fontSize(9.2).fillColor('#555555');
  doc.text(`Date : ${new Date().toLocaleString('fr-FR')}   ·   ISO : ${iso}`, { width: WIDTH() });
  doc.text(`Baseline livrée : p+${version} (DnD file + Accès rapide déjà en prod)`, { width: WIDTH() });
  doc.text(`Checklist MD : docs/audits/CHECKLIST-AMELIORATIONS-2026-09-13.md`, { width: WIDTH() });
  doc.text(`Destinataires : ${to}`, { width: WIDTH() });
  doc.text('Canal SMTP : production PLM · pièce jointe PDF densifié (polices Liberation Sans)', {
    width: WIDTH(),
  });
  doc.moveDown(0.3);
  p(
    'Ce rapport archive l’état du projet après la vague 1.3.230 et pose la feuille de route complète pour demain après-midi et les sessions suivantes. Il couvre les drains batterie réels (radio, prefetch, Exo clip, boucles idle), les gestes UI encore en dessous du niveau YouTube Music, les payloads API trop gros, et la parité web. Une série de correctifs P0 a déjà été codée dans la branche feat/audit-battery-ui-improvements-231 — à valider sur Samsung puis Nothing avant promo prod.',
  );
  p(
    'Règle de lecture : les balises [FAIT] sont dans la branche audit ; [P0]/[P1]/[P2] restent à planifier ; [SKIP-230] = déjà livré, ne pas refaire. La checklist Markdown est la source de vérité opérationnelle — ce PDF en est la version narrative densifiée.',
  );

  h1('1. Contexte produit et contraintes');
  p(
    'PLM (YTMusic) est une stack personnelle : API Node sur VPS, clients web + Android natif Compose, flavors d+/b+/p+. Pipeline strict : local (API LAN) → Samsung (gate) → merge dev → Nothing (gate) → preprod allowlist → prod compte pavel@. Les notes VERSION_NOTES.json doivent être synchronisées web + assets Android avant toute promo.',
  );
  h2('1.1 Non-négociables');
  bullet('Ne jamais purger les fichiers offline (.m4a / .mp4) pour « économiser »');
  bullet('Ne retirer aucune fonctionnalité (sync, mix, paroles, Cast, OTA, DL)');
  bullet('QA Samsung : volume musique coupé pendant installs');
  bullet('Pas de promo prod sans gate Samsung puis Nothing sur canal dev');
  h2('1.2 Appareils');
  bullet('Samsung SM-G990B2 (R5CT7263YJL) — premier gate local / crash DEX / batterie');
  bullet('Nothing Phone — gate après merge ; usage quotidien pavel@ en prod');
  bullet('Blackview — optionnel, même allowlist');

  h1('2. Ce qui vient d’être livré (p+1.3.230)');
  p(
    'Réordonnancement Accès rapide et file d’attente : remplacement du swap titre-par-titre (seuil 40 dp) par un drag fluide style YouTube Music — long-press ou poignée, élévation, auto-scroll haut/bas, commit warm différé. Fichiers : DragReorder.kt, QuickAccessScreen, HomeScreen sheet, NowPlayingScreen QueueTrackRow, PlayerController.moveInQueue(warm=false). Junk racine 0.0 / 85 / 88 / 89 (fichiers vides) supprimés.',
  );
  bullet('[SKIP-230] Ne pas replanifier le DnD Android file / pins');
  bullet('Reste ouvert : parité DnD web (HTML5 ghost / flèches Accès rapide)');

  h1('3. Correctifs déjà codés (branche audit — à tester demain)');
  h2('3.1 Batterie / radio');
  tag('FAIT', 'Warm trackVisual uniquement en mode Vidéo (VideoPlaybackHost) — stoppe le réseau en audio-only');
  tag('FAIT', 'DisposableEffect cancel VisualClipPrefetcher au démontage Now Playing');
  tag('FAIT', 'NetworkMonitor : poll 60 s online / 12 s offline (plus 8 s permanent)');
  tag('FAIT', 'LibraryHeadPrefetcher : pause ticks si ProcessLifecycle STOPPED (BG 15 min)');
  tag('FAIT', 'Heartbeat session HTTP seulement si receiveRemoteSync()');
  tag('FAIT', 'Miroir remote : sleep 45 s si sync off (plus de wakeups 2–6 s)');
  h2('3.2 UI + serveur');
  tag('FAIT', 'onQueueDrag : snapTo UNDISPATCHED (moins de saccades à l’ouverture file)');
  tag('FAIT', 'streamHeal cooldown : bumpWarmPriority seulement, plus de ré-enqueue saturant');
  p(
    'Protocole demain : install PLM Dev Samsung → idle 10 min écran off (logcat sans storm shuffle-heads / trackVisual) → audio-only skips → mode Vidéo open/close sheet → drag file → sync off sans heartbeat 4 s → Nothing → éventuellement promo.',
  );

  h1('4. Batterie Android — inventaire exhaustif');
  p(
    'Pas de wake lock manuel custom ni WifiLock. La conso vient des boucles process-lifetime, du prefetch agressif, du second ExoPlayer en mode clip, et des timers Compose même hors sync. WorkManager absent : OfflineKeeper et LibHeads tournent dans le process app.',
  );
  h2('4.1 P0 restants');
  tag('P0', 'SyncedVideoSurface : stop + clearMediaItems quand clip inactif (pas seulement pause) — WAKE_MODE_NETWORK + decode GPU');
  tag('P0', 'Une seule file StreamPrefetcher (fusion rolling / warmAround / LibHeads) + hard-cap 1 far-prefetch en play');
  tag('P0', 'Déjà partiellement traité : visual warm, LibHeads BG, NetworkMonitor, session loops');
  h2('4.2 P1');
  tag('P1', 'OfflineKeeper → WorkManager Wi-Fi + charge');
  tag('P1', 'PlaybackIdleGuard : demote FGS après 20–30 min pause BG (au lieu de 6 h)');
  tag('P1', 'Couper WAKE_MODE_NETWORK si !isPlaying');
  tag('P1', 'Ticks position : seulement Activity STARTED + écran on ; paroles sans poll 48 ms');
  tag('P1', 'Gate Log.* release via AppLog + rate-limit hot path');
  tag('P1', 'Biblio 14k : pas de playableQueue entière en RAM ; throttle boostVisible');
  h2('4.3 Matrice BatterySaver (rappel)');
  bullet('Normal (>35 %) : prefetch large ; clips ahead ~5 ; ticks ~400 ms ; IdleGuard ~20 min');
  bullet('Soft (≤35 %) : fenêtre ~½ ; clips ahead 2 ; covers ahead 1 ; IdleGuard ~12 min');
  bullet('Actif (≤20 % / Power Save) : ahead = 1 ; warm visual courant ; IdleGuard ~8 min');
  bullet('Garanti : lecture, file, mix, paroles, sync, Cast, OTA, DL manuels ; jamais delete offline/*');
  h2('4.4 Critères de done batterie');
  bullet('Idle 15 min sync off : 0 appel shuffle-heads / trackVisual / session/state');
  bullet('Audio-only 20 min : pas de 2e Exo clip ; pas de warm visual');
  bullet('Vidéo puis sheet fermé : Exo clip arrêté');
  bullet('Observation Nothing : PLM pas anormalement haut vs YTM sur même session');

  h1('5. Mouvements UI et interface Android');
  p(
    'Le DnD 1.3.230 corrige le pire (réordonnancement). Il reste des gestes qui « snappent » ou popent : file expand, dismiss mini-player, ouverture NP, swipe cover. Objectif : spring + VelocityTracker + haptics comme YTM.',
  );
  h2('5.1 P0 motion');
  tag('P0', 'VelocityTracker pour fling expand/collapse file (fin de drag approximatif aujourd’hui)');
  tag('P0', 'Mini-player : spring snap-back + haptic Confirm (seuil 56 dp trop bas)');
  tag('P0', 'Morph cover mini → NP (remplacer tween 0 / slide 90 ms)');
  h2('5.2 P1 sheets / listes / nav');
  tag('P1', 'dismissArmed 420 ms → seuil + vélocité / anchoredDraggable');
  tag('P1', 'Swipe cover : spring + haptic + crossfade');
  tag('P1', 'Uniformiser ModalBottomSheet (TrackActions vs Cast/EQ/History)');
  tag('P1', 'Library sticky chips + skeletons ; Home shimmer');
  tag('P1', 'Haptics NP ; NavHost fade/slide ; placeholders hauteur fenêtre progressive');
  h2('5.3 P2 polish');
  tag('P2', 'Tokens couleur unifiés Theme / Player / web');
  tag('P2', 'Empty states illustrés + CTA');
  tag('P2', 'A11y seek slider / descriptions ; hit-targets 48 dp ; snap LazyRow ; paroles scale');

  h1('6. Application web');
  p(
    'Le web a déjà de bons squelettes Home et un PlayerBar accessible, mais la file et l’Accès rapide sont en retard sur Android 1.3.230. Le poll biblio 20 s + library() full à chaque refresh est un drain serveur et radio navigateur.',
  );
  tag('P0', 'DnD file pointer (insert line, élévation) — TrackRow / QueuePanel / NowPlaying');
  tag('P0', 'Accès rapide : drag fluide (supprimer flèches swap) — HomePage');
  tag('P0', 'library({ light: true }) au boot ; full seulement onglet Biblio');
  tag('P1', 'Stop poll 20 s → ETag / WS library.changed');
  tag('P1', 'Prefetch stream : baisser concurrency ; pause tab hidden');
  tag('P1', 'NP sheet bottom + swipe dismiss');
  tag('P2', 'ProxyHealth 60–120 s ; Admin poll 15 s ; rAF seek ; React.lazy detail/admin');

  h1('7. Backend API — endpoints chauds et correctifs');
  p(
    'Déjà solide : gzip JSON, library light partiel, warm queue, head RAM, gate yt-dlp, shuffle-heads rotatif, taste warm, streamHeal. Les gains restants : payloads, redondance warm, heartbeats HTTP Android, tempêtes telemetry→heal.',
  );
  h2('7.1 Endpoints chauds mobile');
  bullet('GET /api/stream/:id (+ ranges Exo) — continu lecture / prefetch');
  bullet('POST /api/stream/warm — file + biblio');
  bullet('GET /api/library (+ light) — ouverture / refresh (payload massif si full)');
  bullet('GET /api/library/shuffle-heads — ~90 s client + warm serveur');
  bullet('GET /api/home — cold start (reco + taste + shuffle)');
  bullet('PUT /api/session/state — heartbeat 4–12 s si sync');
  bullet('POST /api/telemetry(+batch) — stalls → heal');
  bullet('GET /api/img — scroll listes (cache OK, volume HTTP)');
  h2('7.2 P0 API');
  tag('FAIT', 'Heal cooldown sans ré-enqueue (bump only)');
  tag('P0', 'Budget warm global / user / min — priorité playing > next2 > shuffle > taste');
  tag('P0', '/api/home sans double-warm si taste déjà planifié');
  tag('P0', 'Library pagination + ETag ; mutations sans getFullLibrary');
  tag('P0', 'Session Android : WS ou progress-only 15–30 s');
  tag('P0', 'Telemetry batch : INSERT transaction + heal unique max 5 ids');
  h2('7.3 P1 / P2 API');
  tag('P1', 'Format URL cache SQLite durable ; stream_log prune 5 % ; /stream/:id/ready');
  tag('P1', 'Skip authOptional sur /api/img + health ; indexes telemetry');
  tag('P1', 'LOG_LEVEL + sampler warm/heal');
  tag('P2', 'Debounce listen 30 s ; POST /playback/tick ; ANALYZE PG ; métriques warm dans /health');

  h1('8. Processus, ops, qualité');
  bullet('Pipeline release inchangé (release-pipeline.mdc)');
  bullet('Toute promo : VERSION_NOTES + sync web/assets + bump VERSION');
  bullet('Script QA batterie Samsung idle+lecture → JSON (à industrialiser)');
  bullet('Admin : warm queue depth / heal rate / yt-dlp cooldown (dashboard)');
  bullet('Alerte mail si heal storms > N / 10 min');
  bullet('Doc future : docs/OPS-BATTERY.md (matrice BatterySaver + IdleGuard)');

  h1('9. Plan de sessions (ordre d’attaque)');
  p(
    'Session A (demain PM) : valider tous les [FAIT] Samsung + Nothing, merge → dev, promo si OK. Session B : Exo clip stop + prefetch unique. Session C : gestes NP / mini / morph. Session D : library light + ETag + telemetry batch. Session E : parité web DnD + light. Session F : polish sheets / a11y / skeletons.',
  );
  bullet('Ne jamais court-circuiter Samsung → Nothing');
  bullet('Une PR = un sujet (feat/fix/misc) depuis dev');
  bullet('Notes utilisateur avant chaque numéro déployé');

  h1('10. Risques et anti-patterns à éviter');
  bullet('Ne pas « optimiser » en supprimant offline ou Cast');
  bullet('Ne pas relancer warm visual en audio-only');
  bullet('Ne pas poller session/state si sync multi-appareils est off');
  bullet('Ne pas enqueue heal pendant cooldown (saturait yt-dlp)');
  bullet('Ne pas gonfler NowPlayingScreen (VerifyError DEX Samsung — déjà vécu 1.3.223)');
  bullet('Ne pas mélanger flavors d+/p+ ni comptes dev@ / pavel@');

  h1('11. Annexe — cases checklist (extrait)');
  p(
    'Source : docs/audits/CHECKLIST-AMELIORATIONS-2026-09-13.md. Cases principales à cocher demain et ensuite :',
  );
  const lines = checklistMd
    .split('\n')
    .filter((l) => l.startsWith('- [') || /^#{2,3} /.test(l))
    .slice(0, 70);
  for (const line of lines) {
    ensure(14);
    const isHead = line.startsWith('#');
    doc
      .font(isHead ? 'Bold' : 'Body')
      .fontSize(isHead ? 9 : 8.1)
      .fillColor(isHead ? '#111111' : '#444444')
      .text(line.replace(/^#+\s*/, ''), LEFT(), doc.y, { width: WIDTH(), lineGap: 0.8 });
  }
  doc.moveDown(0.3);

  h1('12. Détail technique des correctifs [FAIT]');
  h2('12.1 VideoPlaybackHost');
  p(
    'Le LaunchedEffect de warm silencieux dépend maintenant de SessionMediaMode.video. En audio-only, aucun appel trackVisual pour le courant ni les suivants. Un DisposableEffect appelle VisualClipPrefetcher.cancel() quand le composable NP se démonte (fermeture sheet après ~160 ms), ce qui coupe les jobs SupervisorJob qui survivaient autrement.',
  );
  h2('12.2 NetworkMonitor');
  p(
    'Avant : Handler.postDelayed 8000 ms en permanence, même online stable, en plus des NetworkCallback. Après : si online, rescan au plus toutes les 60 s ; si offline, 12 s pour rattraper un handover 4G. Les callbacks restent la source de vérité.',
  );
  h2('12.3 LibraryHeadPrefetcher');
  p(
    'Observer ProcessLifecycleOwner : onStop met appForeground=false. La boucle while(true) fait alors delay(15 min) sans tick ni shuffle-heads. Au retour foreground, le rythme 90 s reprend. Réduit fortement la radio en lecture casque écran off avec app en arrière-plan.',
  );
  h2('12.4 Session multi-appareils');
  p(
    'Heartbeat publishPlayback pendant lecture : early-return si !receiveRemoteSync(). Miroir remote en pause : si sync off, sleep 45 s au lieu de poller toutes les 2–6 s puis continue. Quand un seul appareil est utilisé (cas quotidien Nothing), plus de trafic session inutile.',
  );
  h2('12.5 streamHeal');
  p(
    'Pendant le cooldown 8 minutes, healTrackFromTelemetry appelait encore enqueueStreamWarm, ce qui pouvait AJOUTER l’id à la file si absent et saturer yt-dlp sous rafale telemetry. Désormais : bumpWarmPriority(id) uniquement (no-op si pas en queue). Le premier heal hors cooldown continue d’enqueue stream + disk.',
  );
  h2('12.6 onQueueDrag');
  p(
    'Chaque delta lançait scope.launch { snapTo } : file de coroutines et snaps en retard. CoroutineStart.UNDISPATCHED exécute snapTo immédiatement sur le thread courant jusqu’au premier point de suspension — ressenti plus collé au doigt.',
  );

  h1('13. Synthèse exécutive');
  p(
    'Priorité absolue batterie : ne plus réveiller la radio en idle — largement adressé dans la branche audit (LibHeads BG, NetworkMonitor, session sync off, visual warm audio-only). Priorité absolue UI : sensation YTM sur expand file / mini / ouverture NP, puis porter le DnD au web. Priorité serveur : library light+ETag et budget warm. Demain après-midi = validation appareil des [FAIT], pas une nouvelle big-bang feature.',
  );
  bullet(`Version baseline PDF : p+${version}`);
  bullet('Branche correctifs : feat/audit-battery-ui-improvements-231');
  bullet('Checklist : docs/audits/CHECKLIST-AMELIORATIONS-2026-09-13.md');
  bullet('Prochaine action humaine : lire ce mail le matin, tester l’après-midi');
  doc.moveDown(0.4);
  doc.font('Body').fontSize(8).fillColor('#888888');
  doc.text(`PLM audit · p+${version} · fin du document`, LEFT(), doc.y, {
    width: WIDTH(),
    align: 'right',
  });

  await new Promise<void>((resolve, reject) => {
    doc.on('end', () => {
      try {
        writeFileSync(pdfPath, Buffer.concat(chunks));
        resolve();
      } catch (e) {
        reject(e);
      }
    });
    doc.end();
  });

  let pages = 1;
  try {
    const info = execSync(`pdfinfo ${JSON.stringify(pdfPath)}`, { encoding: 'utf8' });
    const m = info.match(/Pages:\s+(\d+)/);
    if (m) pages = Number(m[1]);
  } catch {
    /* ignore */
  }
  return { path: pdfPath, pages };
}

const { path: pdfPath, pages } = await buildPdf();
console.log('PDF →', pdfPath, `pages=${pages}`);

{
  const txt = execSync(`pdftotext -layout ${JSON.stringify(pdfPath)} -`, { encoding: 'utf8' });
  const pageTexts = txt.split('\f');
  const stats = pageTexts.map((t, i) => ({
    i: i + 1,
    chars: t.replace(/\s+/g, '').length,
  }));
  console.log('densité:', stats);
  const realThin = stats.filter((x) => x.chars > 0 && x.chars < 500);
  if (realThin.some((x) => x.chars < 120)) {
    throw new Error('PDF trop vide sur au moins une page — refuser l’envoi');
  }
  if (realThin.length) {
    console.warn('Pages un peu légères:', realThin);
  } else {
    console.log('Densité OK');
  }
  // Smoke accents
  if (!txt.includes('Améliorations') && !txt.includes('amélioration') && !txt.includes('Batterie')) {
    console.warn('Attention: vérifier encodage accents dans le PDF');
  }
  if (txt.includes('Am') && txt.includes('lior') && /Am\W+lior/.test(txt)) {
    console.warn('Accents potentiellement cassés');
  }
}

const subject = `[PLM] Audit complet UI / batterie / API (~${pages} p.) — checklist demain · p+${version}`;

const text = `PLM — Audit technique complet
Date: ${iso}
Version baseline: p+${version}
PDF: ${pdfPath} (${pages} pages)
Checklist: docs/audits/CHECKLIST-AMELIORATIONS-2026-09-13.md

Correctifs [FAIT] dans feat/audit-battery-ui-improvements-231 :
- warm visual uniquement mode Video
- cancel VisualClipPrefetcher au dispose
- NetworkMonitor sans poll 8s
- LibHeads pause en arriere-plan
- heartbeat / miroir session gates sync
- queue drag moins saccade
- streamHeal cooldown sans re-enqueue

A tester demain apres-midi (Samsung puis Nothing).
`;

const html = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:0;background:#f4f4f5;color:#18181b">
  <div style="max-width:680px;margin:24px auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;font-family:Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;line-height:1.55">
    <div style="background:#18181b;color:#fafafa;padding:22px 28px">
      <div style="font-size:13px;letter-spacing:0.04em;opacity:0.75;text-transform:uppercase">PLM · Rapport d'audit</div>
      <h1 style="margin:6px 0 0;font-size:22px;font-weight:700;line-height:1.25">UI, batterie, mobile, web et API</h1>
      <p style="margin:10px 0 0;font-size:14px;opacity:0.85">Baseline <strong>p+${version}</strong> · ${pages} pages PDF · ${new Date().toLocaleString('fr-FR')}</p>
    </div>
    <div style="padding:22px 28px;font-size:15px;color:#27272a">
      <p style="margin:0 0 14px">Bonjour — voici le <strong>rapport densifié</strong> + la checklist à suivre à la lettre demain après-midi. Les accents sont en UTF-8 ; le PDF utilise Liberation Sans (lisible, pas de symboles cassés).</p>
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px 16px;margin:0 0 18px">
        <div style="font-weight:700;color:#991b1b;margin-bottom:6px">Déjà codé — à valider demain</div>
        <ul style="margin:0;padding-left:18px;color:#7f1d1d">
          <li>Warm <code>trackVisual</code> seulement en mode Vidéo</li>
          <li>Cancel prefetch clips au démontage NP</li>
          <li>NetworkMonitor / LibHeads / session sync : moins de wakeups idle</li>
          <li>Drag file moins saccadé + heal serveur sans saturation</li>
        </ul>
      </div>
      <p style="margin:0 0 10px"><strong>Ordre de test :</strong> Samsung PLM Dev → idle + audio/vidéo + drag file → Nothing → (si OK) merge <code>dev</code> puis promo.</p>
      <p style="margin:0 0 10px"><strong>Checklist MD :</strong> <code>docs/audits/CHECKLIST-AMELIORATIONS-2026-09-13.md</code> (cases [FAIT] / [P0] / [P1] / [P2]).</p>
      <p style="margin:0 0 18px">Le PDF joint détaille mobile, web, API, matrice batterie, risques VerifyError, et le plan de sessions A→F.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin:0 0 8px">
        <tr>
          <td style="padding:8px 10px;background:#f4f4f5;border:1px solid #e4e4e7;width:38%"><strong>Pièce jointe</strong></td>
          <td style="padding:8px 10px;border:1px solid #e4e4e7">PLM-audit-complet-${version}.pdf (${pages} p.)</td>
        </tr>
        <tr>
          <td style="padding:8px 10px;background:#f4f4f5;border:1px solid #e4e4e7"><strong>Branche</strong></td>
          <td style="padding:8px 10px;border:1px solid #e4e4e7">feat/audit-battery-ui-improvements-231</td>
        </tr>
        <tr>
          <td style="padding:8px 10px;background:#f4f4f5;border:1px solid #e4e4e7"><strong>Hors scope</strong></td>
          <td style="padding:8px 10px;border:1px solid #e4e4e7">DnD Android 1.3.230 déjà en prod — ne pas refaire</td>
        </tr>
      </table>
    </div>
    <div style="padding:14px 28px 22px;font-size:12px;color:#71717a;border-top:1px solid #f4f4f5">
      SMTP prod PLM · destinataires ${to.replace(/</g, '&lt;')} · généré automatiquement
    </div>
  </div>
</body>
</html>`;

const r = await sendMail({
  to,
  subject,
  html,
  text,
  attachments: [
    {
      filename: `PLM-audit-complet-${version}.pdf`,
      content: readFileSync(pdfPath),
      contentType: 'application/pdf',
    },
  ],
});

writeFileSync(
  join(OUT_DIR, 'mail-result.json'),
  JSON.stringify({ ok: true, r, pages, version, iso, checklistPath, pdfPath }, null, 2),
);
console.log('mail →', r);
