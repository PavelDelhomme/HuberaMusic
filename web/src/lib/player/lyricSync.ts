/** Sync paroles : lead karaoké + offset utilisateur persisté (par titre). */

/** Quasi collé au son — le recalage utilisateur (appui long) affine si besoin. */
export const LYRIC_LEAD_SEC = 0.12;

/**
 * Plus de lag client LRCLIB : l’API étire / décale déjà les timed (v6).
 * Un lag fixe mid-track empirait la dérive de rythme.
 */
export const LRCLIB_BASE_LAG_SEC = 0;

const STORAGE_KEY = 'plm_lyric_sync_v1';

type SyncMap = Record<string, number>;

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

/** Offset ms : positif = retarde l’highlight (corrige paroles trop en avance). */
export function getLyricUserOffsetMs(trackId: string | undefined | null): number {
  if (!trackId) return 0;
  const v = readMap()[trackId];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPush: { trackId: string; offsetMs: number } | null = null;

function schedulePush(trackId: string, offsetMs: number) {
  pendingPush = { trackId, offsetMs };
  if (pushTimer != null) window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    const job = pendingPush;
    pendingPush = null;
    pushTimer = null;
    if (!job) return;
    void import('../../api')
      .then((m) => m.api.saveLyricOffset(job.trackId, job.offsetMs))
      .catch(() => undefined);
  }, 450);
}

export function setLyricUserOffsetMs(trackId: string, offsetMs: number) {
  const map = readMap();
  const clamped = Math.max(-15_000, Math.min(15_000, Math.round(offsetMs)));
  if (clamped === 0) delete map[trackId];
  else map[trackId] = clamped;
  writeMap(map);
  schedulePush(trackId, clamped);
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
  const intro = Math.min(Math.max(dur * 0.08, 6), 18);
  const outro = Math.min(Math.max(dur * 0.07, 5), 16);
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

export function nudgeLyricUserOffsetMs(trackId: string, deltaMs: number): number {
  const next = getLyricUserOffsetMs(trackId) + deltaMs;
  setLyricUserOffsetMs(trackId, next);
  return getLyricUserOffsetMs(trackId);
}
