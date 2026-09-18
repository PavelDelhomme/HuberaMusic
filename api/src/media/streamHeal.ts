/**
 * Auto-heal stream : stall / prefetch miss / load_skip → re-warm format + disk.
 * Sur load_skip / stall répété : cherche aussi un ID de remplacement (vidéo morte).
 */
import { enqueueStreamWarm, enqueueDiskWarm, bumpWarmPriority } from './stream.js';
import { findReplacementId } from './trackReplacement.js';
import { getTrackPayload } from '../library/db.js';

const lastHealAt = new Map<string, number>();
const HEAL_COOLDOWN_MS = 2 * 60_000;
/** Remplacement : plus fréquent sur load_skip (éviter skip sec). */
const lastReplaceAt = new Map<string, number>();
const REPLACE_COOLDOWN_MS = 3 * 60_000;

const HEAL_KINDS = new Set([
  'android.player.stall',
  'android.player',
  'android.player.prefetch_miss',
  'android.player.cold_next',
  'android.player.early_end',
  'android.player.load_skip',
  'android.player.load_recover',
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

function extractMetaString(meta: unknown, key: string): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const v = (meta as Record<string, unknown>)[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function healTrackFromTelemetry(opts: {
  kind: string;
  level?: string;
  meta?: unknown;
  userId?: string;
  message?: string;
}): void {
  const kind = String(opts.kind || '');
  if (!HEAL_KINDS.has(kind) && !kind.startsWith('android.player')) return;
  if (kind === 'android.player' && opts.level === 'info') return;
  const id = extractTrackId(opts.meta);
  if (!id) return;
  const now = Date.now();
  const prev = lastHealAt.get(id) || 0;
  if (now - prev < HEAL_COOLDOWN_MS) {
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

  // load_skip / stall (warn ou error) → tenter remplacement si la vidéo est morte
  // ou si le CDN refuse en boucle (évite spinner / toast côté client).
  const wantReplace =
    kind === 'android.player.load_skip' ||
    kind === 'android.player.stall' ||
    kind === 'android.player.load_recover' ||
    /unavailable|not available|private|removed|non 2xx|502|403/i.test(String(opts.message || ''));

  // Pré-télécharge le .m4a intégral (OAuth remux / proxies) avant la prochaine écoute.
  // Remplacement APRÈS ensure — sinon playable() × 6 saturaient getAudioFormat (stall Blue).
  void import('./ensurePlayable.js')
    .then(({ ensurePlayableOnDisk }) =>
      ensurePlayableOnDisk(id, {
        userId: opts.userId,
        waitMs: 45_000,
        preferProxies: true,
        allowReplace: wantReplace,
        title: extractMetaString(opts.meta, 'title'),
        artist: extractMetaString(opts.meta, 'artist'),
      }),
    )
    .then((r) => {
      if (r?.ok) {
        console.log(`[stream-heal] ensure OK ${id} → ${r.playId} via=${r.via} bytes=${r.bytes}`);
        return;
      }
      if (r) console.warn(`[stream-heal] ensure KO ${id}: ${r.detail || r.via}`);
      if (!wantReplace) return;
      const lastR = lastReplaceAt.get(id) || 0;
      if (Date.now() - lastR < REPLACE_COOLDOWN_MS) return;
      lastReplaceAt.set(id, Date.now());
      void (async () => {
        try {
          const payload = getTrackPayload(id) as {
            title?: string;
            artists?: Array<{ name?: string }>;
          } | null;
          const title = extractMetaString(opts.meta, 'title') || payload?.title;
          const artist =
            extractMetaString(opts.meta, 'artist') ||
            payload?.artists?.map((a) => a?.name).filter(Boolean).join(', ');
          const replacement = await findReplacementId(id, {
            userId: opts.userId,
            title,
            artist,
          });
          if (replacement && replacement !== id) {
            console.log(`[stream-heal] remplacement ${id} → ${replacement}`);
            enqueueStreamWarm([replacement], opts.userId);
            enqueueDiskWarm([replacement]);
          }
        } catch (err) {
          console.warn(
            `[stream-heal] replace KO ${id}:`,
            String((err as Error).message || err).slice(0, 120),
          );
        }
      })();
    })
    .catch(() => {});
}
