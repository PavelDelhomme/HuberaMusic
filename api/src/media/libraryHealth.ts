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
 * peut partir par mail (au plus 1 / 24 h, et seulement si le cycle a vraiment
 * travaillé). Le cycle suivant démarre à l'expiration des délais de
 * revérification, le catalogue YouTube ne cessant pas d'évoluer.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getTrackPayload } from '../library/db.js';
import { mailBrand, sendMail } from '../platform/mail.js';
import { getAudioFormat } from '../youtube/yt.js';
import {
  ensureTrackReplacementSchema,
  findReplacementId,
  getReplacementId,
  looksUnavailable,
} from './trackReplacement.js';
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
/** Au plus un mail de bilan par intervalle (défaut 12 h → max ~2 / jour). */
const REPORT_MIN_INTERVAL_MS = Number(
  process.env.LIBRARY_HEALTH_REPORT_MIN_MS || 12 * 60 * 60_000,
);
/** N’envoie un mail que si le cycle a vraiment travaillé (défaut ≥ 50 titres). */
const REPORT_MIN_DONE = Number(process.env.LIBRARY_HEALTH_REPORT_MIN_DONE || 50);
/** Plafond absolu de mails bilan / 24 h. */
const REPORT_MAX_PER_DAY = Number(process.env.LIBRARY_HEALTH_REPORT_MAX_PER_DAY || 2);
/**
 * File vide depuis au moins ce délai avant de clôturer un cycle.
 * Sinon la vague de re-vérif (1 titre / quelques secondes après 7 j) crée
 * des micro-cycles en continu.
 */
const EMPTY_GRACE_MS = Number(process.env.LIBRARY_HEALTH_EMPTY_GRACE_MS || 30 * 60_000);
/** Quand idle (rien à sonder), espacer les ticks (défaut 30 min). */
const IDLE_TICK_MS = Number(process.env.LIBRARY_HEALTH_IDLE_TICK_MS || 30 * 60_000);

/** `pending` : vidéo morte constatée, remplaçant pas encore cherché. */
type State = 'ok' | 'replaced' | 'dead' | 'pending';

let schemaReady = false;
let timer: NodeJS.Timeout | null = null;
let running = false;
/** Après un cycle vide / bilan : ne pas rappeler finishCycle tant qu’on n’a pas revérifié un titre. */
let cycleIdleClosed = false;
/** Première fois où la file due+pending est vide (0 = pas vide). */
let emptySinceMs = 0;
/** Dernier tick pendant idle (file vide) — backoff. */
let lastIdleProbeMs = 0;
/** Horodatages des mails envoyés (fenêtre 24 h). */
const recentReportAts: number[] = [];
const stats = { checked: 0, ok: 0, replaced: 0, dead: 0, pending: 0, startedAt: 0, reportsSent: 0, reportsSkipped: 0 };

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
  // Colonne ajoutée après coup — cooldown mail persisté (redémarrages).
  const cols = db.prepare('PRAGMA table_info(track_health_cycle)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'last_report_at')) {
    db.exec('ALTER TABLE track_health_cycle ADD COLUMN last_report_at INTEGER NOT NULL DEFAULT 0');
  }
  schemaReady = true;
  reconcileReplacedHealth();
}

/** Une copie de remplacement connue n’est plus un « ok » d’origine. */
function reconcileReplacedHealth() {
  try {
    ensureTrackReplacementSchema();
    db.prepare(
      `UPDATE track_health SET state = 'replaced'
        WHERE state = 'ok'
          AND track_id IN (SELECT dead_id FROM track_id_replacements)`,
    ).run();
  } catch {
    /* table remplacements pas encore créée */
  }
}

function markHealth(trackId: string, state: State) {
  ensureSchema();
  db.prepare(
    `INSERT INTO track_health (track_id, state, checked_at) VALUES (?, ?, ?)
     ON CONFLICT(track_id) DO UPDATE SET state = excluded.state, checked_at = excluded.checked_at`,
  ).run(trackId, state, Date.now());
}

function currentCycle(): { cycle_no: number; started_at: number; last_report_at: number } {
  ensureSchema();
  const row = db.prepare('SELECT cycle_no, started_at, last_report_at FROM track_health_cycle WHERE id = 1').get() as {
    cycle_no: number;
    started_at: number;
    last_report_at?: number;
  };
  return {
    cycle_no: row.cycle_no,
    started_at: row.started_at,
    last_report_at: Number(row.last_report_at || 0),
  };
}

