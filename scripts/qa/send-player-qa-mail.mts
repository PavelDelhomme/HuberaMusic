import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendMail } from '../../api/src/platform/mail.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const reportMd = readFileSync(
  join(root, 'logs/player-qa-20260902-222816/REPORT.md'),
  'utf8',
);

const to = process.env.MAIL_TO || process.env.REPORT_TO || process.env.BATTERY_REPORT_TO || '';
const subject = '[PLM] Récap QA lecteur multimédia — 1.3.133 (Samsung)';
const html = `<div style="font-family:system-ui,sans-serif;line-height:1.45;max-width:720px">
<h2>Récap QA lecteur — <code>p+1.3.133</code></h2>
<p>Session ${new Date().toISOString()} — Samsung, son muet pendant les tests.</p>
<h3>Déploiement</h3>
<ul>
<li>Prod + Docker + OTA APK alignés : <code>p+1.3.133</code> / code <code>10433</code></li>
<li>Samsung + Blackview installés</li>
<li>Notes API : Seek fiable + zone tactile large</li>
</ul>
<h3>Correctifs de la session</h3>
<ul>
<li><b>1.3.131–132</b> : seek barre sans reprise au début sur appui court</li>
<li><b>1.3.133</b> : zone seek élargie + geste tap/drag unifié</li>
</ul>
<h3>QA actions (sans suppressions)</h3>
<p><b>0 FAIL</b> sur la dernière passe. Couvert : Now Playing, seek, play/pause, previous×3, next, aléatoire, boucle, like, paroles, playlist, mix, égaliseur, file d’attente + mix.</p>
<p>WARN non bloquants : chips Télécharger/Vitesse parfois hors scroll horizontal ; UI parfois hors NP après mix file + Back.</p>
<h3>Rapport brut</h3>
<pre style="background:#111;color:#eee;padding:12px;overflow:auto;font-size:12px">${reportMd.replaceAll('<', '&lt;')}</pre>
<p style="color:#666;font-size:12px">Script : <code>scripts/android/player-actions-qa.py</code></p>
</div>`;

const r = await sendMail({ to, subject, html, text: reportMd });
console.log(r);
