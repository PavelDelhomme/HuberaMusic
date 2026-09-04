/**
 * Repère à l'avance les titres dont la vidéo YouTube est morte.
 *
 * Sans cela, la première rencontre avec un titre mort coûte la recherche d'un
 * remplaçant — une quarantaine de secondes — pendant lesquelles le téléphone
 * abandonne et saute le morceau. En balayant les bibliothèques à faible
 * cadence, le remplacement est déjà connu quand l'utilisateur lance le titre.
 *
 * Le balayage couvre **tous les comptes** : l'état de santé est propre à un
 * identifiant YouTube, pas à un compte, donc une seule base sert à tout le
 * monde et un titre partagé n'est vérifié qu'une fois. Une bibliothèque qui
 * arrive — nouveau compte, nouvelle synchronisation — entre d'elle-même dans
 * le lot des titres jamais vérifiés, et passe en priorité.
 *
 * Le balayage tourne en cycles : quand plus rien n'est à vérifier, un bilan
 * part par mail et le cycle suivant démarre à l'expiration des délais de
 * revérification, le catalogue YouTube ne cessant pas d'évoluer.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getTrackPayload } from '../library/db.js';
import { sendMail } from '../platform/mail.js';
import { getAudioFormat } from '../youtube/yt.js';
import { findReplacementId, getReplacementId, looksUnavailable } from './trackReplacement.js';
import { msSinceLastStream } from './stream.js';

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data', 'cache');

/** Intervalle entre deux titres — volontairement lent, YouTube n'aime pas les rafales. */
const TICK_MS = Number(process.env.LIBRARY_HEALTH_TICK_MS || 5_000);
/** Titres réglables sans réseau enchaînés d'affilée dans un même tour. */
const FREE_BATCH = 40;
/** Laisse le serveur démarrer et servir avant de consommer quoi que ce soit. */
const START_DELAY_MS = Number(process.env.LIBRARY_HEALTH_START_DELAY_MS || 120_000);
/**
 * Au-delà de ce délai sans lecture servie, on s'autorise le travail lourd : la
 * recherche d'un remplaçant enchaîne recherches et téléchargements d'essai.
 */
const IDLE_REQUIRED_MS = Number(process.env.LIBRARY_HEALTH_IDLE_MS || 20_000);
const PROBE_MS = 25_000;
/** Un titre sain est revérifié au cycle suivant : une vidéo peut disparaître. */
const RECHECK_OK_MS = Number(process.env.LIBRARY_HEALTH_RECHECK_OK_MS || 7 * 24 * 3_600_000);
/** Un titre sans remplaçant est retenté plus tôt, le catalogue bouge. */
const RETRY_DEAD_MS = Number(process.env.LIBRARY_HEALTH_RETRY_DEAD_MS || 3 * 24 * 3_600_000);
const REPORT_TO = process.env.LIBRARY_HEALTH_REPORT_TO || 'dev@delhomme.ovh';

/** `pending` : vidéo morte constatée, remplaçant pas encore cherché. */
type State = 'ok' | 'replaced' | 'dead' | 'pending';

let schemaReady = false;
let timer: NodeJS.Timeout | null = null;
let running = false;
const stats = { checked: 0, ok: 0, replaced: 0, dead: 0, pending: 0, startedAt: 0 };

