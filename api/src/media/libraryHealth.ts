/**
 * Repère à l'avance les titres dont la vidéo YouTube est morte.
 *
 * Sans cela, la première rencontre avec un titre mort coûte la recherche d'un
 * remplaçant — une quarantaine de secondes — pendant lesquelles le téléphone
 * abandonne et saute le morceau. En balayant la bibliothèque à faible cadence,
 * le remplacement est déjà connu quand l'utilisateur lance le titre.
 *
 * Le balayage s'efface devant une écoute en cours et ne repasse jamais sur un
 * titre déjà vérifié, sauf pour retenter périodiquement ceux restés sans
 * solution : YouTube en republie régulièrement.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getTrackPayload } from '../library/db.js';
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
/** Un titre sans remplaçant est retenté plus tard, le catalogue bouge. */
const RETRY_DEAD_MS = 7 * 24 * 3_600_000;

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
  `);
  schemaReady = true;
}

function markHealth(trackId: string, state: State) {
  ensureSchema();
  db.prepare(
    `INSERT INTO track_health (track_id, state, checked_at) VALUES (?, ?, ?)
     ON CONFLICT(track_id) DO UPDATE SET state = excluded.state, checked_at = excluded.checked_at`,
  ).run(trackId, state, Date.now());
}

/**
 * Les titres écoutés le plus récemment d'abord : ce sont eux que l'utilisateur
 * risque de relancer, et donc là que l'attente se ferait sentir.
 */
function nextTrackId(): string | null {
  ensureSchema();
  const row = db
    .prepare(
      `SELECT t.track_id AS id
         FROM (
           SELECT track_id, created_at FROM library_tracks
           UNION
           SELECT track_id, created_at FROM liked_tracks
         ) t
         LEFT JOIN track_health h ON h.track_id = t.track_id
        WHERE h.track_id IS NULL
           OR (h.state = 'dead' AND h.checked_at < ?)
        ORDER BY (h.track_id IS NOT NULL), t.created_at DESC
        LIMIT 1`,
    )
    .get(Date.now() - RETRY_DEAD_MS) as { id?: string } | undefined;
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
      if (!id) return;
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
  const remaining = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT track_id FROM library_tracks UNION SELECT track_id FROM liked_tracks
       ) t LEFT JOIN track_health h ON h.track_id = t.track_id WHERE h.track_id IS NULL`,
    )
    .get() as { n: number };
  return {
    enabled: process.env.LIBRARY_HEALTH_SCAN !== '0',
    tickMs: TICK_MS,
    sessionChecked: stats.checked,
    byState: Object.fromEntries(rows.map((r) => [r.state, r.n])),
    remaining: remaining?.n ?? 0,
  };
}
