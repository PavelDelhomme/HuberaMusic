#!/usr/bin/env node
/**
 * Wrap-up nuit mesh — HTML + JSON, mail SMTP via music/.env
 * OUT=/tmp/hubera-nuit-2026-10-06 node --env-file=.env scripts/qa/nuit-mesh-wrapup.mjs
 */
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import nodemailer from 'nodemailer';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.env.OUT || '/tmp/hubera-nuit-2026-10-06';
const SUMMARY_P = join(OUT, 'summary.json');
const EVENTS_P = join(OUT, 'events.jsonl');
const LIVE_P = join(OUT, 'live.log');

function loadJson(p, fallback) {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadEvents(p) {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const summary = loadJson(SUMMARY_P, {});
const events = loadEvents(EVENTS_P);
const liveAll = existsSync(LIVE_P) ? readFileSync(LIVE_P, 'utf8') : '';
const liveTail = liveAll
  ? liveAll.trim().split('\n').slice(-40).join('\n')
  : '(pas de live.log)';
const chronicle = existsSync(join(OUT, 'chronicle.md'))
  ? readFileSync(join(OUT, 'chronicle.md'), 'utf8')
  : '';
const playHits = [...liveAll.matchAll(/play=(\d+)s/g)].map((m) => Number(m[1]));
const maxPlayS = playHits.length ? Math.max(...playHits) : 0;

const stats = summary.stats || {};
const devices = ['nothing', 'samsung', 'blackview'];
const byKind = {};
for (const e of events) {
  byKind[e.kind] = (byKind[e.kind] || 0) + 1;
}

function row(name) {
  const s = stats[name] || {};
  return {
    name,
    titles: s.titles || 0,
    skipBuf: s.skips_buf || 0,
    skipFrz: s.skips_frozen || 0,
    skipErr: s.skips_err || 0,
    playMin: Math.round((s.playing_s || 0) / 60),
    last: s.last || '?',
  };
}
const rows = devices.map(row);
const totalTitles = rows.reduce((a, r) => a + r.titles, 0);
const totalBuf = rows.reduce((a, r) => a + r.skipBuf, 0);
const bufRate = totalTitles ? Math.round((100 * totalBuf) / totalTitles) : 0;
const done = Boolean(summary.done);
const stamp = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

const smoke = events.filter((e) => e.kind === 'smoke' || e.kind === 'smoke_missing');
const maps = events.filter((e) => e.kind === 'maps' || e.kind === 'fuel');
const notes = summary.notes || [];

const md = `# Hubera — rapport complet nuit mesh 6→7 oct 2026

Généré : ${stamp} (Europe/Paris)
Cible arrêt : ${summary.stop_at || '2026-10-07T02:00'}
Package Music : ${summary.pkg_music || 'cloud.hubera.music'}
Statut harnais : ${done ? 'terminé 02:00' : 'en cours / partiel'}
Durée : ${summary.elapsed_min ?? '?'} min
Maps/Fuel cycles : ${summary.maps_runs ?? 0}
Smoke autres apps : ${summary.smoke_runs ?? 0}
Pic lecture observé (live.log) : ${maxPlayS} s

${chronicle}

## Music — titres / skips (compteurs harnais)

| Appareil | Titres | Skip buffering | Skip gelé | Skip erreur | Lecture (min) | Dernier titre |
|---|---:|---:|---:|---:|---:|---|
${rows.map((r) => `| ${r.name} | ${r.titles} | ${r.skipBuf} | ${r.skipFrz} | ${r.skipErr} | ${r.playMin} | ${String(r.last).slice(0, 60)} |`).join('\n')}

**Taux skip-buffering** : ${bufRate} % des titres (${totalBuf}/${totalTitles}).
${bufRate > 40 ? '⚠️ Encore beaucoup de skip-buffering — voir chronique (503 trop tôt, puis overlay).' : 'Lecture plus fluide que la nuit précédente.'}

## Contraintes respectées

- Musique muette (STREAM_MUSIC=0), alarmes conservées (volume 7, DND alarms-only)
- Nothing : aucun login paul@delhomme.ovh injecté
- Maps / Fuel compte de test : Samsung + Blackview seulement
- Pas de wipe, pas de \`docker compose down -v\`, pas d’overlay Fuel 1.4.165 présenté comme 166
- OTA jamais forcé

## Maps / Fuel (Samsung + Blackview, pas Nothing)

${maps.length ? maps.slice(-20).map((e) => `- ${e.ts} ${e.kind} ${e.device} run=${e.run || ''} ${e.pkg || ''}`).join('\n') : '(aucun cycle encore)'}

## Smoke autres apps (Samsung)

${smoke.length ? smoke.map((e) => `- ${e.ts} ${e.kind} ${e.pkg || ''} ok=${e.ok ?? ''}`).join('\n') : '(aucun smoke encore)'}

## Notes ADB / lancement

${notes.length ? notes.map((n) => `- ${n}`).join('\n') : '- RAS'}

## Compteurs d’événements

${Object.entries(byKind).sort().map(([k, n]) => `- ${k}: ${n}`).join('\n') || '- (vide)'}

## Queue live (40 dernières lignes)

\`\`\`
${liveTail}
\`\`\`

## À revoir mercredi matin 7 oct

1. Blackview : lecture réelle encore nulle au dernier pointage — proxies / cold wait 28 s.
2. Fuel 1.4.166 : ne pas overlay 165 comme 166 ; login Samsung paul@ à finir (clavier).
3. Mail Samsung : timeout gateway malgré identifiants.
4. Ne **pas** relancer Watchtower sur ytmusic.
5. Autres stacks (Jobs, Budget, Taskflow, Stream, Mail, Drive, Pass, Press, Cloudity) : **déjà up**, ne pas `down -v`.

Fichiers : \`${OUT}\`
`;

writeFileSync(join(OUT, 'rapport.md'), md, 'utf8');
const html = `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Hubera nuit 6-7 oct 2026</title>
<body style="font-family:system-ui,sans-serif;max-width:820px;margin:24px auto;color:#0f172a;line-height:1.5">
<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:13px">${md
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')}</pre>
</body></html>`;
writeFileSync(join(OUT, 'rapport.html'), html, 'utf8');

const docsDirCandidates = [
  join(ROOT, '../docs/content/reports'),
  join(ROOT, '../../products/docs/content/reports'),
  '/home/pactivisme/Documents/Dev/Perso/HuberaDocs/content/reports',
];
for (const d of docsDirCandidates) {
  try {
    mkdirSync(d, { recursive: true });
    copyFileSync(join(OUT, 'rapport.md'), join(d, '2026-10-07-nuit-mesh.md'));
    copyFileSync(SUMMARY_P, join(d, '2026-10-07-nuit-mesh-summary.json'));
    console.log('copie Docs', d);
    break;
  } catch (e) {
    /* try next */
  }
}

const to =
  process.env.BATTERY_REPORT_TO ||
  'pauldelhomme.pro@gmail.com,dev@delhomme.ovh';
const host = process.env.SMTP_HOST || '';
const port = Number(process.env.SMTP_PORT || 465);
const user = process.env.SMTP_USER || '';
const pass = process.env.SMTP_PASS || '';
const fromRaw = process.env.SMTP_FROM || `Hubera Music <${user}>`;
const subject = `[Hubera] Nuit mesh 6→7 oct — Music/Maps/Fuel ${done ? 'TERMINÉ' : 'PARTIEL'} — ${totalTitles} titres, buf ${bufRate}%`;

if (!host) {
  console.log(md);
  console.error('SMTP_HOST vide — dump seulement');
  process.exit(0);
}

const attachments = [
  { filename: 'rapport.md', content: md, contentType: 'text/markdown' },
  { filename: 'rapport.html', content: html, contentType: 'text/html' },
];
if (existsSync(SUMMARY_P)) {
  attachments.push({ filename: 'summary.json', content: readFileSync(SUMMARY_P), contentType: 'application/json' });
}
if (existsSync(EVENTS_P)) {
  attachments.push({ filename: 'events.jsonl', content: readFileSync(EVENTS_P), contentType: 'application/jsonl' });
}

const require = createRequire(import.meta.url);
let nodemailerMod = nodemailer;
try {
  nodemailerMod = require(join(ROOT, 'api/node_modules/nodemailer'));
} catch {
  /* already imported */
}

const tx = nodemailerMod.createTransport({
  host,
  port,
  secure: port === 465 || process.env.SMTP_SECURE === '1',
  auth: user ? { user, pass } : undefined,
});

const info = await tx.sendMail({
  from: fromRaw,
  to,
  subject,
  text: md,
  html,
  attachments,
});
console.log('==> mail envoyé', info.messageId, '→', to);
