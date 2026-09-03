/**
 * Récapitulatif de la session du 3 septembre 2026 : coupures de lecture, file
 * d'attente, paroles, interruptions système, et titres dont la vidéo YouTube
 * a disparu.
 *
 *   npx tsx scripts/qa/send-recap-20260903.mts
 */
import { sendMail } from '../../api/src/platform/mail.ts';

const to = 'dev@delhomme.ovh, [REDACTED]';
const subject = '[PLM] Récapitulatif — 1.3.135 → 1.3.141 + remplacement des titres morts';

type Bloc = { titre: string; lignes: string[] };

const appli: Bloc[] = [
  {
    titre: '1.3.135 — Plus de silence en boucle sur un titre bloqué',
    lignes: [
      "« APRÈS-VOUS MADAME » restait muet en boucle : le lecteur se rebranchait indéfiniment sur un flux qui ne venait pas.",
      'Après quelques tentatives infructueuses, le titre est maintenant passé au lieu de bloquer toute la file.',
    ],
  },
  {
    titre: '1.3.136 — Fin des coupures en cours de morceau',
    lignes: [
      'Une demande de segment au milieu du morceau pouvait attendre sans limite côté serveur.',
      'Elle dispose désormais d’un budget borné, avec repli sur une autre source si le délai est dépassé.',
    ],
  },
  {
    titre: '1.3.137 — Titres qui mettaient du temps à démarrer',
    lignes: [
      'Un titre jamais lu doit d’abord être récupéré par le serveur, ce qui prend parfois une trentaine de secondes.',
      'Le téléphone patiente maintenant assez longtemps pour ce premier démarrage au lieu d’abandonner.',
    ],
  },
  {
    titre: '1.3.138 — La lecture reste sur tes titres',
    lignes: [
      'Lecture aléatoire ou clic sur un titre ne couvraient qu’une fenêtre réduite, puis enchaînaient sur des recommandations YouTube sans rapport.',
      'La file porte désormais sur la bibliothèque entière, chargée au fur et à mesure ; l’onglet « Enregistrés récemment » démarre sur les ajouts récents mais continue sur tout le reste.',
    ],
  },
  {
    titre: '1.3.139 — Paroles au bon endroit dès le changement de titre',
    lignes: [
      'Les paroles restaient sur la fin du morceau précédent et attendaient que la lecture les rattrape.',
      'Elles repartent du haut à chaque changement de titre.',
    ],
  },
  {
    titre: '1.3.140 — « À suivre » reprend son rôle',
    lignes: [
      'Effet de bord de la version précédente : après une écoute depuis la bibliothèque, lancer un titre seul ou une radio faisait tourner la lecture en rond sur trois ou quatre morceaux, sans suggestions.',
      'La prolongation ne s’applique plus qu’à la sélection réellement en cours.',
    ],
  },
  {
    titre: '1.3.141 — Notifications et appels sans casser l’écoute',
    lignes: [
      'Une notification coupait le son ; après un appel, la musique restait en pause.',
      'Une notification baisse maintenant le volume puis le remonte. Un appel met en pause et la lecture repart à la fin de la communication — y compris quand le système nous sort complètement de la pile audio, cas où aucun signal de reprise n’arrive et où la fin d’appel est guettée par nos soins.',
      'Une pause faite à la main pendant un appel reste respectée : la musique ne redémarre pas toute seule.',
    ],
  },
];

const serveur: Bloc[] = [
  {
    titre: 'Titres dont la vidéo YouTube a disparu',
    lignes: [
      'Certains titres de la bibliothèque pointent vers des vidéos supprimées : erreur 502 systématique, morceau injouable définitivement.',
      'Le serveur cherche désormais une autre copie du même morceau, vérifie qu’il s’agit bien du bon titre par le même interprète et d’une durée cohérente, puis mémorise la correspondance.',
      'Les garde-fous ont été resserrés au fil des essais : un remix ne remplace pas l’original, une reprise ne remplace pas l’interprète d’origine, et une durée trop éloignée disqualifie le candidat.',
    ],
  },
  {
    titre: 'Reconnaissance des rééditions',
    lignes: [
      'Trois formats fréquents recalaient à tort de bons remplaçants : les vidéos nommées « Artiste - Titre », les copies publiées comme vidéo plutôt que comme chanson, et les rééditions par des chaînes tierces qui nomment l’interprète dans le titre.',
      'Les trois sont maintenant acceptés. Les coquilles présentes dans les titres enregistrés (« Juqu’à la mort ») sont également tolérées.',
    ],
  },
  {
    titre: 'Attente de quarante secondes supprimée',
    lignes: [
      'Trouver un remplaçant prend une quarantaine de secondes, pendant lesquelles le téléphone abandonne : c’est exactement le saut de titre constaté à l’usage.',
      'Un balayage de fond parcourt donc la bibliothèque et résout les remplacements en amont, en commençant par les titres ajoutés le plus récemment.',
      'Il s’efface devant l’écoute en cours pour la partie coûteuse, ne repasse jamais sur un titre déjà vérifié, et retente au bout d’une semaine ceux restés sans solution — le catalogue YouTube évolue.',
    ],
  },
];