/** Titres de tous les comptes, avec un propriétaire (pool proxy dédié). */
const ALL_TRACKS = `SELECT track_id, MIN(user_id) AS user_id, MAX(created_at) AS created_at FROM (
    SELECT track_id, user_id, created_at FROM library_tracks
    UNION ALL
    SELECT track_id, user_id, created_at FROM liked_tracks
  ) GROUP BY track_id`;

/** Un titre est à vérifier s'il est inconnu, ou si sa vérification a expiré. */
const DUE_CLAUSE = `h.track_id IS NULL
       OR (h.state IN ('ok', 'replaced') AND h.checked_at < :okCut)
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
let lastHealthUserId = '';

function nextTrackId(): { id: string; userId?: string } | null {
  ensureSchema();
  const row = db
    .prepare(
      `SELECT t.track_id AS id, t.user_id AS userId
         FROM (${ALL_TRACKS}) t
         LEFT JOIN track_health h ON h.track_id = t.track_id
        WHERE ${DUE_CLAUSE}
        ORDER BY
          CASE WHEN t.user_id = :lastUser THEN 1 ELSE 0 END,
          CASE WHEN EXISTS (SELECT 1 FROM liked_tracks l WHERE l.track_id = t.track_id) THEN 0 ELSE 1 END,
          (h.track_id IS NOT NULL),
          t.created_at DESC
        LIMIT 1`,
    )
    .get({ ...dueCuts(), lastUser: lastHealthUserId }) as { id?: string; userId?: string } | undefined;
  if (!row?.id) return null;
  return { id: row.id, userId: row.userId };
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

type Check = { state: State; network: boolean; skip?: boolean };

/** Sonde seule : constate la mort d'une vidéo sans chercher son remplaçant. */
async function probeOne(id: string, userId?: string): Promise<Check> {
  if (getReplacementId(id)) return { state: 'replaced', network: false };
  if (cachedOnDisk(id)) return { state: 'ok', network: false };
  try {
    const fmt = await Promise.race([
      getAudioFormat(id, { userId }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), PROBE_MS)),
    ]);
    if (fmt?.url) return { state: 'ok', network: true };
  } catch (err) {
    const message = String((err as Error)?.message || err);
    if (!looksUnavailable(message)) {
      void import('./stream.js')
        .then((m) => m.enqueueListHeadWarm([id]))
        .catch(() => {});
      return { state: 'ok', network: true, skip: true };
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

export type LibraryInventory = {
  total: number;
  comptes: number;
  ok: number;
  replaced: number;
  pending: number;
  dead: number;
  unchecked: number;
};

/** Buckets exclusifs : ok + replaced + pending + dead + unchecked = total. */
export function libraryInventory(): LibraryInventory {
  ensureSchema();
  ensureTrackReplacementSchema();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${ALL_TRACKS})`).get() as { n: number }).n;
  const comptes = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT user_id FROM library_tracks
           UNION
           SELECT user_id FROM liked_tracks
         )`,
      )
      .get() as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT bucket, COUNT(*) AS n FROM (
         SELECT
           CASE
             WHEN r.dead_id IS NOT NULL OR h.state = 'replaced' THEN 'replaced'
             WHEN h.state = 'dead' THEN 'dead'
             WHEN h.state = 'pending' THEN 'pending'
             WHEN h.state = 'ok' THEN 'ok'
             WHEN h.track_id IS NULL THEN 'unchecked'
             ELSE COALESCE(h.state, 'unchecked')
           END AS bucket
           FROM (${ALL_TRACKS}) t
           LEFT JOIN track_health h ON h.track_id = t.track_id
           LEFT JOIN track_id_replacements r ON r.dead_id = t.track_id
       ) GROUP BY bucket`,
    )
    .all() as { bucket: string; n: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.bucket, r.n])) as Record<string, number>;
  return {
    total,
    comptes,
    ok: by.ok || 0,
    replaced: by.replaced || 0,
    pending: by.pending || 0,
    dead: by.dead || 0,
    unchecked: by.unchecked || 0,
  };
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
  const inv = libraryInventory();
  const morts = db
    .prepare("SELECT track_id FROM track_health WHERE state = 'dead' ORDER BY checked_at DESC LIMIT 60")
    .all() as { track_id: string }[];
  const span = db
    .prepare('SELECT MIN(checked_at) AS a, MAX(checked_at) AS b FROM track_health WHERE checked_at >= ?')
    .get(cycle.started_at) as { a: number; b: number };
  const heures = ((span.b - span.a) / 3_600_000).toFixed(1);

  const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? 's' : ''}`;
  const somme =
    inv.ok + inv.replaced + inv.pending + inv.dead + inv.unchecked;
  const lignes = [
    `Cycle nº${cycle.cycle_no} terminé en ${heures} h.`,
    `${inv.total} titres au catalogue, ${pluriel(inv.comptes, 'compte')}.`,
    `État actuel (somme ${somme} = ${inv.total} titres) :`,
    `  · ${pluriel(inv.ok, 'lisible')} (vidéo d’origine)`,
    `  · ${pluriel(inv.replaced, 'remplacé')} (vidéo disparue, autre copie trouvée)`,
    `  · ${inv.pending} en attente de copie`,
    `  · ${inv.dead} sans solution pour l'instant`,
    `  · ${inv.unchecked} pas encore vérifié${inv.unchecked > 1 ? 's' : ''}`,
    `${pluriel(done, 'titre')} sondé${done > 1 ? 's' : ''} pendant ce cycle :`,
    `  · ${pluriel(by.ok || 0, 'lisible')}`,
    `  · ${pluriel(by.replaced || 0, 'remplacé')}`,
    `  · ${by.pending || 0} en attente de copie`,
    `  · ${by.dead || 0} sans solution`,
  ];
  if (morts.length) {
    lignes.push('', 'Titres restés sans remplaçant (retentés dans quelques jours) :');
    for (const m of morts) lignes.push(`  · ${trackLabel(m.track_id)}`);
  }
  const text = lignes.join('\n');
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;line-height:1.55;max-width:720px;color:#111">
    <h1 style="font-size:1.25rem;margin:0 0 4px">Balayage de la bibliothèque — cycle nº${cycle.cycle_no}</h1>
    <p style="color:#666;margin:0 0 18px">Terminé en ${heures} h · ${inv.total} titres · ${pluriel(inv.comptes, 'compte')}</p>
    <p style="margin:0 0 8px"><strong>État actuel</strong> — somme ${somme} = ${inv.total}</p>
    <ul style="margin:0;padding-left:20px">
      <li><strong>${inv.ok}</strong> lisible${inv.ok > 1 ? 's' : ''} — vidéo d’origine</li>
      <li><strong>${inv.replaced}</strong> remplacé${inv.replaced > 1 ? 's' : ''} — vidéo disparue, autre copie trouvée</li>
      <li><strong>${inv.pending}</strong> en attente de copie</li>
      <li><strong>${inv.dead}</strong> sans solution pour l'instant</li>
      <li><strong>${inv.unchecked}</strong> pas encore vérifié${inv.unchecked > 1 ? 's' : ''}</li>
    </ul>
    <p style="margin:18px 0 8px"><strong>Travail de ce cycle</strong> — ${pluriel(done, 'titre')} sondé${done > 1 ? 's' : ''}</p>
    <ul style="margin:0;padding-left:20px">
      <li><strong>${by.ok || 0}</strong> lisible${(by.ok || 0) > 1 ? 's' : ''}</li>
      <li><strong>${by.replaced || 0}</strong> remplacé${(by.replaced || 0) > 1 ? 's' : ''}</li>
      <li><strong>${by.pending || 0}</strong> en attente de copie</li>
      <li><strong>${by.dead || 0}</strong> sans solution</li>
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
    subject: `[${mailBrand()}] Balayage bibliothèque — cycle nº${cycle.cycle_no} terminé`,
    text,
    html,
    done,
  };
}

