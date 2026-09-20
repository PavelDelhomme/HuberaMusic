/**
 * Récapitulatif depuis le dernier mail du 3 sept. (jusqu’à 1.3.141)
 * → versions 1.3.142 … 1.3.161 (4–6 septembre 2026).
 *
 *   npx tsx scripts/qa/send-recap-20260906.mts
 */
import { sendMail } from '../../api/src/platform/mail.ts';

const to = process.env.MAIL_TO || process.env.REPORT_TO || process.env.BATTERY_REPORT_TO || '';
const subject =
  '[PLM] Récapitulatif complet — 1.3.142 → 1.3.161 (paroles, vidéo, PLM/ytmusic, session, permissions)';

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
];

const serveur: Bloc[] = [
  {
    titre: 'Infra / auth prod',
    lignes: [
      'Conteneur ytmusic :latest healthy · appVersion p+1.3.161.',
      'canonicalHost plm.delhomme.ovh · aliasHosts ytmusic + pue-la-merde.',
      'COOKIE_DOMAIN=.delhomme.ovh · CORS pour les trois hôtes · WEBAUTHN_RP_ID=delhomme.ovh.',
      'SEED_EMAIL / SEED_PASSWORD injectés dans Portainer (AUTH_SEED_SYNC) pour éviter « Identifiants invalides ».',
    ],
  },
  {
    titre: 'Médias',
    lignes: [
      'Resolve vidéo : réponse immédiate (même ID) + upgrade clip en fond ; plus de probe bloquant.',
      'Streams audio : smoke Papaoutai / Dernière danse / ReawakeR → HTTP 206 en <100 ms (Range).',
      'Explorer authentifié : shelves OK.',
    ],
  },
];

const verifs = [
  'Prod health p+1.3.161 sur plm et ytmusic.',
  'Login → home shelves ~20 ; 2e appel home ~3–5 s (cache YT).',
  'Session cookie partagée : login plm → /api/auth/me OK via ytmusic.',
  'Samsung SM-G990B2 : p+1.3.161, Accueil visible, pas de « Se connecter ».',
  'Blackview BV9700Pro : p+1.3.161 (était en 1.3.142), Accueil visible, pas de « Se connecter ».',
  'Nothing Phone : p+1.3.161, API forcée plm, permissions notif/micro accordées.',
  'APK OTA publiée sur le VPS (p+1.3.161 / code 10461).',
  'PRs mergées → dev → prod (promo squash) + redeploy SSH Portainer.',
];

const restes = [
  'E13 (fin de titre / « réseau instable ») : encore partiel — warm near-end + replaceMediaItem en place, à surveiller en long run.',
  'Embeddings reco : MVP tags+énergie ; phase CLAP/FAISS plus tard.',
  'Home cold start peut encore frôler 5–6 s si YouTube + reco perso sont lents ensemble (budget YT 4 s déjà en place).',
  'Google Sign-In désactivé en prod (GOOGLE_CLIENT_ID vide) — login email / passkey / QR appareil.',
  'Un `pm clear` ou désinstall remet permissions + session à zéro (comportement Android normal).',
];

const bloc = (b: Bloc) => `${b.titre}\n${b.lignes.map((l) => `  · ${l}`).join('\n')}`;

const text = `PLM — Récapitulatif de session
${new Date().toISOString()}
Suite du mail du 3 septembre 2026 (qui s’arrêtait à p+1.3.141)
Version application / serveur : p+1.3.161

== Application (1.3.142 → 1.3.161) ==
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
  <h1 style="font-size:1.35rem;margin:0 0 4px">PLM — récapitulatif complet</h1>
  <p style="color:#666;margin:0 0 8px">6 septembre 2026 · suite du récap du <b>3 septembre</b> (jusqu’à <code>1.3.141</code>)</p>
  <p style="color:#666;margin:0 0 24px">Version actuelle : <code>p+1.3.161</code> · hôtes <code>plm.delhomme.ovh</code> + <code>ytmusic.delhomme.ovh</code></p>

  <h2 style="font-size:1.15rem;border-bottom:1px solid #eee;padding-bottom:4px">Application (1.3.142 → 1.3.161)</h2>
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