const verifs = [
  '14 521 titres de la bibliothèque inscrits au balayage ; il progresse en continu, y compris pendant l’écoute.',
  'Onze cas d’appariement vérifiés automatiquement (scripts/qa/track-match-check.mts) : les bons remplaçants passent, les reprises et remix sont refusés.',
  'Balayage des flux de la bibliothèque : les titres qui échouaient auparavant se résolvent et se lisent.',
  '« Poto » de Demi Portion : le morceau est sain côté serveur et se lit sans accroc sur le Samsung en 1.3.141.',
  'Samsung et Blackview : lecture continue avec changements de titre réguliers, sans blocage ni erreur de lecteur.',
];

const restes = [
  'Le Nothing tourne encore en 1.3.135, six versions en retard : il lui manque tous les correctifs de coupure ci-dessus, ce qui explique le comportement observé sur « Poto ». Le débogage sans fil n’y répond plus — un branchement USB suffit à le mettre à jour.',
  'Le balayage complet de la bibliothèque demande environ deux jours à la cadence retenue, volontairement lente pour ne pas se faire limiter par YouTube. Les titres récents sont traités en premier.',
];

const bloc = (b: Bloc) => `${b.titre}\n${b.lignes.map((l) => `  · ${l}`).join('\n')}`;

const text = `PLM — Récapitulatif de session
${new Date().toISOString()}
Version application : p+1.3.141 · serveur : à jour

== Application ==
${appli.map(bloc).join('\n\n')}

== Serveur ==
${serveur.map(bloc).join('\n\n')}

== Vérifications ==
${verifs.map((v) => `  · ${v}`).join('\n')}

== Ce qui reste ==
${restes.map((r) => `  · ${r}`).join('\n')}
`;

const htmlBloc = (b: Bloc) => `
  <h3 style="font-size:1rem;margin:18px 0 6px">${b.titre}</h3>
  <ul style="margin:0;padding-left:20px">${b.lignes.map((l) => `<li>${l}</li>`).join('')}</ul>`;

const html = `<div style="font-family:system-ui,-apple-system,sans-serif;line-height:1.55;max-width:760px;color:#111">
  <h1 style="font-size:1.35rem;margin:0 0 4px">PLM — récapitulatif de session</h1>
  <p style="color:#666;margin:0 0 24px">3 septembre 2026 · application <code>p+1.3.141</code> · serveur à jour</p>

  <h2 style="font-size:1.15rem;border-bottom:1px solid #eee;padding-bottom:4px">Application</h2>
  ${appli.map(htmlBloc).join('')}

  <h2 style="font-size:1.15rem;border-bottom:1px solid #eee;padding-bottom:4px;margin-top:28px">Serveur</h2>
  ${serveur.map(htmlBloc).join('')}

  <h2 style="font-size:1.15rem;border-bottom:1px solid #eee;padding-bottom:4px;margin-top:28px">Vérifications</h2>
  <ul style="margin:0;padding-left:20px">${verifs.map((v) => `<li>${v}</li>`).join('')}</ul>

  <h2 style="font-size:1.15rem;border-bottom:1px solid #eee;padding-bottom:4px;margin-top:28px">Ce qui reste</h2>
  <ul style="margin:0;padding-left:20px">${restes.map((r) => `<li>${r}</li>`).join('')}</ul>
</div>`;

await sendMail({ to, subject, html, text });
console.log('récapitulatif envoyé à', to);
