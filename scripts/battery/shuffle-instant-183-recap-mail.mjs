#!/usr/bin/env node
/**
 * Rapport mail A→Z : Aléatoire instantané + anti click-through (1.3.83).
 * Usage: node --env-file=.env scripts/battery/shuffle-instant-183-recap-mail.mjs
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAM = join(
  ROOT,
  'logs/smoke/shuffle-player-20260827-225714-192_168_1_184_5555/report.json',
);
const BV = join(
  ROOT,
  'logs/smoke/shuffle-player-20260827-230315-EEA9700PRO0014587/report.json',
);

function load(p) {
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const sam = load(SAM);
const bv = load(BV);
const now = new Date().toISOString();

function deviceBlock(label, r) {
  if (!r) return `<h3>${esc(label)}</h3><p><em>rapport absent</em></p>`;
  const sh = r.shuffle || {};
  const sp = r.player_spam || {};
  const sk = sp.after_skips || {};
  return `
  <h3>${esc(label)}</h3>
  <ul>
    <li><b>Device</b> : <code>${esc(r.device)}</code> · pkg <code>${esc(r.pkg)}</code></li>
    <li><b>PASS global</b> : ${r.pass ? '✅' : '❌'}</li>
    <li><b>Aléatoire → buffer</b> : ${sh.click_to_play_s}s (ttfb ${sh.ttfb_s}s) — « ${esc(sh.title)} » [${esc(sh.state)}]</li>
    <li><b>Open lecteur + spam next/pause</b> : ${sp.ok ? '✅' : '❌'} · click-through=${esc(String(sp.biblio_clickthrough))} · nav=${esc(String(sp.nav_visible))}</li>
    <li><b>Après 3 skips</b> : « ${esc(sk.title)} » [${esc(sk.state)}] en ${sk.ttfb_s}s</li>
  </ul>`;
}

const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111;max-width:860px">
<h1>PLM — Rapport complet A→Z · Aléatoire instantané + lecteur (27/08/2026)</h1>
<p>Envoyé : <b>${esc(now)}</b> · Prod live : <b>p+1.3.83</b> · ref <code>prod</code> · commit <code>468a4c9</code></p>

<h2>0. Objectif demandé</h2>
<ul>
  <li>Mode <b>Aléatoire</b> sur toute la biblio (catégorie Titres) trop lent — titres rarement préchauffés.</li>
  <li>Préchargement : 1er titre <b>quasi immédiat</b>, suite progressive.</li>
  <li>Préchargement léger de la bibliothèque (formats / têtes courtes).</li>
  <li>Ouverture lecteur multimédia trop lente → clics next/pause/play traversent vers la liste et referment/réduisent le lecteur.</li>
  <li>Workflow : branche <code>feat/</code> depuis <code>dev</code> → tests courts (pas d’endurance multi-heures) → merge <code>dev</code> → validation appareils → promo <code>prod</code> + APK.</li>
  <li>Fin de soirée : arrêter Samsung/Blackview + API Docker locale ; Nothing testé demain en prod par toi.</li>
</ul>

<h2>1. Branche & version</h2>
<ul>
  <li>Branche : <code>feat/library-shuffle-instant-prefetch</code></li>
  <li>Bump <code>VERSION</code> : <b>1.3.82 → 1.3.83</b></li>
  <li>PR → <code>dev</code> : <a href="https://github.com/PavelDelhomme/YTMusic/pull/181">#181</a> (mergée)</li>
  <li>PR → <code>prod</code> : <a href="https://github.com/PavelDelhomme/YTMusic/pull/182">#182</a> (mergée)</li>
  <li>Image GHCR <code>:latest</code> / <code>:prod</code> rebuildée (run CI 33118003360) + redeploy VPS SSH</li>
  <li>APK prod uploadée → <code>https://ytmusic.delhomme.ovh/api/deploy/apk</code> (~26,9 Mo)</li>
</ul>

<h2>2. Correctifs techniques (détail)</h2>

<h3>2.1 Lecture / Aléatoire</h3>
<ul>
  <li><b>LibraryScreen</b> — bouton Aléatoire : shuffle hors UI → <code>warmCurrentBlocking(wait=true)</code> titre #0 → <code>prefetchStartHead</code> (tête Exo ~8–12 s) → puis <code>onPlay</code> ; warm formats des 8 suivants en fond.</li>
  <li><b>PlayerController.play()</b> : plus de prefetch agressif de 6 têtes <code>ignoreQuiet=true</code> avant le 1er play (volait la bande). Quiet + warm format + warm wait en IO ; têtes N+1 différées ~480 ms après démarrage.</li>
  <li><b>StreamPrefetcher</b> : <code>warmCurrentBlocking(..., wait)</code> (API <code>/api/stream/warm</code> avec <code>wait=1</code>) ; <code>warmFormatsLight</code> ; <code>prefetchStartHead</code>.</li>
  <li><b>Biblio</b> : après chargement, échantillon ~36 IDs en warm formats + 8 têtes ~3 s (léger, non bloquant).</li>
</ul>

<h3>2.2 Lecteur (anti click-through)</h3>
<ul>
  <li><b>MainActivity</b> : alpha ouverture <b>instantanée</b> (tween 0) ; scrim opaque sous le sheet ; mini-player / chrome bas gardés ~220 ms à l’open.</li>
  <li><b>NowPlayingScreen</b> : <code>dismissArmed=false</code> pendant ~420 ms à l’ouverture (évite dismiss / gestes pendant spam next/pause).</li>
</ul>

<h3>2.3 Build DEV vs prod API</h3>
<ul>
  <li><code>resolveDevApiBase()</code> accepte désormais un HTTPS explicite via <code>-PAPI_BASE_URL=https://…</code> (tests device flavor DEV contre prod).</li>
</ul>

<h3>2.4 Outils de test</h3>
<ul>
  <li>Nouveau script : <code>scripts/android/shuffle-player-smoke.py</code></li>
  <li>Login fiable : <code>LOGIN_VIA_API=1</code> (token PLM via <code>VITE_DEV_PASSWORD</code> / <code>.env</code> + extras intent) — pas le mdp UI « okay ».</li>
  <li>Parse <code>media_session</code> Samsung : <code>state=PLAYING(3)</code>.</li>
</ul>

<h2>3. Incident crash 401 (~22:42) — diagnostic</h2>
<p><b>Ce n’était pas un échec stream YouTube / proxy.</b></p>
<ul>
  <li>Mail télémétrie : <code>android.crash · auth-or-blocked</code> · <code>HTTP 401</code> Retrofit · session <code>20260827-224242</code> · app <b>d+1.3.83</b> · apiBase <code>https://ytmusic.delhomme.ovh</code>.</li>
  <li>Cause : bascule APK DEV de l’API LAN (<code>http://192.168.1.134:8787</code>) vers HTTPS prod → <b>token PLM LAN périmé</b> encore en prefs ; appels API → 401 fatal.</li>
  <li>Confusion mdp : <code>okay</code> est <b>invalide</b> sur prod ; le login qui marche est <code>VITE_DEV_PASSWORD</code> du <code>.env</code> (32 car.).</li>
  <li>Remédiation tests : <code>pm clear</code> + injection session API ; smoke mis à jour.</li>
  <li>Titres cités dans le mail (Believe / Edith Piaf) = métadonnées file / télémétrie, pas la cause du 401.</li>
</ul>

<h2>4. Résultats smoke (courts, volume musique = 0)</h2>
${deviceBlock('Samsung SM-G990B2 (Wi‑Fi 192.168.1.184:5555)', sam)}
${deviceBlock('Blackview BV9700Pro (USB EEA9700PRO0014587)', bv)}
<p><b>Lecture</b> : Aléatoire ~2,5 s (Samsung) / ~4,7 s (Blackview) jusqu’à BUFFERING — nettement mieux qu’avant (~8–14 s+ / timeouts). Skips suivants ~0,1 s. Open lecteur + spam contrôles : pas de click-through (nav bas absente).</p>
<p>Nothing Phone : souvent ADB offline — non retesté côté agent ; <b>à valider demain en prod p+1.3.83</b> (OTA / QR Admin).</p>

<h2>5. Chronologie (soirée 27/08)</h2>
<ol>
  <li>Création branche feature depuis <code>dev</code> + implémentation warm / prefetch / scrim.</li>
  <li>Build APK DEV 1.3.83 ; 1ers smokes KO (parse session, login, API LAN forcée).</li>
  <li>Fix HTTPS DEV + login API ; smokes PASS Samsung puis Blackview.</li>
  <li>Commit + push · PR <b>#181</b> → <code>dev</code> (merge).</li>
  <li>Demande promo prod : PR <b>#182</b> <code>dev</code>→<code>prod</code> · CI image · redeploy VPS · publish APK.</li>
  <li>Health prod : <code>ok:true</code> · <code>appVersion: p+1.3.83</code>.</li>
  <li>Arrêt Samsung/Blackview (force-stop apps, pause média) · kill smokes · stop API locale <code>:8787</code>.</li>
</ol>

<h2>6. Fichiers touchés (principaux)</h2>
<ul>
  <li><code>VERSION</code></li>
  <li><code>mobile-android/.../StreamPrefetcher.kt</code></li>
  <li><code>mobile-android/.../PlayerController.kt</code></li>
  <li><code>mobile-android/.../ui/library/LibraryScreen.kt</code></li>
  <li><code>mobile-android/.../MainActivity.kt</code></li>
  <li><code>mobile-android/.../ui/player/NowPlayingScreen.kt</code></li>
  <li><code>mobile-android/app/build.gradle.kts</code></li>
  <li><code>scripts/android/shuffle-player-smoke.py</code></li>
</ul>

<h2>7. État fin de soirée</h2>
<ul>
  <li>✅ <code>dev</code> + <code>prod</code> à jour 1.3.83</li>
  <li>✅ APK prod publiée (install Nothing demain via Admin / update in-app)</li>
  <li>✅ Samsung &amp; Blackview stoppés (pas de campagne en cours)</li>
  <li>✅ API Docker/locale YTMusic <code>:8787</code> arrêtée</li>
  <li>⏳ Retest manuel Nothing en production demain</li>
</ul>

<p style="color:#666;font-size:12px">PRs : #181 (dev) · #182 (prod) · smokes : <code>logs/smoke/shuffle-player-20260827-225714-*</code> · <code>...-230315-*</code></p>
</body></html>`;

const text = `PLM — Rapport A→Z Aléatoire + lecteur (27/08/2026) p+1.3.83

Objectif: shuffle biblio plus rapide, prefetch #0 + suite, anti click-through lecteur.
Branche feat/library-shuffle-instant-prefetch → PR #181 dev → PR #182 prod.
Samsung PASS ~2.5s shuffle ; Blackview PASS ~4.7s ; skips ~0.1s.
Crash 401 22:42 = token LAN périmé après switch HTTPS (pas stream YouTube).
Prod live p+1.3.83 ; APK /api/deploy/apk ; devices + :8787 arrêtés.
Nothing: retest manuel demain.

Détail HTML dans le mail.`;

const outDir = join(ROOT, 'logs/smoke/recap-20260827-183-shuffle-instant');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'RAPPORT.html'), html, 'utf8');
writeFileSync(join(outDir, 'RAPPORT.txt'), text, 'utf8');

const to = (process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '')
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
  subject: 'PLM — Rapport A→Z Aléatoire instantané + lecteur (27/08 · p+1.3.83)',
  text,
  html,
});
console.log('Mail OK', info.messageId, '→', to.join(', '));
console.log('Rapport local', join(outDir, 'RAPPORT.html'));
