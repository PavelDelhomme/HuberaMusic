/**
 * Préchargement agressif + démarrage instantané — Hubera Music.
 *
 * Objectif produit : un titre doit démarrer en < 1 s, qu'il soit chaud ou froid.
 *
 * Trois leviers, dans cet ordre :
 *  1. **Cache instantané** : si le .m4a disque ou la tête RAM existe → servi
 *     immédiatement, zéro réseau (déjà géré par stream.ts, on le met en évidence).
 *  2. **Préchargement spéculatif** : dès qu'un utilisateur *regarde* une liste
 *     (recherche, album, playlist, file) on résout le format des N premiers
 *     titres en arrière-plan, sans bloquer la réponse HTTP.
 *  3. **Auto-heal global** : si un titre échoue pour UN utilisateur, on le répare
 *     pour TOUT LE MONDE (disque partagé + remplaçant canonique) et on consigne
 *     l'incident (Docs + mail).
 *
 * Ce module ne remplace pas stream.ts : il l'orchestre. Il est volontairement
 * idempotent (un même id n'est résolu qu'une fois par fenêtre) et rend le
 * budget de temps à l'appelant (`deadlineMs`).
 */
import { existsSync, statSync } from 'node:fs';
import {
  cachePath,
  enqueueStreamWarm,
  enqueueDiskWarm,
  enqueueListHeadWarm,
  downloadTrack,
  isPlaybackHot,
} from './stream.js';
import { peekStreamHead } from './streamHeadCache.js';

const ID_RE = /^[a-zA-Z0-9_-]{11}$/;

/** Combien de titres on pré-résout devant une liste (fenêtre visible). */
const PREWARM_WINDOW = Math.max(3, Math.min(30, Number(process.env.FAST_START_PREWARM || 8) || 8));
/** Titres pour lesquels on pousse aussi le .m4a complet (coûteux : yt-dlp). */
const PREWARM_DISK = Math.max(0, Math.min(6, Number(process.env.FAST_START_PREWARM_DISK || 2) || 2));
/** Budget de premier octet : au-delà, l'utilisateur perçoit un « ça rame ». */
export const FIRST_BYTE_BUDGET_MS = Math.max(
  1_500,
  Math.min(15_000, Number(process.env.FAST_START_FIRST_BYTE_MS || 4_000) || 4_000),
);
/** Un même titre n'est pas re-résolu avant ce délai (anti-tempête). */
const RESOLVE_TTL_MS = 12 * 60_000;

/** Dernière tentative de résolution, pour ne pas lancer 40 yt-dlp d'un coup. */
const lastResolve = new Map<string, number>();
/** Titres vus comme non jouables, avec leur dernier motif. */
const failures = new Map<string, { at: number; userId?: string; reason: string; hits: number }>();
/** Compteurs observables (health / admin). */
const stats = {
  speculative: 0,
  diskQueued: 0,
  failures: 0,
  heals: 0,
  startedAt: Date.now(),
};

type WarmSource = 'search' | 'album' | 'playlist' | 'queue' | 'home' | 'library' | 'next';

function tooSoon(id: string): boolean {
  const last = lastResolve.get(id);
  return Boolean(last && Date.now() - last < RESOLVE_TTL_MS);
}

function mark(id: string) {
  lastResolve.set(id, Date.now());
  if (lastResolve.size > 4_000) {
    const cutoff = Date.now() - RESOLVE_TTL_MS;
    for (const [k, t] of lastResolve) {
      if (t < cutoff) lastResolve.delete(k);
    }
  }
}

/** Un titre déjà prêt (disque complet OU tête RAM) : rien à faire. */
export function isInstantReady(id: string): boolean {
  if (!ID_RE.test(id)) return false;
  try {
    const p = cachePath(id);
    if (existsSync(p) && statSync(p).size >= 1024 * 1024) return true;
  } catch {
    /* ignore */
  }
  return Boolean(peekStreamHead(id));
}

