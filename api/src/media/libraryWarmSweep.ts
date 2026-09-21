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
import {
  enqueueStreamWarm,
  enqueueDiskWarm,
  enqueueLikesDiskWarm,
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

function likesLimit(): number {
  return Math.max(50, Math.min(5000, Number(process.env.LIBRARY_WARM_LIKES_LIMIT || 1500) || 1500));
}

function likedIds(userId: string, limit = likesLimit()): string[] {
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

async function waitIfPlaybackHot(): Promise<void> {
  let spins = 0;
  while (isPlaybackHot(90_000) && spins < 40) {
    spins += 1;
    await new Promise((r) => setTimeout(r, 3_000));
  }
}

/** Une passe : shuffle-heads + recent + likes (disque prioritaire) + taste. */
export async function runLibraryWarmSweepOnce(): Promise<{
  users: number;
  ids: number;
  likes: number;
}> {
  if (running) return { users: 0, ids: lastStats.ids, likes: lastStats.likes };
  running = true;
  const seen = new Set<string>();
  let users = 0;
  try {
    await waitIfPlaybackHot();
    const uids = allUserIds();
    const lim = likesLimit();
    const uniqueLikes: string[] = [];
    for (const uid of uids) {
      users += 1;
      const userHeads: string[] = [];
      const userLikes: string[] = [];
      try {
        const heads = getShuffleHeads(uid, { warm: false, scope: 'all' });
        for (const id of (heads.ids || []).slice(0, 64)) {
          if (!seen.has(id)) {
            seen.add(id);
            userHeads.push(id);
          }
        }
        const recent = getShuffleHeads(uid, { warm: false, scope: 'recent' });
        for (const id of (recent.ids || []).slice(0, 40)) {
          if (!seen.has(id)) {
            seen.add(id);
            userHeads.push(id);
          }
        }
        for (const id of likedIds(uid, lim)) {
          if (!seen.has(id)) {
            seen.add(id);
            userHeads.push(id);
          }
          userLikes.push(id);
          uniqueLikes.push(id);
        }
        scheduleUserTasteWarm(uid);
      } catch (err) {
        console.warn(
          `[libraryWarm] user ${uid.slice(0, 8)}…`,
          String((err as Error).message || err).slice(0, 100),
        );
      }
      await new Promise((r) => setTimeout(r, 400));
      for (let i = 0; i < userLikes.length; i += 16) {
        await waitIfPlaybackHot();
        enqueueLikesDiskWarm(userLikes.slice(i, i + 16));
        enqueueStreamWarm(userLikes.slice(i, i + 16), uid);
        await new Promise((r) => setTimeout(r, 600));
      }
      for (let i = 0; i < userHeads.length; i += 8) {
        await waitIfPlaybackHot();
        const chunk = userHeads.slice(i, i + 8);
        enqueueStreamWarm(chunk, uid);
        enqueueDiskWarm(chunk);
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
    const ids = [...seen];
    lastRunAt = Date.now();
    lastStats = { users, ids: ids.length, likes: uniqueLikes.length, at: lastRunAt };
    const q = diskWarmQueueStats();
    console.info(
      `[libraryWarm] sweep users=${users} uniqueIds=${ids.length} likes=${uniqueLikes.length} diskQ likes=${q.likes} gen=${q.generic}`,
    );
    void warmSharedLyricsForReady(ids.slice(0, 80));
    return { users, ids: ids.length, likes: uniqueLikes.length };
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
    60 * 60_000,
    Math.min(24 * 3600_000, Number(process.env.LIBRARY_WARM_INTERVAL_MS || 3 * 3600_000) || 3 * 3600_000),
  );
  const startDelay = Math.max(
    30_000,
    Number(process.env.LIBRARY_WARM_START_DELAY_MS || 120_000) || 120_000,
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
    likesLimit: likesLimit(),
  };
}
