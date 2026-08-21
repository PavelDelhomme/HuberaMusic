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

export function setLyricUserOffsetMs(trackId: string, offsetMs: number) {
  const map = readMap();
  const clamped = Math.max(-15_000, Math.min(15_000, Math.round(offsetMs)));
  if (clamped === 0) delete map[trackId];
  else map[trackId] = clamped;
  writeMap(map);
}

export function nudgeLyricUserOffsetMs(trackId: string, deltaMs: number): number {
  const next = getLyricUserOffsetMs(trackId) + deltaMs;
  setLyricUserOffsetMs(trackId, next);
  return getLyricUserOffsetMs(trackId);
}
