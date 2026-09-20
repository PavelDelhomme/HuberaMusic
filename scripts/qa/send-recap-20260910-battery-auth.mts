/**
 * Récap session 10 sept. 2026 — batterie Samsung, auth/reset, DL, OTA
 *   node --env-file=.env --import tsx scripts/qa/send-recap-20260910-battery-auth.mts
 */
import { sendMail } from '../../api/src/platform/mail.ts';

const to =
  process.env.BATTERY_REPORT_TO?.trim() ||
  'dev@delhomme.ovh, [SET_VIA_ENV]';
const subject =
  '[PLM] Récap détaillé — batterie Samsung, auth/reset, DL, OTA (1.3.198 → 1.3.205)';

const iso = new Date().toISOString();

const text = `PLM — Rapport de session détaillé
Date: ${iso}
Canal mail: production (SMTP maily.ovh)
Branche code: feat/battery-dl-soft-205 (PR #455 → dev)
APK Samsung installée: p+1.3.205 (versionCode 10505)
API prod health: appVersion p+1.3.204 (serveur notes/API encore en 204 — promo 205 à faire après merge)

================================================================================
1. CONTEXTE
================================================================================
Session longue autour de :
- OTA / multi-fenêtres Confirmer (Nothing / Samsung / Lenovo)
- Auth prod : inscription + reset MDP avec EMAIL_TEST_INSCRIPTION (bin@delhomme.ovh)
- Téléchargements hors-ligne moins saturants mais fiables
- Batterie : analyse + correctifs sur Samsung uniquement
- Gasoil Tracking : trajet sim domicile→travail lancé (ne pas toucher pendant tes mods)

================================================================================
2. BATTERIE — CE QUI A ÉTÉ RELEVÉ (SAMSUNG SM-G990B2)
================================================================================

2.1 Mesure dumpsys (écran ON, ~13 min 32 s, avant reset stats)
- Capacité estimée : ~4370–4500 mAh
- Décharge : ~82,6 mAh en 13m32 (≈ 6,1 mAh/min) — presque 100 % « screen on »
- Screen off discharge : 0 mAh (fenêtre trop courte, écran jamais éteint)
- Autonomie estimée (écran ON) affichée par le système : ~7h30
- Wi‑Fi data (période) : ~93 Mo reçus / ~8 Mo envoyés
- Wi‑Fi battery drain estimé : ~1,23 mAh (faible vs écran + CPU)
- CPU apps : ~19,5 mAh sur la fenêtre
- Cellular : quasi négligeable (Wi‑Fi dominant)

Verdict mesure courte :
→ Le poste n°1 reste l’écran. Pour juger PLM, il faut une session lecture
  écran OFF 15–30 min (après cut réseau IdleGuard 20 min).
→ La radio Wi‑Fi + CPU de fond (prefetch / DL) sont les leviers app réels.

2.2 Ce qui consomme côté PLM (pas de GPS)
PLM n’a PAS de permission localisation. Pas de WifiLock custom.
Conso = réseau + wake Media3 + CPU prefetch/DL.

Composants déjà présents avant 1.3.205 :
- BatterySaver : suit PowerManager.isPowerSaveMode (économiseur OS)
- OfflineKeeper : tick ~20 min, pause si BatterySaver / stream down
- StreamPrefetcher : warm formats + têtes Exo (jusqu’à ~12 ahead Wi‑Fi)
- CoverPrefetcher : respect allowCoverPrefetch()
- LibraryHeadPrefetcher : crawl biblio + warm serveur shuffle/recent (~60 s)
- OfflineDownloadManager : Semaphore max 2
- LocalOfflineStore : Wi‑Fi gros fichier → Range HTTP ×4 en parallèle
- PlaybackIdleGuard : coupe réseau à 20 min pause BG ; FGS shutdown à 6 h
- PlaybackService : FGS MEDIA_PLAYBACK + WAKE_MODE_NETWORK (Exo)

2.3 Problèmes / gaps relevés (avant correctifs 205)
A) LibraryHeadPrefetcher — warmServerShuffleHeads / warmServerRecentHeads /
   warmFormatsBurst NE respectaient PAS BatterySaver (seul tick() le faisait).
   → Sous économiseur, l’app pouvait encore POST warm + têtes périodiquement.

B) StreamPrefetcher.warmAround — ahead jusqu’à 12 sur Wi‑Fi sans appliquer
   streamPrefetchAhead() (contrairement à d’autres chemins).
   → Prefetch agressif même quand BatterySaver ON.

C) LocalOfflineStore — Range ×4 même pendant lecture / BatterySaver.
   → Pic théorique : 2 DL × 4 Range = jusqu’à 8 flux HTTP.

D) OfflineDownloadManager — 2 concurrents même pendant lecture (sauf mobile).
   → Contention radio avec ExoPlayer.

E) BatterySaver = uniquement mode économiseur OS.
   → Batterie < 15 % sans économiseur = comportement « normal » (gourmand).

F) PlaybackIdleGuard FGS 6 h en pause.
   → Notif + process + wake potentiel longtemps en standby.

G) Mobile throttle DL déjà présent (~12 ms / 256 Ko) — OK mais encore un peu
   agressif pour « respirer » la radio.

================================================================================
3. CORRECTIFS BATTERIE / DL — 1.3.205 (installé Samsung)
================================================================================
- BatterySaver actif aussi si batterie ≤ 15 % (BatteryManager)
- warm* LibraryHeadPrefetcher gated par allowBackgroundDownloads()
- warmAround : streamPrefetchAhead() + garde au moins +1 pour skip fiable
- Pendant lecture OU BatterySaver : max 1 DL concurrent ; Range ×2 (pas ×4)
- Idle Wi‑Fi : Range ×4 conservé pour albums (vitesse utile)
- Throttle mobile : ~20 ms / 256 Ko (toujours assez rapide pour finir)
- IdleGuard FGS : 6 h → 3 h (cut réseau inchangé à 20 min)

Fichiers :
- BatterySaver.kt, LibraryHeadPrefetcher.kt, StreamPrefetcher.kt
- OfflineDownloadManager.kt, LocalOfflineStore.kt, PlaybackIdleGuard.kt

================================================================================
4. AUTH PROD — INSCRIPTION + RESET MDP (VALIDÉ)
================================================================================
Compte test : EMAIL_TEST_INSCRIPTION (bin@delhomme.ovh) + MDP .env
Script : scripts/qa/auth-inscription-reset-qa.mts (--purge optionnel)

Résultats :
1) Purge user prod (SSH/docker) → register 200 → mail « Confirme ton adresse »
2) Verify email (POST /api/auth/verify-email) → email_verified
3) Forgot password → mail « Réinitialisation » (IMAP imap.maily.ovh)
4) Reset + login MDP temp → restore MDP .env → login OK
5) Blackview UI p+1.3.204 : Mot de passe oublié → Envoyer le lien → message succès
6) BlueMail Lite : mails reset + confirm visibles dans la boîte bin@

Points techniques :
- GET HTML verify seul ne consomme pas le token ; POST oui
- SMTP prod OK (mail:production sent → bin@)
- Pas d’endpoint admin delete user simple → purge SQLite via script QA

================================================================================
5. TÉLÉCHARGEMENTS (203–205)
================================================================================
1.3.203 : pending title/artist/cover ; 1 DL + throttle sur mobile ; pas d’ahead auto mobile
1.3.204 : Range multi-bouts Wi‑Fi ; reprise .part (FileOutputStream append)
1.3.205 : encore moins saturant pendant lecture / saver (ci-dessus)

Objectif produit : moins saturer le système, rester fiable et assez rapide.

================================================================================
6. OTA / UX (RAPPEL SESSION — 198→202)
================================================================================
1.3.198 Checking fantôme + USER_ACTION_REQUIRED
1.3.199 OTA cross-canal : package APK = prod (pas .dev) — fix d+ vs p+
1.3.200 UX mix/NP/options + vidéo timeout + OTA 1 feuille
1.3.201 Popup MAJ reste ouverte avec %
1.3.202 Anti multi-sessions OTA (installInFlight, plus de VIEW auto)

================================================================================
7. GASOIL TRACKING (HORS PLM — INFO)
================================================================================
Trajet sim lancé sur Samsung (preprod) :
Domicile Thorigné (Camille Saint-Saëns / SIM_HOME) → via Châteaugiron →
Intermarché La Guerche (SIM_WORK). Suivi « Travail A/R (sim) » puis historique.
Tablette Lenovo : pas de package Gasoil (PLM seulement).
→ Ne pas relancer / purger pendant tes modifications Gasoil en cours.

================================================================================
8. ÉTAT PROD / APPAREILS
================================================================================
- API plm.delhomme.ovh : healthy, privateMode, allowRegister=true
- appVersion API notes : encore p+1.3.204 jusqu’à promo après merge PR #455
- Samsung : p+1.3.205 (APK locale installée)
- Blackview : testé auth UI en 204 ; à OTA 205 après merge/promo
- Nothing : non re-gate batterie cette session
- PR : https://github.com/PavelDelhomme/YTMusic/pull/455

================================================================================
9. SUITE RECOMMANDÉE
================================================================================
1) Merger PR #455 → dev → redeploy / promo prod + OTA
2) Session batterie Samsung 20–30 min : lecture Wi‑Fi écran OFF, puis
   dumpsys batterystats (comparer mAh screen-off + wifi + uid PLM)
3) Même mesure avec économiseur OS ON
4) DL album pendant lecture : vérifier 1 flux + Range×2
5) Batterie faible <15 % : logs « BatterySaver ON (.../lowBatt) »
6) Re-tester inscription avec --purge quand tu voudras (compte bin@)

Bonne soirée.
`;

