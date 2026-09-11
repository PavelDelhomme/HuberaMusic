/** Sync paroles : lead karaoké + offset appris (perso + crowd + segments rythme). */

/**
 * Avance karaoké par défaut (~0,10 s perçue pour lire / chanter dessus).
 * 180 ms bruts : absorbe latence UI / horloge lecteur (~50–80 ms) sans toucher la sync manuelle.
 */
export const LYRIC_LEAD_SEC = 0.18;

/**
 * Plus de lag client LRCLIB : l’API étire / décale déjà les timed (v6).
 * Un lag fixe mid-track empirait la dérive de rythme.
 */
export const LRCLIB_BASE_LAG_SEC = 0;

const STORAGE_KEY = 'plm_lyric_sync_v1';
const SEGMENTS_KEY = 'plm_lyric_segments_v1';

type SyncMap = Record<string, number>;
export type LyricSegmentLocal = {
  bucket: number;
  startRatio: number;
  endRatio: number;
  offsetMs: number;
};
type SegmentMap = Record<string, LyricSegmentLocal[]>;

function readMap(): SyncMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SyncMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeMap(map: SyncMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota / private */
  }
}

function readSegments(): SegmentMap {
  try {
    const raw = localStorage.getItem(SEGMENTS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SegmentMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeSegments(map: SegmentMap) {
  try {
    localStorage.setItem(SEGMENTS_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** Offset ms constant (legacy) : positif = retarde l’highlight. */
export function getLyricUserOffsetMs(trackId: string | undefined | null): number {
  if (!trackId) return 0;
  const v = readMap()[trackId];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function getLyricSegments(trackId: string | undefined | null): LyricSegmentLocal[] {
  if (!trackId) return [];
  const segs = readSegments()[trackId];
  return Array.isArray(segs) ? segs : [];
}

export function setLyricSegments(trackId: string, segments: LyricSegmentLocal[]) {
  const map = readSegments();
  if (!segments.length) delete map[trackId];
  else map[trackId] = segments;
  writeSegments(map);
}

/**
 * Offset effectif à l’instant audio (secondes) — interpolé si segments.
 * Sinon offset constant perso / crowd.
 */
export function lyricOffsetSecAt(
  trackId: string | undefined | null,
  audioSec: number,
  durationSec?: number | null,
): number {
  const segs = getLyricSegments(trackId);
  const base = getLyricUserOffsetMs(trackId);
  if (segs.length >= 2 && durationSec && durationSec > 5) {
    const r = Math.max(0, Math.min(1, audioSec / durationSec));
    const pts = segs
      .map((s) => ({ r: (s.startRatio + s.endRatio) / 2, o: s.offsetMs / 1000 }))
      .sort((a, b) => a.r - b.r);
    if (r <= pts[0]!.r) return pts[0]!.o;
    if (r >= pts[pts.length - 1]!.r) return pts[pts.length - 1]!.o;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      if (r >= a.r && r <= b.r) {
        const t = (r - a.r) / Math.max(1e-6, b.r - a.r);
        return a.o + (b.o - a.o) * t;
      }
    }
  }
  return base / 1000;
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPush: {
  trackId: string;
  offsetMs: number;
  atMs?: number;
  durationMs?: number;
  source?: string;
} | null = null;

function schedulePush(job: NonNullable<typeof pendingPush>) {
  pendingPush = job;
  if (pushTimer != null) window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    const j = pendingPush;
    pendingPush = null;
    pushTimer = null;
    if (!j) return;
    void import('../../api')
      .then((m) =>
        m.api.saveLyricOffset(j.trackId, j.offsetMs, {
          atMs: j.atMs,
          durationMs: j.durationMs,
          source: j.source,
        }),
      )
      .then((r) => {
        if (r?.segments?.length) {
          setLyricSegments(
            j.trackId,
            r.segments.map((s) => ({
              bucket: s.bucket,
              startRatio: s.startRatio,
              endRatio: s.endRatio,
              offsetMs: s.offsetMs,
            })),
          );
        }
      })
      .catch(() => undefined);
  }, 450);
}

export function setLyricUserOffsetMs(
  trackId: string,
  offsetMs: number,
  opts?: { atMs?: number; durationMs?: number; source?: string },
) {
  const map = readMap();
  const clamped = Math.max(-15_000, Math.min(15_000, Math.round(offsetMs)));
  if (clamped === 0) delete map[trackId];
  else map[trackId] = clamped;
  writeMap(map);
  schedulePush({
    trackId,
    offsetMs: clamped,
    atMs: opts?.atMs,
    durationMs: opts?.durationMs,
    source: opts?.source || 'nudge',
  });
}

/** Fusionne les offsets appris sur le compte (serveur = source si local à 0). */
export function mergeLyricOffsetsFromServer(offsets: Record<string, number> | null | undefined) {
  if (!offsets || typeof offsets !== 'object') return;
  const map = readMap();
  let changed = false;
  for (const [id, raw] of Object.entries(offsets)) {
    const v = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : 0;
    if (!id || v === 0) continue;
    if (map[id] == null || map[id] === 0) {
      map[id] = Math.max(-15_000, Math.min(15_000, v));
      changed = true;
    }
  }
  if (changed) writeMap(map);
}

export function applyServerOffsetIfUnset(trackId: string, offsetMs: number | null | undefined): number {
  const local = getLyricUserOffsetMs(trackId);
  if (local !== 0) return local;
  const v = typeof offsetMs === 'number' && Number.isFinite(offsetMs) ? Math.round(offsetMs) : 0;
  if (v === 0) return 0;
  const map = readMap();
  map[trackId] = Math.max(-15_000, Math.min(15_000, v));
  writeMap(map);
  return map[trackId];
}

export function applyServerSegments(
  trackId: string,
  segments:
    | { bucket: number; startRatio: number; endRatio: number; offsetMs: number }[]
    | null
    | undefined,
) {
  if (!trackId || !segments?.length) return;
  // Ne pas écraser des segments perso déjà plus riches
  const existing = getLyricSegments(trackId);
  if (existing.length >= segments.length) return;
  setLyricSegments(
    trackId,
    segments.map((s) => ({
      bucket: s.bucket,
      startRatio: s.startRatio,
      endRatio: s.endRatio,
      offsetMs: Math.max(-15_000, Math.min(15_000, Math.round(s.offsetMs))),
    })),
  );
}

/** Lignes chantées seulement — ignore [Verse], (x2), Intro… */
export function sungLines(raw: string): string[] {
  return raw.split(/\r?\n/).map((l) => l.replace(/\u00a0/g, ' ').trim()).filter((s) => {
    if (!s) return false;
    if (/^\[.+]$/.test(s)) return false;
    if (/^\(.+\)$/.test(s) && s.length < 28) return false;
    if (
      /^(intro|outro|instrumental|bridge|chorus|refrain|couplet|verse|hook|solo)\b/i.test(s) &&
      s.length < 28
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Sans LRC officiel : répartit les lignes sur la durée pour que le suivi
 * avance comme sur un titre cadencé (Welcome to the Internet).
 */
export function estimateTimedFromPlain(
  raw: string | null | undefined,
  durationSec?: number | null,
): { t: number; text: string }[] {
  if (!raw?.trim()) return [];
  const lines = sungLines(raw);
  if (lines.length < 2) return [];
  const dur = durationSec && durationSec >= 20 ? durationSec : Math.max(lines.length * 3.2, 60);
  const intro = Math.min(Math.max(dur * 0.035, 2.2), 10);
  const outro = Math.min(Math.max(dur * 0.06, 4), 14);
  const window = Math.max(dur - intro - outro, lines.length * 1.2);
  const weights = lines.map((l) => Math.max(8, l.length));
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  return lines.map((text, i) => {
    const t = intro + (acc / total) * window;
    acc += weights[i]!;
    return { t, text };
  });
}

export function nudgeLyricUserOffsetMs(
  trackId: string,
  deltaMs: number,
  opts?: { atMs?: number; durationMs?: number },
): number {
  const next = getLyricUserOffsetMs(trackId) + deltaMs;
  setLyricUserOffsetMs(trackId, next, { ...opts, source: 'nudge' });
  return getLyricUserOffsetMs(trackId);
}