/**
 * Préchargement spéculatif d'une liste (résultats de recherche, album, playlist…).
 *
 * Non bloquant : rend la main immédiatement, le travail part en arrière-plan.
 * Chaque titre est poussé dans la file `warm` (résolution du format googlevideo,
 * bon marché) et les `PREWARM_DISK` premiers manquants dans la file `disk`
 * (téléchargement .m4a complet, pour un démarrage vraiment instantané ensuite).
 *
 * `source` sert au diagnostic (savoir quelle vue a déclenché la chauffe).
 */
export function speculativePrewarm(
  ids: string[],
  opts?: { userId?: string; source?: WarmSource; window?: number; disk?: number },
): { queued: number; disk: number } {
  const window = Math.max(1, Math.min(40, opts?.window ?? PREWARM_WINDOW));
  const diskN = Math.max(0, Math.min(8, opts?.disk ?? PREWARM_DISK));
  const list: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids || []) {
    const id = String(raw || '').trim();
    if (!ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    list.push(id);
    if (list.length >= window) break;
  }
  if (!list.length) return { queued: 0, disk: 0 };

  const cold = list.filter((id) => !isInstantReady(id));
  if (!cold.length) return { queued: 0, disk: 0 };

  // 1) Formats : bon marché, on pousse toute la fenêtre visible.
  enqueueStreamWarm(cold, opts?.userId);
  enqueueListHeadWarm(cold, { front: true });
  stats.speculative += cold.length;

  // 2) Disque : coûteux (slots yt-dlp). On limite, et on n'y touche pas si
  //    quelqu'un écoute déjà (sinon on vole la bande au titre en cours).
  let diskQueued = 0;
  if (diskN > 0 && !isPlaybackHot(90_000)) {
    const needDisk = cold.filter((id) => !tooSoon(id)).slice(0, diskN);
    if (needDisk.length) {
      enqueueDiskWarm(needDisk);
      needDisk.forEach(mark);
      diskQueued = needDisk.length;
      stats.diskQueued += diskQueued;
    }
  }

  console.info(
    `[fastStart] prewarm src=${opts?.source || 'list'} window=${cold.length} disk=${diskQueued} hot=${isPlaybackHot(90_000)}`,
  );
  return { queued: cold.length, disk: diskQueued };
}

/**
 * Attente bornée d'un premier octet côté disque. Rend le chemin dès que le
 * fichier dépasse `minBytes` ; `null` si le budget est épuisé.
 */
export async function waitForInstantStart(
  id: string,
  opts?: { budgetMs?: number; minBytes?: number },
): Promise<string | null> {
  if (!ID_RE.test(id)) return null;
  const budgetMs = Math.max(200, opts?.budgetMs ?? FIRST_BYTE_BUDGET_MS);
  const minBytes = Math.max(64 * 1024, opts?.minBytes ?? 256 * 1024);
  const path = cachePath(id);
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      if (existsSync(path) && statSync(path).size >= minBytes) return path;
    } catch {
      /* ignore */
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 120));
  }
}

/**
 * Force le téléchargement disque d'un titre (utilisé quand un client signale
 * un échec : on prépare le fichier pour que la reprise soit instantanée).
 * Ne jette jamais : peut échouer en silence (le heal prendra le relais).
 */
export async function forceDiskPrepare(
  id: string,
  opts?: { userId?: string; waitMs?: number },
): Promise<{ ok: boolean; path?: string; detail?: string }> {
  if (!ID_RE.test(id)) return { ok: false, detail: 'id invalide' };
  const path = cachePath(id);
  try {
    if (existsSync(path) && statSync(path).size >= 1024 * 1024) {
      return { ok: true, path };
    }
  } catch {
    /* ignore */
  }
  try {
    const budget = Math.max(3_000, Math.min(60_000, opts?.waitMs ?? 20_000));
    await Promise.race([
      downloadTrack(id, { userId: opts?.userId, preferProxies: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('fastStart disk timeout')), budget)),
    ]);
    if (existsSync(path)) return { ok: true, path };
    return { ok: false, detail: 'fichier absent après download' };
  } catch (err) {
    return { ok: false, detail: String((err as Error).message || err).slice(0, 160) };
  }
}

