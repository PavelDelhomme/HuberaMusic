/**
 * Auto-heal stream : quand un client signale stall / prefetch miss / erreur player
 * sur un trackId, on re-chauffe format + disk pour les prochaines lectures.
 * Throttle par id pour ne pas saturer le worker warm.
 */
import { enqueueStreamWarm, enqueueDiskWarm, bumpWarmPriority } from './stream.js';

const lastHealAt = new Map<string, number>();
const HEAL_COOLDOWN_MS = 8 * 60_000;

const HEAL_KINDS = new Set([
  'android.player.stall',
  'android.player',
  'android.player.prefetch_miss',
  'android.player.cold_next',
  'android.player.early_end',
]);

function extractTrackId(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Record<string, unknown>;
  for (const k of ['trackId', 'id', 'videoId', 'currentId']) {
    const v = String(m[k] ?? '').trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
  }
  return null;
}

export function healTrackFromTelemetry(opts: {
  kind: string;
  level?: string;
  meta?: unknown;
  userId?: string;
}): void {
  const kind = String(opts.kind || '');
  if (!HEAL_KINDS.has(kind) && !kind.startsWith('android.player')) return;
  // Ne pas re-warm sur chaque info debug
  if (kind === 'android.player' && opts.level === 'info') return;
  const id = extractTrackId(opts.meta);
  if (!id) return;
  const now = Date.now();
  const prev = lastHealAt.get(id) || 0;
  if (now - prev < HEAL_COOLDOWN_MS) {
    // Pendant cooldown : ne PAS ré-enqueue (saturait la file warm).
    // Remonte seulement si déjà en queue.
    bumpWarmPriority(id);
    return;
  }
  lastHealAt.set(id, now);
  if (lastHealAt.size > 2_000) {
    const cutoff = now - HEAL_COOLDOWN_MS * 2;
    for (const [k, t] of lastHealAt) {
      if (t < cutoff) lastHealAt.delete(k);
    }
  }
  console.log(`[stream-heal] re-warm ${id} kind=${kind}`);
  enqueueStreamWarm([id], opts.userId);
  enqueueDiskWarm([id]);
}
