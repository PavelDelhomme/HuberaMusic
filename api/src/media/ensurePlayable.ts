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
  enqueueStreamWarm,
  isCompleteEnoughDiskFile,
  isDashBrandFilePath,
} from './stream.js';
import { findReplacementId, getReplacementId } from './trackReplacement.js';

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

/** Prépare N titres suivants (file Android) sans bloquer — priorité likes disk. */
export function ensurePlayableQueueAhead(
  ids: string[],
  opts?: { userId?: string },
): void {
  const uniq = [
    ...new Set(ids.filter((id) => /^[a-zA-Z0-9_-]{11}$/.test(id))),
  ].slice(0, 12);
  if (!uniq.length) return;
  enqueueLikesDiskWarm(uniq);
  enqueueStreamWarm(uniq, opts?.userId);
  // Kick async ensure pour le +1 (budget court) — le reste en file disk.
  const next = uniq[0];
  if (next) {
    void ensurePlayableOnDisk(next, {
      userId: opts?.userId,
      waitMs: 20_000,
      preferProxies: true,
    });
  }
}
