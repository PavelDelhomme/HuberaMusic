/**
 * Récapitulatif session 6 sept. — suite 1.3.142→161 + paroles Genius + cold-start tous comptes (→1.3.165).
 *
 *   npx tsx scripts/qa/send-recap-20260906-full.mts
 */
import { sendMail } from '../../api/src/platform/mail.ts';

const to = process.env.MAIL_TO || process.env.REPORT_TO || process.env.BATTERY_REPORT_TO || '';
const subject =
  '[Hubera Music] Récapitulatif — 1.3.142 → 1.3.165 (session, paroles Genius, cold-start tous comptes)';

type Bloc = { titre: string; lignes: string[] };

const appli: Bloc[] = [
  {
    titre: '1.3.142 → 1.3.161 — (déjà dans le récap précédent)',
    lignes: [
      'File d’attente, suivi d’erreurs, paroles partout, karaoké calé (outro), mode vidéo, PLM+ytmusic, session, permissions, accueil borné 4 s.',
    ],
  },
  {
    titre: '1.3.162 → 1.3.163 — Paroles Genius vraiment récupérées',
    lignes: [
      'Problème : depuis le VPS Genius renvoyait HTTP 403 → beaucoup de « paroles introuvables » alors que la page existait en un clic web.',
      'Correctif : recherche multi-variantes (feat.) + découverte d’URL type web + scrape via proxies HTTP (même pool que les streams).',
      '1.3.163 : proxies en course parallèle + budget ~12–13 s ; source « genius » conservée après estimation du suivi karaoké.',
      'Cache paroles invalidé (v15). Balayage biblio : ~78 % de paroles (misses surtout instrumentaux).',
    ],
  },
  {
    titre: '1.3.164 — Préchargement goûts (Hélène + comptes)',
    lignes: [
      'Endpoint admin warm-candidates : history / likes / library de tous les comptes.',
      'Warm goûts Hélène : (G)I-DLE, LiSA, YOASOBI, ReawakeR, Céline Dion, Aitana, Rosalía, ITZY, aespa, NewJeans…',
      'Android : crawl biblio plus tôt/large + demande cache disque serveur.',
      'Mesure : titres déjà en cache ~30–180 ms (ram / disk-ram) ; Blackview muet : lecture LiSA OK.',
    ],
  },
  {
    titre: '1.3.165 — Cold start intelligent pour TOUS les utilisateurs',
    lignes: [
      'Scheduler serveur tasteWarm (~12 min) : chauffe history/likes/library de tous les comptes (formats + têtes RAM + .m4a compressés partagés).',
      'Déclenché aussi au login, refresh token, accueil, biblio, device-login — sans bloquer l’UI.',
      'Cache .m4a global : un titre chauffé pour un compte accélère les autres.',
      'Warm concurrency 3 ; têtes RAM plus larges ; Android warm des seeds dès l’accueil.',
      'Vérifié : global warm≈88 + diskQueue≈36 ; hits multi-comptes ~90–225 ms quand chaud.',
    ],
  },
];

const serveur: Bloc[] = [
  {
    titre: 'Prod actuelle',
    lignes: [
      'appVersion p+1.3.165 · healthy · branche prod.',
      'Hôtes : plm.delhomme.ovh (canon) + ytmusic.delhomme.ovh.',
      'APK OTA p+1.3.165 / versionCode 10465 publiée sur le VPS.',
      'STREAM_WARM_CONCURRENCY=3 · TASTE_WARM scheduler actif.',
    ],
  },
  {
    titre: 'Paroles (pipeline)',
    lignes: [
      'YouTube → LRCLIB → captions → lyrics.ovh → Genius (proxies) → estimation timed + sync perso/crowd.',
    ],
  },
  {
    titre: 'Streams (pipeline cold-start)',
    lignes: [
      'Login/home → scheduleUserTasteWarm → file warm formats/têtes.',
      'File disque basse priorité → downloadTrack .m4a (partagé).',
      'Cycle global listWarmCandidates → tous les vrais comptes (hors tests).',
    ],
  },
];

