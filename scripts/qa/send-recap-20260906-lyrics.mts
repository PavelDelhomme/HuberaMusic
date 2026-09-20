/**
 * Récapitulatif = mail du 6 sept. (1.3.142→161) + correctif paroles Genius (1.3.162–163).
 *
 *   npx tsx scripts/qa/send-recap-20260906-lyrics.mts
 */
import { sendMail } from '../../api/src/platform/mail.ts';

const to = process.env.MAIL_TO || process.env.REPORT_TO || process.env.BATTERY_REPORT_TO || '';
const subject =
  '[PLM] Récapitulatif — 1.3.142 → 1.3.163 (session + paroles Genius proxies)';

type Bloc = { titre: string; lignes: string[] };

const appli: Bloc[] = [
  {
    titre: '1.3.142 → 1.3.143 — File d’attente plus lisible',
    lignes: [
      'Plus de place pour la suite de la file, et le titre suivant visible sans devoir tout déplier.',
    ],
  },
  {
    titre: '1.3.144 → 1.3.145 — Suivi d’erreurs + paroles partout',
    lignes: [
      'Chaque erreur signalée a son document de suivi.',
      'Le suivi des paroles s’applique sur tous les titres (plus seulement une partie du catalogue).',
    ],
  },
  {
    titre: '1.3.146 → 1.3.150 — Paroles, pochettes, début de titre',
    lignes: [
      'Paroles plus justes ; titre suivant visible ; paroles plus vite / déjà prêtes au prochain titre.',
      'Mise à jour visible + paroles plus précises ; le début de chaque titre se joue vraiment.',
      'Pochettes plus rapides ; sync paroles mémorisée.',
    ],
  },
  {
    titre: '1.3.151 → 1.3.152 — Mise à jour APK sans blocage',
    lignes: [
      'Confirmer la mise à jour sans bloquer l’app.',
      'Plus jamais bloqué sur « Confirmer l’installation ».',
    ],
  },
  {
    titre: '1.3.153 → 1.3.155 — Karaoké calé',
    lignes: [
      'Paroles qui apprennent le rythme en cours de morceau.',
      'Lead ~0,10 s pour chanter dessus.',
      'Correctif majeur : un silence de fin (outro) n’est plus pris pour une intro → plus de retard 10–20 s (ex. APRÈS-VOUS MADAME).',
    ],
  },
  {
    titre: '1.3.156 → 1.3.158 — Mode vidéo réparé',
    lignes: [
      'En mode Vidéo : son du clip YouTube ; retour Titre resynchronisé.',
      'Cache visual + Play après force-stop (E22) + écran Téléchargements + reco embeddings tags/énergie.',
      'Fix critique : la résolution vidéo ne bloque plus l’API (probe trop long) → le clip s’ouvre vraiment.',
    ],
  },
  {
    titre: '1.3.159 → 1.3.161 — PLM + ytmusic, session, permissions',
    lignes: [
      'Canon prod = plm.delhomme.ovh ; alias ytmusic.delhomme.ovh (et pue-la-merde) restent valides.',
      'Cookies Domain=.delhomme.ovh : une session web marche sur les deux hôtes.',
      'Seed admin resynchronisé côté VPS ; seed local aligné.',
      'QR /login-device OK sur plm et ytmusic ; bascule plm↔ytmusic ne déconnecte plus l’app.',
      'Permission notifications : une seule invite par installation (plus de spam à chaque MAJ).',
      'Accueil : budget YouTube borné ~4 s — le contenu perso arrive d’abord si YT est lent.',
      'Email de connexion mémorisé sur le téléphone.',
    ],
  },
  {
    titre: '1.3.162 → 1.3.163 — Paroles Genius vraiment récupérées',
    lignes: [
      'Problème : depuis le VPS Genius renvoyait HTTP 403 (blocage IP datacenter) → beaucoup de « paroles introuvables » alors que la page Genius existe en un clic web.',
      'Correctif : recherche multi-variantes (feat., artiste principal) + découverte d’URL type recherche web (DuckDuckGo) + scrape HTML via proxies HTTP (même pool que les streams).',
      '1.3.163 : proxies en course parallèle + budget ~12–13 s (plus de timeouts à 45 s) ; la source « genius » reste visible même après estimation du suivi karaoké.',
      'Cache paroles invalidé (v15) pour retenter les anciens misses.',
      'Les paroles récupérées entrent dans le suivi (estimation des timings + offsets perso/crowd déjà en place).',
    ],
  },
];

