/**
 * Mail récap d’une version PLM (appelé après chaque promo).
 *
 *   node --env-file=.env --import tsx scripts/qa/send-version-mail.mts --version 1.3.187 --title "…" --notes-file path.txt
 */
import { readFileSync, existsSync } from 'node:fs';
import { sendMail } from '../../api/src/platform/mail.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1];
  return undefined;
}

const version = arg('version') || process.env.VERSION || '';
const title = arg('title') || process.env.TITLE || '';
const notesFile = arg('notes-file') || process.env.NOTES_FILE;
const notesRaw =
  (notesFile && existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : '') ||
  process.env.NOTES ||
  '';

if (!version || !title || !notesRaw.trim()) {
  console.error('Usage: VERSION=1.3.187 TITLE="…" NOTES="…" npx tsx scripts/qa/send-version-mail.mts');
  process.exit(1);
}

const notes = notesRaw
  .split(/\r?\n/)
  .map((l) => l.replace(/^[-•*]\s*/, '').trim())
  .filter(Boolean);

const to = process.env.MAIL_TO || '';
const subject = `[Hubera Music] ${version} — ${title}`;
const when = new Date().toISOString();

const text = `PLM — Nouvelle version ${version}
Date: ${when}
Titre: ${title}
Appareil installé: Samsung uniquement (gate)

Notes:
${notes.map((n) => `- ${n}`).join('\n')}

OTA: https://plm.delhomme.ovh/api/deploy/apk
`;

const html = `<div style="font-family:system-ui,sans-serif;line-height:1.5;max-width:720px;color:#111">
  <h1 style="font-size:1.3rem;margin:0 0 6px">PLM <code>${version}</code></h1>
  <p style="color:#555;margin:0 0 16px">${when} · <b>${title}</b></p>
  <p style="margin:0 0 12px">Installé sur <b>Samsung</b> (gate) · OTA publiée · Blackview / Nothing non touchés.</p>
  <h2 style="font-size:1.05rem">Nouveautés / correctifs</h2>
  <ul>${notes.map((n) => `<li>${n.replace(/</g, '&lt;')}</li>`).join('')}</ul>
  <p style="color:#666;font-size:12px;margin-top:20px">Téléchargement OTA : <a href="https://plm.delhomme.ovh/api/deploy/apk">/api/deploy/apk</a></p>
</div>`;

const r = await sendMail({ to, subject, html, text });
console.log(JSON.stringify(r, null, 2));
