/**
 * Balayage préfixes ~3 s (256 Ko AAC) — tous les comptes, cache VPS partagé.
 * Un titre chaud pour paul@ l’est aussi pour les autres. Pas le fichier entier.
 *
 * Env :
 *  LIBRARY_WARM_SWEEP=0          → off
 *  LIBRARY_WARM_INTERVAL_MS      → défaut 45 min
 *  LIBRARY_WARM_START_DELAY_MS   → défaut 45 s
 */
import { db } from '../library/db.js';
import { getShuffleHeads } from '../library/shuffleHeads.js';
import {
  enqueueStreamWarm,
  enqueueListHeadWarm,
  enqueueLibraryPrefixWarm,
  isPlaybackHot,
  diskWarmQueueStats,
} from './stream.js';
import { scheduleUserTasteWarm } from './tasteWarmScheduler.js';

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastRunAt = 0;
let lastStats = { users: 0, ids: 0, likes: 0, at: 0 };

function enabled(): boolean {
  return String(process.env.LIBRARY_WARM_SWEEP || '1').trim() !== '0';
}

function allUserIds(): string[] {
  try {
    const rows = db.prepare(`SELECT id FROM users`).all() as { id: string }[];
    return rows.map((r) => r.id).filter(Boolean);
  } catch {
    return [];
  }
}

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

function allSharedLibraryIds(limit = 20_000): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (id: string) => {
    if (!validId(id) || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  try {
    const lib = db
      .prepare(`SELECT DISTINCT track_id FROM library_tracks LIMIT ?`)
      .all(limit) as { track_id: string }[];
    for (const r of lib) push(r.track_id);
  } catch {
    /* sqlite/pg */
  }
  try {
    const likes = db
      .prepare(`SELECT DISTINCT track_id FROM liked_tracks LIMIT ?`)
      .all(limit) as { track_id: string }[];
    for (const r of likes) push(r.track_id);
  } catch {
    /* ignore */
  }
  return out;
}

/** Une passe : préfixes 256 Ko de toute la biblio union, têtes Aléatoire en priorité. */
export async function runLibraryWarmSweepOnce(): Promise<{
  users: number;
  ids: number;
  likes: number;
}> {
  if (isPlaybackHot(120_000)) {
    console.info('[libraryWarm] skip sweep — lecture en cours');
    return { users: 0, ids: lastStats.ids, likes: lastStats.likes };
  }
  if (running) return { users: 0, ids: lastStats.ids, likes: lastStats.likes };
  running = true;
  try {
    const uids = allUserIds();
    const front: string[] = [];
    const frontSeen = new Set<string>();
    for (const uid of uids) {
      try {
        const heads = getShuffleHeads(uid, { warm: false, scope: 'all' });
        for (const id of (heads.ids || []).slice(0, 24)) {
          if (!frontSeen.has(id) && validId(id)) {
            frontSeen.add(id);
            front.push(id);
          }
        }
        scheduleUserTasteWarm(uid);
      } catch {
        /* un compte KO n’arrête pas les autres */
      }
    }
    const all = allSharedLibraryIds();
    enqueueListHeadWarm(front, { front: true });
    enqueueStreamWarm(front.slice(0, 16));
    for (let i = 0; i < all.length; i += 80) {
      enqueueLibraryPrefixWarm(all.slice(i, i + 80));
    }
    lastRunAt = Date.now();
    lastStats = { users: uids.length, ids: all.length, likes: 0, at: lastRunAt };
    const q = diskWarmQueueStats();
    console.info(
      `[libraryWarm] prefix users=${uids.length} uniqueIds=${all.length} heads=${front.length} q prefix=${q.libPrefix} list=${q.listHeads}`,
    );
    void warmSharedLyricsForReady(front.slice(0, 40));
    return { users: uids.length, ids: all.length, likes: 0 };
  } finally {
    running = false;
  }
}

/** Paroles déjà trouvées + flux complets : une copie gzip pour tous les comptes. */
async function warmSharedLyricsForReady(priorityIds: string[]): Promise<void> {
  try {
    const catalog = await import('../library/sharedCatalog.js');
    const scan = catalog.scanReadyAudioFromDisk();
    const missing = [
      ...priorityIds.filter((id) => !catalog.hasSharedLyrics(id)),
      ...catalog.listReadyAudioMissingLyrics(40),
    ].filter((id, i, a) => a.indexOf(id) === i);
    const { getTrackPayload } = await import('../library/db.js');
    const { getLyrics } = await import('../youtube/yt.js');
    let n = 0;
    for (const id of missing) {
      if (n >= 24) break;
      if (isPlaybackHot(90_000)) break;
      if (catalog.hasSharedLyrics(id)) continue;
      const meta = getTrackPayload(id);
      const title = String(meta?.title || '').trim();
      const artist = (meta?.artists || []).map((a) => a.name).filter(Boolean).join(' ');
      await getLyrics(id, { title, artist }).catch(() => null);
      n += 1;
      await new Promise((r) => setTimeout(r, 3_500));
    }
    const st = catalog.sharedCatalogStats();
    console.info(
      `[libraryWarm] lyrics scan=${scan.ready} stored=${st.lyrics} audioReady=${st.audioReady} warmed=${n}`,
    );
  } catch (err) {
    console.warn('[libraryWarm] lyrics', String((err as Error).message || err).slice(0, 120));
  }
}

export function startLibraryWarmSweep(): void {
  if (!enabled()) {
    console.info('[libraryWarm] disabled');
    return;
  }
  if (timer) return;
  const everyMs = Math.max(
    20 * 60_000,
    Math.min(6 * 3600_000, Number(process.env.LIBRARY_WARM_INTERVAL_MS || 45 * 60_000) || 45 * 60_000),
  );
  const startDelay = Math.max(
    20_000,
    Number(process.env.LIBRARY_WARM_START_DELAY_MS || 45_000) || 45_000,
  );
  setTimeout(() => {
    void runLibraryWarmSweepOnce();
  }, startDelay);
  timer = setInterval(() => {
    void runLibraryWarmSweepOnce();
  }, everyMs);
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    try {
      (timer as NodeJS.Timeout).unref?.();
    } catch {
      /* ignore */
    }
  }
  console.info(`[libraryWarm] scheduler every ${Math.round(everyMs / 3600_000)} h (start in ${Math.round(startDelay / 1000)} s)`);
}

export function libraryWarmSweepStatus() {
  return {
    enabled: enabled(),
    running,
    lastRunAt,
    ...lastStats,
    diskQueue: diskWarmQueueStats(),
    likesLimit: 0,
  };
}