/**
 * Enregistre un échec de lecture observé pour un utilisateur. Sert à :
 *  - éviter de re-servir un titre cassé en boucle,
 *  - déclencher l'auto-heal global (voir `healGlobally`).
 */
export function notePlaybackFailure(
  id: string,
  opts: { userId?: string; reason: string },
): { shouldHeal: boolean; hits: number } {
  if (!ID_RE.test(id)) return { shouldHeal: false, hits: 0 };
  const now = Date.now();
  const prev = failures.get(id);
  const hits = prev && now - prev.at < 10 * 60_000 ? prev.hits + 1 : 1;
  failures.set(id, { at: now, userId: opts.userId, reason: opts.reason, hits });
  stats.failures += 1;
  if (failures.size > 2_000) {
    const cutoff = now - 30 * 60_000;
    for (const [k, v] of failures) {
      if (v.at < cutoff) failures.delete(k);
    }
  }
  // Dès la 1ʳᵉ occurrence → on répare tout de suite (l'utilisateur n'attend pas).
  return { shouldHeal: hits >= 1, hits };
}

export type HealOutcome = {
  ok: boolean;
  videoId: string;
  playId?: string;
  via?: string;
  replacement?: string | null;
  detail?: string;
  ms: number;
};

/**
 * Auto-heal **global** : répare un titre pour tout le monde.
 *
 *  1. Purge le cache cassé du videoId (disque + format + tête RAM) via
 *     `ensurePlayableOnDisk` (qui appelle downloadTrack → invalide le format).
 *  2. Retélécharge proprement, avec remplaçant canonique autorisé.
 *  3. Si l'id canonique change, `trackReplacement` persiste le mapping : la
 *     bibliothèque de TOUS les comptes est remappée (disque partagé).
 *
 * Rend le résultat pour journalisation ; ne jette pas.
 */
export async function healGlobally(
  id: string,
  opts?: { userId?: string; title?: string; artist?: string; waitMs?: number },
): Promise<HealOutcome> {
  const started = Date.now();
  if (!ID_RE.test(id)) {
    return { ok: false, videoId: id, detail: 'id invalide', ms: 0 };
  }
  try {
    const { ensurePlayableOnDisk } = await import('./ensurePlayable.js');
    const res = await ensurePlayableOnDisk(id, {
      userId: opts?.userId,
      title: opts?.title,
      artist: opts?.artist,
      waitMs: Math.max(5_000, Math.min(90_000, opts?.waitMs ?? 45_000)),
      preferProxies: true,
      allowReplace: true,
    });
    stats.heals += 1;
    console.info(
      `[fastStart] heal ${id} ok=${res.ok} via=${res.via} play=${res.playId} ${Date.now() - started}ms`,
    );
    return {
      ok: res.ok,
      videoId: id,
      playId: res.playId,
      via: res.via,
      replacement: res.playId && res.playId !== id ? res.playId : null,
      detail: res.detail,
      ms: Date.now() - started,
    };
  } catch (err) {
    console.warn('[fastStart] heal KO', id, String((err as Error).message || err).slice(0, 160));
    return {
      ok: false,
      videoId: id,
      detail: String((err as Error).message || err).slice(0, 160),
      ms: Date.now() - started,
    };
  }
}

export function fastStartStats() {
  return {
    ...stats,
    resolveTracked: lastResolve.size,
    failuresTracked: failures.size,
    firstByteBudgetMs: FIRST_BYTE_BUDGET_MS,
    prewarmWindow: PREWARM_WINDOW,
    prewarmDisk: PREWARM_DISK,
    uptimeMs: Date.now() - stats.startedAt,
  };
}

export function recentPlaybackFailures(limit = 50) {
  return [...failures.entries()]
    .map(([id, v]) => ({ id, at: v.at, userId: v.userId, reason: v.reason, hits: v.hits }))
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(1, Math.min(500, limit)));
}
