/**
 * Catalogue streaming (Spotify / Deezer / iTunes) → métadonnées canoniques
 * puis paroles (LRCLIB, lyrics.ovh, color-lyrics si cookie Spotify).
 * Ne prend jamais un autre « ADHD » (James Arthur, A-min, etc.).
 */
import { looksLikeLyrics } from './lyricsTiming.js';
import { artistMatchScore, titleMatchScore } from './lyricsGenius.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export type CatalogHit = {
  title: string;
  artist: string;
  album?: string;
  durationSec?: number;
  isrc?: string;
  spotifyId?: string;
  appleId?: string;
  deezerId?: string;
  url?: string;
  source: 'spotify' | 'deezer' | 'itunes';
};

function fold(s: string) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\badah\b/g, 'adhd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function scoreHit(wantA: string, wantT: string, gotA: string, gotT: string) {
  return titleMatchScore(fold(wantT), fold(gotT)) + artistMatchScore(fold(wantA), fold(gotA));
}

function accept(wantA: string, wantT: string, gotA: string, gotT: string) {
  const s = scoreHit(wantA, wantT, gotA, gotT);
  const toks = fold(wantT).split(' ').filter((x) => x.length > 1);
  if (s >= 72) return true;
  if (s >= 50 && toks.length >= 2) return true;
  return false;
}

async function fetchJson(url: string, timeoutMs = 7000, headers?: Record<string, string>) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(headers || {}) },
    redirect: 'follow',
  }).catch(() => null);
  if (!res?.ok) return null;
  return res.json().catch(() => null);
}

async function searchItunes(artist: string, title: string): Promise<CatalogHit | null> {
  const q = encodeURIComponent(`${artist} ${title}`.trim());
  const data = (await fetchJson(
    `https://itunes.apple.com/search?term=${q}&entity=song&limit=8`,
    8000,
  )) as { results?: Array<Record<string, unknown>> } | null;
  for (const r of data?.results || []) {
    const t = String(r.trackName || '');
    const a = String(r.artistName || '');
    if (!accept(artist, title, a, t)) continue;
    const ms = Number(r.trackTimeMillis || 0);
    return {
      title: t,
      artist: a,
      album: String(r.collectionName || '') || undefined,
      durationSec: ms >= 1000 ? Math.round(ms / 1000) : undefined,
      appleId: String(r.trackId || '') || undefined,
      url: String(r.trackViewUrl || '') || undefined,
      source: 'itunes',
    };
  }
  return null;
}

async function searchDeezer(artist: string, title: string): Promise<CatalogHit | null> {
  const queries = [
    `track:"${title}" ${artist}`,
    `artist:"${artist}" ${title}`,
    `${artist} ${title}`,
  ];
  for (const q of queries) {
    const data = (await fetchJson(
      `https://api.deezer.com/search?q=${encodeURIComponent(q)}`,
      7000,
    )) as { data?: Array<Record<string, unknown>> } | null;
    for (const r of data?.data || []) {
      const t = String(r.title || r.title_short || '');
      const a = String((r.artist as { name?: string } | undefined)?.name || '');
      if (!accept(artist, title, a, t)) continue;
      const id = String(r.id || '');
      const full = id
        ? ((await fetchJson(`https://api.deezer.com/track/${id}`, 6000)) as Record<
            string,
            unknown
          > | null)
        : r;
      const isrc = String(full?.isrc || r.isrc || '') || undefined;
      const dur = Number(full?.duration || r.duration || 0);
      return {
        title: t,
        artist: a,
        album: String((r.album as { title?: string } | undefined)?.title || '') || undefined,
        durationSec: dur > 0 ? dur : undefined,
        isrc,
        deezerId: id || undefined,
        url: String(r.link || '') || undefined,
        source: 'deezer',
      };
    }
  }
  return null;
}

async function spotifyToken(): Promise<string | null> {
  const ready = String(process.env.SPOTIFY_ACCESS_TOKEN || '').trim();
  if (ready) return ready;
  const id = String(process.env.SPOTIFY_CLIENT_ID || '').trim();
  const secret = String(process.env.SPOTIFY_CLIENT_SECRET || '').trim();
  if (id && secret) {
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      signal: AbortSignal.timeout(6000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    }).catch(() => null);
    if (res?.ok) {
      const json = (await res.json().catch(() => null)) as { access_token?: string } | null;
      if (json?.access_token) return json.access_token;
    }
  }
  return null;
}

