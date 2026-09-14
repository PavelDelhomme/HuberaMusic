/**
 * Balayage warm multi-comptes : tous les utilisateurs, têtes Aléatoire + likes.
 * Complète libraryHealth (remplacement vidéos mortes) en préchauffant les flux
 * pour que l’Aléatoire / lecture ne tombe plus sur des titres froids.
 *
 * Env :
 *  LIBRARY_WARM_SWEEP=0          → off
 *  LIBRARY_WARM_INTERVAL_MS      → défaut 6 h
 *  LIBRARY_WARM_START_DELAY_MS   → défaut 180 s
 */
import { db } from '../library/db.js';
import { getShuffleHeads } from '../library/shuffleHeads.js';
import { enqueueStreamWarm, enqueueDiskWarm } from './stream.js';
import { scheduleUserTasteWarm } from './tasteWarmScheduler.js';

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let lastRunAt = 0;
let lastStats = { users: 0, ids: 0, at: 0 };

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

function likedIds(userId: string, limit = 40): string[] {
  try {
    return (
      db
        .prepare(
          `SELECT track_id FROM liked_tracks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(userId, limit) as { track_id: string }[]
    )
      .map((r) => r.track_id)
      .filter((id) => /^[a-zA-Z0-9_-]{11}$/.test(id));
  } catch {
    return [];
  }
}

/** Une passe : shuffle-heads (warm) + likes + taste pour chaque compte. */
export async function runLibraryWarmSweepOnce(): Promise<{
  users: number;
  ids: number;
}> {
  if (running) return { users: 0, ids: lastStats.ids };
  running = true;
  const seen = new Set<string>();
  let users = 0;
  try {
    const uids = allUserIds();
    for (const uid of uids) {
      users += 1;
      try {
        const heads = getShuffleHeads(uid, { warm: true, scope: 'all' });
        for (const id of heads.ids || []) seen.add(id);
        for (const id of likedIds(uid, 32)) seen.add(id);
        scheduleUserTasteWarm(uid);
      } catch (err) {
        console.warn(
          `[libraryWarm] user ${uid.slice(0, 8)}…`,
          String((err as Error).message || err).slice(0, 100),
        );
      }
      // Laisse respirer yt-dlp entre comptes
      await new Promise((r) => setTimeout(r, 400));
    }
    const ids = [...seen];
    // Batch warm (priorité tête de file)
    for (let i = 0; i < ids.length; i += 24) {
      const chunk = ids.slice(i, i + 24);
      enqueueStreamWarm(chunk);
      enqueueDiskWarm(chunk.slice(0, 12));
      await new Promise((r) => setTimeout(r, 800));
    }
    lastRunAt = Date.now();
    lastStats = { users, ids: ids.length, at: lastRunAt };
    console.info(`[libraryWarm] sweep users=${users} uniqueIds=${ids.length}`);
    return { users, ids: ids.length };
  } finally {
    running = false;
  }
}

export function startLibraryWarmSweep(): void {
  if (!enabled()) {
    console.info('[libraryWarm] disabled');
    return;
  }
  if (timer) return;
  const everyMs = Math.max(
    60 * 60_000,
    Math.min(24 * 3600_000, Number(process.env.LIBRARY_WARM_INTERVAL_MS || 6 * 3600_000) || 6 * 3600_000),
  );
  const startDelay = Math.max(
    30_000,
    Number(process.env.LIBRARY_WARM_START_DELAY_MS || 180_000) || 180_000,
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
  };
}
