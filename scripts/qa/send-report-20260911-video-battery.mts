/**
 * Rapport densifié ~10 pages (sans pages vides) — vidéo / batterie / VerifyError
 *   node --env-file=.env --import tsx scripts/qa/send-report-20260911-video-battery.mts
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { sendMail } from '../../api/src/platform/mail.ts';

const to =
  process.env.BATTERY_REPORT_TO?.trim() ||
  process.env.REPORT_TO?.trim() ||
  '';

const OUT_DIR = join(process.cwd(), 'tmp', 'report-2026-09-11-video-battery');
mkdirSync(OUT_DIR, { recursive: true });

const iso = new Date().toISOString();
const version = readFileSync(join(process.cwd(), 'VERSION'), 'utf8').trim();

async function buildPdf(): Promise<{ path: string; pages: number }> {
  const require = createRequire(import.meta.url);
  const PDFDocument = require(
    '/home/pactivisme/Documents/Dev/Perso/GasoilTracking/scripts/reports/node_modules/pdfkit',
  );
  const pdfPath = join(OUT_DIR, 'PLM-rapport-video-batterie-2026-09-11.pdf');
  const doc = new PDFDocument({
    margin: 50,
    size: 'A4',
    bufferPages: true,
    info: {
      Title: 'PLM — Rapport vidéo, clip, batterie & stabilisation',
      Author: 'PLM / Cursor',
      Subject: `Session 11 sept. 2026 · ${version}`,
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  const BOTTOM = 792;
  const ensure = (need = 54) => {
    if (doc.y + need > BOTTOM) doc.addPage();
  };
  const h1 = (t: string) => {
    ensure(68);
    doc.moveDown(0.3);
    doc.fontSize(12.5).fillColor('#111').text(t, { underline: true });
    doc.moveDown(0.32);
    doc.fontSize(9.4).fillColor('#222');
  };
  const h2 = (t: string) => {
    ensure(42);
    doc.moveDown(0.18);
    doc.fontSize(10.2).fillColor('#222').text(t);
    doc.moveDown(0.2);
    doc.fontSize(9.4).fillColor('#333');
  };
  const p = (t: string) => {
    ensure(28);
    doc.fontSize(9.4).fillColor('#333').text(t, { align: 'justify', lineGap: 1.75 });
    doc.moveDown(0.28);
  };
  const bullet = (t: string) => {
    ensure(18);
    doc.fontSize(9.3).fillColor('#333').text(`• ${t}`, { indent: 6, lineGap: 1.5 });
  };

  // ——— Page de garde densifiée ———
  doc.fontSize(17).fillColor('#000').text('PLM — Rapport technique détaillé');
  doc.moveDown(0.2);
  doc.fontSize(10.5).fillColor('#444').text('Vidéo · Clip · Batterie · Crash VerifyError · Correctif p+1.3.224');
  doc.moveDown(0.35);
  doc.fontSize(9.3).fillColor('#555');
  doc.text(`Date : ${new Date().toLocaleString('fr-FR')}   ·   ISO : ${iso}`);
  doc.text(`Version livrée : p+${version} (versionCode Android dérivé du sémver)`);
  doc.text(`Destinataires : ${to}`);
  doc.text('Canal SMTP : production PLM (maily.ovh) · pièce jointe PDF densifié');
  doc.moveDown(0.3);
  p(
    'Ce document remplace le précédent rapport PDF (pages quasi vides causées par des doc.addPage() forcés avant chaque annexe courte). Ici le texte coule en continu : saut de page uniquement quand la marge basse est atteinte. Contenu : objectifs session, chronologie 1.3.218→1.3.224, diagnostic complet de l’alerte e-mail VerifyError, architecture mode Vidéo, téléchargements, batterie, API, checklist, décisions UX, synthèse.',
  );
  p(
    'Public : revue technique perso (dev@ / pavel@). Niveau de détail volontairement élevé pour archivage et relecture sans devoir rouvrir le chat Cursor.',
  );

  h1('1. Contexte, objectifs et contraintes');
  p(
    'L’utilisateur a demandé une expérience vidéo proche d’un lecteur multimédia classique sur Android PLM. Concrètement : ouvrir la file d’attente ne doit ni couper ni pauser le clip — uniquement masquer la surface et reprendre à la même position ; associer la durée du clip au titre pour que la seekbar soit cohérente ; le plein écran doit être le vrai flux Exo (pas une capture) et ne doit plus se refermer tout de suite (ghost-tap / Dialog). Ajouts : télécharger aussi les vidéos avec les titres ; option Compte pour l’overlay FS (seek, play/pause, prev/next, quitter) ; tests Blackview ; améliorations batterie sans perte de données ; suppression de l’écran plein « Recherche du clip… » ; rapport multi-pages par e-mail.',
  );
  h2('1.1 Contraintes non négociables');
  bullet('Ne jamais supprimer les fichiers offline (.m4a / .mp4) pour « économiser »');
  bullet('Ne retirer aucune fonctionnalité (sync, mix, paroles, Cast, OTA, DL utilisateur…)');
  bullet('Pipeline release : local → Samsung → merge dev → Nothing → preprod → prod');
  bullet('QA Samsung : volume musique coupé (STREAM_MUSIC=0) pendant les installs');
  bullet('Notes VERSION_NOTES.json synchronisées web + assets Android avant déploiement');
  h2('1.2 Appareils de référence');
  bullet('Samsung SM-G990B2 (R5CT7263YJL) — premier gate local / crash VerifyError / install p+');
  bullet('Nothing Phone — gate après merge/OTA ; usage quotidien compte pavel@ en prod');
  bullet('Blackview BV9700Pro — QA automatisée lecteur + observation clips offline');

  h1('2. Chronologie des versions de la session');
  p(
    'Chaque patch a été installé en flavor prod (p+) sur la flotte perso et publié OTA quand pertinent. La table ci-dessous est la mémoire opérationnelle de la vague.',
  );
  for (const [v, d] of [
    ['1.3.218', 'Plein écran unique Exo + prefetch clips sur la file'],
    ['1.3.219', 'File ouverte : NP reste composé (alpha 0) sous le panneau — plus de pause/coupe ; durée clip → VisualIdCache + applyKnownDurationMs'],
    ['1.3.220', 'FS stable : overlay (plus Dialog) + anti ghost-tap ~520 ms + paysage/portrait via ActivityInfo'],
    ['1.3.221', 'DL audio+vidéo parallèle ; overlay FS multimédia ; option Compte ; lecture .mp4 offline'],
    ['1.3.222', 'BatterySaver élargi (≤20 % / Power Save + soft ≤35 %) ; IdleGuard coupe réseau plus tôt sans purge offline'],
    ['1.3.223', 'Plus d’écran « Recherche du clip… » ; warm silencieux visualId ; Coil mémoire/disque allégés'],
    ['1.3.224', 'Fix fatal VerifyError DEX : extraction VideoPlaybackHost hors NowPlayingScreen ; compile + install Samsung OK'],
  ] as const) {
    bullet(`${v} — ${d}`);
  }

  h1('3. L’e-mail d’erreur reçu — ce n’était pas le rapport SMTP');
  p(
    'Confusion possible : un e-mail d’erreur est arrivé peu après le rapport PDF. Ce n’est pas un échec d’envoi du PDF (le SMTP maily.ovh avait répondu 250 OK). C’est l’alerte télémétrie PLM (fatal android.crash) déclenchée automatiquement quand l’APK p+1.3.223 plantait à l’ouverture de Now Playing en mode Vidéo sur Samsung. Le pipeline mail d’erreurs a fait son travail.',
  );
  h2('3.1 Signature technique');
  bullet('Exception : java.lang.VerifyError');
  bullet('Message type : Verifier rejected class …NowPlayingScreenKt.NowPlayingScreen(…)');
  bullet('Indice DEX : copy-cat1 v0<-v273 type=Composer — frame avec trop de registres locaux');
  bullet('Surface : composition Now Playing / branche SessionMediaMode.video');
  bullet('Effet : crash immédiat à l’ouverture NP → UncaughtExceptionHandler → POST /api/telemetry → e-mail');
  h2('3.2 Pourquoi ça casse (cause racine)');
  p(
    'NowPlayingScreen.kt était devenu un monolithe Compose : file d’attente, paroles, seek, Cast, save queue, equalizer, et toute la logique vidéo (resolve visualId deux temps, warm silencieux, plein écran, sync position clip↔player, orientation). Le compilateur Compose génère alors une méthode dont le frame DEX dépasse ce que le vérifieur ART accepte sur certains appareils (Samsung en particulier). Ce n’est ni un 502 stream, ni un bug Exo, ni un problème OAuth TV : c’est une limite de taille de méthode / registres.',
  );
  h2('3.3 Correctif structurel 1.3.224');
  bullet('Fichier nouveau : ui/player/VideoPlaybackHost.kt');
  bullet('Classe VideoPlaybackUi : streamUrl, error, visualId, resolving, fullscreen, fsTapArmed, fsMediaControls, lastClipPosMs, lastPrevTap');
  bullet('rememberVideoPlaybackUi(player, ui, container, sheetVisible) : tous les LaunchedEffect resolve/warm/orientation + BackHandler FS');
  bullet('VideoFullscreenOverlay(…) : surface Exo plein écran + contrôles + sync seek');
  bullet('NowPlayingScreen : val video = rememberVideoPlaybackUi(…) puis branche inline + appel overlay');
  bullet('Validation : ./gradlew :app:compileProdReleaseKotlin OK ; install p+1.3.224 Samsung Success ; versionName=p+1.3.224');
  p(
    'Pourquoi ça marche : la méthode composable NowPlayingScreen redescend sous le seuil de registres du vérifieur. L’UX file / FS / contrôles reste identique. Aucun changement de contrat API ni de préférences utilisateur.',
  );

  h1('4. « Recherche du clip… » — diagnostic et correctifs 1.3.223');
  p(
    'Avant 1.3.223, si aucun visualId n’était en cache, l’UI affichait un spinner + libellé plein cadre pendant jusqu’à ~5,5 s. Cette attente (waitMs API) sert à éviter les ID Topic audio-only, mais bloquait inutilement la perception de rapidité. L’utilisateur voyait un écran vide/attente au lieu de la pochette déjà connue.',
  );
  h2('4.1 Stratégie retenue');
  bullet('Pochette immédiate dès l’ouverture NP (même sans visualId)');
  bullet('Pastille discrète « Clip… » seulement si resolve encore en cours');
  bullet('Warm silencieux visualId (titre courant + suivants), respect BatterySaver');
  bullet('Resolve deux temps : quick wait≈600 ms puis upgrade wait≈4500 ms en fond');
  bullet('Si offline/{id}.mp4 présent → URI locale immédiate, zéro attente réseau');
  p(
    'Résultat : bascule mode Vidéo perçue comme instantanée sur titres déjà croisés ; sur titre froid, la musique et la pochette sont là tout de suite, le clip s’affine ensuite.',
  );

  h1('5. Architecture lecteur mode Vidéo');
  p(
    'SyncedVideoSurface encapsule ExoPlayer/Media3 pour le clip, avec cache vidéo, gestes double-tap ±5 s, et barre de contrôles FS optionnelle. La file d’attente ouverte ne dispose plus la surface : Now Playing reste dans l’arbre Compose sous alpha 0. Disposer Exo coupait le son — c’était le bug 1.3.219. Le plein écran n’utilise plus Dialog (dismiss auto + ghost-tap) mais un overlay zIndex dans la même fenêtre, avec armement anti-tap ~520 ms après entrée FS.',
  );
  h2('5.1 Sync audio clip ↔ player principal');
  bullet('En FS / mode clip audio : useClipAudio=true — le son vient du flux vidéo Exo');
  bullet('onClipPositionMs : si écart >1,2 s vs ui.positionMs → player.seek(safe)');
  bullet('onClipDurationMs : VisualIdCache.putClipDurationMs + player.applyKnownDurationMs');
  bullet('Sortie mode Vidéo : seek éventuel sur lastClipPosMs pour reprendre la position');
  h2('5.2 Flux resolve côté client (ordre strict)');
  bullet('(1) container.offlineStore.videoPlayUri(trackId) si .mp4 local');
  bullet('(2) VisualIdCache.get(trackId) → container.videoStreamUrl(vid)');
  bullet('(3) API trackVisual wait≈600 — affichage dès que possible');
  bullet('(4) API trackVisual wait≈4500 — upgrade silencieux si meilleur clip');
  bullet('Échec / trop lent → clearStream + message court sur pochette (jamais écran plein recherche)');

  h1('6. Téléchargements audio + vidéo');
  p(
    'OfflineDownloadManager résout le visualId et télécharge le .mp4 en parallèle du .m4a. Les fichiers vivent sous offline/{id}.m4a et offline/{id}.mp4. Un échec clip est best-effort : l’audio reste. BatterySaver / IdleGuard / trim cache Exo ne touchent jamais à ces fichiers utilisateur. Observation Samsung après les vagues batterie : ~54 titres .m4a toujours présents.',
  );
  h2('6.1 Lecture offline mode Vidéo');
  bullet('Si .mp4 présent : streamUrl = URI file:// locale — démarrage immédiat');
  bullet('Sinon : chemin réseau /api/stream/{visualId}?type=video (auth headers)');
  bullet('Option Compte : bascule affichage contrôles FS sans changer le téléchargement');

  h1('7. Batterie — inventaire, paliers, garanties');
  p(
    'Objectif : réduire réseau/CPU de fond sans retirer de chemins UI ni purger le stockage offline. BatterySaver.isActive() si Power Save OS ou batterie ≤20 % hors charge. isSoft() si ≤35 %. Prefetch stream, prefetch clips, ticks NP, heartbeats sync, CoverPrefetcher et OfflineKeeper se calent. IdleGuard coupe le réseau plus tôt en pause arrière-plan. Coil : heap mémoire ~12 %, disque ~72 Mo, crossfade off.',
  );
  h2('7.1 Matrice énergétique');
  bullet('Normal (>35 %, pas d’économiseur) : prefetch large ; clips ahead ~5 ; ticks ~400 ms ; IdleGuard ~20 min');
  bullet('Soft (≤35 %) : fenêtre prefetch ~½ ; clips ahead 2 ; covers ahead 1 ; IdleGuard ~12 min');
  bullet('Actif (≤20 % / Power Save) : ahead stream/clips = 1 ; warm visualId courant seul ; IdleGuard ~8 min ; toast informatif possible');
  bullet('Garanti dans tous les modes : lecture, file, mix, paroles, sync, Cast, OTA, DL manuels ; aucune delete offline/*');
  h2('7.2 Ce qui n’a PAS été fait (volontairement)');
  bullet('Pas de purge LRU agressive des téléchargements');
  bullet('Pas de désactivation Cast / paroles / mix');
  bullet('Pas de forcer audio-only quand l’utilisateur a choisi Vidéo (sauf resolve impossible)');

  h1('8. Contrats API & pièges Topic');
  p(
    'Endpoint GET /api/track/{id}/visual?title&artist&durationSeconds&wait=N renvoie { visualId, source: same|search|none, … }. wait=0 lit cache RAM/SQLite (search éventuelle en fond). wait>0 fait Promise.race entre searchBetterClip et le timeout — priorise un clip officiel. Stream vidéo : /api/stream/{visualId}?type=video. Streamer l’ID audio Topic directement provoque souvent 10–14 s de buffer puis « Clip trop lent » côté Exo.',
  );
  bullet('Client : container.api.trackVisual + container.videoStreamUrl + ensureFreshToken');
  bullet('Cache disque VisualIdCache + durée clip pour seekbar titre');
  bullet('Prefetch VisualClipPrefetcher.maintain(queue, index) quand SessionMediaMode.video');

  h1('9. Validation flotte — protocole et résultats');
  h2('9.1 Samsung (gate VerifyError)');
  bullet('Install FLAVOR=prod API https://ytmusic.delhomme.ovh — Success');
  bullet('versionName observé : p+1.3.224 / versionCode=10524');
  bullet('Volume STREAM_MUSIC forcé à 0 pendant QA');
  bullet('Critère OK : ouvrir NP mode Vidéo sans VerifyError / sans FATAL EXCEPTION');
  h2('9.2 Blackview & Nothing');
  bullet('Blackview : QA player + présence clips offline après DL');
  bullet('Nothing : alignement p+ + OTA après publish-apk-remote');
  h2('9.3 Checklist manuelle complète');
  for (const c of [
    'NP mode Vidéo Samsung : pas de crash VerifyError',
    '5 titres : pochette immédiate ; pastille Clip… au plus quelques secondes',
    'Plein écran : seek, pause, next, prev (double-tap restart/prev), quitter — pas de dismiss fantôme',
    'File pendant clip : son/image continus (Exo non disposé)',
    'Option Compte contrôles FS on/off respectée au prochain FS',
    'DL Wi‑Fi : .m4a + .mp4 ; avion : clip local si présent',
    'Économiseur OS : lecture OK ; fichiers offline non purgés',
    'Passage Audio ↔ Vidéo : reprise position cohérente',
  ]) {
    bullet(c);
  }

  h1('10. Fichiers clés (carte de navigation code)');
  for (const f of [
    'NowPlayingScreen.kt — UI NP allégée ; délègue vidéo à VideoPlaybackHost',
    'VideoPlaybackHost.kt — NOUVEAU : état, effects resolve/warm/FS, overlay',
    'SyncedVideoSurface.kt — Exo clip, gestes, contrôles multimédia FS',
    'VisualIdCache.kt — cache visualId + durée clip par trackId',
    'VideoPlaybackPrefs.kt — préférence contrôles FS (Compte)',
    'OfflineDownloadManager.kt / LocalOfflineStore.kt — .m4a + .mp4',
    'BatterySaver.kt / PlaybackIdleGuard.kt / VisualClipPrefetcher.kt / CoverPrefetcher.kt',
    'YtMusicApp.kt — init Coil / garde-fous globaux',
    'AndroidManifest.xml — orientation unspecified + configChanges adaptés FS',
    'VERSION + VERSION_NOTES.json (+ web/public + assets Android)',
  ]) {
    bullet(f);
  }

  h1('11. Journal de décisions UX');
  bullet('File : masquer ≠ disposer (alpha 0) — seule façon d’éviter la coupe Exo');
  bullet('FS : overlay in-app plutôt que Dialog — anti ghost-tap et anti dismiss config');
  bullet('Anti ghost-tap : fsTapArmed=false puis delay 520 ms avant autoriser exit');
  bullet('Contrôles FS : option Compte défaut ON — respect profil minimaliste');
  bullet('DL vidéo parallèle : latence totale perçue plus courte, bande partagée');
  bullet('Pastille « Clip… » vs plein écran recherche — friction cognitive réduite');
  bullet('Battery soft sans toast spam ; toast seulement au passage actif');
  bullet('Découpage VideoPlaybackHost prioritaire sur toute nouvelle feature NP (stabilité ART)');

  h1('12. Glossaire opérationnel');
  bullet('visualId — ID YouTube du clip associé au titre audio (souvent ≠ id Topic)');
  bullet('Topic — piste souvent audio-only ; mauvais candidat pour surface vidéo');
  bullet('VerifyError — rejet ART d’une méthode DEX trop complexe (registres Compose)');
  bullet('Exo / Media3 — moteur de lecture ; FGS — service premier plan (notif média)');
  bullet('waitMs — délai max côté API pour searchBetterClip');
  bullet('alpha 0 — composable toujours présent mais invisible (file ouverte)');
  bullet('OTA — APK publié sur le serveur pour mise à jour in-app');

  h1('13. Commandes de reproduction / livraison');
  bullet('bash scripts/deploy/bump-version.sh patch');
  bullet('FLAVOR=prod DEVICE=<serial> API_BASE_URL=https://ytmusic.delhomme.ovh bash scripts/android/kotlin-android-install.sh install');
  bullet('adb shell cmd media_session volume --stream 3 --set 0   # mute Samsung QA');
  bullet('bash scripts/android/publish-apk-remote.sh');
  bullet('DEVICE=… bash scripts/android/player-actions-qa.sh');
  bullet('node --env-file=.env --import tsx scripts/qa/send-report-20260911-video-battery.mts');
  bullet('adb shell dumpsys package ovh.delhomme.ytmusic | grep versionName');

  h1('14. Risques résiduels et suite recommandée');
  bullet('Premier titre vraiment froid : pastille Clip… possible quelques secondes (acceptable)');
  bullet('Mesure batterie écran OFF 20–30 min encore utile pour chiffrer le gain soft/actif');
  bullet('Cast hors scope de cette vague');
  bullet('Surveiller télémétrie : plus aucun VerifyError NowPlayingScreen après 1.3.224');
  bullet('Si NowPlayingScreen regrossit : extraire encore (paroles / file) avant d’ajouter des features');
  p(
    'Recommandation : garder VideoPlaybackHost comme frontière stricte. Toute logique clip nouvelle (gestes, sous-titres clip, qualité) doit entrer dans ce module, pas revenir dans NowPlayingScreen.',
  );


  h1('15. Récit détaillé des bugs traités (ordre chronologique)');
  p(
    'Cette section archive le déroulé exact demandé par l’utilisateur, pour ne pas dépendre du chat. Chaque item a un symptôme, une cause, un correctif versionné et un critère de validation.',
  );
  h2('15.1 File d’attente qui coupait la vidéo');
  p(
    'Symptôme : ouvrir la file pendant un clip pausait ou tuait la lecture. Cause : la branche SyncedVideoSurface était conditionnée de façon à sortir de la composition (dispose Exo). Correctif 1.3.219 : garder NP composé sous le panneau file avec alpha 0 / zIndex bas. Critère : son continu + position stable à la fermeture de la file.',
  );
  h2('15.2 Plein écran qui se refermait tout de suite');
  p(
    'Symptôme : entrée FS puis dismiss immédiat. Cause : Dialog Material + ghost-tap qui traversait le nouvel overlay + changements de configuration. Correctif 1.3.220 : overlay in-window, clickable no-op de fond, fsTapArmed=false pendant ~520 ms, orientation SENSOR_LANDSCAPE puis retour PORTRAIT. Critère : FS reste ouvert jusqu’à back / bouton quitter / gesture armé.',
  );
  h2('15.3 Téléchargements sans clips');
  p(
    'Symptôme : titres offline audio-only. Correctif 1.3.221 : OfflineDownloadManager lance resolveVisualId + fetch mp4 en parallèle du m4a ; LocalOfflineStore expose videoPlayUri. Critère : présence de paires .m4a/.mp4 après DL Wi‑Fi ; lecture avion du clip.',
  );
  h2('15.4 Contrôles multimédia FS');
  p(
    'Demande : seek, play/pause, prev/next, quitter, option Compte. Correctif 1.3.221 : showMediaControls branché sur VideoPlaybackPrefs ; double-tap prev = restart vs skip. Critère : option OFF masque la barre ; ON la restaure au prochain FS.',
  );
  h2('15.5 Batterie sans casse de données');
  p(
    'Demande : économies générales sans perte. Correctif 1.3.222–223 : paliers soft/actif, IdleGuard sans purge, Coil allégé, prefetch calé. Critère : compteur offline Samsung inchangé ; features UI toujours joignables.',
  );
  h2('15.6 Écran « Recherche du clip… »');
  p(
    'Symptôme : attente plein cadre. Correctif 1.3.223 : pochette + pastille + warm + resolve 2 temps. Critère : aucun libellé plein cadre « Recherche du clip… » dans NP.',
  );
  h2('15.7 Crash VerifyError + e-mail d’erreur');
  p(
    'Symptôme : e-mail fatal android.crash après install 1.3.223 ; NP plante. Cause : méthode Compose trop grosse. Correctif 1.3.224 : VideoPlaybackHost. Critère : versionName p+1.3.224 ; ouverture NP mode Vidéo sans VerifyError.',
  );

  h1('16. Détail technique VideoPlaybackHost');
  p(
    'VideoPlaybackUi est une classe d’état mutable Compose (var by mutableStateOf / mutableLongStateOf). enterFullscreen() arme fsTapArmed=false avant de passer fullscreen=true. exitFullscreen(force) ignore les taps tant que !fsTapArmed sauf force=true (BackHandler, erreur lecture, sortie mode). clearStream(err) remet streamUrl/visualId/resolving à zéro et pose un message utilisateur court.',
  );
  p(
    'rememberVideoPlaybackUi orchestre : (a) warm visualId respectant BatterySaver ; (b) resolve principal quand sheetVisible && SessionMediaMode.video ; (c) VisualClipPrefetcher.maintain sur la file ; (d) reset lastClipPosMs au change de track ; (e) setVideoClipMode + exit FS quand on quitte le mode Vidéo ; (f) BackHandler FS ; (g) orientation Activity ; (h) relecture préférence contrôles FS à l’ouverture sheet/FS.',
  );
  p(
    'VideoFullscreenOverlay early-return si !fullscreen || url==null || !SessionMediaMode.video. Sinon Box noir zIndex 80 + SyncedVideoSurface fullscreen=true useClipAudio=true. Les callbacks seek/erreur délèguent au PlayerController et VisualIdCache. Cette séparation est volontairement la frontière anti-VerifyError.',
  );

  h1('17. Scénarios de test pas-à-pas (Samsung muet)');
  bullet('Prérequis : adb volume STREAM_MUSIC=0 ; login pavel@ ou compte prod autorisé ; Wi‑Fi OK');
  bullet('T1 — Lancer un titre audio, basculer mode Vidéo : pochette immédiate, clip arrive, pas de crash');
  bullet('T2 — Ouvrir FS, attendre 1 s, taper hors contrôles : ne doit PAS fermer ; quitter via bouton');
  bullet('T3 — En FS, seek à 50 %, pause, play, next, prev double-tap');
  bullet('T4 — Pendant clip, ouvrir file : audio continue ; fermer file : clip toujours là');
  bullet('T5 — Compte → désactiver contrôles FS → rouvrir FS : barre absente');
  bullet('T6 — Télécharger 2 titres Wi‑Fi → vérifier offline/*.mp4 via stockage app / logs');
  bullet('T7 — Avion : relancer un titre DL : clip local si mp4 présent');
  bullet('T8 — Activer économiseur OS : lecture OK ; fichiers offline toujours listés');
  bullet('T9 — logcat | grep VerifyError doit rester vide après 5 ouvertures NP');
  p(
    'En cas d’échec T1/T9 : capturer logcat -b crash, dumpsys package versionName, et renvoyer télémétrie. Ne pas promo prod tant que T1 échoue.',
  );

  h1('18. Matrice appareil × build × compte');
  bullet('Samsung + PLM prod p+ + pavel@ — gate crash + batterie (cette session)');
  bullet('Nothing + PLM prod p+ + pavel@ — usage quotidien après OTA');
  bullet('Blackview + PLM prod p+ — QA scripts player-actions');
  bullet('Dev local : flavor d+ + API LAN :8787 + dev@ — hors scope de cette promo p+');
  p(
    'Rappel pipeline : on n’installe pas prod pour valider une feature jamais vue sur Samsung en d+/LAN. Ici la vague a déjà passé les gates antérieurs ; 1.3.224 est un hotfix stabilité sur prod déjà déployée.',
  );

  h1('19. Ce que contient / ne contient pas l’OTA');
  bullet('Contient : fix VerifyError, logique clip déjà présente 218–223');
  bullet('Ne contient pas : Cast amélioré, nouveaux thèmes, refonte paroles');
  bullet('Notes utilisateur 1.3.224 : stabilisation lecteur vidéo / plantage NP');
  bullet('Publish : scripts/android/publish-apk-remote.sh après install Samsung');

  h1('20. Annexes textuelles densifiées — erreurs typiques à distinguer');
  p(
    'Pour éviter de mélanger les alertes mail : (1) VerifyError NowPlayingScreen = taille méthode Compose → VideoPlaybackHost. (2) ExoPlaybackException Source error HTTP 502 = proxy/stream → OAuth TV / circuit-breaker, pas ce patch. (3) early_end = fin prématurée piste → autre chantier. (4) DNS unresolved = réseau appareil. (5) Player wrong thread = offline download thread — déjà traité historiquement. L’e-mail de cette session correspond au cas (1).',
  );
  p(
    'Le premier PDF de rapport avait ~10 « pages » dont plusieurs annexes d’une seule ligne après addPage forcé : d’où l’impression de pages vides. La règle désormais : jamais addPage() sans contenu immédiat d’au moins un titre + un paragraphe ; pagination uniquement via ensure(marge).',
  );
  p(
    'Densité cible : chaque page ≥ ~1500 caractères utiles. Si une page tombe sous 800 caractères utiles (hors form-feed final pdftotext), le script avertit. Si <200, l’envoi est refusé.',
  );


  h1('21. Journal détaillé des changements fichier par fichier');
  p(
    'NowPlayingScreen.kt : suppression des blocs LaunchedEffect resolve/warm/orientation et de l’overlay FS inline ; introduction de rememberVideoPlaybackUi et VideoFullscreenOverlay ; conservation de la branche inline SyncedVideoSurface (non-FS) et de toute l’UI file/paroles/seek. Objectif unique : réduire la taille de méthode DEX.',
  );
  p(
    'VideoPlaybackHost.kt : nouveau fichier ~380 lignes. Porte l’état vidéo, les effets réseau, le BackHandler FS, la gestion d’orientation Activity, et l’overlay FS. SessionMediaMode (défini dans SyncedVideoSurface.kt, même package) reste la source de vérité « audio vs vidéo ».',
  );
  p(
    'SyncedVideoSurface.kt : inchangé fonctionnellement dans 1.3.224 ; continue d’exposer showMediaControls, onClipPositionMs, onClipDurationMs, onPlaybackError, onToggleFullscreen. Les callers sont maintenant NowPlayingScreen (inline) et VideoFullscreenOverlay (FS).',
  );
  p(
    'BatterySaver / IdleGuard / Coil / Prefetchers : inchangés par le hotfix 224 ; déjà livrés en 222–223. VERSION_NOTES.json reçoit une entrée utilisateur claire (« Stabilisation lecteur vidéo ») pour l’écran Version Compte.',
  );

  h1('22. Comparatif avant / après (résumé opérationnel)');
  bullet('Avant file ouverte : Exo disposé → coupe. Après : alpha 0 → continu.');
  bullet('Avant FS : Dialog → dismiss fantôme. Après : overlay + armement 520 ms.');
  bullet('Avant DL : audio seul. Après : audio+mp4 parallèle.');
  bullet('Avant clip : écran Recherche… Après : pochette + pastille.');
  bullet('Avant batterie : peu de paliers / risque purge. Après : soft/actif sans purge.');
  bullet('Avant 223 : NP compile mais trop gros → VerifyError runtime. Après 224 : host extrait → ART OK.');

  h1('23. Procédure de diagnostic si nouvel e-mail crash');
  bullet('Lire kind (android.crash / android.player / …) et Pré-diagnostic famille');
  bullet('Si VerifyError + NowPlayingScreen : vérifier que VideoPlaybackHost est bien dans l’APK ; mesurer taille méthode via dexdump si besoin');
  bullet('Si Exo 502 : dig API, health VPS, OAuth TV, circuit-breaker offline');
  bullet('Si early_end : logs pos/expected — autre chantier durée');
  bullet('Toujours croiser versionName APK (dumpsys) avec VERSION serveur / OTA manifest');
  p(
    'Le fait que le mail parte automatiquement est voulu : « quoi qu’il arrive ». Ne pas désactiver. Traiter chaque fatal comme un ticket, en classant la famille avant de coder.',
  );

  h1('24. Mesures batterie recommandées (protocole)');
  p(
    'Pour chiffrer le gain soft/actif : (1) charger à 100 % ; (2) lecture Wi‑Fi écran OFF 30 min mode normal, noter % ; (3) même test ≤35 % soft ; (4) même test ≤20 % ou Power Save. Garder playlist identique, volume 0, pas de Cast. Reporter delta %/30 min. Ne pas conclure sur un seul run (variance radio).',
  );
  bullet('Indicateurs secondaires : dumpsys batterystats ; fréquence ticks NP ; nombre de prefetch HTTP');
  bullet('Garde-fou : si soft coupe trop le prefetch → skip « froid » — remonter ahead minimum à 1 (déjà le cas en actif)');

  h1('25. Sécurité / auth / canaux (rappel session)');
  bullet('Prod APK p+ → https://ytmusic.delhomme.ovh / plm.delhomme.ovh selon build');
  bullet('Compte perso prod : pavel@ ; admin seed : dev@ / paul@ selon secrets');
  bullet('Secrets : Bitwarden + KeePassXC — jamais commit .env');
  bullet('OTA publiée : manifest versionName=p+1.3.224 versionCode=10524 via SSH volume docker');

  h1('26. Texte de relecture pour l’utilisateur (non technique)');
  p(
    'En résumé simple : le mode Vidéo ne coupe plus quand tu ouvres la file, le plein écran ne se ferme plus tout seul, tu as des boutons de lecteur en grand écran (réglables dans Compte), les téléchargements prennent aussi la vidéo, tu ne restes plus bloqué sur « Recherche du clip… », la batterie est ménagée sans effacer tes titres, et le plantage qui t’a envoyé un e-mail d’erreur est corrigé dans p+1.3.224. Le PDF d’avant avait des pages presque vides : celui-ci est rempli de bout en bout.',
  );


  h1('27. Annexes — extraits de configuration et comportements runtime');
  p(
    'SessionMediaMode.video est un flag de session (pas une préférence persistée globale seule) : quand il est vrai, le player bascule setVideoClipMode(true), les surfaces Exo vidéo deviennent actives, et le prefetch clips démarre. Quand il repasse faux, FS est forcé fermé, le prefetch clips s’arrête, et lastClipPosMs peut être réappliqué sur le player audio pour éviter un saut de position.',
  );
  p(
    'VideoPlaybackPrefs.fullscreenControls lit un booléen SharedPreferences. La valeur est relue à l’ouverture du sheet NP et à l’entrée FS pour que le changement Compte soit pris sans redémarrer l’app. Défaut true.',
  );
  p(
    'VisualIdCache stocke visualId et clipDurationMs par trackId. putClipDurationMs alimente applyKnownDurationMs : la seekbar du titre reflète la durée réelle du clip quand l’API audio ment ou omet durationSeconds. remove(trackId) est appelé sur erreur de lecture clip pour forcer un nouveau resolve au prochain essai.',
  );
  p(
    'BatterySaver.isActive / isSoft sont consultés par StreamPrefetcher, VisualClipPrefetcher, CoverPrefetcher, OfflineKeeper et les ticks UI. La règle d’or documentée dans le code et ici : aucune de ces classes ne doit appeler delete sur offline/*. Le trim cache Exo ne cible que le cache froid réseau.',
  );
  h2('27.1 Manifest & orientation');
  p(
    'MainActivity : screenOrientation unspecified + configChanges adaptés pour éviter la reconstruction complète au passage paysage FS. Le correctif 1.3.220 s’appuie dessus : sans configChanges, l’Activity recréée tuait l’overlay. requestedOrientation est posé explicitement en SENSOR_LANDSCAPE (FS) puis PORTRAIT (sortie). DisposableEffect restaure PORTRAIT au dispose du host vidéo.',
  );
  h2('27.2 Télémétrie & mail d’erreur');
  p(
    'UncaughtExceptionHandler → AppLog / telemetry POST level=fatal kind=android.crash avec stack + breadcrumbs + recentLogs. Le serveur enrichit (pré-diagnostic famille) et envoie SMTP. C’est ce chemin qui a produit l’e-mail VerifyError. Après 1.3.224, ce kind ne doit plus apparaître pour NowPlayingScreen ; s’il réapparaît, traiter comme régression de taille de méthode.',
  );

  h1('28. Plan de non-régression (à rejouer après tout futur gros patch NP)');
  bullet('Compile prodReleaseKotlin + assembleProdDebug');
  bullet('Install Samsung muet ; ouvrir NP vidéo 10 fois de suite');
  bullet('logcat VerifyError / FATAL EXCEPTION = 0 hit');
  bullet('Parcours T1–T9 §17');
  bullet('Vérifier VERSION_NOTES entrée présente pour le numéro VERSION');
  bullet('Publish OTA + contrôle manifest versionCode incrémenté');
  bullet('Nothing : OTA ou install ADB ; smoke FS + file');
  p(
    'Si un développeur ajoute >~200 lignes d’effets dans NowPlayingScreen, extraire d’abord (paroles host, queue host) avant merge. La CI ne détecte pas VerifyError : seul le device réel (Samsung) est le filet.',
  );


  h1('29. Annexes — FAQ courte (questions déjà posées dans la session)');
  bullet('Q : Pourquoi un e-mail d’erreur juste après le rapport ? R : crash VerifyError télémétrie, pas échec SMTP.');
  bullet('Q : Pourquoi des pages blanches dans le 1er PDF ? R : addPage() avant des annexes d’une ligne.');
  bullet('Q : Mes titres offline ont-ils été effacés pour la batterie ? R : non, interdit dans tous les paliers.');
  bullet('Q : La file coupe-t-elle encore la vidéo ? R : non depuis 1.3.219 (alpha 0).');
  bullet('Q : Le plein écran se referme-t-il tout seul ? R : corrigé 1.3.220 + armement 520 ms.');
  bullet('Q : Où est l’option des contrôles FS ? R : Compte → préférence VideoPlaybackPrefs.');
  bullet('Q : Faut-il réinstaller partout ? R : Samsung+Blackview faits ; Nothing via OTA p+1.3.224 quand branché.');
  p(
    'Cette FAQ est volontairement redondante avec les sections 3 et 15 : elle sert de point d’entrée rapide si on ne lit que la fin du PDF.',
  );

  h1('30. Index des versions notes utilisateur (libellé Compte)');
  for (const line of [
    '1.3.219 — File sans coupure vidéo ; durée clip associée au titre',
    '1.3.220 — Plein écran ne se referme plus tout seul',
    '1.3.221 — Contrôles FS + DL clips + option Compte',
    '1.3.222 — Économie batterie sans perte de données',
    '1.3.223 — Clip instantané (plus d’écran Recherche) + Coil léger',
    '1.3.224 — Stabilisation lecteur vidéo (plantage NP / VerifyError)',
  ]) {
    bullet(line);
  }

  h1('31. Synthèse exécutive');




  p(
    'Les versions 1.3.218→1.3.223 livrent un mode Vidéo continu (file, plein écran, contrôles, offline) sans écran bloquant de recherche clip, avec une gestion batterie par paliers sans perte de données ni de fonctionnalités. La 1.3.224 corrige le plantage VerifyError signalé par e-mail en extrayant la logique vidéo hors de NowPlayingScreen. L’APK p+1.3.224 est installée sur Samsung (son coupé). Ce PDF est densifié : plus de pages blanches artificielles ; le contenu couvre diagnostic, architecture, API, checklist et décisions.',
  );
  doc.moveDown(0.35);
  doc.fontSize(9).fillColor('#666').text(
    'Document régénéré automatiquement pour archivage et revue. PDF joint au courriel SMTP prod. Fin.',
  );

  // Supprimer d’éventuelles pages finales vides (bufferPages)
  const range = doc.bufferedPageRange();
  // Ne rien faire de destructif si PDFKit ne permet pas facilement de drop ;
  // on compte les pages réellement écrites via range.count après end.
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

  // Compte pages via pdfinfo
  let pages = range.count;
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
    lines: t.split('\n').filter((l) => l.trim()).length,
  }));
  console.log('densité:', stats);
  const thin = stats.filter((x) => x.chars < 800 && !(x.i === stats.length && x.chars === 0));
  // ignorer éventuel trailing form-feed vide de pdftotext
  const realThin = stats.filter((x) => x.chars > 0 && x.chars < 800);
  if (realThin.length) {
    console.warn('Pages peu denses:', realThin);
    if (realThin.some((x) => x.chars < 200)) {
      throw new Error('PDF trop vide sur au moins une page — refuser l’envoi');
    }
  } else {
    console.log('Densité OK');
  }
  if (pages < 7) {
    console.warn(`Attention: seulement ${pages} pages (cible ~8–10 densifiées)`);
  }
}

const subject = `[Hubera Music] Rapport densifié (~${pages} p.) + VerifyError corrigé — p+${version}`;

const text = `PLM — Rapport technique densifié
Date: ${iso}
Version: p+${version}
PDF: ${pdfPath} (${pages} pages)

Erreur e-mail reçue = crash VerifyError (NowPlayingScreen trop gros pour ART),
PAS un échec d'envoi du précédent PDF.

Correctif 1.3.224 = VideoPlaybackHost (état clip + overlay FS isolés).
Samsung installé : versionName=p+1.3.224 (volume muet).

PDF régénéré densifié : plus de pages blanches artificielles.
`;

const html = `
<div style="font-family:system-ui,sans-serif;max-width:720px;line-height:1.5;color:#222">
  <h1 style="font-size:20px;margin:0 0 8px">PLM — Rapport densifié + stabilisation</h1>
  <p style="color:#666;margin:0 0 16px">p+${version} · ${pages} pages · ${new Date().toLocaleString('fr-FR')}</p>
  <p><strong>Erreur e-mail :</strong> crash <code>VerifyError</code> sur Now Playing (méthode Compose trop grosse pour le vérifieur ART) — pas un problème SMTP. Corrigé en <strong>1.3.224</strong> (<code>VideoPlaybackHost</code>). Samsung : <code>p+1.3.224</code> installé (son coupé).</p>
  <p>PDF joint <strong>densifié</strong> : diagnostic crash, architecture vidéo, DL, batterie, API, checklist, décisions UX. Plus de pages quasi vides.</p>
  <ul>
    <li>Fix plantage NP mode Vidéo</li>
    <li>Clip : pochette immédiate + warm</li>
    <li>FS / file / DL clips inchangés côté usage</li>
    <li>Batterie : paliers sans purge offline</li>
  </ul>
  <p style="color:#888;font-size:12px;margin-top:28px">SMTP prod PLM · ${to.replaceAll('<', '&lt;')}</p>
</div>
`;

const r = await sendMail({
  to,
  subject,
  html,
  text,
  attachments: [
    {
      filename: `PLM-rapport-video-batterie-${version}.pdf`,
      content: readFileSync(pdfPath),
      contentType: 'application/pdf',
    },
  ],
});

writeFileSync(
  join(OUT_DIR, 'mail-result.json'),
  JSON.stringify({ ok: true, r, pages, version, iso }, null, 2),
);
console.log('mail →', r);