const serveur: Bloc[] = [
  {
    titre: 'Infra / auth prod',
    lignes: [
      'Conteneur ytmusic :latest healthy · appVersion p+1.3.163.',
      'canonicalHost plm.delhomme.ovh · aliasHosts ytmusic + pue-la-merde.',
      'COOKIE_DOMAIN=.delhomme.ovh · CORS pour les trois hôtes · WEBAUTHN_RP_ID=delhomme.ovh.',
      'SEED_EMAIL / SEED_PASSWORD injectés dans Portainer (AUTH_SEED_SYNC).',
      'YOUTUBE_HTTP_PROXY_FREE actif : utilisé aussi pour Genius quand l’IP VPS est refusée.',
    ],
  },
  {
    titre: 'Médias / paroles',
    lignes: [
      'Chaîne : YouTube → LRCLIB → captions → lyrics.ovh → Genius (proxies) → estimation timed.',
      'Script QA : scripts/qa/library-lyrics-sweep.mts (échantillon biblio multi-styles).',
      'APK OTA p+1.3.163 / code 10463 publiée sur le VPS.',
    ],
  },
];

const verifs = [
  'Prod health p+1.3.163 sur plm.delhomme.ovh.',
  'Balayage biblio aléatoire 40 titres : paroles 31/40 (78 %), timed 78 % — misses surtout instrumentaux (Einaudi, Chopin, dark ambient). Plus de timeouts 45 s.',
  'Échantillon Bibliothèque (18 titres divers) : 15/18 paroles — sources lrclib / genius / lyrics.ovh / estimated. Ex. Genius OK sur « Я не проигрываю » ; Bella ciao GIMS OK via lrclib.',
  'Blackview BV9700Pro : p+1.3.163 installé, session injectée, volume 0, lecture « Tout lire » (PlaybackState=3) + action Paroles dans la session média.',
  'Samsung SM-G990B2 : p+1.3.163 + session injectée.',
  'PRs #362 / #364 → dev ; promo #365 → prod.',
];

const restes = [
  'E13 (fin de titre / « réseau instable ») : encore partiel — à surveiller en long run.',
  'Embeddings reco : MVP tags+énergie ; phase CLAP/FAISS plus tard.',
  'Home cold start peut encore frôler 5–6 s si YouTube + reco perso sont lents ensemble.',
  'Google Sign-In désactivé en prod — login email / passkey / QR appareil.',
  'Proxies publics Genius : parfois lents / flaky — budget borné pour ne pas bloquer le lecteur ; instrumentaux restent sans paroles (normal).',
];

const bloc = (b: Bloc) => `${b.titre}\n${b.lignes.map((l) => `  · ${l}`).join('\n')}`;

const text = `PLM — Récapitulatif de session
${new Date().toISOString()}
Suite du mail du 3 septembre 2026 (jusqu’à p+1.3.141) + mail 6 sept. (→161) + paroles Genius
Version application / serveur : p+1.3.163

== Application (1.3.142 → 1.3.163) ==
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
  <h1 style="font-size:1.35rem;margin:0 0 4px">PLM — récapitulatif (session + paroles)</h1>
  <p style="color:#666;margin:0 0 8px">6 septembre 2026 · suite du récap du <b>3 septembre</b> + correctif paroles Genius</p>
  <p style="color:#666;margin:0 0 24px">Version actuelle : <code>p+1.3.163</code> · hôtes <code>plm.delhomme.ovh</code> + <code>ytmusic.delhomme.ovh</code></p>

  <h2 style="font-size:1.15rem;border-bottom:1px solid #eee;padding-bottom:4px">Application (1.3.142 → 1.3.163)</h2>
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