/**
 * Bilan de fin de cycle. Le repère avance toujours (évite de recompter les
 * mêmes titres), mais le mail est plafonné : ≥ REPORT_MIN_DONE titres,
 * intervalle min REPORT_MIN_INTERVAL_MS, max REPORT_MAX_PER_DAY / 24 h.
 */
async function finishCycle() {
  if (cycleIdleClosed) return;
  // Ferme l’idle tout de suite : même si le mail est omis / le rapport vide,
  // on ne rappelle plus finishCycle toutes les 5 s.
  cycleIdleClosed = true;

  const report = buildCycleReport();
  if (!report) return;

  const cycle = currentCycle();
  const now = Date.now();
  const sinceReport = now - (cycle.last_report_at || 0);
  const dayCut = now - 24 * 60 * 60_000;
  while (recentReportAts.length && recentReportAts[0]! < dayCut) recentReportAts.shift();
  const allowMail =
    Boolean(REPORT_TO) &&
    process.env.LIBRARY_HEALTH_REPORT !== '0' &&
    report.done >= REPORT_MIN_DONE &&
    sinceReport >= REPORT_MIN_INTERVAL_MS &&
    recentReportAts.length < REPORT_MAX_PER_DAY;

  db.prepare(
    'UPDATE track_health_cycle SET cycle_no = ?, started_at = ?, last_report_at = ? WHERE id = 1',
  ).run(cycle.cycle_no + 1, now, allowMail ? now : cycle.last_report_at || 0);

  if (!allowMail) {
    stats.reportsSkipped++;
    console.log(
      `[health] cycle nº${cycle.cycle_no} terminé (done=${report.done}) — mail omis ` +
        `(minDone=${REPORT_MIN_DONE}, cooldown=${Math.round(REPORT_MIN_INTERVAL_MS / 3600000)}h, ` +
        `dayCap=${REPORT_MAX_PER_DAY}, sentToday=${recentReportAts.length}, ` +
        `sinceReport=${Math.round(sinceReport / 60000)}min)`,
    );
    return;
  }

  await sendMail({ to: REPORT_TO, subject: report.subject, html: report.html, text: report.text });
  recentReportAts.push(now);
  stats.reportsSent++;
  console.log(`[health] cycle nº${cycle.cycle_no} terminé, bilan envoyé à ${REPORT_TO}`);
}

