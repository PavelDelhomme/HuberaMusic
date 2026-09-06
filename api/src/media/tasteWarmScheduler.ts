/**
 * Préchauffe intelligente multi-comptes :
 * - au login / home / library : warm formats + têtes RAM des titres probables
 * - périodique (tous comptes) : history/likes/library → warm + .m4a disque (capé)
 *
 * Objectif : cold start ≪ 1 s quand le titre a déjà été vu par n’importe quel compte
 * (cache disque global `data/cache/{id}.m4a`).
 */
import { existsSync, statSync } from 'node:fs';
import { listWarmCandidates } from '../platform/adminUsers.js';
import { getHistory, getTopListened } from '../library/library.js';
import { db } from '../library/db.js';
import { cachePath, enqueueStreamWarm, enqueueDiskWarm } from './stream.js';

const enabled = () => {
  const v = String(process.env.TASTE_WARM_ENABLED ?? '').trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off') return false;
  // Prod ON par défaut ; local OFF sauf opt-in
  const env = String(process.env.APP_ENV || process.env.NODE_ENV || '').toLowerCase();
  if (v === '1' || v === 'true' || v === 'on') return true;
  return env === 'production' || env === 'prod';
};

const userCooldown = new Map<string, number>();
const USER_COOLDOWN_MS = 3 * 60_000;
let globalTimer: ReturnType<typeof setInterval> | null = null;
let globalRunning = false;

function validId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

function needsDisk(id: string): boolean {
  try {
    const p = cachePath(id);
    if (!existsSync(p)) return true;
    return statSync(p).size < 1024 * 1024;
  } catch {
    return true;
  }
}

function userTrackIds(userId: string, limit = 36): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (!validId(id) || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const t of getHistory(userId, limit)) push(t.id);
  for (const t of getTopListened(userId, Math.min(20, limit))) push(t.id);
  try {
    const liked = db
      .prepare(
        `SELECT track_id FROM liked_tracks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(userId, limit) as { track_id: string }[];
    for (const r of liked) push(r.track_id);
  } catch {
    /* ignore */
  }
  try {
    const lib = db
      .prepare(
        `SELECT track_id FROM library_tracks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(userId, Math.min(24, limit)) as { track_id: string }[];
    for (const r of lib) push(r.track_id);
  } catch {
    /* ignore */
  }
  return out.slice(0, limit);
}

/**
 * Warm immédiat (non bloquant) pour un compte qui ouvre l’app.
 * Formats + têtes RAM ; .m4a disque pour les ~12 premiers manquants.
 */
export function scheduleUserTasteWarm(
  userId: string,
  extraIds: string[] = [],
  opts?: { force?: boolean; disk?: number },
): void {
  if (!enabled() || !userId) return;
  const now = Date.now();
  if (!opts?.force) {
    const last = userCooldown.get(userId) || 0;
    if (now - last < USER_COOLDOWN_MS) {
      // Toujours remonter la priorité des extras (titre home / play)
      const extras = extraIds.filter(validId).slice(0, 12);
      if (extras.length) enqueueStreamWarm(extras, userId);
      return;
    }
  }
  userCooldown.set(userId, now);

  setTimeout(() => {
    try {
      const ids = [
        ...extraIds.filter(validId),
        ...userTrackIds(userId, 40),
      ].filter((id, i, a) => a.indexOf(id) === i);
      if (!ids.length) return;
      enqueueStreamWarm(ids.slice(0, 28), userId);
      const diskN = Math.max(0, Math.min(16, opts?.disk ?? 10));
      const needDisk = ids.filter(needsDisk).slice(0, diskN);
      if (needDisk.length) enqueueDiskWarm(needDisk);
      console.info(
        `[tasteWarm] user=${userId.slice(0, 8)} warm=${Math.min(28, ids.length)} disk=${needDisk.length}`,
      );
    } catch (err) {
      console.warn('[tasteWarm] user', String((err as Error).message || err).slice(0, 120));
    }
  }, 0);
}

/** Cycle global : tous les comptes (history/likes/library), cache disque partagé. */
export async function runGlobalTasteWarmOnce(): Promise<{ warmed: number; disk: number }> {
  if (!enabled()) return { warmed: 0, disk: 0 };
  if (globalRunning) return { warmed: 0, disk: 0 };
  globalRunning = true;
  try {
    const maxPerUser = Math.max(15, Math.min(80, Number(process.env.TASTE_WARM_PER_USER || 40) || 40));
    const maxTotal = Math.max(40, Math.min(600, Number(process.env.TASTE_WARM_TOTAL || 220) || 220));
    const candidates = listWarmCandidates({ maxPerUser, maxTotal });
    const ids = candidates.map((c) => c.trackId).filter(validId);
    if (!ids.length) return { warmed: 0, disk: 0 };

    // Lots pour ne pas saturer la file warm
    for (let i = 0; i < ids.length; i += 20) {
      enqueueStreamWarm(ids.slice(i, i + 20));
    }
    const diskCap = Math.max(8, Math.min(80, Number(process.env.TASTE_WARM_DISK || 36) || 36));
    const needDisk = ids.filter(needsDisk).slice(0, diskCap);
    enqueueDiskWarm(needDisk);
    console.info(`[tasteWarm] global warm=${ids.length} diskQueue=${needDisk.length}`);
    return { warmed: ids.length, disk: needDisk.length };
  } catch (err) {
    console.warn('[tasteWarm] global', String((err as Error).message || err).slice(0, 140));
    return { warmed: 0, disk: 0 };
  } finally {
    globalRunning = false;
  }
}

export function startGlobalTasteWarmScheduler(): void {
  if (!enabled()) {
    console.info('[tasteWarm] disabled');
    return;
  }
  if (globalTimer) return;
  const everyMs = Math.max(
    5 * 60_000,
    Math.min(60 * 60_000, Number(process.env.TASTE_WARM_INTERVAL_MS || 12 * 60_000) || 12 * 60_000),
  );
  // Premier passage après boot (laisser yt-dlp / cookies se stabiliser)
  setTimeout(() => {
    void runGlobalTasteWarmOnce();
  }, 45_000);
  globalTimer = setInterval(() => {
    void runGlobalTasteWarmOnce();
  }, everyMs);
  console.info(`[tasteWarm] scheduler every ${Math.round(everyMs / 60000)} min`);
}
