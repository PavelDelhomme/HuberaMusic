/**
 * Résout un ID vidéo « visuel » pour le mode multimédia.
 * RAPIDE : pas de probe getVideoFormat (bloquait 10–60 s) — le stream ?type=video
 * résout le format à la lecture. Index SQLite + RAM pour skip search.
 */
import { getTrack, search } from '../youtube/yt.js';
import type { Track } from '../youtube/types.js';
import { getVisualCache, putVisualCache, deleteVisualCache } from './visualCache.js';

export type VisualResolve = {
  audioId: string;
  visualId: string | null;
  source: 'same' | 'search' | 'none';
  title?: string;
  artist?: string;
};

const cache = new Map<string, { at: number; value: VisualResolve }>();
const TTL_MS = 6 * 60 * 60 * 1000; // RAM 6 h
const searchInflight = new Map<string, Promise<VisualResolve>>();

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(official|video|lyrics|audio|mv|clip|hd|4k|remaster(ed)?)\b/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function artistLine(t: Track): string {
  return (t.artists || [])
    .map((a) => a.name)
    .filter(Boolean)
    .join(', ');
}

function scoreCandidate(
  cand: Track,
  title: string,
  artist: string,
  durationSec?: number | null,
): number {
  const nt = normalize(title);
  const na = normalize(artist);
  const ct = normalize(cand.title || '');
  const ca = normalize(artistLine(cand));
  let score = 0;
  if (ct === nt) score += 50;
  else if (ct.includes(nt) || nt.includes(ct)) score += 28;
  else {
    const tw = new Set(nt.split(' ').filter((w) => w.length > 2));
    const cw = ct.split(' ').filter((w) => w.length > 2);
    const hit = cw.filter((w) => tw.has(w)).length;
    score += Math.min(24, hit * 6);
  }
  if (na && ca) {
    if (ca === na) score += 40;
    else if (ca.includes(na) || na.includes(ca)) score += 22;
  }
  const blob = `${cand.title} ${artistLine(cand)}`.toLowerCase();
  if (/\b(official|officiel|mv|music video|clip)\b/.test(blob)) score += 12;
  if (/\b(lyric|paroles|audio only|visualizer)\b/.test(blob)) score -= 8;
  if (durationSec && cand.durationSeconds && cand.durationSeconds > 0) {
    const delta = Math.abs(cand.durationSeconds - durationSec) / durationSec;
    if (delta <= 0.08) score += 18;
    else if (delta <= 0.2) score += 8;
    else if (delta > 0.45) score -= 20;
  }
  return score;
}

function remember(value: VisualResolve) {
  cache.set(value.audioId, { at: Date.now(), value });
  putVisualCache({
    audioId: value.audioId,
    visualId: value.visualId,
    source: value.source,
    title: value.title,
    artist: value.artist,
  });
}

function sameResolve(
  id: string,
  title?: string,
  artist?: string,
): VisualResolve {
  return {
    audioId: id,
    visualId: id,
    source: 'same',
    title: title || undefined,
    artist: artist || undefined,
  };
}

/** Recherche clip en fond — n’bloque pas la 1ʳᵉ réponse. */
async function searchBetterClip(
  id: string,
  title: string,
  artist: string,
  durationSec: number | null,
): Promise<VisualResolve> {
  const existing = searchInflight.get(id);
  if (existing) return existing;
  const job = (async (): Promise<VisualResolve> => {
    const fallback = sameResolve(id, title, artist);
    const q = [title, artist].filter(Boolean).join(' ').trim();
    if (!q) {
      remember(fallback);
      return fallback;
    }
    try {
      const buckets = await search(q, 'video');
      const pool = [...(buckets.videos || []), ...(buckets.songs || [])].filter(
        (t) => t?.id && /^[a-zA-Z0-9_-]{11}$/.test(t.id),
      );
      const ranked = pool
        .map((t) => ({ t, s: scoreCandidate(t, title, artist, durationSec) }))
        .filter((x) => x.s >= 45)
        .sort((a, b) => b.s - a.s);
      const best = ranked[0]?.t;
      // Préférer un autre ID seulement s’il score clairement mieux qu’un simple match
      if (best && best.id !== id && (ranked[0]?.s ?? 0) >= 70) {
        const value: VisualResolve = {
          audioId: id,
          visualId: best.id,
          source: 'search',
          title: best.title || title || undefined,
          artist: artistLine(best) || artist || undefined,
        };
        remember(value);
        return value;
      }
    } catch (err) {
      console.warn('[visual-resolve] search failed', id, err);
    }
    remember(fallback);
    return fallback;
  })().finally(() => {
    searchInflight.delete(id);
  });
  searchInflight.set(id, job);
  return job;
}

/**
 * Résolution synchrone rapide : cache → sinon même ID immédiat.
 * Option `upgrade=1` : lance une recherche clip en arrière-plan (ne bloque pas).
 */
export async function resolveVisualVideo(
  audioId: string,
  hints?: {
    title?: string;
    artist?: string;
    durationSeconds?: number | null;
    /** Si true, lance search en fond pour améliorer le cache (réponse toujours rapide). */
    upgrade?: boolean;
  },
): Promise<VisualResolve> {
  const id = String(audioId || '').trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) {
    return { audioId: id, visualId: null, source: 'none' };
  }

  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const persisted = getVisualCache(id);
  if (persisted?.visual_id) {
    const value: VisualResolve = {
      audioId: id,
      visualId: persisted.visual_id,
      source: (persisted.source as VisualResolve['source']) || 'same',
      title: persisted.title || hints?.title || undefined,
      artist: persisted.artist || hints?.artist || undefined,
    };
    cache.set(id, { at: Date.now(), value });
    return value;
  }

  let title = (hints?.title || '').trim();
  let artist = (hints?.artist || '').trim();
  let durationSec = hints?.durationSeconds ?? null;

  if (!title) {
    try {
      const { track } = await Promise.race([
        getTrack(id),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('meta timeout')), 2500)),
      ]);
      title = track.title || '';
      artist = artistLine(track);
      durationSec = track.durationSeconds ?? null;
    } catch {
      /* keep empty */
    }
  }

  // Réponse immédiate : même ID (le player streamera ?type=video)
  const fast = sameResolve(id, title, artist);
  remember(fast);

  if (hints?.upgrade !== false && title) {
    void searchBetterClip(id, title, artist, durationSec).catch(() => {});
  }

  return fast;
}

/** Force refresh cache (après erreur de lecture côté client). */
export function invalidateVisualCache(audioId: string) {
  const id = String(audioId || '').trim();
  if (!id) return;
  cache.delete(id);
  deleteVisualCache(id);
}