const html = `<div style="font-family:system-ui,sans-serif;line-height:1.55;max-width:820px;color:#111">
  <h1 style="font-size:1.4rem;margin:0 0 6px">PLM — Rapport détaillé (batterie, auth, DL, OTA)</h1>
  <p style="color:#555;margin:0 0 18px">${iso}<br/>
  Samsung <code>p+1.3.205</code> · API prod notes encore <code>p+1.3.204</code> · mail <b>production</b><br/>
  PR <a href="https://github.com/PavelDelhomme/YTMusic/pull/455">#455</a> · script QA auth + BatterySaver élargi</p>

  <h2>1. Batterie Samsung — mesures</h2>
  <p>Fenêtre courte (~13 min 32 s, <b>écran allumé</b>, stats avant reset) :</p>
  <ul>
    <li>Décharge ≈ <b>82,6 mAh</b> (≈ 6,1 mAh/min) — quasi 100 % screen-on</li>
    <li>Screen-off : 0 mAh (pas de fenêtre écran éteint utile)</li>
    <li>Wi‑Fi ≈ 93 Mo↓ / 8 Mo↑ · drain Wi‑Fi estimé ≈ 1,23 mAh</li>
    <li>CPU apps ≈ 19,5 mAh · capacité ~4370–4500 mAh</li>
  </ul>
  <p><b>Verdict :</b> l’écran domine. Les leviers PLM = radio Wi‑Fi + prefetch/DL + FGS Media3
  (<code>WAKE_MODE_NETWORK</code>). <b>Pas de GPS</b> dans PLM.</p>

  <h2>2. Causes relevées (avant 1.3.205)</h2>
  <ol>
    <li><b>LibraryHeadPrefetcher</b> : warm serveur / formats burst ignoraient BatterySaver (seul <code>tick()</code> le respectait).</li>
    <li><b>warmAround</b> : jusqu’à ~12 titres ahead Wi‑Fi sans <code>streamPrefetchAhead()</code>.</li>
    <li><b>DL Range ×4</b> même pendant lecture → pic jusqu’à 8 flux HTTP (2 DL × 4).</li>
    <li><b>2 DL concurrents</b> pendant lecture (Wi‑Fi) → contention avec Exo.</li>
    <li><b>BatterySaver</b> = économiseur OS seulement (pas le seuil &lt; 15 %).</li>
    <li><b>IdleGuard FGS 6 h</b> en pause → standby long avec notif/service.</li>
  </ol>

  <h2>3. Correctifs 1.3.205 (installés Samsung)</h2>
  <table style="border-collapse:collapse;width:100%;font-size:14px">
    <tr style="background:#f4f4f4"><th style="text-align:left;padding:8px">Changement</th><th style="text-align:left;padding:8px">Effet</th></tr>
    <tr><td style="padding:8px;border-top:1px solid #ddd">BatterySaver aussi ≤ 15 %</td><td style="padding:8px;border-top:1px solid #ddd">Prefetch allégé sans attendre l’économiseur</td></tr>
    <tr><td style="padding:8px;border-top:1px solid #ddd">Warm serveur / warmAround gated</td><td style="padding:8px;border-top:1px solid #ddd">Moins de radio en fond ; skip +1 conservé</td></tr>
    <tr><td style="padding:8px;border-top:1px solid #ddd">1 DL si lecture / saver ; Range ×2</td><td style="padding:8px;border-top:1px solid #ddd">Moins saturant ; ×4 idle Wi‑Fi pour albums</td></tr>
    <tr><td style="padding:8px;border-top:1px solid #ddd">Throttle mobile ~20 ms / 256 Ko</td><td style="padding:8px;border-top:1px solid #ddd">Plus doux, encore assez rapide</td></tr>
    <tr><td style="padding:8px;border-top:1px solid #ddd">FGS idle 6 h → 3 h</td><td style="padding:8px;border-top:1px solid #ddd">Cut réseau déjà à 20 min (inchangé)</td></tr>
  </table>

  <h2>4. Auth prod (inscription + reset) — OK</h2>
  <p>Compte <code>EMAIL_TEST_INSCRIPTION</code> (<code>bin@delhomme.ovh</code>) · IMAP maily · BlueMail Lite Blackview.</p>
  <ul>
    <li>Purge → register → mail confirm → verify POST → OK</li>
    <li>Forgot → mail reset → reset MDP → login → restore MDP .env → OK</li>
    <li>UI Blackview : « Mot de passe oublié ? » → message succès envoi lien</li>
  </ul>
  <p style="color:#555;font-size:13px">Script : <code>scripts/qa/auth-inscription-reset-qa.mts</code> (<code>--purge</code>)</p>

  <h2>5. Téléchargements 203→205</h2>
  <ul>
    <li><b>203</b> : titre/artiste pendant DL ; 1 DL mobile ; pas d’ahead auto mobile</li>
    <li><b>204</b> : multi-bouts Wi‑Fi + reprise <code>.part</code></li>
    <li><b>205</b> : encore plus doux pendant lecture / saver</li>
  </ul>

  <h2>6. OTA rappel (198→202)</h2>
  <p>Checking fantôme → package cross-canal d+/p+ → popup % → une seule feuille Confirmer
  (anti multi-sessions Nothing).</p>

  <h2>7. Gasoil (info)</h2>
  <p>Sim commute Samsung preprod : Thorigné → Châteaugiron → Intermarché La Guerche
  (terminé / historique). <b>Pas de relance</b> pendant tes mods Gasoil.</p>

  <h2>8. Suite</h2>
  <ol>
    <li>Merger / promo <b>1.3.205</b> (API notes + OTA flotte)</li>
    <li>Session batterie 20–30 min <b>écran OFF + lecture</b> puis dumpsys</li>
    <li>Comparer économiseur ON vs OFF ; DL album pendant lecture</li>
    <li>Logcat <code>BatterySaver ON (.../lowBatt)</code> sous 15 %</li>
  </ol>

  <p style="color:#888;font-size:12px;margin-top:28px">Envoyé via SMTP prod PLM · destinataire(s) : ${to.replaceAll('<', '&lt;')}</p>
</div>`;

const r = await sendMail({ to, subject, html, text });
console.log(JSON.stringify(r, null, 2));
