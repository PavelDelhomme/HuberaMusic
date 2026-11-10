/**
 * Hub de santé de lecture — Hubera Music.
 *
 * Point d'entrée unique pour « un son plante chez un utilisateur ».
 *
 * Appelé par :
 *  - la télémétrie client (`streamHeal` → `healTrackFromTelemetry`),
 *  - le routeur de flux quand la résolution échoue (`stream.ts`),
 *  - le balayage bibliothèque (`playabilitySweep`),
 *  - les scripts QA / un endpoint admin.
 *
 * Il garantit que la réparation profite à **tous** les comptes :
 *  1. `healGlobally` retélécharge / remplace le videoId et met à jour le disque
 *     partagé + le mapping canonique (`track_id_replacements`), lu par tout le
 *     monde au prochain play.
 *  2. L'incident est consigné (Hubera Docs + mail) via `recordStreamIncident`.
 *  3. Un cache d'idempotence évite de relancer la même réparation en boucle.
 */
import { healGlobally, notePlaybackFailure, type HealOutcome } from './fastStart.js';
import { recordStreamIncident } from './streamIncident.js';
import { bumpWarmPriority, enqueueDiskWarm, enqueueStreamWarm } from './stream.js';

/** Une réparation par titre au plus toutes les 40 s (anti-tempête yt-dlp). */
const HEAL_COOLDOWN_MS = Math.max(10_000, Number(process.env.HEAL_COOLDOWN_MS || 40_000) || 40_000);
const inflightHeals = new Map<string, Promise<HealOutcome>>();
const lastHealAt = new Map<string, number>();
const stats = { requested: 0, healed: 0, failed: 0, replaced: 0, skipped: 0 };

function tooSoon(id: string): boolean {
  const last = lastHealAt.get(id);
  return Boolean(last && Date.now() - last < HEAL_COOLDOWN_MS);
}

/**
 * Répare un titre pour tout le monde. Idempotent et dédupliqué.
 *
 * @param reason  motif lisible (ex. '502 froid', 'android.player.stall')
 * @param opts.record  consigner l'incident Docs + mail (défaut true)
 */
export async function healTrackForEveryone(
  videoId: string,
  opts?: {
    userId?: string;
    title?: string;
    artist?: string;
    reason?: string;
    record?: boolean;
    waitMs?: number;
  },
): Promise<HealOutcome | null> {
  const id = String(videoId || '').trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) return null;
  stats.requested += 1;

  const pending = inflightHeals.get(id);
  if (pending) {
    stats.skipped += 1;
    return pending;
  }
  if (tooSoon(id)) {
    stats.skipped += 1;
    return null;
  }
  lastHealAt.set(id, Date.now());
  if (lastHealAt.size > 2_000) {
    const cutoff = Date.now() - HEAL_COOLDOWN_MS * 4;
    for (const [k, t] of lastHealAt) {
      if (t < cutoff) lastHealAt.delete(k);
    }
  }

  const reason = String(opts?.reason || 'lecture KO').slice(0, 200);
  notePlaybackFailure(id, { userId: opts?.userId, reason });

  const job = (async (): Promise<HealOutcome> => {
    try {
      const out = await healGlobally(id, {
        userId: opts?.userId,
        title: opts?.title,
        artist: opts?.artist,
        waitMs: opts?.waitMs,
      });

      if (out.ok) {
        stats.healed += 1;
        // Le disque/mapping est prêt : on remonte la priorité de chauffe.
        const target = out.playId || id;
        enqueueStreamWarm([target], opts?.userId);
        bumpWarmPriority(target);
        if (out.replacement) {
          stats.replaced += 1;
          enqueueDiskWarm([out.replacement]);
          console.info(`[stream-hub] remplacement global ${id} → ${out.replacement}`);
        } else {
          enqueueDiskWarm([target]);
        }
      } else {
        stats.failed += 1;
      }

      if (opts?.record !== false) {
        void recordStreamIncident({
          videoId: id,
          playId: out.playId,
          via: out.via,
          reason,
          userId: opts?.userId,
          title: opts?.title,
          artist: opts?.artist,
          healed: out.ok,
          replacement: out.replacement,
          ms: out.ms,
        }).catch(() => {});
      }
      return out;
    } finally {
      inflightHeals.delete(id);
    }
  })();

  inflightHeals.set(id, job);
  return job;
}

/** Réparation en lot (digest, balayage) — séquentielle avec petit délai. */
export function healManyForEveryone(
  items: Array<{ videoId: string; title?: string; artist?: string; reason?: string }>,
  opts?: { userId?: string; record?: boolean; delayMs?: number },
): void {
  const list = (items || [])
    .filter((i) => /^[a-zA-Z0-9_-]{11}$/.test(String(i?.videoId || '')))
    .slice(0, 60);
  const delay = Math.max(250, Math.min(5_000, opts?.delayMs ?? 1_200));
  list.forEach((item, i) => {
    setTimeout(() => {
      void healTrackForEveryone(item.videoId, {
        userId: opts?.userId,
        title: item.title,
        artist: item.artist,
        reason: item.reason || 'lot',
        record: opts?.record,
      }).catch(() => {});
    }, i * delay);
  });
}

export function streamHealthHubStats() {
  return {
    ...stats,
    inflight: inflightHeals.size,
    cooldownMs: HEAL_COOLDOWN_MS,
    tracked: lastHealAt.size,
  };
}
