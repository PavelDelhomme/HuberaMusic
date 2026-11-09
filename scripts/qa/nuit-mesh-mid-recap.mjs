#!/usr/bin/env node
/** Recap à mi-parcours — n’arrête PAS le harnais. */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import nodemailer from 'nodemailer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.env.OUT || '/tmp/hubera-nuit-2026-10-06';
const summary = JSON.parse(readFileSync(join(OUT, 'summary.json'), 'utf8'));
const events = existsSync(join(OUT, 'events.jsonl'))
  ? readFileSync(join(OUT, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean)
  : [];
const live = existsSync(join(OUT, 'live.log'))
  ? readFileSync(join(OUT, 'live.log'), 'utf8').trim().split('\n').slice(-12).join('\n')
  : '';
const s = summary.stats || {};
const row = (n) => s[n] || {};
const stamp = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

const md = `Hubera — recap à mi-parcours (tests TOUJOURS en cours)
Généré : ${stamp}  ·  arrêt prévu : 02:00  ·  mail final à 02:00

Les tests ne sont PAS arrêtés.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OÙ ON EN EST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Harnais muet Samsung + Blackview (Music p+1.3.352), alarmes conservées.
• Nothing : hors tests (YouTube / sommeil). Music tué dessus, DND coupé.
• Compte Music labo : paul@ (compte principal), pas le seed vide dev@.
• Contrôles agent toutes les 6 min.
• Session harnais actuelle depuis ~19:58 (BUF_S=40 s avant skip).

Session actuelle (${summary.elapsed_min ?? '?'} min) :
- Samsung : ${row('samsung').titles || 0} titres · skip buffering ${row('samsung').skips_buf || 0} · lecture réelle ${Math.round((row('samsung').playing_s || 0) / 60)} min · dernier : ${(row('samsung').last || '').slice(0, 70)}
- Blackview : ${row('blackview').titles || 0} titres · skip buffering ${row('blackview').skips_buf || 0} · lecture réelle ${Math.round((row('blackview').playing_s || 0) / 60)} min · dernier : ${(row('blackview').last || '').slice(0, 70)}
- Maps/Fuel cycles : ${summary.maps_runs ?? 0}  ·  smoke autres apps : ${summary.smoke_runs ?? 0}

Cumul événements depuis ~19:00 (plusieurs relances) : ${events.length} lignes
(titres ${events.filter((e) => e.kind === 'title').length}, skip_buf ${events.filter((e) => e.kind === 'skip_buf').length}, maps ${events.filter((e) => e.kind === 'maps').length}, fuel ${events.filter((e) => e.kind === 'fuel').length}, smoke ${events.filter((e) => e.kind === 'smoke').length})

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CE QUI BLOQUE (en cours de traitement)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Music : presque tous les titres restent en BUFFERING (pos=0). Logcat : paroles ~21 s qui saturent OkHttp, GET /api/stream/…/url Canceled, stall-escalate. Le skip 15 s empirait ; maintenant 40 s.
• Fuel Samsung : pas vraiment connecté (écran « données sur le serveur / Connexion » + tuto). Fuel/Maps Blackview avaient une session.
• Mail / Drive / Calendar / Contacts / Photos / Pass / Tasks : écran login Hubera ID. Saisie ADB du mot de passe (caractères spéciaux) n’a pas pris.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DOCS + BITWARDEN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• docs.hubera.cloud : le formulaire volait le focus (401 → rebuild des champs). Corrigé, en ligne (?v=20261006e).
• Compte = le même Hubera ID admin (paul@), pas un mot de passe Docs séparé.
• Bitwarden : pas d’accès CLI au coffre depuis ici (bw absent, coffre verrouillé). À faire sur ta fiche Hubera ID déjà existante :
  URI : https://docs.hubera.cloud
  (éventuellement aussi https://docs.hubera.cloud/ et https://admin.hubera.cloud si tu veux l’admin ops)
  Match : Host (autofill). Pas de nouvel identifiant.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROCHAIN MAIL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
02:00 — rapport détaillé + JSON (tests alors terminés).

Live :
${live}
`;

const host = process.env.SMTP_HOST || '';
const port = Number(process.env.SMTP_PORT || 465);
const user = process.env.SMTP_USER || '';
const pass = process.env.SMTP_PASS || '';
const fromRaw = process.env.SMTP_FROM || `Hubera Music <${user}>`;
const to = process.env.BATTERY_REPORT_TO || 'pauldelhomme.pro@gmail.com,dev@delhomme.ovh';
const subject = `[Hubera] Recap mi-parcours nuit 6→7 oct — tests EN COURS (pas arrêtés)`;

const require = createRequire(import.meta.url);
let nm = nodemailer;
try { nm = require(join(ROOT, 'api/node_modules/nodemailer')); } catch { /* imported */ }

if (!host) {
  console.log(md);
  process.exit(0);
}
const tx = nm.createTransport({
  host, port,
  secure: port === 465 || process.env.SMTP_SECURE === '1',
  auth: user ? { user, pass } : undefined,
});
const html = `<pre style="font-family:ui-monospace,monospace;font-size:13px;line-height:1.45;white-space:pre-wrap">${md
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
const info = await tx.sendMail({ from: fromRaw, to, subject, text: md, html });
console.log('==> recap mi-parcours envoyé', info.messageId, '→', to);
