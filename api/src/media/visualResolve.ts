/**
 * Résout un ID vidéo « visuel » pour le mode multimédia :
 * même trackId si un progressif vidéo existe, sinon recherche clip titre+artiste.
 */
import { getTrack, getVideoFormat, search } from '../youtube/yt.js';
import type { Track } from '../youtube/mappers.js';

export type VisualResolve = {
  audioId: string;
  visualId: string | null;
  source: 'same' | 'search' | 'none';
  title?: string;
  artist?: string;
};

const cache = new Map<string, { at: number; value: VisualResolve }>();
const TTL_MS = 60 * 60 * 1000;
const PROBE_MS = 8_000;

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

async function probeVideo(id: string): Promise<boolean> {
  try {
    await Promise.race([
      getVideoFormat(id),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), PROBE_MS)),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function resolveVisualVideo(
  audioId: string,
  hints?: { title?: string; artist?: string; durationSeconds?: number | null },
): Promise<VisualResolve> {
  const id = String(audioId || '').trim();
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) {
    return { audioId: id, visualId: null, source: 'none' };
  }

  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let title = (hints?.title || '').trim();
  let artist = (hints?.artist || '').trim();
  let durationSec = hints?.durationSeconds ?? null;

  if (!title) {
    try {
      const { track } = await getTrack(id);
      title = track.title || '';
      artist = artistLine(track);
      durationSec = track.durationSeconds ?? null;
    } catch {
      /* oembed/search only */
    }
  }

  if (await probeVideo(id)) {
    const value: VisualResolve = {
      audioId: id,
      visualId: id,
      source: 'same',
      title: title || undefined,
      artist: artist || undefined,
    };
    cache.set(id, { at: Date.now(), value });
    return value;
  }

  const q = [title, artist].filter(Boolean).join(' ').trim();
  if (!q) {
    const value: VisualResolve = { audioId: id, visualId: null, source: 'none' };
    cache.set(id, { at: Date.now(), value });
    return value;
  }

  try {
    const buckets = await search(q, 'video');
    const pool = [...(buckets.videos || []), ...(buckets.songs || [])].filter(
      (t) => t?.id && t.id !== id && /^[a-zA-Z0-9_-]{11}$/.test(t.id),
    );
    const ranked = pool
      .map((t) => ({ t, s: scoreCandidate(t, title, artist, durationSec) }))
      .filter((x) => x.s >= 40)
      .sort((a, b) => b.s - a.s)
      .slice(0, 5);

    for (const { t } of ranked) {
      if (await probeVideo(t.id)) {
        const value: VisualResolve = {
          audioId: id,
          visualId: t.id,
          source: 'search',
          title: t.title || title || undefined,
          artist: artistLine(t) || artist || undefined,
        };
        cache.set(id, { at: Date.now(), value });
        return value;
      }
    }
  } catch (err) {
    console.warn('[visual-resolve] search failed', id, err);
  }

  const value: VisualResolve = {
    audioId: id,
    visualId: null,
    source: 'none',
    title: title || undefined,
    artist: artist || undefined,
  };
  cache.set(id, { at: Date.now(), value });
  return value;
}
