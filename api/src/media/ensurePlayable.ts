/**
 * Pré-validation d’un titre AVANT écoute utilisateur :
 * - .m4a progressif complet sur disque (intégrité ftyp)
 * - sinon téléchargement via proxies (VPS bot-bloqué)
 * - si KO → ID de remplacement jouable + même traitement
 *
 * Objectif : zéro 502 / coupure mid-piste faute de fichier partiel.
 */
import { existsSync, statSync } from 'node:fs';
import {
  cachePath,
  downloadTrack,
  enqueueDiskWarm,
  enqueueLikesDiskWarm,
  enqueueListHeadWarm,
  enqueueNextDiskWarm,
  enqueueStreamWarm,
  isCompleteEnoughDiskFile,
  isDashBrandFilePath,
  isPlaybackHot,
} from './stream.js';
import { findReplacementId, getReplacementId } from './trackReplacement.js';

/** Fenêtre à pré-vérifier (format + proxy + tête disque) avant que l’utilisateur arrive. */
export const PREFLIGHT_AHEAD = 20;
/** .m4a intégral : seulement les tout prochains — 20 téléchargements complets noient yt-dlp. */
const FULL_DISK_HOT = 3;
const FULL_DISK_IDLE = 8;
const VERIFIED_TTL_MS = 30 * 60_000;

const verified = new Map<string, { playId: string; at: number }>();
let preflightBusy = false;
const preflightWait: Array<{ ids: string[]; userId?: string }> = [];

export function isQueueTitleVerified(id: string): boolean {
  const hit = verified.get(id);
  return Boolean(hit && Date.now() - hit.at < VERIFIED_TTL_MS);
}

function markVerified(id: string, playId = id) {
  const at = Date.now();
  verified.set(id, { playId, at });
  if (playId !== id) verified.set(playId, { playId, at });
  if (verified.size > 8_000) {
    const cutoff = at - VERIFIED_TTL_MS;
    for (const [k, v] of verified) {
      if (v.at < cutoff) verified.delete(k);
    }
  }
}

export type EnsurePlayableResult = {
  ok: boolean;
  videoId: string;
  /** Id réellement servi (remplaçant éventuel). */
  playId: string;
  path?: string;
  bytes?: number;
  via: 'disk' | 'download' | 'replacement' | 'fail';
  detail?: string;
};

function integrityOk(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    if (!isCompleteEnoughDiskFile(path)) return false;
    if (isDashBrandFilePath(path)) return false;
    const size = statSync(path).size;
    // AAC 128k ≈ 16 Ko/s → 90 s min ≈ 1,4 Mo. Sous 1 Mo = risque EOS précoce.
    return size >= 1024 * 1024;
  } catch {
    return false;
  }
}

/**
 * Garantit un fichier disque jouable pour `videoId` (ou un remplaçant).
 * `waitMs` : budget max (0 = fire-and-forget enqueue seulement).
 */
export async function ensurePlayableOnDisk(
  videoId: string,
  opts?: {
    userId?: string;
    title?: string;
    artist?: string;
    waitMs?: number;
    preferProxies?: boolean;
    allowReplace?: boolean;
  },
): Promise<EnsurePlayableResult> {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return { ok: false, videoId, playId: videoId, via: 'fail', detail: 'id invalide' };
  }
  const preferProxies = opts?.preferProxies !== false;
  const allowReplace = opts?.allowReplace !== false;
  const waitMs = Math.max(0, Math.min(90_000, opts?.waitMs ?? 25_000));

  const tryId = async (id: string): Promise<EnsurePlayableResult | null> => {
    const path = cachePath(id);
    if (integrityOk(path)) {
      return {
        ok: true,
        videoId,
        playId: id,
        path,
        bytes: statSync(path).size,
        via: 'disk',
      };
    }
    if (waitMs <= 0) {
      enqueueLikesDiskWarm([id]);
      enqueueStreamWarm([id], opts?.userId);
      return null;
    }
    try {
      const out = await Promise.race([
        downloadTrack(id, { progressiveOnly: true, preferProxies }),
        new Promise<string>((_, rej) =>
          setTimeout(() => rej(new Error('ensure download timeout')), waitMs),
        ),
      ]);
      if (integrityOk(out)) {
        return {
          ok: true,
          videoId,
          playId: id,
          path: out,
          bytes: statSync(out).size,
          via: 'download',
        };
      }
      return {
        ok: false,
        videoId,
        playId: id,
        via: 'fail',
        detail: 'fichier incomplet / DASH après download',
      };
    } catch (err) {
      return {
        ok: false,
        videoId,
        playId: id,
        via: 'fail',
        detail: String((err as Error).message || err).slice(0, 160),
      };
    }
  };

  // Remplaçant déjà mémorisé : tenter d’abord l’id courant (cache), sinon le mapping.
  const first = await tryId(videoId);
  if (first?.ok) return first;

  const known = getReplacementId(videoId);
  if (known && known !== videoId) {
    const second = await tryId(known);
    if (second?.ok) {
      return { ...second, videoId, via: 'replacement' };
    }
  }

  if (!allowReplace) {
    return first || { ok: false, videoId, playId: videoId, via: 'fail', detail: 'ensure KO' };
  }

  try {
    const replacement = await Promise.race([
      findReplacementId(videoId, {
        userId: opts?.userId,
        title: opts?.title,
        artist: opts?.artist,
      }),
      new Promise<null>((r) => setTimeout(() => r(null), Math.min(8_000, waitMs || 8_000))),
    ]);
    if (replacement && replacement !== videoId) {
      enqueueDiskWarm([replacement]);
      const third = await tryId(replacement);
      if (third?.ok) {
        return { ...third, videoId, playId: replacement, via: 'replacement' };
      }
    }
  } catch {
    /* ignore */
  }

  // Dernier recours : enfile pour plus tard
  enqueueLikesDiskWarm([videoId]);
  enqueueStreamWarm([videoId], opts?.userId);
  return (
    first || {
      ok: false,
      videoId,
      playId: videoId,
      via: 'fail',
      detail: 'ensure KO + queued',
    }
  );
}