function ensureSchema() {
  if (schemaReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS track_health (
      track_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      checked_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_track_health_state ON track_health(state, checked_at);
    CREATE INDEX IF NOT EXISTS idx_track_health_checked ON track_health(checked_at);

    -- Les deux tables sont indexées sur (user_id, track_id) par leur clé primaire ;
    -- le balayage, lui, les parcourt par titre, tous comptes confondus.
    CREATE INDEX IF NOT EXISTS idx_library_tracks_track ON library_tracks(track_id);
    CREATE INDEX IF NOT EXISTS idx_liked_tracks_track ON liked_tracks(track_id);

    CREATE TABLE IF NOT EXISTS track_health_cycle (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cycle_no INTEGER NOT NULL,
      started_at INTEGER NOT NULL
    );
  `);
  // Repère à zéro : le premier bilan couvre aussi ce qui a été vérifié avant
  // l'apparition de cette table.
  db.prepare('INSERT OR IGNORE INTO track_health_cycle (id, cycle_no, started_at) VALUES (1, 1, 0)').run();
  schemaReady = true;
}

function markHealth(trackId: string, state: State) {
  ensureSchema();
  db.prepare(
    `INSERT INTO track_health (track_id, state, checked_at) VALUES (?, ?, ?)
     ON CONFLICT(track_id) DO UPDATE SET state = excluded.state, checked_at = excluded.checked_at`,
  ).run(trackId, state, Date.now());
}

function currentCycle(): { cycle_no: number; started_at: number } {
  ensureSchema();
  return db.prepare('SELECT cycle_no, started_at FROM track_health_cycle WHERE id = 1').get() as {
    cycle_no: number;
    started_at: number;
  };
}

/** Titres de tous les comptes, en une seule liste dédoublonnée. */
const ALL_TRACKS = `SELECT track_id, MAX(created_at) AS created_at FROM (
    SELECT track_id, created_at FROM library_tracks
    UNION ALL
    SELECT track_id, created_at FROM liked_tracks
  ) GROUP BY track_id`;

/** Un titre est à vérifier s'il est inconnu, ou si sa vérification a expiré. */
const DUE_CLAUSE = `h.track_id IS NULL
       OR (h.state = 'ok' AND h.checked_at < :okCut)
       OR (h.state = 'dead' AND h.checked_at < :deadCut)`;

function dueCuts() {
  const now = Date.now();
  return { okCut: now - RECHECK_OK_MS, deadCut: now - RETRY_DEAD_MS };
}

/**
 * Les titres ajoutés le plus récemment d'abord, jamais vérifiés en tête : ce
 * sont eux que l'utilisateur risque de lancer, et donc là où l'attente se
 * ferait sentir. Une bibliothèque fraîchement synchronisée passe donc devant.
 */
function nextTrackId(): string | null {
  ensureSchema();
  const row = db
    .prepare(
      `SELECT t.track_id AS id
         FROM (${ALL_TRACKS}) t
         LEFT JOIN track_health h ON h.track_id = t.track_id
        WHERE ${DUE_CLAUSE}
        ORDER BY (h.track_id IS NOT NULL), t.created_at DESC
        LIMIT 1`,
    )
    .get(dueCuts()) as { id?: string } | undefined;
  return row?.id || null;
}

/** Vidéo morte constatée mais dont le remplaçant reste à chercher. */
function nextPendingId(): string | null {
  ensureSchema();
  const row = db
    .prepare(`SELECT track_id AS id FROM track_health WHERE state = 'pending' ORDER BY checked_at LIMIT 1`)
    .get() as { id?: string } | undefined;
  return row?.id || null;
}

function dueCount(): number {
  ensureSchema();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (${ALL_TRACKS}) t
         LEFT JOIN track_health h ON h.track_id = t.track_id
        WHERE ${DUE_CLAUSE}`,
    )
    .get(dueCuts()) as { n: number };
  return row?.n ?? 0;
}

function cachedOnDisk(id: string): boolean {
  try {
    const file = join(CACHE_DIR, `${id}.m4a`);
    return existsSync(file) && statSync(file).size > 1024 * 1024;
  } catch {
    return false;
  }
}

type Check = { state: State; network: boolean };

/** Sonde seule : constate la mort d'une vidéo sans chercher son remplaçant. */
async function probeOne(id: string): Promise<Check> {
  if (cachedOnDisk(id) || getReplacementId(id)) return { state: 'ok', network: false };
  try {
    const fmt = await Promise.race([
      getAudioFormat(id),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), PROBE_MS)),
    ]);
    if (fmt?.url) return { state: 'ok', network: true };
  } catch (err) {
    const message = String((err as Error)?.message || err);
    if (!looksUnavailable(message)) {
      // Réseau, quota, délai dépassé : on ne conclut rien, le titre repassera.
      return { state: 'ok', network: true };
    }
    return { state: 'pending', network: true };
  }
  return { state: 'ok', network: true };
}

