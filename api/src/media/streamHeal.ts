/**
 * Auto-heal stream : stall / prefetch miss / load_skip → re-warm format + disk.
 * Sur load_skip / stall répété : cherche aussi un ID de remplacement (vidéo morte).
 */
import { enqueueStreamWarm, enqueueDiskWarm, bumpWarmPriority, enqueueListHeadWarm } from './stream.js';
import { findReplacementId } from './trackReplacement.js';
import { getTrackPayload } from '../library/db.js';

const lastHealAt = new Map<string, number>();
const HEAL_COOLDOWN_MS = 2 * 60_000;
/** Même en escalate : ne pas relancer ensure toutes les 2 s (yt-dlp se noie → timeout). */
const ESCALATE_COOLDOWN_MS = 25_000;
/** Ensure déjà en cours pour cet id — bump priorité, pas un 2e download. */
const inFlightEnsure = new Set<string>();
const lastEnsureAt = new Map<string, number>();
/** 2e stall/prefetch du même id dans 90 s → ensure disque (plus seulement le format). */
const stallHits = new Map<string, { n: number; at: number }>();
const ESCALATE_WINDOW_MS = 90_000;
/** Remplacement : plus fréquent sur load_skip (éviter skip sec). */
const lastReplaceAt = new Map<string, number>();
const REPLACE_COOLDOWN_MS = 3 * 60_000;

const HEAL_KINDS = new Set([
  'android.player.stall',
  'android.player.prefetch_miss',
  'android.player.early_end',
  'android.player.load_skip',
  'android.player.load_recover',
]);
/** Hint UI à 2,5 s : ne PAS lancer ensure/replace (noie yt-dlp pendant le resolve live). */
const FORMAT_ONLY_KINDS = new Set([
  'android.player.prefetch_miss',
  'android.player.load_recover',
  'android.player.stall',
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

function noteStallHit(id: string, now: number): number {
  const prev = stallHits.get(id);
  if (!prev || now - prev.at > ESCALATE_WINDOW_MS) {
    stallHits.set(id, { n: 1, at: now });
    return 1;
  }
  const n = prev.n + 1;
  stallHits.set(id, { n, at: now });
  if (stallHits.size > 2_000) {
    const cutoff = now - ESCALATE_WINDOW_MS * 2;
    for (const [k, t] of stallHits) {
      if (t.at < cutoff) stallHits.delete(k);
    }
  }
  return n;
}

export function healTrackFromTelemetry(opts: {
  kind: string;
  level?: string;
  meta?: unknown;
  userId?: string;
  message?: string;
  force?: boolean;
}): void {
  const kind = String(opts.kind || '');
  // Uniquement les kinds listés — plus de `android.player*` (cold_next à 2,5 s
  // lançait ensure+replace et saturait yt-dlp pendant le resolve live).
  if (!HEAL_KINDS.has(kind)) return;
  if (opts.level === 'info') return;
  const id = extractTrackId(opts.meta);
  if (!id) return;
  const now = Date.now();
  const hits = noteStallHit(id, now);
  // stall froid : jamais d’ensure .m4a (ça noie yt-dlp pendant le /url live).
  const escalate =
    kind === 'android.player.stall' || kind === 'android.player.prefetch_miss'
      ? hits >= 8
      : hits >= 2;
  if (inFlightEnsure.has(id)) {
    bumpWarmPriority(id);
    enqueueDiskWarm([id]);
    return;
  }
  const prev = lastHealAt.get(id) || 0;
  // 1er stall : format only. 2e dans 90 s (ou load_skip) : ensure le .m4a.
  const formatOnly = FORMAT_ONLY_KINDS.has(kind) && !escalate && !opts.force;
  if (formatOnly) {
    if (now - prev < HEAL_COOLDOWN_MS) {
      bumpWarmPriority(id);
      return;
    }
    lastHealAt.set(id, now);
    console.log(`[stream-heal] re-warm ${id} kind=${kind} hits=${hits} escalate=false`);
    enqueueStreamWarm([id], opts.userId);
    bumpWarmPriority(id);
    return;
  }
  const prevEnsure = lastEnsureAt.get(id) || 0;
  if (!opts.force && now - prevEnsure < ESCALATE_COOLDOWN_MS) {
    bumpWarmPriority(id);
    enqueueDiskWarm([id]);
    return;
  }
  lastHealAt.set(id, now);
  lastEnsureAt.set(id, now);
  if (lastHealAt.size > 2_000) {
    const cutoff = now - HEAL_COOLDOWN_MS * 2;
    for (const [k, t] of lastHealAt) {
      if (t < cutoff) lastHealAt.delete(k);
    }
    for (const [k, t] of lastEnsureAt) {
      if (t < cutoff) lastEnsureAt.delete(k);
    }
  }
  console.log(`[stream-heal] re-warm ${id} kind=${kind} hits=${hits} escalate=${escalate}`);
  enqueueStreamWarm([id], opts.userId);
  enqueueDiskWarm([id]);
  enqueueListHeadWarm([id], { front: true });

  // Remplacement seulement après un skip confirmé (titre vraiment mort).
  const wantReplace =
    kind === 'android.player.load_skip' ||
    kind === 'android.player.early_end' ||
    /unavailable|VIDEO_UNAVAILABLE|private|removed/i.test(String(opts.message || ''));

  // Pré-télécharge le .m4a intégral (OAuth remux / proxies) avant la prochaine écoute.
  // Remplacement APRÈS ensure — sinon playable() × 6 saturaient getAudioFormat (stall Blue).
  inFlightEnsure.add(id);
  void import('./ensurePlayable.js')
    .then(({ ensurePlayableOnDisk }) =>
      ensurePlayableOnDisk(id, {
        userId: opts.userId,
        waitMs: 70_000,
        preferProxies: true,
        allowReplace: wantReplace,
        title: extractMetaString(opts.meta, 'title'),
        artist: extractMetaString(opts.meta, 'artist'),
      }),
    )
    .then((r) => {
      inFlightEnsure.delete(id);
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
    .catch(() => {
      inFlightEnsure.delete(id);
    });
}

/** Bilan digest → re-warm / ensure / remplacement des titres qui ont échoué. */
export function healTracksFromDigest(
  tracks: Array<{ trackId: string; title?: string; artist?: string; loadSkips?: number }>,
): void {
  const list = (tracks || [])
    .filter((t) => /^[a-zA-Z0-9_-]{11}$/.test(String(t.trackId || '')))
    .slice(0, 64);
  if (!list.length) return;
  console.log(`[stream-heal] digest → ${list.length} titre(s) à réparer`);
  list.forEach((t, i) => {
    setTimeout(() => {
      healTrackFromTelemetry({
        kind: 'android.player.load_skip',
        level: 'warn',
        message: 'digest-daily',
        force: true,
        meta: { trackId: t.trackId, title: t.title, artist: t.artist },
      });
    }, i * 1500);
  });
}
