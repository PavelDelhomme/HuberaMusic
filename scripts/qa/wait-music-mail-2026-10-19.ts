/**
 * Envoie un seul mail + PDF quand la preuve 2000 est finie,
 * ou à 07:15 le 20 oct 2026 (heure de Paris) avec le partiel.
 * Ne supprime aucune tâche Docs.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildTextPdf } from '../../api/src/platform/textPdf.ts';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const nodemailer = require('nodemailer') as typeof import('nodemailer');

const OUT = '/tmp/hubera-music-proof-2026-10-19';
const DEADLINE = Date.parse('2026-10-20T07:15:00+02:00');
const TASK_ID = '96696bf2c3cf6722';

function loadEnv(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const i = s.indexOf('=');
    env[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return env;
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

type Row = {
  cat?: string;
  pool?: string;
  under2s?: boolean;
  ms?: number;
};

function digestFromRows(): {
  library: number;
  sample: number;
  counts: Record<string, number>;
  under2s: number;
  foreign: Record<string, number>;
  partial: boolean;
} {
  const summaryPath = `${OUT}/summary.json`;
  if (existsSync(summaryPath)) {
    const s = JSON.parse(readFileSync(summaryPath, 'utf8')) as {
      library?: number;
      sample?: number;
      librarySample?: Record<string, number>;
      foreign?: Record<string, number>;
    };
    const counts = { ...(s.librarySample || {}) };
    const under2s = Number(counts.under2s || 0);
    delete counts.under2s;
    return {
      library: Number(s.library || 0),
      sample: Number(s.sample || 0),
      counts,
      under2s,
      foreign: s.foreign || {},
      partial: false,
    };
  }
  const rows: Row[] = existsSync(`${OUT}/rows.jsonl`)
    ? readFileSync(`${OUT}/rows.jsonl`, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Row)
    : [];
  const lib = rows.filter((r) => r.pool === 'library');
  const foreign = rows.filter((r) => r.pool === 'foreign');
  const count = (list: Row[]) => {
    const c: Record<string, number> = {};
    for (const r of list) c[r.cat || '?'] = (c[r.cat || '?'] || 0) + 1;
    return c;
  };
  const meta = existsSync(`${OUT}/meta.json`)
    ? (JSON.parse(readFileSync(`${OUT}/meta.json`, 'utf8')) as { library?: number; sample?: number })
    : {};
  return {
    library: Number(meta.library || 0),
    sample: lib.length,
    counts: count(lib),
    under2s: lib.filter((r) => r.under2s).length,
    foreign: { n: foreign.length, ...count(foreign) },
    partial: true,
  };
}

function serverNote(): string {
  const p = `${OUT}/server-patch.txt`;
  if (!existsSync(p)) return 'Correctif serveur : pas confirme au moment du mail.';
  return readFileSync(p, 'utf8').trim();
}

function reportText(d: ReturnType<typeof digestFromRows>): string {
  const c = d.counts;
  const n = d.sample || 1;
  const line = (k: string, label: string) =>
    `${label}: ${c[k] || 0} (${Math.round(((c[k] || 0) / n) * 100)} %)`;
  return [
    d.partial ? 'PREUVE PARTIELLE (le balayage continuait encore).' : 'PREUVE TERMINEE.',
    `Bibliotheque en base : 14653 fiches. API (titres presents) : ${d.library}. Echantillon demande : 2000. Mesures : ${d.sample}.`,
    '',
    'Bibliotheque (premiers octets, sans son, 60 s max, jamais le morceau entier)',
    line('joue', 'Joues'),
    line('meme_morceau', 'Meme morceau ailleurs'),
    line('indisponible', 'Indisponibles'),
    line('pas_de_flux', 'Pas de flux'),
    `Partis en moins de 2 s : ${d.under2s}`,
    '',
    `Hors bibliotheque : ${JSON.stringify(d.foreign)}`,
    '',
    'Acces rapide (1.3.376, commit 53f57ec)',
    'La lecture et l aleatoire ne prennent que les titres epingles, en boucle. A suivre et les similaires n y entrent pas. Pas encore sur les telephones : le Nothing etait en appel, ecran non pris. OTA non forcee, APK non publiee cette nuit.',
    '',
    'Prechargement',
    'Liste de 400 titres differents tout de suite, warm disque en serie. Demarrage sur un titre deja en cache. File Exo courte, suite chargee ensuite. Precedent aussi precharge.',
    '',
    'Idees testees',
    'Retenu : cache d un itag deja signe + tete audio. Les succes observes partent vers 160 ms.',
    'Retenu : prechargement du suivant et du precedent, file courte.',
    serverNote(),
    'Ecarte : plus de proxies en parallele (ca sature le relais).',
    'Ollama est allume, aucun modele n etait charge. Le modele 0,5B n a pas repondu. La route n a pas ete choisie par lui.',
    '',
    'Ce qui passe sous 2 s : un titre deja en cache (206, ~160 ms).',
    'Ce qui ne passe pas : un titre froid reste sans octet jusqu au plafond de 60 s, puis on note pas de flux et on passe.',
    'Alternative retenue : ne pas remplacer par une autre chanson. Servir la tete deja chaude, reprendre le meme itag si le fichier est incomplet, et sauter en moins de 60 s si rien ne vient.',
  ].join('\n');
}

async function send(env: Record<string, string>, text: string) {
  const to = env.BATTERY_REPORT_TO || '';
  if (!to) throw new Error('destinataire manquant');
  const pdf = buildTextPdf({
    title: 'Hubera Music — 19 oct 2026',
    sections: [{ heading: 'Acces rapide, prechargement, preuve', body: fold(text) }],
  });
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 465),
    secure: true,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  const from = env.SMTP_FROM || env.SMTP_USER;
  await transporter.sendMail({
    from,
    to,
    subject: 'Hubera Music — 19 oct 2026',
    text: fold(text),
    attachments: [
      {
        filename: 'Hubera-2026-10-19-music.pdf',
        content: pdf,
        contentType: 'application/pdf',
      },
    ],
  });
}

function updateDocs(text: string) {
  const local = '/tmp/music-docs-body.txt';
  writeFileSync(local, text.slice(0, 4000));
  execFileSync('scp', ['-o', 'ConnectTimeout=20', local, 'pavel-server:/tmp/music-docs-body.txt']);
  const remote = [
    'docker cp /tmp/music-docs-body.txt hubera-docs:/tmp/music-docs-body.txt',
    `docker exec -w /app hubera-docs node --input-type=module -e 'import { readFileSync } from "node:fs"; import Database from "better-sqlite3"; const db = new Database("/app/data/docs.sqlite"); const body = readFileSync("/tmp/music-docs-body.txt", "utf8"); const cur = db.prepare("SELECT id FROM tasks WHERE id = ?").get("${TASK_ID}"); if (!cur) throw new Error("task"); db.prepare("UPDATE tasks SET body = ?, updated_at = ? WHERE id = ?").run(body, Date.now(), "${TASK_ID}"); console.log("docs_updated");'`,
  ].join(' && ');
  execFileSync('ssh', ['-o', 'ConnectTimeout=20', 'pavel-server', remote], { stdio: 'inherit' });
}

async function main() {
  const env = loadEnv(new URL('../../.env', import.meta.url).pathname);
  while (Date.now() < DEADLINE && !existsSync(`${OUT}/summary.json`)) {
    await new Promise((r) => setTimeout(r, 60_000));
  }
  if (existsSync(`${OUT}/mail-sent`)) return;
  const d = digestFromRows();
  const text = reportText(d);
  await send(env, text);
  try {
    updateDocs(text);
  } catch (err) {
    console.error('docs', err instanceof Error ? err.message : err);
  }
  writeFileSync(`${OUT}/mail-sent`, new Date().toISOString());
  console.log('mail_sent', d.partial ? 'partial' : 'full', 'n', d.sample);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
