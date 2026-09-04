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