async function tick() {
  if (running) return;
  // Idle : rien due → ne pas poller toutes les 5 s
  if (cycleIdleClosed && dueCount() === 0 && !nextPendingId()) {
    if (Date.now() - lastIdleProbeMs < IDLE_TICK_MS) return;
    lastIdleProbeMs = Date.now();
  }
  running = true;
  try {
    // La recherche d'un remplaçant est lourde : elle attend une accalmie. La
    // simple sonde, elle, coûte un appel d'API et peut tourner pendant l'écoute,
    // sans quoi une session de plusieurs heures gèlerait tout le balayage.
    if (msSinceLastStream() >= IDLE_REQUIRED_MS) {
      const pending = nextPendingId();
      if (pending) {
        emptySinceMs = 0;
        cycleIdleClosed = false;
        const state = await resolvePending(pending);
        markHealth(pending, state);
        stats[state]++;
        if (state === 'replaced') {
          const rid = getReplacementId(pending);
          if (rid) {
            void import('./stream.js')
              .then((m) => {
                m.enqueueListHeadWarm([rid], { front: true });
                m.enqueueDiskWarm([rid]);
              })
              .catch(() => {});
          }
        }
        return;
      }
    }
    // Un titre déjà en cache se règle sans toucher au réseau : lui consacrer un
    // tour d'horloge complet ferait durer le balayage des jours pour rien.
    for (let i = 0; i < FREE_BATCH; i++) {
      const next = nextTrackId();
      if (!next) {
        // Plus rien à vérifier pour l’instant. Attendre EMPTY_GRACE_MS avant de
        // clôturer : la re-vérif à 7 j drippe 1 titre / 5–20 s et ne doit pas
        // déclencher un « cycle terminé » à chaque trou.
        if (!nextPendingId()) {
          if (!emptySinceMs) emptySinceMs = Date.now();
          if (Date.now() - emptySinceMs >= EMPTY_GRACE_MS) {
            await finishCycle();
          }
        } else {
          emptySinceMs = 0;
        }
        return;
      }
      emptySinceMs = 0;
      cycleIdleClosed = false;
      lastHealthUserId = next.userId || lastHealthUserId;
      const { state, network, skip } = await probeOne(next.id, next.userId);
      if (!skip) {
        markHealth(next.id, state);
        stats.checked++;
        stats[state]++;
      }
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
    reportMinIntervalHours: Math.round(REPORT_MIN_INTERVAL_MS / 3_600_000),
    reportMinDone: REPORT_MIN_DONE,
    reportMaxPerDay: REPORT_MAX_PER_DAY,
    idleTickMinutes: Math.round(IDLE_TICK_MS / 60_000),
    emptyGraceMinutes: Math.round(EMPTY_GRACE_MS / 60_000),
    recheckOkDays: Math.round(RECHECK_OK_MS / 86_400_000),
    retryDeadDays: Math.round(RETRY_DEAD_MS / 86_400_000),
    cycle: cycle.cycle_no,
    cycleStartedAt: new Date(cycle.started_at).toISOString(),
    lastReportAt: cycle.last_report_at ? new Date(cycle.last_report_at).toISOString() : null,
    cycleIdleClosed,
    trackTotal: total,
    inventory: libraryInventory(),
    sessionChecked: stats.checked,
    reportsSent: stats.reportsSent,
    reportsSkipped: stats.reportsSkipped,
    byState: Object.fromEntries(rows.map((r) => [r.state, r.n])),
    remaining: dueCount(),
  };
}