/**
 * Prépare ~20 titres d’avance sans noyer le titre en cours :
 * 1) formats RAM + tête .m4a (proxy dédié par titre si le 1er meurt)
 * 2) fichier complet seulement pour les 4–8 suivants
 * 3) si format KO → autre proxy, puis remplaçant cohérent déjà mappé
 */
export function ensurePlayableQueueAhead(
  ids: string[],
  opts?: { userId?: string },
): void {
  const uniq = [
    ...new Set(ids.filter((id) => /^[a-zA-Z0-9_-]{11}$/.test(id))),
  ].slice(0, 50);
  if (!uniq.length) return;
  const hot = isPlaybackHot(90_000);
  const aheadN = hot ? 4 : PREFLIGHT_AHEAD;
  const ahead = uniq.slice(0, aheadN);
  const fullN = hot ? FULL_DISK_HOT : FULL_DISK_IDLE;
  enqueueStreamWarm(ahead, opts?.userId);
  if (!hot) enqueueListHeadWarm(ahead, { front: true });
  enqueueNextDiskWarm(ahead.slice(0, fullN));
  if (!hot) enqueueLikesDiskWarm(ahead.slice(0, 4));
  const [first, ...rest] = ahead;
  if (first) {
    void ensurePlayableOnDisk(first, {
      userId: opts?.userId,
      waitMs: hot ? 0 : 8_000,
      preferProxies: true,
    }).then((r) => {
      if (r?.ok) markVerified(first, r.playId);
    });
  }
  for (const id of rest.slice(0, Math.max(0, fullN - 1))) {
    void ensurePlayableOnDisk(id, {
      userId: opts?.userId,
      waitMs: 0,
      preferProxies: true,
    });
  }
  if (!hot) enqueuePreflightTwenty(ahead, opts?.userId);
}

function enqueuePreflightTwenty(ids: string[], userId?: string) {
  preflightWait.push({ ids, userId });
  if (preflightWait.length > 6) preflightWait.splice(0, preflightWait.length - 6);
  if (!preflightBusy) void runPreflightQueue();
}

async function runPreflightQueue() {
  if (preflightBusy) return;
  preflightBusy = true;
  try {
    while (preflightWait.length) {
      const job = preflightWait.shift();
      if (!job) break;
      await runPreflightTwenty(job.ids, job.userId);
    }
  } finally {
    preflightBusy = false;
    if (preflightWait.length) void runPreflightQueue();
  }
}

async function runPreflightTwenty(ids: string[], userId?: string) {
  const hot = isPlaybackHot(90_000);
  const conc = hot ? 2 : 3;
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const idx = cursor++;
      const id = ids[idx];
      if (!id) continue;
      try {
        await preflightOne(id, userId, { deep: idx < 8 || !hot });
      } catch {
        /* best-effort — le titre reste en file disque */
      }
    }
  };
  await Promise.all(Array.from({ length: conc }, () => worker()));
}

async function preflightOne(
  videoId: string,
  userId: string | undefined,
  opts: { deep: boolean },
): Promise<void> {
  if (isQueueTitleVerified(videoId) && integrityOk(cachePath(videoId))) return;
  if (integrityOk(cachePath(videoId))) {
    markVerified(videoId);
    return;
  }
  const known = getReplacementId(videoId);
  if (known && known !== videoId && integrityOk(cachePath(known))) {
    markVerified(videoId, known);
    enqueueListHeadWarm([known], { front: true });
    return;
  }

  const { getAudioFormat } = await import('../youtube/yt.js');
  const tryFormat = async (fresh: boolean) => {
    try {
      const fmt = await Promise.race([
        getAudioFormat(videoId, {
          userId,
          forceFresh: fresh,
        }),
        new Promise<null>((r) => setTimeout(() => r(null), fresh ? 10_000 : 7_000)),
      ]);
      return Boolean(fmt && (fmt as { url?: string }).url);
    } catch {
      return false;
    }
  };

  if (await tryFormat(false)) {
    markVerified(videoId);
    enqueueListHeadWarm([videoId], { front: true });
    return;
  }
  // Même titre, autre proxy (forceFresh mélange le pool).
  if (await tryFormat(true)) {
    markVerified(videoId);
    enqueueListHeadWarm([videoId], { front: true });
    enqueueDiskWarm([videoId]);
    return;
  }

  if (!opts.deep) {
    enqueueListHeadWarm([videoId], { front: true });
    return;
  }

  try {
    const replacement = await Promise.race([
      findReplacementId(videoId, { userId }),
      new Promise<null>((r) => setTimeout(() => r(null), 8_000)),
    ]);
    if (replacement && replacement !== videoId) {
      enqueueStreamWarm([replacement], userId);
      enqueueListHeadWarm([replacement], { front: true });
      enqueueDiskWarm([replacement]);
      if (integrityOk(cachePath(replacement))) {
        markVerified(videoId, replacement);
        return;
      }
      try {
        const fmt = await Promise.race([
          getAudioFormat(replacement, { userId, forceFresh: true }),
          new Promise<null>((r) => setTimeout(() => r(null), 8_000)),
        ]);
        if (fmt && (fmt as { url?: string }).url) markVerified(videoId, replacement);
      } catch {
        /* mapping déjà persisté — le prochain play servira le remplaçant */
      }
    }
  } catch {
    enqueueListHeadWarm([videoId]);
  }
}
