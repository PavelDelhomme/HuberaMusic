#!/usr/bin/env node
/**
 * Rapport mail campagne libshuffle 120 min + bilan stream/DNS (27/08/2026).
 * Usage: node --env-file=.env scripts/battery/libshuffle-120-recap-mail.mjs
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAM = join(
  ROOT,
  'logs/endurance/libshuffle-20260827-193037-192_168_1_184_5555/report.json',
);
const BV = join(
  ROOT,
  'logs/endurance/libshuffle-20260827-193037-192_168_1_12_5555/report.json',
);

function load(p) {
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function sectionDevice(label, r) {
  if (!r) return `<h3>${label}</h3><p><em>rapport absent</em></p>`;
  const titles = (r.uniqueTitles || []).slice(0, 25).map((t) => `<li>${esc(t)}</li>`).join('');
  const sample = (r.titles || [])
    .slice(-8)
    .map((t) => `<li>+${t.t}s — ${esc((t.title || '?').slice(0, 60))} [${esc(t.state || '')}]</li>`)
    .join('');
  const final = r.final || {};
  return `
  <h3>${esc(label)}</h3>
  <ul>
    <li><b>Device</b> : ${esc(r.device)}</li>
    <li><b>Durée</b> : ${r.elapsedSec}s (~${Math.round((r.elapsedSec || 0) / 60)} min) — cible ${r.durationMin} min</li>
    <li><b>Transitions</b> : ${r.transitions} · <b>Skips</b> : ${r.skips} · <b>Titres uniques</b> : ${r.uniqueCount}</li>
    <li><b>Reshuffles biblio</b> : ${r.reshuffles ?? '?'}</li>
    <li><b>Erreurs script</b> : ${r.errorCount} (souvent faux positifs logcat / cache local)</li>
    <li><b>ok script</b> : ${r.ok ? '✅' : '⚠️ false (erreurs comptées)'} — lecture finale <b>${esc(final.state)}</b> « ${esc(final.title || '?')} »</li>
  </ul>
  <p><b>Dernières transitions</b></p><ul>${sample}</ul>
  <p><b>Échantillon titres uniques</b></p><ul>${titles}</ul>`;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const sam = load(SAM);
const bv = load(BV);

const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;line-height:1.45;color:#111">
<h1>PLM — Rapport campagne 120 min + bilan stream (27/08/2026)</h1>
<p>Date : ${new Date().toISOString()} · Prod <b>p+1.3.81</b> · Proxies gratuits ON · Relais PC OFF</p>

<h2>1. Ce qui a été résolu aujourd’hui</h2>
<ul>
  <li><b>Relais PC maison</b> : plus forcé en prod (opt-in <code>ALLOW_STREAM_UPSTREAM=1</code> uniquement). Tunnel stoppé.</li>
  <li><b>Proxies HTTP gratuits</b> pour yt-dlp : rotation après échec direct VPS (bypass 50x / LOGIN_REQUIRED).</li>
  <li><b>Fallback VPS</b> après relais KO (déjà 1.3.79) + skip auto player + FGS (1.3.80).</li>
  <li><b>Streams titres mail/erreur</b> : 20/20 puis 6/6 recheck → HTTP <b>206</b> (Lose Yourself, Mockingbird, Pandemonium, Vois sur ton chemin, #Alkogolichka, YOUSATONMYMIND, etc.).</li>
  <li><b>Biblio nettoyée</b> : playlists test « QA Endurance Diversité » + « Mix test » supprimées.</li>
  <li><b>APK</b> p+1.3.81 installée Samsung + Blackview (Nothing hors ADB).</li>
</ul>

<h2>2. Erreur DNS de l’email (android.player · dns)</h2>
<p><b>Ce n’est pas un échec du proxy / de la bascule 1.3.81.</b></p>
<ul>
  <li>Horodatage player : <b>19:24</b> (heure locale) — encore en <b>p+1.3.80</b>, <i>avant</i> le déploiement 1.3.81 (~19:16) et la campagne 19:30.</li>
  <li>Cause réelle : <code>UnknownHostException: ytmusic.delhomme.ovh</code> sur le <b>téléphone</b> (Wi‑Fi/DNS device), pas ExoPlayer codec, pas YouTube 50x.</li>
  <li>DNS serveur OK maintenant : A = <code>95.111.227.204</code> · ping Samsung/Blackview OK · streams 206.</li>
  <li>Titre principal : <b>Vois sur ton chemin (Techno Mix) — BENNETT</b> (<code>i9Jr50r8L7o</code>) — stream revalidé 206.</li>
</ul>
<p><b>« Titres inconnus » InetAddress / sendRequest</b> : faux positifs — symboles Java 11 caractères extraits de la stack. Correctif API en cours (ne plus scanner les stacks en aveugle + blocklist). Les vrais titres de l’alerte :</p>
<ul>
  <li>i9Jr50r8L7o — Vois sur ton chemin (Techno Mix) — BENNETT</li>
  <li>FLJ_PQ5_lTg — #Alkogolichka — Arthur Pirozhkov</li>
  <li>xnIZmWmAaCc — YOUSATONMYMIND — Rilès</li>
  <li>B5EbznZ2LFA — Head Shoulders Knees And Toes — Lucas King</li>
  <li>HB43Ksrc_dM — Vae Victis — SUPERIOR.CAT.PROTEUS</li>
</ul>

<h2>3. Campagne libshuffle 120 minutes (19:30 → 21:31)</h2>
<p>Skip ~35 s · reshuffle biblio/Aléatoire ~6 min · volume musique = 0.</p>
${sectionDevice('Samsung SM-G990B2', sam)}
${sectionDevice('Blackview BV9700Pro', bv)}
<p><b>Nothing</b> : jamais joignable en ADB (offline) — non testé cette session.</p>

<h2>4. Ce qui s’est bien passé</h2>
<ul>
  <li>~2 h continues sur 2 appareils, file active jusqu’à la fin (état final PLAYING).</li>
  <li>Samsung : <b>210</b> transitions · <b>144</b> skips · <b>129</b> titres uniques.</li>
  <li>Blackview : <b>150</b> transitions · <b>130</b> skips · <b>119</b> titres uniques.</li>
  <li>Pas de crash FGS · pas de vague 503 stream post-1.3.81 · tunnel maison non requis.</li>
  <li>Volume forcé à 0 pendant les tests.</li>
</ul>

<h2>5. Ce qui a moins bien passé</h2>
<ul>
  <li><b>DNS device</b> (19:24, encore 1.3.80) : alerte mail retardée (~20:18) — glitch Wi‑Fi/DNS Samsung, pas prod API.</li>
  <li><b>Cache Exo local 3003</b> (ex. Insolent 5 / Holy Place) : fichier cache tronqué · stream serveur OK · gen cache s4 déjà en place.</li>
  <li>Script marque <code>ok=false</code> à cause de lignes ERROR logcat (dont faux positifs / erreurs locales) alors que la lecture a tenu 120 min.</li>
  <li>UI « Titres » parfois vide (« Rien d’enregistré ») alors que la file J’aime/queue joue encore — à clarifier demain (source Aléatoire = toute la biblio réelle).</li>
  <li>Nothing non testé (ADB).</li>
</ul>

<h2>6. Skip titre bloqué → message utilisateur</h2>
<p>Déjà en place : toast au passage auto au titre suivant après échecs répétés. Amélioration : toast long avec motif (<b>DNS/réseau KO</b>, serveur 5xx, etc.) + nom du titre suivant. Sera dans la prochaine APK (tests demain).</p>

<h2>7. Plan demain</h2>
<ol>
  <li>APK avec toast skip enrichi + éventuel bump.</li>
  <li>Lancer Aléatoire sur <b>toute</b> la bibliothèque (pas seulement une file résiduelle).</li>
  <li>Priorité titres jamais vus + recheck des IDs mail (DNS/50x/3003).</li>
  <li>Volume = 0 · Nothing si ADB pairé.</li>
</ol>

<p style="color:#666;font-size:12px">PRs : #175 (dev) · #176 (prod) · logs : <code>logs/endurance/campaign-20260827-193037-libshuffle-post181/</code></p>
</body></html>`;

const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const outDir = join(ROOT, 'logs/endurance/campaign-20260827-193037-libshuffle-post181');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'RAPPORT.html'), html, 'utf8');
writeFileSync(join(outDir, 'RAPPORT.txt'), text, 'utf8');

const to = (process.env.ADMIN_EMAILS || process.env.SMTP_REPLY_TO || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (!to.length) {
  console.error('ADMIN_EMAILS vide');
  process.exit(2);
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: process.env.SMTP_SECURE !== '0',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const info = await transporter.sendMail({
  from: process.env.SMTP_FROM || 'PLM <noreply@maily.ovh>',
  to: to.join(', '),
  subject: 'PLM — Rapport campagne 120 min + DNS/stream (27/08 · p+1.3.81)',
  text,
  html,
});
console.log('Mail OK', info.messageId, '→', to.join(', '));
console.log('Rapport local', join(outDir, 'RAPPORT.html'));
