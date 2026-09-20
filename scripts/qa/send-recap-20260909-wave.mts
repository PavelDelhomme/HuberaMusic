/**
 * Récap 5 versions PLM — 1.3.187 → 1.3.191 (9 sept. 2026)
 *   node --env-file=.env --import tsx scripts/qa/send-recap-20260909-wave.mts
 */
import { sendMail } from '../../api/src/platform/mail.ts';

const to = process.env.MAIL_TO || process.env.REPORT_TO || process.env.BATTERY_REPORT_TO || '';
const subject = '[PLM] Récapitulatif — 1.3.187 → 1.3.191 (lecteur, biblio, offline, cast, polish)';

const versions = [
  {
    v: '1.3.187',
    t: 'Lecteur sans silence',
    pts: [
      'Toasts buffering distincts (hors-ligne / serveur / Wi‑Fi) + skip auto si stuck',
      'Skip suivant : warm immédiat #1–#2',
      'File Holder avant suggestions ; silence de fin plus prévisible',
      'Handover réseau + rechauffe après veille',
      'Web : max 3 retries 502 puis suivant ; cache têtes API élargi',
    ],
  },
  {
    v: '1.3.188',
    t: 'Bibliothèque & Accueil fluides',
    pts: [
      'Pull-to-refresh toast ; filtres ✕ accessibles',
      'Empty states Profils / Fichiers / Podcasts / Livres',
      'Recherche : erreurs FR + warm des 8 premiers résultats',
      'Prefetch viewport biblio ; warm pin à l’épinglage',
      'Téléchargés : ordre Playlists → Albums → Titres',
    ],
  },
  {
    v: '1.3.189',
    t: 'Paroles, hors-ligne, pins',
    pts: [
      'Paroles cachées à la fin du DL + prefetch +2 titres',
      'Écran Téléchargements : section Erreurs',
      'Alerte espace disque ; 2ᵉ tap annule DL',
      'OfflineKeeper respect BatterySaver',
      'Messages DASH clairs',
    ],
  },
  {
    v: '1.3.190',
    t: 'Cast, session, notifications',
    pts: [
      'Cast : Lecture ici / Musique ailleurs + reprise locale',
      'Chromecast web : message d’échec clair',
      'MediaSession durée hint ; tick NP BatterySaver',
      'Accueil : empty Podcasts/Livres ; MixCache preview',
      'Toasts pin ; hero Mix label ; warm artiste',
    ],
  },
  {
    v: '1.3.191',
    t: 'Polish compte & parité',
    pts: [
      'Compte : stats écoute 7 j ; sheet biblio optimiste',
      'UpdateBanner / InstallBanner / PlayerBar web',
      'Pin depuis Now Playing ; Aide MAJ/cast/offline',
      'Audio focus duck ; télémétrie ; ApiErrors FR',
      'Samsung uniquement installé (gate)',
    ],
  },
];

const text = `PLM — Récapitulatif 1.3.187 → 1.3.191
Date: ${new Date().toISOString()}
Appareil gate: Samsung (Blackview / Nothing non touchés)
OTA: https://plm.delhomme.ovh/api/deploy/apk
Version finale: p+1.3.191

${versions
  .map((x) => `== ${x.v} — ${x.t} ==\n${x.pts.map((p) => `- ${p}`).join('\n')}`)
  .join('\n\n')}
`;

const html = `<div style="font-family:system-ui,sans-serif;line-height:1.5;max-width:780px;color:#111">
  <h1 style="font-size:1.35rem;margin:0 0 6px">Récap PLM · 1.3.187 → 1.3.191</h1>
  <p style="color:#555;margin:0 0 16px">${new Date().toISOString()} · finale <code>p+1.3.191</code> · Samsung only</p>
  <p>Cinq versions livrées à la suite (lecteur → biblio → offline/paroles → cast → polish). Blackview et Nothing non touchés.</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px;margin:16px 0">
    <tr style="background:#f4f4f4"><th style="text-align:left;padding:8px">Ver</th><th style="text-align:left;padding:8px">Thème</th></tr>
    ${versions
      .map(
        (x) =>
          `<tr><td style="padding:8px;border-top:1px solid #ddd"><code>${x.v}</code></td><td style="padding:8px;border-top:1px solid #ddd"><b>${x.t}</b><ul style="margin:6px 0 0;padding-left:18px">${x.pts
            .map((p) => `<li>${p}</li>`)
            .join('')}</ul></td></tr>`,
      )
      .join('')}
  </table>
  <p style="color:#666;font-size:12px">OTA : <a href="https://plm.delhomme.ovh/api/deploy/apk">/api/deploy/apk</a> · mails individuels déjà envoyés pour chaque version.</p>
</div>`;

const r = await sendMail({ to, subject, html, text });
console.log(JSON.stringify(r, null, 2));
