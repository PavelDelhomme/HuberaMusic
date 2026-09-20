import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendMail } from '../../api/src/platform/mail.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const qaPath = join(root, 'logs/player-qa-20260902-222816/REPORT.md');
const qaMd = existsSync(qaPath) ? readFileSync(qaPath, 'utf8') : '(rapport QA non trouvé)';

const to = process.env.MAIL_TO || process.env.REPORT_TO || process.env.BATTERY_REPORT_TO || '';
const subject = '[PLM] Rapport de session complet — 1.3.129 → 1.3.134 (2 sept. 2026)';

const text = `PLM — Rapport de session complet
Date: ${new Date().toISOString()}
Version finale prod: p+1.3.134 (versionCode 10434)

== État final ==
- API / notes: 1.3.134 — Précharge ~15 s à l'ajout en file
- OTA serveur: p+1.3.134 / 10434
- Conteneur ytmusic: healthy (:latest)
- Samsung / Blackview / Nothing: p+1.3.134 installés

== Versions livrées cette session ==
1.3.129 — Lecteur : pochette pleine largeur (cover bord-à-bord, crop piliers YT)
1.3.130 — Cover remplie (plus de carte flottante), zoom adaptatif, fond flou
1.3.131 — Seek barre : plus de retour au début (scrub stale → seek 0)
1.3.132 — Seek tap court via position X (PlayerSeekBar custom)
1.3.133 — Zone tactile seek élargie + geste tap/drag unifié + script QA
1.3.134 — Précharge ~15 s dès ajout en file / lire ensuite

== Problèmes traités ==
1) Now Playing « carte » / fond pas unifié / piliers marron YouTube
   → cover pleine zone, zoom adaptatif selon ratio, blur ambiant

2) Clic court sur barre de progression → reprise au début
   → cause: Slider Material + scrub=-1 → seek négatif → 0
   → fix: PlayerSeekBar position X + zone tactile large

3) Ajout en file sans précharge → coupure au lancement
   → prefetch ~15 s immédiat, priorité si « suivant » / dernier ajout

== QA lecteur (Samsung, son muet) ==
0 FAIL — play/pause, prev×3, next, aléatoire, boucle, like, paroles,
playlist, mix, égaliseur, file + mix.
WARN: chips Télécharger/Vitesse parfois hors scroll; UI hors NP après mix file.

== Déploiements ==
PRs mergées → dev → prod, CI Docker OK, APK uploadée VPS (OTA Admin),
appareils mis à jour (Samsung, Blackview, Nothing).

== QA brut ==
${qaMd}
`;

const html = `<div style="font-family:system-ui,sans-serif;line-height:1.5;max-width:780px;color:#111">
  <h1 style="font-size:1.35rem;margin:0 0 8px">Rapport de session PLM</h1>
  <p style="color:#555;margin:0 0 20px">${new Date().toISOString()} · version finale <code>p+1.3.134</code> (code <code>10434</code>)</p>

  <h2 style="font-size:1.1rem">État final (vérifié)</h2>
  <ul>
    <li><b>API / notes</b> : 1.3.134 — Précharge ~15 s à l’ajout en file</li>
    <li><b>OTA serveur</b> : p+1.3.134 / 10434 (installable demain sur Nothing comme d’habitude)</li>
    <li><b>Conteneur</b> : ytmusic healthy · image <code>:latest</code></li>
    <li><b>Appareils</b> : Samsung, Blackview, Nothing → déjà en p+1.3.134</li>
  </ul>

  <h2 style="font-size:1.1rem">Versions livrées</h2>
  <table style="border-collapse:collapse;width:100%;font-size:14px">
    <tr style="background:#f4f4f4"><th style="text-align:left;padding:6px 8px">Ver</th><th style="text-align:left;padding:6px 8px">Contenu</th></tr>
    <tr><td style="padding:6px 8px;border-top:1px solid #ddd"><code>1.3.129</code></td><td style="padding:6px 8px;border-top:1px solid #ddd">Pochette NP pleine largeur</td></tr>
    <tr><td style="padding:6px 8px;border-top:1px solid #ddd"><code>1.3.130</code></td><td style="padding:6px 8px;border-top:1px solid #ddd">Cover remplie (plus de carte), zoom anti-piliers, fond flou</td></tr>
    <tr><td style="padding:6px 8px;border-top:1px solid #ddd"><code>1.3.131</code></td><td style="padding:6px 8px;border-top:1px solid #ddd">Seek : plus de retour au début (scrub stale)</td></tr>
    <tr><td style="padding:6px 8px;border-top:1px solid #ddd"><code>1.3.132</code></td><td style="padding:6px 8px;border-top:1px solid #ddd">Seek tap court via position X (PlayerSeekBar)</td></tr>
    <tr><td style="padding:6px 8px;border-top:1px solid #ddd"><code>1.3.133</code></td><td style="padding:6px 8px;border-top:1px solid #ddd">Zone seek élargie + geste unifié + script QA</td></tr>
    <tr><td style="padding:6px 8px;border-top:1px solid #ddd"><code>1.3.134</code></td><td style="padding:6px 8px;border-top:1px solid #ddd">Précharge ~15 s dès ajout en file / lire ensuite</td></tr>
  </table>

  <h2 style="font-size:1.1rem">Problèmes → correctifs</h2>
  <ol>
    <li><b>Now Playing « carte » / piliers / fond chelou</b><br/>
      Cover remplit la zone, zoom adaptatif selon ratio, blur ambiant sous le chrome.</li>
    <li><b>Appui court sur la barre → musique au début</b><br/>
      Cause : Slider Material + scrub encore à -1 → seek négatif → 0.<br/>
      Fix : barre custom sur coordonnée X + zone tactile large + garde-fou.</li>
    <li><b>Ajout en file puis lancement avec blanc / chargement</b><br/>
      Prefetch immédiat ~15 s du titre ajouté (priorité si suivant / dernier ajout), sans couper le titre en cours.</li>
  </ol>

  <h2 style="font-size:1.1rem">QA lecteur (Samsung, son muet)</h2>
  <p><b>0 FAIL</b>. Couvert : Now Playing, seek, play/pause, previous×3, next, aléatoire, boucle, like, paroles, playlist, mix, égaliseur, file d’attente + mix.</p>
  <p style="color:#666">WARN non bloquants : chips Télécharger/Vitesse parfois hors scroll ; UI parfois hors NP après mix file + Back.</p>

  <h2 style="font-size:1.1rem">Déploiements</h2>
  <ul>
    <li>PRs → <code>dev</code> → <code>prod</code> (dont #274 / #275 pour 1.3.134)</li>
    <li>CI Docker GHCR OK + redeploy VPS</li>
    <li>APK OTA uploadée sur le volume serveur</li>
  </ul>

  <h2 style="font-size:1.1rem">Rapport QA brut</h2>
  <pre style="background:#111;color:#eee;padding:12px;overflow:auto;font-size:12px;border-radius:8px">${qaMd.replaceAll('<', '&lt;')}</pre>

  <p style="color:#888;font-size:12px;margin-top:24px">Bonne nuit — à plus tard.</p>
</div>`;

const r = await sendMail({ to, subject, html, text });
console.log(r);
