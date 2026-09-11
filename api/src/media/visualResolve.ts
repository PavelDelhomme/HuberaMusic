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
  const blob = `${cand.title} ${artistLine(cand)}`.toLowerCase();
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
  // Clip officiel artiste / VEVO en priorité forte
  if (/\b(official\s*music\s*video|official\s*video|clip\s*officiel|video\s*officielle)\b/.test(blob)) {
    score += 42;
  } else if (/\bvevo\b/.test(blob)) {
    score += 36;
  } else if (/\b(official|officiel|mv|music video|clip)\b/.test(blob)) {
    score += 22;
  }
  // Artiste dans le titre du clip ou chaîne proche
  if (na && (ct.includes(na) || blob.includes(na))) score += 10;
  // Pénalités contenus non officiels / dérivés
  if (/\b(cover|karaoke|karaoke|instrumental|sped up|slowed|nightcore|8d|remix|mashup|reaction|fan.?made|lyric|paroles|audio only|visualizer|audio)\b/.test(blob)) {
    score -= 28;
  }
  if (/\b(live|concert|session|performance)\b/.test(blob) && !/\bofficial\b/.test(blob)) {
    score -= 16;
  }
  if (/\b(topic)\b/.test(blob)) score -= 18; // chaînes « Topic » = souvent audio seul
  if (durationSec && cand.durationSeconds && cand.durationSeconds > 0) {
    const delta = Math.abs(cand.durationSeconds - durationSec) / durationSec;
    if (delta <= 0.08) score += 18;
    else if (delta <= 0.2) score += 8;
    else if (delta > 0.45) score -= 20;
  }
  return score;
}

/** Titres clairement non officiels → on force une nouvelle search (cache obsolète). */
function looksNonOfficialBlob(title?: string | null, artist?: string | null): boolean {
  const blob = `${title || ''} ${artist || ''}`.toLowerCase();
  return /\b(cover|karaoke|instrumental|sped up|slowed|nightcore|8d|remix|mashup|reaction|fan.?made|lyric video|paroles|audio only|visualizer)\b/.test(
    blob,
  );
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
    const qOfficial = [title, artist, 'official music video'].filter(Boolean).join(' ').trim();
    if (!q && !qOfficial) {
      remember(fallback);
      return fallback;
    }
    try {
      // D’abord la query « official music video », puis la query simple
      const bucketsOfficial = qOfficial
        ? await search(qOfficial, 'video').catch(() => null)
        : null;
      const buckets =
        q && q !== qOfficial ? await search(q, 'video').catch(() => null) : bucketsOfficial;
      const pool = [
        ...((bucketsOfficial?.videos || []) as Track[]),
        ...((bucketsOfficial?.songs || []) as Track[]),
        ...(buckets?.videos || []),
        ...(buckets?.songs || []),
      ].filter((t) => t?.id && /^[a-zA-Z0-9_-]{11}$/.test(t.id));
      // dédoublonne par id (ordre = priorité official d’abord)
      const seen = new Set<string>();
      const uniq = pool.filter((t) => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      });
      const ranked = uniq
        .map((t) => ({ t, s: scoreCandidate(t, title, artist, durationSec) }))
        .filter((x) => x.s >= 48)
        .sort((a, b) => b.s - a.s);
      const best = ranked[0]?.t;
      const bestScore = ranked[0]?.s ?? 0;
      const bestBlob = `${best?.title || ''} ${artistLine(best || ({} as Track))}`.toLowerCase();
      const looksOfficial =
        /\b(official\s*music\s*video|official\s*video|vevo|clip\s*officiel)\b/.test(bestBlob);
      // Accepter plus tôt si clairement officiel ; sinon seuil plus haut
      const threshold = looksOfficial ? 55 : 68;
      if (best && best.id !== id && bestScore >= threshold) {
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
 * Résolution clip visuel.
 * - Par défaut : cache / même ID immédiat (+ search en fond).
 * - `waitMs` > 0 : attend jusqu’à N ms la recherche d’un vrai clip officiel
 *   (évite de streamer un ID « Topic » audio-only → Exo qui mouline).
 */
export async function resolveVisualVideo(
  audioId: string,
  hints?: {
    title?: string;
    artist?: string;
    durationSeconds?: number | null;
    /** Si true, lance search (fond ou attendu selon waitMs). */
    upgrade?: boolean;
    /** Attendre la search jusqu’à N ms avant de répondre. */
    waitMs?: number;
  },
): Promise<VisualResolve> {
  const id = String(audioId || '').trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) {
    return { audioId: id, visualId: null, source: 'none' };
  }

  const waitMs = Math.max(0, Math.min(12_000, Number(hints?.waitMs || 0) || 0));

  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) {
    if (looksNonOfficialBlob(hit.value.title, hit.value.artist)) {
      cache.delete(id);
      deleteVisualCache(id);
    } else {
      // Cache « same » + client qui attend : retente une search (clip officiel).
      if (waitMs > 0 && hit.value.source === 'same' && hints?.upgrade !== false) {
        const title = (hints?.title || hit.value.title || '').trim();
        const artist = (hints?.artist || hit.value.artist || '').trim();
        if (title) {
          try {
            const better = await Promise.race([
              searchBetterClip(id, title, artist, hints?.durationSeconds ?? null),
              new Promise<VisualResolve>((resolve) =>
                setTimeout(() => resolve(hit.value), waitMs),
              ),
            ]);
            if (better.visualId && better.visualId !== id) return better;
          } catch {
            /* keep hit */
          }
        }
      }
      return hit.value;
    }
  }

  const persisted = getVisualCache(id);
  if (persisted?.visual_id) {
    // Anciens caches « cover / lyrics / … » : invalider pour retomber sur un clip officiel
    if (looksNonOfficialBlob(persisted.title, persisted.artist)) {
      deleteVisualCache(id);
      cache.delete(id);
    } else {
      const value: VisualResolve = {
        audioId: id,
        visualId: persisted.visual_id,
        source: (persisted.source as VisualResolve['source']) || 'same',
        title: persisted.title || hints?.title || undefined,
        artist: persisted.artist || hints?.artist || undefined,
      };
      cache.set(id, { at: Date.now(), value });
      if (waitMs > 0 && value.source === 'same' && hints?.upgrade !== false) {
        const title = (hints?.title || value.title || '').trim();
        const artist = (hints?.artist || value.artist || '').trim();
        if (title) {
          try {
            const better = await Promise.race([
              searchBetterClip(id, title, artist, hints?.durationSeconds ?? null),
              new Promise<VisualResolve>((resolve) =>
                setTimeout(() => resolve(value), waitMs),
              ),
            ]);
            if (better.visualId && better.visualId !== id) return better;
          } catch {
            /* keep persisted */
          }
        }
      }
      return value;
    }
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

  const fast = sameResolve(id, title, artist);

  if (hints?.upgrade !== false && title) {
    if (waitMs > 0) {
      try {
        const better = await Promise.race([
          searchBetterClip(id, title, artist, durationSec),
          new Promise<VisualResolve>((resolve) => setTimeout(() => resolve(fast), waitMs)),
        ]);
        if (better.visualId) {
          remember(better);
          return better;
        }
      } catch {
        /* fall through */
      }
      remember(fast);
      return fast;
    }
    remember(fast);
    void searchBetterClip(id, title, artist, durationSec).catch(() => {});
    return fast;
  }

  remember(fast);
  return fast;
}

/** Force refresh cache (après erreur de lecture côté client). */
export function invalidateVisualCache(audioId: string) {
  const id = String(audioId || '').trim();
  if (!id) return;
  cache.delete(id);
  deleteVisualCache(id);
}
