import type { Track } from '../api';

const PREFIX = 'ytm_mix_v1_';
/** Aligné sur le TTL serveur (12 h). */
export const MIX_CLIENT_TTL_MS = 12 * 60 * 60 * 1000;
export const MIX_TARGET = 200;

type MixCacheEntry = {
  tracks: Track[];
  generatedAt: number;
  target?: number;
};

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function mixCacheKey(kind: 'cat' | 'track' | 'album' | 'artist', id: string) {
  return kind === 'cat' ? `cat:${id}` : `radio:${kind}:${id}`;
}

export function getCachedMix(key: string): Track[] | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MixCacheEntry;
    if (!Array.isArray(parsed?.tracks) || !parsed.tracks.length) return null;
    if (Date.now() - (parsed.generatedAt || 0) > MIX_CLIENT_TTL_MS) {
      s.removeItem(PREFIX + key);
      return null;
    }
    return parsed.tracks.slice(0, MIX_TARGET);
  } catch {
    return null;
  }
}

export function setCachedMix(key: string, tracks: Track[], meta?: { generatedAt?: number; target?: number }) {
  const s = storage();
  if (!s || !tracks.length) return;
  try {
    const entry: MixCacheEntry = {
      tracks: tracks.slice(0, MIX_TARGET),
      generatedAt: meta?.generatedAt || Date.now(),
      target: meta?.target || MIX_TARGET,
    };
    s.setItem(PREFIX + key, JSON.stringify(entry));
  } catch {
    /* quota — ignore */
  }
}

/** Invalide un mix mis en cache (like / dislike → nouvelles propositions). */
export function clearCachedMix(key: string) {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
}

/** Mix précalculé assez long → pas besoin d’autoplay incrémental. */
export function isPrecomputedMixSource(
  sourceKind: string | null | undefined,
  remainingUserTracks: number,
) {
  if (sourceKind !== 'mix' && sourceKind !== 'radio' && sourceKind !== 'album' && sourceKind !== 'artist') {
    return false;
  }
  return remainingUserTracks >= 20;
}
