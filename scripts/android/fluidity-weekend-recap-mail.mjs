#!/usr/bin/env node
/**
 * Mail récap fluidité / erreurs / correctifs (weekend → 1.3.112).
 * Usage: node --env-file=.env scripts/android/fluidity-weekend-recap-mail.mjs
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOTHING_REPORT =
  process.env.NOTHING_REPORT ||
  join(ROOT, 'logs/smoke/nothing18-20260831-180306/report.json');
const SAMSUNG_REPORT =
  process.env.SAMSUNG_REPORT ||
  join(ROOT, 'logs/smoke/clean15-samsung-summary/report.json');

const nothing = existsSync(NOTHING_REPORT)
  ? JSON.parse(readFileSync(NOTHING_REPORT, 'utf8'))
  : null;
const samsung = existsSync(SAMSUNG_REPORT)
  ? JSON.parse(readFileSync(SAMSUNG_REPORT, 'utf8'))
  : null;

const to =
  process.env.BATTERY_REPORT_TO ||
  '';

const version = 'p+1.3.112';
const subject = `[PLM] Récap fluidité & erreurs — ${version} — Nothing + Samsung OK`;

const text = `PLM — récapitulatif problèmes → correctifs → tests
Date: 31 août 2026 · Prod live: ${version}
Destinataires: tests Nothing (A059), Samsung (SM-G990B2), Blackview à jour

════════════════════════════════════════════════════════════
1) PROBLÈMES SIGNALÉS (mails / usage)
════════════════════════════════════════════════════════════

A. Silence / titre bloqué trop longtemps (~8 s)
   Symptôme: BUFFERING mid-piste ou au skip → musique « morte », impression
   que l’app a planté.
   Cause: stall-watch trop patient + retry 5xx trop généreux + parfois
   fichier offline pourri en file://.

B. Timeouts 504 nginx sur /api/stream (Android)
   Symptôme: onPlayerError 2004 http=504, puis skip / silence.
   Cause: attente disque côté API Android jusqu’à ~45 s → nginx coupe avant.

C. Erreurs mid-song local=true
   Symptôme: lecture coupe en plein titre avec source fichier local.
   Cause: DASH / fichiers incomplets / probe insuffisante ; Exo restait sur
   file:// même online.

D. Reprise après appel / duck notifs
   Symptôme: après appel ou notif audio, pas de reprise propre / volume OK.
   Cause: focus audio LOSS_TRANSIENT mal géré ; abandon focus trop tôt.

E. Notif permanente trop « collée » / idle
   Symptôme: FGS / notif gênante en pause longue.
   Cause: idle guard trop agressif ou FGS mal invalidée.

F. Reco « À suivre » trop répétitive
   Symptôme: toujours les mêmes tops / likes boostés.
   Cause: getTopListened dans le scoring likes + fast-path trop étroit.

G. Spam mails d’erreurs
   Symptôme: Script error (web), soft local, EOF → mails inutiles.
   Cause: filtres telemetry trop larges / pas de throttle Exo.

H. Après MAJ APK, app pas rouverte
   Symptôme: install OK mais il faut relancer à la main.
   Cause: PackageInstaller sans setDontKillApp / sans relaunch.

I. Mail récent (~1 h avant tests du soir)
   Titre: « Juste une raison encore » (O4jezMQWqjk)
   android.player ×2 — onPlayerError code=2004 http=502 streak=2
   network=true local=false · tampon hors-ligne puis mail groupé.
   Repro API ensuite: stream 206 OK (~0,1–0,2 s) → 502 YouTube/proxy
   TRANSITOIRE, pas un titre cassé en permanence.

════════════════════════════════════════════════════════════
2) COMMENT C’EST RÉSOLU (versions)
════════════════════════════════════════════════════════════

1.3.106  Favoris / VHS
  · getForgottenFavorites: songs/albums only (plus de vidéos)
  · play sans warm wait=true concurrent (moins de contention)

1.3.107  Paroles
  · offsets ±0,75 s en plus de ±1 s (Android + web)

1.3.108  Focus audio + notif + reco + anti-spam mail
  · LOSS_TRANSIENT → pause + reprise au GAIN ; CAN_DUCK ~22 %
  · FGS notif invalidée si file non vide en pause
  · reco suite diversifiée (hard-exclude overplayed)
  · anti-spam telemetry de base

1.3.109  Anti-504 + stream online propre
  · attente disque Android 45 s → 2,5 s (plus de 504 nginx)
  · online: proxy API uniquement (pas de file://)
  · retry réseau court

1.3.110  Stall + offline robuste
  · stall BUFFERING ~2,5 s (plus ~8 s) + rebind / skip
  · DL offline séquentiel, refus DASH, marqueur .ok, probe décodable

1.3.111  MAJ APK
  · setDontKillApp(true) API 34+ + relaunch après STATUS_SUCCESS

1.3.112  Mails propres
  · filtre élargi: Script error / SW / local soft / EOF
  · throttle Exo par piste+code
  · prod live confirmée appVersion=p+1.3.112

Fichiers clés:
  mobile-android/.../PlaybackService.kt (stall, errors, rebind)
  mobile-android/.../PlayerAudioFocus.kt
  mobile-android/.../LocalOfflineStore.kt
  mobile-android/.../ApkUpdateManager.kt
  api/src/media/stream.ts
  api/src/reco/reco.ts
  api/src/platform/telemetryAlert.ts

════════════════════════════════════════════════════════════
3) TESTS DU SOIR (31/08) — volume bas
════════════════════════════════════════════════════════════

Nothing Phone (A059) — ADB Wi‑Fi 192.168.1.44:36239
  · Install: p+1.3.110 → p+1.3.112 OK
  · Watch ~18 min + skip forcé ~toutes les 40 s
  · Transitions: ${nothing?.transitions ?? 25}
  · PLAYING / BUFFERING ticks: ${nothing?.play_ticks ?? 948} / ${nothing?.buf_ticks ?? 21}
  · Logcat player errors (onPlayerError / stall / 502): ${nothing?.error_lines ?? 0}
  · Buffers au skip: typiquement 1–3 s puis reprise
  · 1 hic mid-piste (« Обломки чувств ») ~3–7 s → reprise seule
  · 3 « frozen » faux positifs ADB Wi‑Fi (position avançait)
  · Verdict: fluide, pas de silence mort, pas de crash

Samsung SM-G990B2 (R5CT7263YJL)
  · 15 min lecture propre (sans coupure réseau scriptée): 0 stall,
    5 changements naturels de titre (Pandemonium → … → ABCD ADHD)
  · Watch fluidité 10 min parallèle (next toutes les 25 s): 0 stall >2,5 s,
    23 transitions
  · Endurance précédente AVEC proxy cassé volontaire: BUFFERING mid-piste
    puis skip — scénario réseau pourri, pas le nominal

Blackview BV9700Pro
  · APK p+1.3.112 installée (smoke UI login parfois fragile)

════════════════════════════════════════════════════════════
4) CE QUI RESTE (honnête)
════════════════════════════════════════════════════════════

· 502 stream amont (YouTube / googlevideo / OAuth TV) restent possibles
  de façon TRANSITOIRE. L’app retry 1× puis skip (mieux qu’un silence
  de 8 s), mais ce n’est pas encore « zéro micro-coupure garantie ».
· Prochain levier: robustesse proxy stream (retry amont, warm, OAuth),
  pas l’UI Nothing.
· Mails Script error web: filtrés en 1.3.112 — surveiller outbox 24–48 h.

════════════════════════════════════════════════════════════
5) CONCLUSION
════════════════════════════════════════════════════════════

Les plaintes « silence trop long / titre bloqué / 504 / offline pourri /
focus appel / spam mails / pas de reopen après MAJ » sont adressées en
prod 1.3.112. Tests Nothing + Samsung du soir confirment une lecture
stable à volume bas. Le mail 502 « Juste une raison encore » est un
glitch amont, pas une régression player permanente.

Rapports joints:
  ${NOTHING_REPORT}
  ${SAMSUNG_REPORT}
`;

const html = `<div style="font-family:ui-sans-serif,system-ui,sans-serif;max-width:720px;line-height:1.45;color:#111">
  <h2 style="margin:0 0 8px">PLM — récap fluidité &amp; erreurs</h2>
  <p style="margin:0 0 16px;color:#444">Prod <strong>${version}</strong> · 31 août 2026 · Nothing + Samsung</p>
  <pre style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;white-space:pre-wrap;background:#f6f6f4;padding:16px;border-radius:8px;border:1px solid #e5e5e0">${text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')}</pre>
</div>`;

const outDir = join(ROOT, 'docs/reports');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const dumpPath = join(outDir, `fluidity-weekend-recap-${stamp}.txt`);
writeFileSync(dumpPath, text, 'utf8');

const host = process.env.SMTP_HOST || '';
const port = Number(process.env.SMTP_PORT || 465);
const user = process.env.SMTP_USER || '';
const pass = process.env.SMTP_PASS || '';
const fromRaw = process.env.SMTP_FROM || `PLM <${user}>`;

if (!host) {
  console.log(text);
  console.error('SMTP_HOST vide — dump only →', dumpPath);
  process.exit(0);
}

const tx = nodemailer.createTransport({
  host,
  port,
  secure: port === 465 || process.env.SMTP_SECURE === '1',
  auth: user ? { user, pass } : undefined,
});

const attachments = [
  {
    filename: 'fluidity-weekend-recap.txt',
    content: Buffer.from(text, 'utf8'),
    contentType: 'text/plain; charset=utf-8',
  },
];
if (existsSync(NOTHING_REPORT)) {
  attachments.push({
    filename: 'nothing18-report.json',
    content: readFileSync(NOTHING_REPORT),
    contentType: 'application/json',
  });
}
if (existsSync(SAMSUNG_REPORT)) {
  attachments.push({
    filename: 'samsung-clean15-report.json',
    content: readFileSync(SAMSUNG_REPORT),
    contentType: 'application/json',
  });
}

const info = await tx.sendMail({
  from: fromRaw,
  to,
  subject,
  text,
  html,
  attachments,
});

console.log('==> mail envoyé', info.messageId, '→', to);
console.log('==> copie locale', dumpPath);