const verifs = [
  'Prod health p+1.3.165.',
  'Paroles : sweep biblio ~78 % ; Genius via proxies validé ; cas Bella ciao / Jefe / Brisé OK.',
  'Hélène : login OK ; warm goûts K-Pop/anime ; Blackview volume 0 lecture LiSA Akeboshi.',
  'Tous comptes : POST /api/admin/taste-warm → warmed≈88 disk≈36 ; logs [tasteWarm] scheduler + user/global.',
  'Streams chauds multi-users : ~90–225 ms (disk-ram) vs plusieurs secondes à froid.',
  'PRs mergées → dev → prod (#362–#369 selon lots paroles / warm / cold-start).',
];

const restes = [
  'Titres jamais écoutés / jamais vus en biblio restent plus lents la 1ʳᵉ fois (normal) puis entrent dans le cache partagé.',
  'Proxies Genius / yt-dlp parfois flaky — budgets bornés pour ne pas bloquer le lecteur.',
  'E13 (fin de titre / réseau instable) : encore à surveiller en long run.',
  'STREAM_HEAD_CACHE env Portainer peut rester vide → défaut code 36 s’applique.',
];

const bloc = (b: Bloc) => `${b.titre}\n${b.lignes.map((l) => `  · ${l}`).join('\n')}`;

const text = `PLM — Récapitulatif de session
${new Date().toISOString()}
Suite du mail du 3 septembre (→1.3.141) + récap 6 sept. session/paroles + cold-start
Version application / serveur : p+1.3.165

== Application (focus 1.3.162 → 1.3.165) ==
${appli.map(bloc).join('\n\n')}

== Serveur / ops ==
${serveur.map(bloc).join('\n\n')}

== Vérifications ==
${verifs.map((v) => `  · ${v}`).join('\n')}

== Ce qui reste ==
${restes.map((r) => `  · ${r}`).join('\n')}
`;

const htmlBloc = (b: Bloc) => `
  <h3 style="font-size:1rem;margin:18px 0 6px">${b.titre}</h3>
  <ul style="margin:0;padding-left:20px">${b.lignes.map((l) => `<li>${l}</li>`).join('')}</ul>`;

const html = `<div style="font-family:system-ui,-apple-system,sans-serif;line-height:1.55;max-width:780px;color:#111">
  <h1 style="font-size:1.35rem;margin:0 0 4px">PLM — récapitulatif (paroles + cold-start)</h1>
  <p style="color:#666;margin:0 0 8px">6 septembre 2026 · suite du récap session + correctifs du soir</p>
  <p style="color:#666;margin:0 0 24px">Version actuelle : <code>p+1.3.165</code> · <code>plm.delhomme.ovh</code></p>

  <h2 style="font-size:1.15rem;border-bottom:1px solid #eee;padding-bottom:4px">Application (1.3.162 → 1.3.165)</h2>
  ${appli.map(htmlBloc).join('')}

  <h2 style="font-size:1.15rem;border-bottom:1px solid #eee;padding-bottom:4px;margin-top:28px">Serveur / ops</h2>
  ${serveur.map(htmlBloc).join('')}

  <h2 style="font-size:1.15rem;border-bottom:1px solid #eee;padding-bottom:4px;margin-top:28px">Vérifications</h2>
  <ul style="margin:0;padding-left:20px">${verifs.map((v) => `<li>${v}</li>`).join('')}</ul>

  <h2 style="font-size:1.15rem;border-bottom:1px solid #eee;padding-bottom:4px;margin-top:28px">Ce qui reste</h2>
  <ul style="margin:0;padding-left:20px">${restes.map((r) => `<li>${r}</li>`).join('')}</ul>
</div>`;

await sendMail({ to, subject, html, text });
console.log('récapitulatif envoyé à', to);