/** Partie coûteuse, réservée aux moments sans écoute en cours. */
async function resolvePending(id: string): Promise<State> {
  const meta = getTrackPayload(id);
  const replacement = await findReplacementId(id, {
    title: meta?.title,
    artist: (meta?.artists || []).map((a) => a?.name).filter(Boolean).join(', '),
    durationSeconds: meta?.durationSeconds ?? null,
  });
  if (replacement) {
    console.log(`[health] ${id} mort → ${replacement}`);
    return 'replaced';
  }
  console.warn(`[health] ${id} mort, sans remplaçant`);
  return 'dead';
}

function trackLabel(id: string): string {
  const t = getTrackPayload(id);
  if (!t?.title) return id;
  const artist = (t.artists || []).map((a) => a?.name).filter(Boolean).join(', ');
  return artist ? `${t.title} — ${artist} (${id})` : `${t.title} (${id})`;
}

export type CycleReport = { subject: string; text: string; html: string; done: number };

/** Séparé de l'envoi pour pouvoir en contrôler le rendu sans écrire de mail. */
export function buildCycleReport(): CycleReport | null {
  const cycle = currentCycle();
  const rows = db
    .prepare('SELECT state, COUNT(*) AS n FROM track_health WHERE checked_at >= ? GROUP BY state')
    .all(cycle.started_at) as { state: string; n: number }[];
  const done = rows.reduce((s, r) => s + r.n, 0);
  // Rien vérifié depuis le dernier bilan : le balayage attend simplement
  // l'expiration des délais de revérification, ce n'est pas un cycle.
  if (!done) return null;

  const by = Object.fromEntries(rows.map((r) => [r.state, r.n])) as Record<string, number>;
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${ALL_TRACKS})`).get() as { n: number }).n;
  const comptes = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  const morts = db
    .prepare("SELECT track_id FROM track_health WHERE state = 'dead' ORDER BY checked_at DESC LIMIT 60")
    .all() as { track_id: string }[];
  // Durée réelle du travail : entre le premier et le dernier titre vérifié. Le
  // repère de cycle, lui, date de la fin du bilan précédent, d'éventuels jours
  // d'attente compris.
  const span = db
    .prepare('SELECT MIN(checked_at) AS a, MAX(checked_at) AS b FROM track_health WHERE checked_at >= ?')
    .get(cycle.started_at) as { a: number; b: number };
  const heures = ((span.b - span.a) / 3_600_000).toFixed(1);

  const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? 's' : ''}`;
  const lignes = [
    `Cycle nº${cycle.cycle_no} terminé en ${heures} h.`,
    `${total} titres au catalogue, ${pluriel(comptes, 'compte')}.`,
    `${pluriel(done, 'titre')} vérifié${done > 1 ? 's' : ''} pendant ce cycle :`,
    `  · ${pluriel(by.ok || 0, 'lisible')}`,
    `  · ${pluriel(by.replaced || 0, 'remplacé')} (vidéo disparue, autre copie trouvée)`,
    `  · ${by.dead || 0} sans solution pour l'instant`,
  ];
  if (morts.length) {
    lignes.push('', 'Titres restés sans remplaçant (retentés dans quelques jours) :');
    for (const m of morts) lignes.push(`  · ${trackLabel(m.track_id)}`);
  }
  const text = lignes.join('\n');
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;line-height:1.55;max-width:720px;color:#111">
    <h1 style="font-size:1.25rem;margin:0 0 4px">Balayage de la bibliothèque — cycle nº${cycle.cycle_no}</h1>
    <p style="color:#666;margin:0 0 18px">Terminé en ${heures} h · ${total} titres · ${pluriel(comptes, 'compte')}</p>
    <ul style="margin:0;padding-left:20px">
      <li><strong>${by.ok || 0}</strong> lisible${(by.ok || 0) > 1 ? 's' : ''}</li>
      <li><strong>${by.replaced || 0}</strong> remplacé${(by.replaced || 0) > 1 ? 's' : ''} — vidéo disparue, autre copie trouvée</li>
      <li><strong>${by.dead || 0}</strong> sans solution pour l'instant</li>
    </ul>
    ${
      morts.length
        ? `<h2 style="font-size:1rem;margin:22px 0 6px">Restés sans remplaçant</h2>
           <p style="color:#666;margin:0 0 8px">Retentés automatiquement dans quelques jours.</p>
           <ul style="margin:0;padding-left:20px">${morts
             .map((m) => `<li>${trackLabel(m.track_id)}</li>`)
             .join('')}</ul>`
        : ''
    }
  </div>`;

  return {
    subject: `[PLM] Balayage bibliothèque — cycle nº${cycle.cycle_no} terminé`,
    text,
    html,
    done,
  };
}

/**
 * Bilan de fin de cycle, envoyé une seule fois : le repère de cycle repart de
 * maintenant juste après, donc le cycle suivant reste muet tant qu'il n'a rien
 * vérifié.
 */
async function finishCycle() {
  const report = buildCycleReport();
  if (!report) return;
  const cycle = currentCycle();
  db.prepare('UPDATE track_health_cycle SET cycle_no = ?, started_at = ? WHERE id = 1').run(
    cycle.cycle_no + 1,
    Date.now(),
  );
  await sendMail({ to: REPORT_TO, subject: report.subject, html: report.html, text: report.text });
  console.log(`[health] cycle nº${cycle.cycle_no} terminé, bilan envoyé à ${REPORT_TO}`);
}

async function tick() {
  if (running) return;
  running = true;
  try {
    // La recherche d'un remplaçant est lourde : elle attend une accalmie. La
    // simple sonde, elle, coûte un appel d'API et peut tourner pendant l'écoute,
    // sans quoi une session de plusieurs heures gèlerait tout le balayage.
    if (msSinceLastStream() >= IDLE_REQUIRED_MS) {
      const pending = nextPendingId();
      if (pending) {
        const state = await resolvePending(pending);
        markHealth(pending, state);
        stats[state]++;
        return;
      }
    }
    // Un titre déjà en cache se règle sans toucher au réseau : lui consacrer un
    // tour d'horloge complet ferait durer le balayage des jours pour rien.
    for (let i = 0; i < FREE_BATCH; i++) {
      const id = nextTrackId();
      if (!id) {
        // Plus rien à vérifier : le cycle est bouclé. Reste éventuellement des
        // remplaçants à chercher, qui attendent une accalmie.
        if (!nextPendingId()) await finishCycle();
        return;
      }
      const { state, network } = await probeOne(id);
      markHealth(id, state);
      stats.checked++;
      stats[state]++;
      if (network) return;
    }
  } catch (err) {
    console.warn('[health] tick KO:', String((err as Error).message || err).slice(0, 120));
  } finally {
    running = false;
  }
}

export function startLibraryHealthScan() {
  if (timer || process.env.LIBRARY_HEALTH_SCAN === '0') return;
  stats.startedAt = Date.now();
  setTimeout(() => {
    timer = setInterval(() => {
      void tick();
    }, TICK_MS);
    // Un intervalle qui empêcherait l'arrêt du process n'apporte rien.
    timer.unref?.();
  }, START_DELAY_MS).unref?.();
}

export function libraryHealthStatus() {
  ensureSchema();
  const rows = db
    .prepare('SELECT state, COUNT(*) AS n FROM track_health GROUP BY state')
    .all() as { state: string; n: number }[];
  const cycle = currentCycle();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${ALL_TRACKS})`).get() as { n: number }).n;
  return {
    enabled: process.env.LIBRARY_HEALTH_SCAN !== '0',
    tickMs: TICK_MS,
    reportTo: REPORT_TO,
    recheckOkDays: Math.round(RECHECK_OK_MS / 86_400_000),
    retryDeadDays: Math.round(RETRY_DEAD_MS / 86_400_000),
    cycle: cycle.cycle_no,
    cycleStartedAt: new Date(cycle.started_at).toISOString(),
    trackTotal: total,
    sessionChecked: stats.checked,
    byState: Object.fromEntries(rows.map((r) => [r.state, r.n])),
    remaining: dueCount(),
  };
}