async function searchSpotify(artist: string, title: string, isrc?: string): Promise<CatalogHit | null> {
  const token = await spotifyToken();
  if (!token) return null;
  const q = isrc
    ? `isrc:${isrc}`
    : `track:${title} artist:${artist}`;
  const data = (await fetchJson(
    `https://api.spotify.com/v1/search?type=track&limit=8&q=${encodeURIComponent(q)}`,
    7000,
    { Authorization: `Bearer ${token}` },
  )) as { tracks?: { items?: Array<Record<string, unknown>> } } | null;
  for (const r of data?.tracks?.items || []) {
    const t = String(r.name || '');
    const artists = (r.artists as Array<{ name?: string }> | undefined) || [];
    const a = artists.map((x) => x.name).filter(Boolean).join(' ');
    if (!accept(artist, title, a, t) && !isrc) continue;
    const ext = (r.external_ids as { isrc?: string } | undefined)?.isrc;
    const ms = Number(r.duration_ms || 0);
    return {
      title: t,
      artist: a,
      album: String((r.album as { name?: string } | undefined)?.name || '') || undefined,
      durationSec: ms >= 1000 ? Math.round(ms / 1000) : undefined,
      isrc: ext || isrc,
      spotifyId: String(r.id || '') || undefined,
      url: String((r.external_urls as { spotify?: string } | undefined)?.spotify || '') || undefined,
      source: 'spotify',
    };
  }
  return null;
}

async function fetchSpotifyColorLyrics(trackId: string): Promise<string | null> {
  const token = String(process.env.SPOTIFY_ACCESS_TOKEN || '').trim() || (await spotifyToken());
  const cookie = String(process.env.SPOTIFY_SP_DC || '').trim();
  if (!trackId || (!token && !cookie)) return null;
  const url = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${trackId}?format=json&market=from_token`;
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/json',
    'App-Platform': 'WebPlayer',
    Origin: 'https://open.spotify.com',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = `sp_dc=${cookie}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers,
  }).catch(() => null);
  if (!res?.ok) return null;
  const json = (await res.json().catch(() => null)) as {
    lyrics?: { lines?: Array<{ words?: string }> };
  } | null;
  const lines = (json?.lyrics?.lines || [])
    .map((l) => String(l.words || '').trim())
    .filter((s) => s && s !== '♪');
  const text = lines.join('\n');
  return looksLikeLyrics(text) ? text : null;
}

async function fetchLrclibExact(hit: CatalogHit): Promise<string | null> {
  const params = new URLSearchParams();
  params.set('artist_name', hit.artist);
  params.set('track_name', hit.title);
  if (hit.album) params.set('album_name', hit.album);
  if (hit.durationSec) params.set('duration', String(hit.durationSec));
  const data = (await fetchJson(`https://lrclib.net/api/get?${params}`, 6000)) as {
    plainLyrics?: string;
    syncedLyrics?: string;
  } | null;
  const plain = String(data?.plainLyrics || data?.syncedLyrics || '').trim();
  return looksLikeLyrics(plain) ? plain : null;
}

async function fetchOvhExact(hit: CatalogHit): Promise<string | null> {
  const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(hit.artist)}/${encodeURIComponent(hit.title)}`;
  const data = (await fetchJson(url, 5000)) as { lyrics?: string } | null;
  const lyrics = String(data?.lyrics || '').trim();
  return looksLikeLyrics(lyrics) ? lyrics : null;
}

export async function resolveStreamingCatalog(
  artist: string,
  title: string,
): Promise<CatalogHit | null> {
  const [deezer, itunes] = await Promise.all([
    searchDeezer(artist, title).catch(() => null),
    searchItunes(artist, title).catch(() => null),
  ]);
  const base = deezer || itunes;
  const spotify = await searchSpotify(artist, title, base?.isrc).catch(() => null);
  return spotify || base;
}

export async function fetchSpotifyLyrics(
  artist: string,
  title: string,
): Promise<{ lyrics: string; source: 'spotify' | 'lyrics.ovh' | 'lrclib'; url?: string } | null> {
  const hit = await resolveStreamingCatalog(artist, title);
  if (!hit) return null;
  if (hit.spotifyId) {
    const color = await fetchSpotifyColorLyrics(hit.spotifyId).catch(() => null);
    if (color) return { lyrics: color, source: 'spotify', url: hit.url };
  }
  const [lrc, ovh] = await Promise.all([
    fetchLrclibExact(hit).catch(() => null),
    fetchOvhExact(hit).catch(() => null),
  ]);
  if (lrc) return { lyrics: lrc, source: 'lrclib', url: hit.url };
  if (ovh) return { lyrics: ovh, source: 'lyrics.ovh', url: hit.url };
  return null;
}

export function catalogSearchLinks(hit: CatalogHit | null, artist: string, title: string) {
  const q = encodeURIComponent(`${hit?.artist || artist} ${hit?.title || title}`.trim());
  return [
    {
      label: 'Spotify',
      url: hit?.url && hit.source === 'spotify'
        ? hit.url
        : `https://open.spotify.com/search/${q}`,
    },
    {
      label: 'Apple Music',
      url: hit?.url && hit.source === 'itunes'
        ? hit.url
        : `https://music.apple.com/us/search?term=${q}`,
    },
  ];
}
