/**
 * Récap 1.3.193 → 1.3.195 (9 sept. 2026)
 *   node --env-file=.env --import tsx scripts/qa/send-recap-20260909-193-195.mts
 */
import { sendMail } from '../../api/src/platform/mail.ts';

const to = process.env.MAIL_TO || process.env.REPORT_TO || process.env.BATTERY_REPORT_TO || '';
const subject = '[Hubera Music] Récapitulatif — 1.3.193 → 1.3.195 (lecteur, UX, polish)';

const versions = [
  {
    v: '1.3.193',
    t: 'Fiabilité lecteur & hors-ligne',
    pts: [
      'Skip buffering aligné cold start (~24 s) — plus de saut trop tôt Samsung',
      'Hors-ligne : replaceMediaItem (sans recharger toute la file)',
      'Télémétrie digest plafonnée (80 / 256 Ko)',
      'Toast reprise après appel',
      'DL : Aléatoire + Tout réessayer ; fenêtre biblio 220/+200 ; search debounce 380 ms',
    ],
  },
  {
    v: '1.3.194',
    t: 'UX Accueil, Compte & économie d’énergie',
    pts: [
      'Accueil : haptic pull + toast « Accueil actualisé »',
      'Compte : compteur DL + Mo libres',
      'BatterySaver : toast à l’activation',
      'Paroles prefetch +3 ; suggestions search 260 ms',
      'Erreurs DL : titres même hors liste locale',
    ],
  },
  {
    v: '1.3.195',
    t: 'Polish aide, mini-lecteur & reprise réseau',
    pts: [
      'Aide : cold start skip + note Économiseur d’énergie',
      'Toast « Réseau de retour — reprise »',
      'Mini-lecteur : haptic play / prev / next',
      'Bandeau hors-ligne : compteur via revision',
    ],
  },
];

const text = `PLM — Récapitulatif 1.3.193 → 1.3.195
Date: ${new Date().toISOString()}
Appareil gate: Samsung (Blackview / Nothing non touchés)
OTA: https://plm.delhomme.ovh/api/deploy/apk
Version finale: p+1.3.195

${versions
  .map((x) => `== ${x.v} — ${x.t} ==\n${x.pts.map((p) => `- ${p}`).join('\n')}`)
  .join('\n\n')}
`;

const html = `<div style="font-family:system-ui,sans-serif;line-height:1.5;max-width:780px;color:#111">
  <h1 style="font-size:1.35rem;margin:0 0 6px">Récap PLM · 1.3.193 → 1.3.195</h1>
  <p style="color:#555;margin:0 0 16px">${new Date().toISOString()} · Samsung uniquement · OTA publiée</p>
  ${versions
    .map(
      (x) =>
        `<h2 style="font-size:1.05rem;margin:18px 0 6px"><code>${x.v}</code> — ${x.t}</h2><ul>${x.pts
          .map((p) => `<li>${p.replace(/</g, '&lt;')}</li>`)
          .join('')}</ul>`,
    )
    .join('')}
  <p style="color:#666;font-size:12px;margin-top:20px">Téléchargement : <a href="https://plm.delhomme.ovh/api/deploy/apk">/api/deploy/apk</a></p>
</div>`;

const r = await sendMail({ to, subject, html, text });
console.log(JSON.stringify(r, null, 2));
