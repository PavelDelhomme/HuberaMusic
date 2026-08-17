import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Innertube, UniversalCache, ClientType, YTNodes, Parser, Log } from 'youtubei.js';
import { resolveYoutubeCookieHeader, youtubeCookiesFingerprint, ytDlpCookieArgs, ytDlpCookieArgSets, YTDLP_AUDIO_FORMAT_CANDIDATES } from './youtubeCookies.js';
import { getSignedStreamYT } from './streamAuth.js';

// youtubei.js loggue massivement des Type mismatch (WatchNext / Message) → pollue make logs
try {
  Log.setLevel(Log.Level.ERROR);
  Parser.setParserErrorHandler(() => {
    /* ignore mismatches non fatals */
  });
} catch {
  /* versions sans setParserErrorHandler */
}
import {
  asText,
  extractThumbs,
  mapAny,
  mapListItem,
  parseAuthorField,
  artistsFromHeader,
  extractYear,
  inferAlbumReleaseType,
  isPlausibleArtistName,
  cleanMusicTitle,
  isWeakTitle,
  preferCatalogAudio,
  sanitizeTrack,
} from './mappers.js';
import { getFullLibrary, getHistory } from '../library/library.js';
import { listFollows, listSearchHistory } from '../library/prefs.js';
import {
  dedupeArtists,
  filterByRelevance,
  foldText,
  isSpokenWordHit,
  mergeTracks,
  pickTopResult,
  rankByQuery,
  scoreSearchItem,
  shelfBucketFromTitle,
  tokenize,
  artistNameAliasMatch,
  type SearchPersonalization,
} from '../reco/searchRank.js';
import {
  applyCachedDurations,
  cacheTrackDuration,
  hitToTrack,
  loadSearchHitsSeed,
  resolveSearchHit,
} from '../reco/searchHits.js';
import type { AlbumMeta, ArtistMeta, PlaylistMeta, Shelf, Track } from './types.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Variantes d’ortho pour requêtes artiste courtes (FR / typos fréquentes). */
function artistSpellingAlternates(query: string): string[] {
  const q = foldText(query);
  if (!q || tokenize(query).length > 2) return [];
  const map: Record<string, string[]> = {
    suzanne: ['suzane'],
    suzane: ['suzanne'],
    kevinn: ['kevin'],
    amandine: ['amandin'],
  };
  const out = new Set<string>();
  for (const alt of map[q] || []) {
    if (alt && alt !== q) out.add(alt);
  }
  // Doublement / dédoublement d’une consonne médiane (n, s, l, t)
  if (q.length >= 5 && q.length <= 12) {
    const m = q.match(/^(.+?)([nsltrp])\2(.+)$/);
    if (m) out.add(`${m[1]}${m[2]}${m[3]}`);
    const m2 = q.match(/^(.+?)([nsltrp])([^nsltrp].*)$/);
    if (m2 && !q.includes(m2[2] + m2[2])) {
      out.add(`${m2[1]}${m2[2]}${m2[2]}${m2[3]}`);
    }
  }
  return [...out].filter((a) => a !== q).slice(0, 2);
}

let yt: Innertube | null = null;
let ytCookieFp: string | null = null;

export async function getYT(): Promise<Innertube> {
  const fp = youtubeCookiesFingerprint();
  if (yt && ytCookieFp === fp) return yt;
  yt = null;
  ytCookieFp = fp;
  const cookie = resolveYoutubeCookieHeader();
  yt = await Innertube.create({
    cache: new UniversalCache(true, join(ROOT, 'data', 'yt-cache')),
    generate_session_locally: true,
    client_type: ClientType.WEB,
    ...(cookie ? { cookie } : {}),
  });
  return yt;
}

/** Force recreate Innertube (après maj cookies Admin). */
export function resetYT() {
  yt = null;
  ytCookieFp = null;
}

type AudioFormat = {
  url: string;
  mimeType?: string;
  bitrate?: number;
  contentLength?: number;
  expiresAt: number;
};

/** Cache URLs googlevideo (évite re-decipher à chaque play / prefetch). */
const AUDIO_FORMAT_CACHE_VER = 'anon-vr-v3';
const audioFormatCache = new Map<string, AudioFormat>();
const audioFormatInflight = new Map<string, Promise<AudioFormat>>();

function audioCacheKey(videoId: string) {
  return `${AUDIO_FORMAT_CACHE_VER}:${videoId}`;
}

/** Invalide une URL audio cache (ex. 403 googlevideo) pour forcer un nouveau resolve. */
export function invalidateAudioFormat(videoId: string) {
  audioFormatCache.delete(audioCacheKey(videoId));
  audioFormatInflight.delete(audioCacheKey(videoId));
  // Ancienne clé sans version (sessions hot-reload)
  audioFormatCache.delete(videoId);
  audioFormatInflight.delete(videoId);
}

export function clearAudioFormatCache() {
  audioFormatCache.clear();
  audioFormatInflight.clear();
}

function parseExpireMs(url: string): number | null {
  try {
    const exp = new URL(url).searchParams.get('expire');
    if (exp && /^\d+$/.test(exp)) return Number(exp) * 1000;
  } catch {
    /* ignore */
  }
  return null;
}

/** `m:ss` ou `h:mm:ss` si ≥ 1 h (évite `164:16`). */
function formatDurationClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const total = Math.floor(totalSeconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = s.toString().padStart(2, '0');
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

function shelvesFrom(sections: any[]): Shelf[] {
  const shelves: Shelf[] = [];
  for (const section of sections || []) {
    const title =
      section?.header?.title?.text ||
      section?.header?.title?.toString?.() ||
      section?.title?.text ||
      section?.title?.toString?.() ||
      'Suggestions';

    const contents = section?.contents || section?.items || [];
    const items = contents
      .map((c: any) => mapAny(c))
      .filter(Boolean) as Track[];

    if (items.length) shelves.push({ title: String(title), items });
  }
  return shelves;
}

export async function getHome(): Promise<Shelf[]> {
  const innertube = await getYT();
  const home = await innertube.music.getHomeFeed();
  const sections = (home as any).sections || (home as any).contents || [];
  return shelvesFrom(Array.isArray(sections) ? sections : []);
}

export async function getHomeMore(page: number, seedIds: string[] = []): Promise<{
  shelves: Shelf[];
  hasMore: boolean;
}> {
  const innertube = await getYT();
  const shelves: Shelf[] = [];

  if (page === 1) {
    try {
      shelves.push(...(await getExplore()));
    } catch {
      /* ignore */
    }
  } else if (page === 2) {
    const moods = [
      'focus playlist',
      'chill hits playlist',
      'workout playlist',
      'party mix playlist',
      'indie playlist',
      'jazz playlist',
    ];
    for (const q of moods) {
      try {
        const result = await innertube.music.search(q, { type: 'playlist' } as any);
        const items: Track[] = [];
        for (const shelf of (result as any).contents || []) {
          for (const item of shelf?.contents || shelf?.items || []) {
            const m = mapAny(item);
            if (m && (m.type === 'playlist' || m.id.startsWith('PL') || m.id.startsWith('VL'))) {
              items.push({ ...m, type: 'playlist' });
            }
          }
        }
        if (items.length) shelves.push({ title: q.replace(' playlist', '').replace(/^./, (c) => c.toUpperCase()), items: items.slice(0, 12) });
      } catch {
        /* ignore */
      }
    }
  } else {
    // Pages 3+ : recommandations à partir des seeds (historique / top)
    const seeds = seedIds.slice((page - 3) * 3, (page - 3) * 3 + 3);
    for (const id of seeds) {
      if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) continue;
      try {
        const { related, radio } = await getRelated(id);
        const pool = [...radio, ...related].filter((t) => isPlayableId(t.id));
        if (pool.length) {
          shelves.push({
            title: 'Recommandé pour toi',
            items: pool.slice(0, 16),
          });
        }
      } catch {
        /* ignore */
      }
    }
    // Fallback search waves
    if (!shelves.length) {
      const queries = ['new music friday', 'top songs 2024', 'viral hits', 'deep focus', 'lofi beats', 'french pop'];
      const q = queries[(page - 3) % queries.length];
      try {
        const result = await innertube.music.search(q);
        const items: Track[] = [];
        for (const shelf of (result as any).contents || []) {
          for (const item of shelf?.contents || shelf?.items || []) {
            const m = mapAny(item);
            if (m) items.push(m);
          }
        }
        if (items.length) shelves.push({ title: `À découvrir · ${q}`, items: items.slice(0, 20) });
      } catch {
        /* ignore */
      }
    }
  }

  // Dedupe shelf titles with page suffix if needed
  const titled = shelves.map((s, i) => ({
    ...s,
    title: s.title,
    items: s.items,
  }));

  return { shelves: titled, hasMore: page < 12 };
}

function isPlayableId(id: string) {
  return /^[a-zA-Z0-9_-]{11}$/.test(id);
}

export async function getExplore(): Promise<Shelf[]> {
  const innertube = await getYT();
  const explore = await innertube.music.getExplore();
  const sections = (explore as any).sections || (explore as any).contents || [];
  const shelves = shelvesFrom(Array.isArray(sections) ? sections : []);

  // Boutons New releases / Charts / Moods (souvent hors sections)
  const topButtons = (explore as any).top_buttons;
  if (Array.isArray(topButtons) && topButtons.length) {
    const items = topButtons.map((b: any) => mapAny(b)).filter(Boolean) as Track[];
    if (items.length) {
      shelves.unshift({ title: 'Explorer', items });
    }
  }
  return shelves;
}

/**
 * Contenu d’une catégorie Moods & genres (params du MusicNavigationButton).
 */
export async function getMoodCategory(
  paramsOrId: string,
  titleHint = '',
): Promise<{ title: string; shelves: Shelf[] }> {
  const raw = String(paramsOrId || '').replace(/^mood:/, '').trim();
  if (!raw) return { title: titleHint || 'Moods', shelves: [] };

  const innertube = await getYT();
  const browseId = 'FEmusic_moods_and_genres_category';
  const params = raw.startsWith('FE') ? undefined : raw;

  const res = await innertube.session.actions.execute('/browse', {
    browseId: raw.startsWith('FE') ? raw : browseId,
    ...(params ? { params } : {}),
    client: 'YTMUSIC',
  } as any);

  const data = (res as any)?.data || res;
  const sectionList =
    data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents ||
    data?.contents?.sectionListRenderer?.contents ||
    [];

  // Parse via youtubei si possible
  let shelves: Shelf[] = [];
  try {
    const parsed = Parser.parseResponse(data);
    const sections =
      (parsed as any)?.contents_memo?.getType?.(YTNodes.MusicCarouselShelf) ||
      (parsed as any)?.contents?.contents ||
      [];
    if (Array.isArray(sections) && sections.length) {
      shelves = shelvesFrom(sections);
    }
  } catch {
    /* fallback brut ci-dessous */
  }

  if (!shelves.length && Array.isArray(sectionList)) {
    for (const block of sectionList) {
      const carousel = block.musicCarouselShelfRenderer;
      if (!carousel) continue;
      const title =
        carousel.header?.musicCarouselShelfBasicHeaderRenderer?.title?.runs
          ?.map((r: { text?: string }) => r.text || '')
          .join('') ||
        titleHint ||
        'Suggestions';
      const items: Track[] = [];
      for (const it of carousel.contents || []) {
        const two = it.musicTwoRowItemRenderer;
        const nav = it.musicNavigationButtonRenderer;
        if (two) {
          const mapped = mapAny({
            type: 'MusicTwoRowItem',
            title: two.title,
            subtitle: two.subtitle,
            thumbnail: two.thumbnailRenderer || two.thumbnail,
            endpoint: two.navigationEndpoint,
            id:
              two.navigationEndpoint?.browseEndpoint?.browseId ||
              two.navigationEndpoint?.watchEndpoint?.videoId,
            item_type: two.navigationEndpoint?.browseEndpoint
              ?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType
              ?.toLowerCase()
              ?.includes('album')
              ? 'album'
              : two.navigationEndpoint?.browseEndpoint
                    ?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig
                    ?.pageType?.toLowerCase()
                    ?.includes('playlist')
                ? 'playlist'
                : undefined,
          });
          if (mapped) items.push(mapped);
        } else if (nav) {
          const mapped = mapAny({
            type: 'MusicNavigationButton',
            button_text: nav.buttonText?.runs?.map((r: { text?: string }) => r.text || '').join('') || nav.buttonText,
            endpoint: {
              payload: {
                browseId: nav.clickCommand?.browseEndpoint?.browseId,
                params: nav.clickCommand?.browseEndpoint?.params,
              },
            },
          });
          if (mapped) items.push(mapped);
        }
      }
      if (items.length) shelves.push({ title: String(title), items });
    }
  }

  // Dernier recours : recherche par nom d’ambiance
  if (!shelves.length && titleHint) {
    try {
      const result = await innertube.music.search(`${titleHint} mix`, { type: 'playlist' } as any);
      const items: Track[] = [];
      for (const shelf of (result as any).contents || []) {
        for (const item of shelf?.contents || shelf?.items || []) {
          const m = mapAny(item);
          if (m) items.push(m.type === 'playlist' ? m : { ...m, type: m.type || 'playlist' });
        }
      }
      if (items.length) shelves.push({ title: titleHint, items: items.slice(0, 20) });
    } catch {
      /* ignore */
    }
  }

  const title =
    titleHint ||
    shelves[0]?.title ||
    'Moods & genres';

  return { title, shelves };
}

type SearchBuckets = {
  topResult: Track | null;
  songs: Track[];
  videos: Track[];
  albums: Track[];
  artists: Track[];
  playlists: Track[];
  podcasts: Track[];
};

function emptyBuckets(): SearchBuckets {
  return {
    topResult: null,
    songs: [],
    videos: [],
    albums: [],
    artists: [],
    playlists: [],
    podcasts: [],
  };
}

function collectFromResult(result: any): SearchBuckets {
  const buckets = emptyBuckets();

  const push = (mapped: Track | null | undefined, forced?: keyof Omit<SearchBuckets, 'topResult'>) => {
    if (!mapped?.id) return;
    if (forced) {
      buckets[forced].push(mapped);
      return;
    }
    if (mapped.type === 'album') buckets.albums.push(mapped);
    else if (mapped.type === 'artist') buckets.artists.push(mapped);
    else if (mapped.type === 'playlist') buckets.playlists.push(mapped);
    else if (mapped.type === 'video') buckets.videos.push(mapped);
    else buckets.songs.push(mapped);
  };

  // Formes Innertube variables : contents, results, items, shelves
  const contents =
    result?.contents ||
    result?.results ||
    result?.items ||
    result?.sections ||
    [];
  for (const shelf of contents) {
    const title = String(
      shelf?.header?.title?.text || shelf?.title?.text || shelf?.header?.title || shelf?.title || '',
    );
    const shelfBucket = shelfBucketFromTitle(title);
    const shelfType = String(shelf?.type || '');
    let items = shelf?.contents || shelf?.items || shelf?.results || [];

    // Item plat (pas un shelf) — mapper directement
    if (!items.length && (shelf?.id || shelf?.video_id || shelf?.browse_id)) {
      const mapped = mapAny(shelf);
      if (mapped) {
        if (shelfBucket) push(mapped, shelfBucket);
        else push(mapped);
      }
      continue;
    }

    // MusicCardShelf: carte top + liste imbriquée — bucket selon le type mappé
    if (shelfType === 'MusicCardShelf') {
      if (shelf) {
        const card = mapAny(shelf);
        if (card) {
          if (card.type === 'artist') push(card, 'artists');
          else if (card.type === 'album') push(card, 'albums');
          else if (card.type === 'playlist') push(card, 'playlists');
          else if (card.type === 'video') push(card, 'videos');
          else push(card, 'songs');
          if (!buckets.topResult) buckets.topResult = card;
        }
      }
      items = items.filter((i: any) => i?.type === 'MusicResponsiveListItem' || i?.id);
    }

    for (const item of items) {
      const mapped = mapAny(item);
      if (!mapped) continue;
      if (shelfBucket) push(mapped, shelfBucket);
      else push(mapped);
    }
  }

  const top = result?.header || result?.top_result || result?.reframed_header;
  if (top && !buckets.topResult) {
    buckets.topResult = mapAny(top?.contents?.[0] || top) || null;
  }

  for (const key of ['songs', 'videos', 'albums', 'artists', 'playlists'] as const) {
    const shelf = result?.[key];
    const items = shelf?.contents || shelf?.items || (Array.isArray(shelf) ? shelf : []);
    for (const item of items) {
      const mapped = mapAny(item);
      if (mapped) buckets[key].push(mapped);
    }
  }

  return buckets;
}

async function innertubeSearch(query: string, filter?: string) {
  const innertube = await getYT();
  const filters =
    filter && filter !== 'all' ? ({ type: filter } as any) : undefined;
  return innertube.music.search(query, filters);
}

function buildSearchPersonalization(userId: string): SearchPersonalization {
  const artistWeights = new Map<string, number>();
  const bump = (name: string | undefined | null, w: number) => {
    const f = foldText(String(name || ''));
    if (f.length < 2) return;
    artistWeights.set(f, (artistWeights.get(f) || 0) + w);
  };

  try {
    for (const f of listFollows(userId)) {
      bump(f.artist_name, 6);
      try {
        const p = JSON.parse(f.payload || '{}');
        bump(p?.name || p?.title, 4);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const lib = getFullLibrary(userId);
    for (const t of lib.liked || []) {
      for (const a of t.artists || []) bump(a.name, 4);
    }
    for (const a of lib.artists || []) bump(a.name || a.title, 5);
  } catch {
    /* ignore */
  }

  try {
    for (const t of getHistory(userId, 60)) {
      for (const a of t.artists || []) bump(a.name, 3);
    }
  } catch {
    /* ignore */
  }

  try {
    for (const s of listSearchHistory(userId, 40)) {
      const qq = String(s.query || '');
      const toks = tokenize(qq);
      if (toks.length >= 2) {
        bump(toks.slice(-2).join(' '), 3);
        bump(toks.slice(-3).join(' '), 2);
      }
      if (toks.length <= 3) bump(qq, 2);
    }
  } catch {
    /* ignore */
  }

  const artistNames = [...artistWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([n]) => n);

  let trackIds: string[] = [];
  try {
    trackIds = getHistory(userId, 80).map((t) => t.id);
  } catch {
    trackIds = [];
  }

  return { artistNames, trackIds };
}

export async function search(
  query: string,
  filter?: string,
  opts?: { userId?: string },
) {
  const q = String(query || '').trim().replace(/\s+/g, ' ');
  const rawFilter = String(filter || 'all').toLowerCase().trim();
  const filterNorm =
    !rawFilter || rawFilter === 'all'
      ? 'all'
      : rawFilter === 'songs' || rawFilter === 'song'
        ? 'song'
        : rawFilter === 'videos' || rawFilter === 'video'
          ? 'video'
          : rawFilter === 'albums' || rawFilter === 'album'
            ? 'album'
            : rawFilter === 'artists' || rawFilter === 'artist'
              ? 'artist'
              : rawFilter === 'playlists' || rawFilter === 'playlist'
                ? 'playlist'
                : rawFilter === 'podcasts' || rawFilter === 'podcast'
                  ? 'podcast'
                  : rawFilter === 'audiobooks' ||
                      rawFilter === 'audiobook' ||
                      rawFilter === 'livre-audio' ||
                      rawFilter === 'livre_audio'
                    ? 'audiobook'
                    : rawFilter;
  if (!q) return emptyBuckets();

  // Podcast / livre audio : chemin dédié (pas de type Innertube music fiable)
  if (filterNorm === 'podcast' || filterNorm === 'audiobook') {
    const personalization = opts?.userId ? buildSearchPersonalization(opts.userId) : undefined;
    const spoken = await searchSpokenContent(q, filterNorm, personalization);
    return {
      topResult: spoken[0] || null,
      songs: spoken,
      videos: [],
      albums: [],
      artists: [],
      playlists: [],
      podcasts: spoken,
    };
  }

  const personalization = opts?.userId ? buildSearchPersonalization(opts.userId) : undefined;

  let primary: any;
  let songExtra: any = null;
  let artistExtra: any = null;
  let albumExtra: any = null;

  if (filterNorm === 'all') {
    const spellingAlts = artistSpellingAlternates(q);
    [primary, songExtra, artistExtra, albumExtra] = await Promise.all([
      innertubeSearch(q).catch(() => null),
      innertubeSearch(q, 'song').catch(() => null),
      innertubeSearch(q, 'artist').catch(() => null),
      innertubeSearch(q, 'album').catch(() => null),
    ]);
    // Orthographe proche (suzanne → suzane) : enrichit le bucket artistes
    if (spellingAlts.length) {
      const altArtists = await Promise.all(
        spellingAlts.slice(0, 2).map((alt) => innertubeSearch(alt, 'artist').catch(() => null)),
      );
      for (const extra of altArtists) {
        if (!extra) continue;
        const bucket = collectFromResult(extra);
        if (!artistExtra) artistExtra = extra;
        else {
          // merge later via fromArtists — stash on a synthetic collector
          (artistExtra as any).__plmAltArtists = [
            ...((artistExtra as any).__plmAltArtists || []),
            ...bucket.artists,
          ];
        }
      }
    }
    if (!primary && !songExtra && !artistExtra && !albumExtra) {
      // Dernier essai soft : recherche sans filtre
      primary = await innertubeSearch(q).catch(() => null);
    }
  } else {
    primary = await innertubeSearch(q, filterNorm).catch(() => null);
    if (!primary) {
      primary = await innertubeSearch(q).catch(() => null);
    }
  }

  const main = primary ? collectFromResult(primary) : emptyBuckets();
  const fromSongs = songExtra ? collectFromResult(songExtra) : emptyBuckets();
  const fromArtists = artistExtra ? collectFromResult(artistExtra) : emptyBuckets();
  const altArtists = ((artistExtra as any)?.__plmAltArtists || []) as Track[];
  const fromAlbums = albumExtra ? collectFromResult(albumExtra) : emptyBuckets();

  // Pas d’injection « query + artiste favori » : ça polluait (Keny sur n’importe quoi).
  // La perso reste un soft-boost sur des résultats déjà pertinents (voir personalizeBoost).

  const songs = filterByRelevance(
    rankByQuery(mergeTracks(fromSongs.songs, main.songs), q, personalization),
    q,
  );
  // Alt orthographe (suzane) en tête du merge → mieux classé si scores proches
  const artists = dedupeArtists(
    filterByRelevance(
      rankByQuery(
        mergeTracks(altArtists, fromArtists.artists, main.artists),
        q,
        personalization,
      ),
      q,
    ),
    q,
  );
  const albums = filterByRelevance(
    rankByQuery(mergeTracks(fromAlbums.albums, main.albums), q, personalization),
    q,
  );
  const videos = filterByRelevance(
    rankByQuery(mergeTracks(main.videos, fromSongs.videos), q, personalization),
    q,
  );
  const playlists = filterByRelevance(rankByQuery(main.playlists, q, personalization), q);

  let topResult = pickTopResult(
    q,
    {
      topResult: main.topResult || fromSongs.topResult || fromArtists.topResult,
      songs,
      artists,
      albums,
      videos,
      playlists,
    },
    personalization,
  );

  // Index hits (seed + clics) : épingle le tube canonique sans masquer le reste
  let songsOut = songs;
  let topOut = topResult;
  try {
    loadSearchHitsSeed();
    const hit = resolveSearchHit(q);
    if (hit && (filterNorm === 'all' || filterNorm === 'song')) {
      let hitTrack: Track | null = songsOut.find((t) => t.id === hit.videoId) || null;
      if (!hitTrack) {
        hitTrack = hitToTrack(hit);
        // Enrichit via getTrack (titre/artistes/durée) — best effort
        try {
          const { track } = await getTrack(hit.videoId, { light: true });
          if (track?.id) {
            hitTrack = {
              ...hitTrack,
              ...track,
              type: 'song',
              artists:
                track.artists?.length ? track.artists : hitTrack.artists?.length ? hitTrack.artists : hit.artist ? [{ name: hit.artist }] : [],
              title: track.title && track.title !== 'Sans titre' ? track.title : hitTrack.title,
            };
          }
        } catch {
          /* seed metadata suffit */
        }
      } else {
        hitTrack = { ...hitTrack, type: 'song' };
      }
      songsOut = mergeTracks([hitTrack], songsOut);
      // Seed tube : enrichit les titres, mais n’écrase pas un top « fiche artiste »
      // (ex. requête « stromae » / « suzane » → artiste, pas Papaoutai en meilleure résultat)
      const topArtistName = foldText(topOut?.title || topOut?.artists?.[0]?.name || '');
      const keepArtistTop =
        topOut?.type === 'artist' &&
        (topArtistName === foldText(q) || artistNameAliasMatch(topArtistName, foldText(q)));
      if (!keepArtistTop) {
        topOut = hitTrack;
      }
    }
  } catch (err) {
    console.warn('[search] hit inject failed', err);
  }

  // Top = fiche artiste → ses titres devant les homonymes (Cohen « Suzanne » vs Virile / Champagne)
  if (topOut?.type === 'artist') {
    const artistName = foldText(topOut.title || topOut.artists?.[0]?.name || '');
    if (artistName.length >= 2) {
      // Match exact du nom (pas alias) — évite de booster « SUZANNE » A.R. Rahman pour Suzane
      const byArtist = songsOut.filter((t) =>
        (t.artists || []).some((a) => foldText(a.name) === artistName),
      );
      if (byArtist.length) songsOut = mergeTracks(byArtist, songsOut);
    }
  }

  songsOut = applyCachedDurations(songsOut);
  const videosOut = applyCachedDurations(videos);

  if (filterNorm === 'song') {
    // Titres uniquement — ne pas mélanger les vidéos (réactions / lyrics)
    let only = filterByRelevance(rankByQuery(main.songs, q, personalization), q);
    try {
      loadSearchHitsSeed();
      const hit = resolveSearchHit(q);
      if (hit) {
        let hitTrack: Track | null = only.find((t) => t.id === hit.videoId) || null;
        if (!hitTrack) {
          hitTrack = hitToTrack(hit);
          try {
            const { track } = await getTrack(hit.videoId, { light: true });
            if (track?.id) {
              hitTrack = {
                ...hitTrack,
                ...track,
                type: 'song',
                artists:
                  track.artists?.length
                    ? track.artists
                    : hitTrack.artists?.length
                      ? hitTrack.artists
                      : hit.artist
                        ? [{ name: hit.artist }]
                        : [],
                title: track.title && track.title !== 'Sans titre' ? track.title : hitTrack.title,
              };
            }
          } catch {
            /* */
          }
        }
        only = mergeTracks([hitTrack], only);
      }
    } catch {
      /* */
    }
    only = applyCachedDurations(only);
    return {
      topResult: only[0] || topOut,
      songs: only,
      videos: [],
      albums: [],
      artists: [],
      playlists: [],
    };
  }
  if (filterNorm === 'video') {
    const only = filterByRelevance(
      rankByQuery(main.videos.length ? main.videos : main.songs, q, personalization),
      q,
    );
    return {
      topResult: only[0] || null,
      songs: [],
      videos: applyCachedDurations(only),
      albums: [],
      artists: [],
      playlists: [],
    };
  }
  if (filterNorm === 'album') {
    const only = filterByRelevance(rankByQuery(main.albums, q, personalization), q);
    return { topResult: only[0] || null, songs: [], videos: [], albums: only, artists: [], playlists: [] };
  }
  if (filterNorm === 'artist') {
    // Préférer les vrais artistes ; si YT renvoie peu, enrichir via topResult / all
    let only = filterByRelevance(rankByQuery(main.artists, q, personalization), q);
    if (only.length < 3) {
      const all = await innertubeSearch(q).catch(() => null);
      if (all) {
        const extra = collectFromResult(all);
        const merged = mergeTracks(only, extra.artists);
        if (extra.topResult?.type === 'artist') merged.unshift(extra.topResult);
        only = filterByRelevance(rankByQuery(merged, q, personalization), q);
      }
    }
    if (main.topResult?.type === 'artist' && scoreSearchItem(main.topResult, q) >= 140) {
      only = mergeTracks([main.topResult], only);
    }
    only = dedupeArtists(only, q);
    return { topResult: only[0] || null, songs: [], videos: [], albums: [], artists: only, playlists: [] };
  }
  if (filterNorm === 'playlist') {
    const only = filterByRelevance(rankByQuery(main.playlists, q, personalization), q);
    return { topResult: only[0] || null, songs: [], videos: [], albums: [], artists: [], playlists: only };
  }

  return {
    topResult: topOut,
    songs: songsOut,
    videos: videosOut,
    albums,
    artists,
    playlists,
  };
}

/** Podcasts / livres audio : heuristique YTM (pas de filtre Innertube dédié fiable). */
async function searchSpokenContent(
  q: string,
  kind: 'podcast' | 'audiobook',
  personalization?: SearchPersonalization,
): Promise<Track[]> {
  const suffixes =
    kind === 'audiobook'
      ? ['audiobook', 'livre audio', 'full audiobook']
      : ['podcast', 'podcast episode', 'épisode podcast'];
  const qFold = foldText(q);
  const queries = [
    q,
    ...suffixes
      .filter((s) => !qFold.includes(foldText(s)))
      .map((s) => `${q} ${s}`),
  ].slice(0, 3);

  const pool: Track[] = [];
  for (const qq of queries) {
    const raw = await innertubeSearch(qq).catch(() => null);
    if (!raw) continue;
    const b = collectFromResult(raw);
    pool.push(...(b.songs || []), ...(b.videos || []));
  }

  const seen = new Set<string>();
  const playable = pool.filter((t) => {
    if (!t?.id || seen.has(t.id)) return false;
    if (!/^[a-zA-Z0-9_-]{11}$/.test(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  const spoken = playable.filter((t) => isSpokenWordHit(t));
  // Si peu de hits « podcast » explicites : garder les longs formats (souvent épisodes)
  const longForm = playable.filter((t) => (t.durationSeconds || 0) >= 20 * 60);
  const merged =
    spoken.length >= 4
      ? spoken
      : mergeTracks(spoken, longForm.length ? longForm : playable.slice(0, 24));

  const tagged = merged.map((t) => ({
    ...t,
    type: 'song' as const,
    album: t.album || {
      name: kind === 'audiobook' ? 'Livre audio' : 'Podcast',
      id: kind,
    },
  }));

  return applyCachedDurations(
    filterByRelevance(rankByQuery(tagged, q, personalization), q),
  ).slice(0, 40);
}

export async function exploreSpoken(kind: 'podcast' | 'audiobook' = 'podcast'): Promise<{
  title: string;
  items: Track[];
}> {
  const seedQ = kind === 'audiobook' ? 'audiobook' : 'podcast';
  const items = await searchSpokenContent(seedQ, kind);
  return {
    title: kind === 'audiobook' ? 'Livres audio' : 'Podcasts',
    items,
  };
}

export async function searchSuggestions(query: string): Promise<string[]> {
  const innertube = await getYT();
  const sections = await innertube.music.getSearchSuggestions(query);
  const out: string[] = [];
  for (const section of sections || []) {
    const contents = (section as any).contents || [];
    for (const item of contents) {
      const text =
        item?.suggestion?.text ||
        item?.suggestion?.toString?.() ||
        item?.text ||
        '';
      if (text) out.push(String(text));
    }
  }
  return out;
}

export async function getTrack(videoId: string, opts?: { light?: boolean }) {
  const light = opts?.light === true;
  const cacheKey = light ? `L:${videoId}` : videoId;
  const cached = trackMetaCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TRACK_META_TTL_MS) {
    return { track: cached.track };
  }
  const value = await fetchTrackMeta(videoId, light);
  trackMetaCache.set(cacheKey, { track: value.track, at: Date.now() });
  while (trackMetaCache.size > TRACK_META_MAX) {
    const first = trackMetaCache.keys().next().value;
    if (first === undefined) break;
    trackMetaCache.delete(first);
  }
  return value;
}

/**
 * Complète titres / artistes manquants (« Sans titre ») via getInfo.
 * Persiste dans tracks_cache pour ne plus les perdre.
 */
export async function hydrateTracks(
  tracks: Track[],
  opts?: { concurrency?: number; limit?: number },
): Promise<Track[]> {
  if (!tracks?.length) return tracks || [];
  const { upsertTrack } = await import('../library/db.js');
  const limit = opts?.limit ?? 36;
  const concurrency = Math.max(1, opts?.concurrency ?? 4);
  const out = tracks.map((t) => ({ ...t }));
  const weakIdx = out
    .map((t, i) =>
      t?.id &&
      /^[a-zA-Z0-9_-]{11}$/.test(t.id) &&
      (isWeakTitle(t.title, t.id) ||
        !(t.artists || []).length ||
        !(t.durationSeconds && t.durationSeconds > 0))
        ? i
        : -1,
    )
    .filter((i) => i >= 0)
    .slice(0, limit);
  if (!weakIdx.length) return out;

  for (let i = 0; i < weakIdx.length; i += concurrency) {
    const batch = weakIdx.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (idx) => {
        const cur = out[idx];
        try {
          const { track } = await getTrack(cur.id, { light: true });
          const merged: Track = {
            ...cur,
            ...track,
            title: isWeakTitle(track.title, track.id) ? cur.title : track.title,
            artists:
              track.artists?.length && track.artists.some((a) => a.name)
                ? track.artists
                : cur.artists || [],
            album: track.album || cur.album,
            thumbnails: track.thumbnails?.length ? track.thumbnails : cur.thumbnails,
            duration: track.duration || cur.duration,
            durationSeconds: track.durationSeconds ?? cur.durationSeconds,
            type:
              // Ne pas écraser un clip mappé OMV → song via getTrack light
              cur.type === 'video' ? 'video' : track.type || cur.type,
          };
          out[idx] = merged;
          if (!isWeakTitle(merged.title, merged.id)) {
            try {
              upsertTrack(merged);
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* ignore */
        }
      }),
    );
  }
  return out;
}

export async function hydrateTrack(track: Track): Promise<Track> {
  const [one] = await hydrateTracks([track], { limit: 1, concurrency: 1 });
  return one || track;
}

const TRACK_META_TTL_MS = 20 * 60 * 1000;
const TRACK_META_MAX = 180;
const trackMetaCache = new Map<string, { track: Track; at: number }>();

/** Fallback titre/artiste quand music.getInfo renvoie vide (souvent IP datacenter). */
async function fallbackTitleArtist(
  videoId: string,
): Promise<{ title?: string; artist?: string }> {
  try {
    const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`,
    )}&format=json`;
    const ctrl = AbortSignal.timeout(6000);
    const r = await fetch(oembed, {
      signal: ctrl,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PLM/1.0)' },
    });
    if (r.ok) {
      const j = (await r.json()) as { title?: string; author_name?: string };
      const title = String(j.title || '').trim();
      let artist = String(j.author_name || '').trim();
      // Chaînes auto « Artist - Topic »
      artist = artist.replace(/\s*-\s*Topic\s*$/i, '').trim();
      if (title) return { title, artist: artist || undefined };
    }
  } catch {
    /* ignore */
  }
  try {
    const { spawn } = await import('node:child_process');
    const ytdlp = join(ROOT, 'bin', 'yt-dlp');
    const out = await new Promise<string>((resolve, reject) => {
      const proc = spawn(
        ytdlp,
        [
          '--no-playlist',
          '--no-warnings',
          '--print',
          '%(title)s\n%(artist)s\n%(uploader)s',
          ...ytDlpCookieArgs(),
          `https://www.youtube.com/watch?v=${videoId}`,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let buf = '';
      let err = '';
      proc.stdout.on('data', (c) => {
        buf += String(c);
      });
      proc.stderr.on('data', (c) => {
        err += String(c);
      });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0 && buf.trim()) resolve(buf);
        else reject(new Error(err.trim() || `yt-dlp meta exit ${code}`));
      });
    });
    const [title, artist, uploader] = out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l !== 'NA');
    if (title) return { title, artist: artist || uploader };
  } catch {
    /* ignore */
  }
  return {};
}

async function fetchTrackMeta(videoId: string, light = false) {
  const innertube = await getYT();
  let info: any = null;
  let basic: any = {};
  try {
    info = await innertube.music.getInfo(videoId);
    basic = info?.basic_info || {};
  } catch {
    /* getInfo parfois bloqué en datacenter */
  }

  // Fallback client YouTube classique si music.getInfo vide
  if (!basic?.title) {
    try {
      const ytInfo = await (innertube as any).getBasicInfo?.(videoId);
      if (ytInfo?.basic_info?.title) {
        basic = { ...basic, ...ytInfo.basic_info };
        info = info || ytInfo;
      }
    } catch {
      /* ignore */
    }
  }

  let artists: { name: string; id?: string }[] = [];
  if (Array.isArray(basic.artists) && basic.artists.length) {
    artists = basic.artists
      .map((a: any) => ({
        name: String(a.name || '').trim(),
        id: a.channel_id || a.id,
      }))
      .filter((a: { name: string }) => a.name && isPlausibleArtistName(a.name));
  }
  if (!artists.length && basic.author) {
    artists = parseAuthorField(String(basic.author), basic.channel_id).filter(
      (a) => a.name && isPlausibleArtistName(a.name),
    );
  }

  let album: Track['album'] | undefined;
  if (basic.album?.id || basic.album?.name) {
    album = {
      name: String(basic.album.name || basic.album.title || 'Album'),
      id: basic.album.id || basic.album.browse_id,
    };
  }

  if (!light && ((artists.length && artists.some((a) => !a.id)) || !album?.id)) {
    try {
      const up = await innertube.music.getUpNext(videoId, true);
      const first = ((up as any).contents || [])
        .map((c: any) => mapListItem(c))
        .find((t: Track | null) => t && t.id === videoId) as Track | undefined;
      if (first?.artists?.length) {
        artists = artists.map((a) => {
          if (a.id) return a;
          const match = first.artists.find(
            (f) => f.name.toLowerCase() === a.name.toLowerCase() && f.id,
          );
          return match ? { name: a.name, id: match.id } : a;
        });
        if (!artists.length) artists = first.artists.filter((a) => isPlausibleArtistName(a.name));
      }
      if (!album?.id && first?.album) album = first.album;
      if (isWeakTitle(String(basic.title || ''), videoId) && first?.title) {
        basic = { ...basic, title: first.title };
      }
    } catch {
      /* ignore */
    }
  }

  if (!light) {
    for (let i = 0; i < artists.length; i++) {
      if (artists[i].id) continue;
      try {
        const found = await search(artists[i].name, 'artist');
        const hit = found.artists.find(
          (a) => a.title.toLowerCase() === artists[i].name.toLowerCase() || a.id.startsWith('UC'),
        );
        if (hit?.id?.startsWith('UC')) artists[i] = { name: artists[i].name, id: hit.id };
      } catch {
        /* ignore */
      }
    }
  }

  let title = cleanMusicTitle(String(basic.title || '')) || String(basic.title || '').trim();
  if (isWeakTitle(title, videoId) || !artists.length) {
    const fb = await fallbackTitleArtist(videoId);
    if (fb.title && isWeakTitle(title, videoId)) {
      title = cleanMusicTitle(fb.title) || fb.title;
    }
    if (!artists.length && fb.artist) {
      artists = parseAuthorField(fb.artist).filter((a) => isPlausibleArtistName(a.name));
    }
  }
  if (!title) title = 'Sans titre';

  let thumbnails = extractThumbs(basic, info, { thumbnail: basic.thumbnail });
  if (!thumbnails.length && /^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    thumbnails = [
      { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 1280, height: 720 },
      { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 480, height: 360 },
    ];
  }

  const track: Track = {
    id: videoId,
    title,
    artists,
    album,
    durationSeconds: basic.duration,
    duration: basic.duration != null ? formatDurationClock(basic.duration) : undefined,
    thumbnails,
    type: 'song',
  };
  if (!(track.durationSeconds && track.durationSeconds > 0)) {
    const cached = applyCachedDurations([track])[0];
    Object.assign(track, cached);
  }
  if (track.durationSeconds && track.durationSeconds > 0) {
    try {
      cacheTrackDuration(videoId, track.durationSeconds, track.duration);
    } catch {
      /* */
    }
  }

  return light ? { track } : { track, info };
}

export async function getUpNext(
  videoId: string,
  opts?: { hydrateLimit?: number },
): Promise<Track[]> {
  const innertube = await getYT();
  const panel = await innertube.music.getUpNext(videoId, true);
  const contents = (panel as any).contents || [];
  const mapped = contents.map((c: any) => mapListItem(c) || mapAny(c)).filter(Boolean) as Track[];
  // Audio-first (ATV / song) avant clips OMV « Officiel »
  const preferred = preferCatalogAudio(mapped);
  // hydrateLimit bas = skip plus rapide (titres faibles OK pour la file, hydratés plus tard)
  return hydrateTracks(preferred, {
    limit: opts?.hydrateLimit ?? 40,
    concurrency: Math.min(5, Math.max(2, opts?.hydrateLimit ?? 40)),
  });
}

export async function getRelated(videoId: string): Promise<{
  related: Track[];
  radio: Track[];
}> {
  const innertube = await getYT();
  const related: Track[] = [];
  const radio: Track[] = [];

  try {
    const section = await innertube.music.getRelated(videoId);
    const contents = (section as any)?.contents || (section as any)?.items || [];
    for (const block of contents) {
      const items = block?.contents || block?.items || [block];
      for (const item of items) {
        const mapped = mapAny(item);
        if (mapped) related.push(mapped);
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const up = await getUpNext(videoId);
    radio.push(...up.filter((t) => t.id !== videoId));
  } catch {
    /* ignore */
  }

  const uniq = (arr: Track[]) => {
    const seen = new Set<string>();
    return arr.filter((t) => {
      if (seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    });
  };

  const [relH] = await Promise.all([
    hydrateTracks(preferCatalogAudio(uniq(related)), { limit: 30, concurrency: 5 }),
  ]);
  // radio déjà passé par getUpNext → hydrateTracks + preferCatalogAudio
  return { related: relH, radio: preferCatalogAudio(uniq(radio)) };
}

export async function getAlbumRadio(albumId: string): Promise<Track[]> {
  const { tracks } = await getAlbum(albumId);
  const seed = tracks.find((t) => /^[a-zA-Z0-9_-]{11}$/.test(t.id));
  if (!seed) return [];
  const { radio, related } = await getRelated(seed.id);
  const mid = tracks.filter((t) => /^[a-zA-Z0-9_-]{11}$/.test(t.id))[Math.min(3, tracks.length - 1)];
  let extra: Track[] = [];
  if (mid && mid.id !== seed.id) {
    try {
      const r2 = await getRelated(mid.id);
      extra = [...r2.radio.slice(0, 10), ...r2.related.slice(0, 8)];
    } catch {
      /* ignore */
    }
  }
  const seen = new Set<string>();
  return [...radio, ...related, ...tracks.slice(0, 6), ...extra].filter((t) => {
    if (!t?.id || seen.has(t.id) || t.id === seed.id) return false;
    seen.add(t.id);
    return /^[a-zA-Z0-9_-]{11}$/.test(t.id);
  });
}

export async function getArtistRadio(artistId: string): Promise<Track[]> {
  const { songs } = await getArtist(artistId);
  const seed = songs.find((t) => /^[a-zA-Z0-9_-]{11}$/.test(t.id));
  if (!seed) return [];
  const { radio, related } = await getRelated(seed.id);
  const seen = new Set<string>();
  return [...radio, ...related, ...songs.slice(0, 10)].filter((t) => {
    if (!t?.id || seen.has(t.id) || t.id === seed.id) return false;
    seen.add(t.id);
    return /^[a-zA-Z0-9_-]{11}$/.test(t.id);
  });
}

function isTopSongsShelfTitle(title: string): boolean {
  const t = title.toLowerCase();
  return (
    t.includes('top song') ||
    t.includes('titres les plus') ||
    t.includes('plus écout') ||
    t.includes('plus ecout') ||
    t.includes('popular song') ||
    t.includes('songs') ||
    t.includes('titre')
  );
}

function artistMetaFromHeader(artistId: string, artist: any): ArtistMeta {
  const header = artist?.header || {};
  const rawSubscribers =
    asText(header.subtitle) ||
    asText(header.subscription_button?.subscriber_count_text) ||
    asText(header.subscriber_count) ||
    '';
  const subscribers = (() => {
    const s = rawSubscribers.trim();
    if (!s) return undefined;
    if (/^(subscribed|subscribe|abonné|s'abonner)$/i.test(s)) return undefined;
    return s;
  })();
  return {
    id: artistId,
    name: asText(header.title) || 'Artiste',
    subscribers,
    thumbnails: extractThumbs(header, artist),
    description: asText(header.description) || asText(artist?.description) || undefined,
  };
}

function mapSongNodes(nodes: any[]): Track[] {
  const out: Track[] = [];
  const seen = new Set<string>();
  for (const node of nodes || []) {
    if (!node || node.type === 'ContinuationItem') continue;
    const t = mapAny(node);
    if (!t?.id || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

/**
 * Liste complète des titres d’un artiste (shelf « Top songs » → browse + continuations).
 * Distinct des tops affichés sur la fiche artiste.
 */
export async function getArtistSongs(
  artistId: string,
  opts?: { limit?: number },
): Promise<{ artist: ArtistMeta; tracks: Track[] }> {
  const limit = Math.min(Math.max(opts?.limit ?? 500, 1), 800);
  const innertube = await getYT();
  const artist = await innertube.music.getArtist(artistId);
  const meta = artistMetaFromHeader(artistId, artist);
  const actions = (innertube as any).actions;

  let rawNodes: any[] = [];
  let continuation: any = null;

  const shelves = ((artist as any).sections || []).filter(
    (s: any) => s?.type === 'MusicShelf' || s?.endpoint,
  );
  const shelf =
    shelves.find((s: any) => isTopSongsShelfTitle(asText(s.title))) ||
    shelves.find((s: any) => s?.endpoint) ||
    null;

  try {
    if (shelf?.endpoint?.call) {
      const page = await shelf.endpoint.call(actions, { client: 'YTMUSIC', parse: true });
      const pl = page?.contents_memo?.getType?.(YTNodes.MusicPlaylistShelf)?.[0] || null;
      if (pl?.contents) {
        rawNodes = [...pl.contents];
        continuation =
          [...pl.contents].find((c: any) => c?.type === 'ContinuationItem') || pl.continuation || null;
      }
    }
  } catch {
    /* fallback below */
  }

  if (!rawNodes.length) {
    try {
      const pl = await (artist as any).getAllSongs();
      rawNodes = [...(pl?.contents || [])];
      continuation =
        rawNodes.find((c: any) => c?.type === 'ContinuationItem') || pl?.continuation || null;
    } catch {
      /* last resort: tops only */
    }
  }

  let tracks = mapSongNodes(rawNodes);
  let guard = 0;
  while (continuation && tracks.length < limit && guard < 25) {
    guard += 1;
    try {
      let page: any;
      if (typeof continuation === 'string') {
        const response = await actions.execute('/browse', {
          client: 'YTMUSIC',
          continuation,
        });
        page = Parser.parseResponse(response.data);
      } else if (continuation?.endpoint?.call) {
        page = await continuation.endpoint.call(actions, { client: 'YTMUSIC', parse: true });
      } else {
        break;
      }

      const contShelf = page?.continuation_contents;
      const append = page?.on_response_received_actions?.[0];
      const moreNodes: any[] = contShelf?.contents
        ? [...contShelf.contents]
        : append?.contents
          ? [...append.contents]
          : [];
      const more = mapSongNodes(moreNodes);
      if (!more.length) break;
      const seen = new Set(tracks.map((t) => t.id));
      for (const t of more) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        tracks.push(t);
        if (tracks.length >= limit) break;
      }
      continuation =
        moreNodes.find((c: any) => c?.type === 'ContinuationItem') ||
        contShelf?.continuation ||
        null;
    } catch {
      break;
    }
  }

  if (!tracks.length) {
    const fallback = await getArtist(artistId);
    tracks = fallback.songs;
  }

  return { artist: meta, tracks: tracks.slice(0, limit) };
}

const LYRICS_CACHE_MAX = 400;
/** bump pour invalider d’anciens timed mal alignés / écrasés */
const LYRICS_CACHE_VER = 'v4';
type LyricsResult = {
  lyrics: string | null;
  timed: { startMs: number; text: string }[] | null;
  source?: 'youtube' | 'lrclib' | 'lrc' | null;
  /** Décalage appliqué aux timed (ms) — positif = paroles retardées (corrige avance) */
  syncOffsetMs?: number;
};
const lyricsCache = new Map<string, LyricsResult & { at: number }>();

function lyricsCacheKey(videoId: string) {
  return `${LYRICS_CACHE_VER}:${videoId}`;
}

function putLyricsCache(videoId: string, result: LyricsResult) {
  lyricsCache.set(lyricsCacheKey(videoId), { ...result, at: Date.now() });
  while (lyricsCache.size > LYRICS_CACHE_MAX) {
    const first = lyricsCache.keys().next().value;
    if (first === undefined) break;
    lyricsCache.delete(first);
  }
}

function parseLrcBlock(raw: string): { startMs: number; text: string }[] {
  const out: { startMs: number; text: string }[] = [];
  const re = /^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?]\s*(.*)$/;
  for (const row of raw.split(/\r?\n/)) {
    const m = row.trim().match(re);
    if (!m) continue;
    const min = Number(m[1]);
    const sec = Number(m[2]);
    const frac = m[3]
      ? m[3].length <= 2
        ? Number(m[3].padEnd(2, '0')) * 10
        : Number(m[3].padEnd(3, '0').slice(0, 3))
      : 0;
    const text = (m[4] || '').trim();
    if (!text) continue;
    out.push({ startMs: (min * 60 + sec) * 1000 + frac, text });
  }
  return out;
}

/**
 * Aligne un LRC studio sur la durée YouTube (intro clip plus longue → paroles trop tôt).
 * offset positif = retarde les lignes (corrige l’avance).
 */
function alignTimedToTrack(
  timed: { startMs: number; text: string }[],
  trackDurationSec?: number,
  sourceDurationSec?: number,
): { timed: { startMs: number; text: string }[]; offsetMs: number } {
  if (!timed.length) return { timed, offsetMs: 0 };

  let offsetMs = 0;
  if (
    trackDurationSec &&
    trackDurationSec >= 20 &&
    sourceDurationSec &&
    sourceDurationSec >= 20
  ) {
    const diffSec = trackDurationSec - sourceDurationSec;
    // Uniquement retarder (clip YT plus long / intro) — ne jamais avancer auto
    // (avance auto = paroles encore plus en avant, plainte UX fréquente).
    if (diffSec >= 0.35 && diffSec <= 30) {
      offsetMs = Math.round(diffSec * 1000);
    }
  }

  // Sans durée source : estime un décalage d’intro si la plage LRC est « trop courte »
  if (
    offsetMs === 0 &&
    trackDurationSec &&
    trackDurationSec >= 30 &&
    timed.length >= 4
  ) {
    const first = timed[0]!.startMs / 1000;
    const last = timed[timed.length - 1]!.startMs / 1000;
    const span = last - first;
    // Master ~span, clip YT plus long → gap final (intro+outro). On décale d’environ l’intro.
    const tailGap = trackDurationSec - last;
    // Si première ligne quasi à 0 et gap de fin notable → intro clip YT probable
    if (first < 2.5 && span >= trackDurationSec * 0.5 && span <= trackDurationSec * 0.99) {
      if (tailGap >= 3 && tailGap <= 35) {
        // Prendre l’essentiel du surplus comme intro (rap FR / clips clip-heavy)
        offsetMs = Math.round(Math.min(Math.max(tailGap * 0.8, 2.5), 24) * 1000);
      } else if (first < 1.2 && span >= trackDurationSec * 0.85) {
        // Durées quasi égales mais LRC démarre à 0 → léger lag intro typique clip
        offsetMs = 2500;
      }
    }
  }

  if (!offsetMs) return { timed, offsetMs: 0 };
  return {
    offsetMs,
    timed: timed.map((l) => ({
      ...l,
      startMs: Math.max(0, Math.round(l.startMs + offsetMs)),
    })),
  };
}

type LrclibHit = {
  lyrics: string | null;
  timed: { startMs: number; text: string }[] | null;
  sourceDurationSec?: number;
};

async function fetchLrclibTimed(
  artist: string,
  title: string,
  durationSec?: number,
): Promise<LrclibHit | null> {
  if (!title.trim()) return null;
  const ctrl = AbortSignal.timeout(4500);
  const headers = { 'User-Agent': 'PLM/1.0 (self-hosted)' };

  const tryGet = async (
    artistName: string,
    trackName: string,
    withDuration: boolean,
  ): Promise<LrclibHit | null> => {
    if (!trackName.trim()) return null;
    const params = new URLSearchParams({
      artist_name: (artistName || 'Unknown').slice(0, 120),
      track_name: trackName.slice(0, 160),
    });
    if (withDuration && durationSec && durationSec > 0) {
      params.set('duration', String(Math.round(durationSec)));
    }
    const res = await fetch(`https://lrclib.net/api/get?${params}`, { signal: ctrl, headers });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      syncedLyrics?: string | null;
      plainLyrics?: string | null;
      duration?: number;
    };
    const sourceDurationSec =
      typeof data.duration === 'number' && data.duration > 0 ? data.duration : undefined;
    const synced = data.syncedLyrics?.trim();
    if (synced) {
      const timed = parseLrcBlock(synced);
      if (timed.length) {
        return {
          lyrics: timed.map((l) => l.text).join('\n'),
          timed,
          sourceDurationSec,
        };
      }
    }
    const plain = data.plainLyrics?.trim();
    if (plain) return { lyrics: plain, timed: null, sourceDurationSec };
    return null;
  };

  const cleanTitle = title
    .replace(/\s*[\[(【].*?[\])】]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const titleVariants = [
    cleanTitle,
    title,
    cleanTitle.replace(/['’]/g, ''),
    cleanTitle.replace(/['’]/g, "'"),
  ].filter((t, i, arr) => t && arr.indexOf(t) === i);

  // 1) get exact (avec durée) → 2) get sans durée → 3) search
  for (const t of titleVariants) {
    const hit =
      (await tryGet(artist, t, true).catch(() => null)) ||
      (await tryGet(artist, t, false).catch(() => null)) ||
      (await tryGet('', t, true).catch(() => null));
    if (hit?.timed?.length || hit?.lyrics) return hit;
  }

  const q = [artist, cleanTitle || title].filter(Boolean).join(' ').slice(0, 180);
  if (!q) return null;
  const searchRes = await fetch(
    `https://lrclib.net/api/search?${new URLSearchParams({ q })}`,
    { signal: ctrl, headers },
  ).catch(() => null);
  if (!searchRes?.ok) return null;
  const results = (await searchRes.json()) as Array<{
    artistName?: string;
    trackName?: string;
    syncedLyrics?: string | null;
    plainLyrics?: string | null;
    duration?: number;
  }>;
  if (!Array.isArray(results) || !results.length) return null;

  const scoreHit = (r: (typeof results)[number]) => {
    let s = 0;
    if (r.syncedLyrics?.trim()) s += 20;
    else if (r.plainLyrics?.trim()) s += 5;
    if (durationSec && durationSec > 0 && typeof r.duration === 'number' && r.duration > 0) {
      const d = Math.abs(r.duration - durationSec);
      if (d <= 2) s += 60;
      else if (d <= 5) s += 30;
      else if (d <= 10) s += 10;
      else if (d > 20) s -= 50;
    }
    return s;
  };
  const ranked = [...results].sort((a, b) => scoreHit(b) - scoreHit(a));
  const best =
    ranked.find((r) => r.syncedLyrics?.trim() && scoreHit(r) >= 20) ||
    ranked.find((r) => r.plainLyrics?.trim()) ||
    ranked[0];
  if (!best) return null;

  const timedOk = (timed: { startMs: number; text: string }[]) => {
    if (timed.length < 2) return false;
    if (!durationSec || durationSec < 20) return true;
    const last = timed[timed.length - 1]!.startMs / 1000;
    // Timings d’une autre version / autre titre → rejeter le sync
    if (last > durationSec * 1.4 || last < durationSec * 0.35) return false;
    return true;
  };

  const sourceDurationSec =
    typeof best.duration === 'number' && best.duration > 0 ? best.duration : undefined;

  if (best.syncedLyrics?.trim()) {
    const timed = parseLrcBlock(best.syncedLyrics);
    if (timed.length && timedOk(timed)) {
      return {
        lyrics: timed.map((l) => l.text).join('\n'),
        timed,
        sourceDurationSec,
      };
    }
    // Sync incohérent → plain plutôt que faux karaoké
    if (best.plainLyrics?.trim()) {
      return { lyrics: best.plainLyrics.trim(), timed: null, sourceDurationSec };
    }
  }
  if (best.plainLyrics?.trim()) {
    return { lyrics: best.plainLyrics.trim(), timed: null, sourceDurationSec };
  }
  // Search hits sometimes omit lyric bodies → re-get by names
  return tryGet(best.artistName || artist, best.trackName || cleanTitle || title, false);
}

export async function getLyrics(videoId: string): Promise<LyricsResult> {
  const cached = lyricsCache.get(lyricsCacheKey(videoId));
  if (cached) {
    const ttl = cached.lyrics ? 6 * 60 * 60 * 1000 : 90 * 1000; // null : court TTL pour retenter
    if (Date.now() - cached.at < ttl) {
      const { at: _at, ...rest } = cached;
      return rest;
    }
  }

  const innertube = await getYT();
  let text: string | null = null;
  let timed: { startMs: number; text: string }[] | null = null;
  let source: LyricsResult['source'] = null;
  let syncOffsetMs = 0;

  try {
    const lyrics = await innertube.music.getLyrics(videoId);
    if (lyrics) {
      const anyL = lyrics as any;
      text = String(anyL.description?.text || anyL.description || anyL.lyrics?.text || '') || null;
      const timedSrc =
        anyL.lyrics?.lines ||
        anyL.timed_lyrics ||
        anyL.timedLyrics ||
        anyL.contents?.timed_lyrics?.lines ||
        [];
      const parsed: { startMs: number; text: string }[] = [];
      if (Array.isArray(timedSrc)) {
        for (const line of timedSrc) {
          const startMs = Number(
            line.start_time_ms ?? line.startMs ?? line.start_ms ?? line.tStartMs ?? NaN,
          );
          const lineText = String(line.text || line.lyric_line || line.snippet?.text || '').trim();
          if (Number.isFinite(startMs) && lineText) parsed.push({ startMs, text: lineText });
        }
      }
      if (parsed.length) {
        timed = parsed;
        source = 'youtube';
      }
      if (!text && timed?.length) text = timed.map((l) => l.text).join('\n');
    }
  } catch {
    /* fallback LRCLIB */
  }

  // LRCLIB uniquement si pas de timed YouTube (ne jamais écraser le sync YTM)
  if (!timed?.length || !text) {
    try {
      const meta = await getTrack(videoId, { light: true }).catch(() => null);
      const title = meta?.track?.title || '';
      const artist =
        meta?.track?.artists?.map((a) => a.name).filter(Boolean).join(' ') ||
        meta?.track?.artists?.[0]?.name ||
        '';
      const durationSec =
        typeof meta?.track?.durationSeconds === 'number'
          ? meta.track.durationSeconds
          : undefined;
      const ext = await fetchLrclibTimed(artist, title, durationSec);
      if (ext) {
        if (!timed?.length && ext.timed?.length) {
          const aligned = alignTimedToTrack(ext.timed, durationSec, ext.sourceDurationSec);
          timed = aligned.timed;
          syncOffsetMs = aligned.offsetMs;
          source = 'lrclib';
        }
        if (!text && ext.lyrics) text = ext.lyrics;
        else if (ext.lyrics && !timed?.length) text = text || ext.lyrics;
      }
    } catch {
      /* ignore */
    }
  }

  // Texte LRC brut → timed
  if (!timed?.length && text) {
    const fromText = parseLrcBlock(text);
    if (fromText.length >= 3) {
      timed = fromText;
      source = 'lrc';
    }
  }

  // Dernier filet : timings hors durée du titre → texte seul
  if (timed?.length) {
    try {
      const meta = await getTrack(videoId, { light: true }).catch(() => null);
      const dur =
        typeof meta?.track?.durationSeconds === 'number' ? meta.track.durationSeconds : 0;
      if (dur >= 20) {
        const last = timed[timed.length - 1]!.startMs / 1000;
        if (last > dur * 1.4 || last < dur * 0.35) {
          timed = null;
          source = null;
          syncOffsetMs = 0;
        }
      }
    } catch {
      /* keep */
    }
  }

  const result: LyricsResult = {
    lyrics: text,
    timed: timed?.length ? timed : null,
    source: timed?.length ? source : null,
    syncOffsetMs: timed?.length ? syncOffsetMs : 0,
  };
  putLyricsCache(videoId, result);
  return result;
}

export async function getArtist(artistId: string): Promise<{
  artist: ArtistMeta;
  songs: Track[];
  albums: Track[];
  singles: Track[];
  videos: Track[];
  featured: Track[];
  similar: Track[];
  playlists: Track[];
}> {
  const innertube = await getYT();
  const artist = await innertube.music.getArtist(artistId);
  const meta = artistMetaFromHeader(artistId, artist);

  const songs: Track[] = [];
  const albums: Track[] = [];
  const singles: Track[] = [];
  const videos: Track[] = [];
  const featured: Track[] = [];
  const similar: Track[] = [];
  const playlists: Track[] = [];

  const sections = (artist as any).sections || [];
  for (const section of sections) {
    const title = String(
      section?.header?.title?.text || section?.title?.text || section?.title || '',
    ).toLowerCase();
    const items = applyCachedDurations(
      (section.contents || [])
        .map((c: any) => mapAny(c))
        .filter(Boolean)
        .map((t: Track) => sanitizeTrack(t as Track)) as Track[],
    );

    if (
      title.includes('top song') ||
      title.includes('song') ||
      title.includes('titre') ||
      title.includes('popular')
    ) {
      songs.push(...items);
    } else if (title.includes('single') || title.includes('ep')) {
      singles.push(...items.map((i) => ({ ...i, type: i.type === 'unknown' ? 'album' as const : i.type })));
    } else if (title.includes('album')) {
      albums.push(...items.map((i) => ({ ...i, type: 'album' as const })));
    } else if (title.includes('video')) {
      videos.push(...items);
    } else if (
      title.includes('fan') ||
      title.includes('similar') ||
      title.includes('also like') ||
      title.includes('might also') ||
      title.includes('artistes similaires')
    ) {
      similar.push(...items.map((i) => ({ ...i, type: 'artist' as const })));
    } else if (title.includes('featured') || title.includes('appears')) {
      featured.push(...items);
    } else if (title.includes('playlist')) {
      playlists.push(...items.map((i) => ({ ...i, type: 'playlist' as const })));
    } else if (items[0]?.type === 'artist') {
      similar.push(...items);
    } else if (items[0]?.type === 'album') {
      albums.push(...items);
    } else if (items[0]?.type === 'song' || items[0]?.type === 'video') {
      songs.push(...items);
    }
  }

  // Hydrate durées manquantes (top songs) depuis le cache / getTrack léger
  const needDur = songs.filter((t) => !t.durationSeconds || !t.duration).slice(0, 12);
  if (needDur.length) {
    await Promise.all(
      needDur.map(async (t) => {
        try {
          const full = await getTrack(t.id, { light: true });
          const tr = full?.track || full;
          if (tr?.durationSeconds || tr?.duration) {
            t.durationSeconds = tr.durationSeconds || t.durationSeconds;
            t.duration = tr.duration || t.duration;
            if (t.durationSeconds) {
              cacheTrackDuration(t.id, t.durationSeconds, t.duration);
            }
          }
        } catch {
          /* ignore */
        }
      }),
    );
  }

  return {
    artist: meta,
    songs: applyCachedDurations(songs.map(sanitizeTrack)),
    albums: albums.map(sanitizeTrack),
    singles: singles.map(sanitizeTrack),
    videos: applyCachedDurations(videos.map(sanitizeTrack)),
    featured: featured.map(sanitizeTrack),
    similar: similar.map(sanitizeTrack),
    playlists: playlists.map(sanitizeTrack),
  };
}

export async function getAlbum(albumId: string): Promise<{
  album: AlbumMeta;
  tracks: Track[];
}> {
  const innertube = await getYT();
  let id = albumId;

  // OLAK5… = browse album ; youtubei.getAlbum n’accepte que MPR*
  if (id.startsWith('OLAK5')) {
    try {
      const browse = await innertube.session.actions.execute('/browse', {
        browseId: id,
        client: 'YTMUSIC',
      } as any);
      const data = (browse as any)?.data || browse;
      const mpr =
        JSON.stringify(data).match(/"browseId":"(MPREb_[^"]+)"/)?.[1] ||
        JSON.stringify(data).match(/MPREb_[A-Za-z0-9_-]+/)?.[0];
      if (mpr) id = mpr;
    } catch {
      /* try getAlbum with original — may throw */
    }
  }

  const album = await innertube.music.getAlbum(id);
  const header = (album as any).header || {};
  const cover = extractThumbs(header, album);

  let artists = artistsFromHeader(header);
  // Certains payloads youtubei exposent les artistes à la racine
  if (!artists.length && Array.isArray((album as any).artists)) {
    artists = ((album as any).artists as any[])
      .map((a) => ({
        name: String(a?.name || '').trim(),
        id: a?.channel_id || a?.id,
      }))
      .filter((a) => isPlausibleArtistName(a.name));
  }
  const year =
    extractYear(header.year) ||
    extractYear(header.subtitle) ||
    extractYear(header.second_subtitle) ||
    undefined;

  const contents = (album as any).contents || (album as any).sections?.[0]?.contents || [];
  const tracks = contents
    .map((c: any) => mapAny(c, cover))
    .filter(Boolean)
    .map((t: Track) => {
      if (!t.thumbnails?.length && cover.length) t.thumbnails = cover;
      if (!t.album) t.album = { name: String(header.title?.text || header.title || 'Album'), id };
      return t;
    }) as Track[];

  // Fallback : artistes les plus fréquents dans les pistes
  if (!artists.length) {
    const counts = new Map<string, { name: string; id?: string; n: number }>();
    for (const t of tracks) {
      for (const a of t.artists || []) {
        if (!a.name || !isPlausibleArtistName(a.name)) continue;
        const key = (a.id || a.name).toLowerCase();
        const cur = counts.get(key);
        if (cur) cur.n += 1;
        else counts.set(key, { name: a.name, id: a.id, n: 1 });
      }
    }
    artists = [...counts.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, 4)
      .map(({ name, id: artistId }) => ({ name, id: artistId }));
  }

  // Dernier recours : meta du 1er titre (getInfo) — souvent fiable
  if (!artists.length) {
    const firstId = tracks.find((t) => /^[a-zA-Z0-9_-]{11}$/.test(t.id))?.id;
    if (firstId) {
      try {
        const { track } = await fetchTrackMeta(firstId, true);
        artists = (track.artists || []).filter((a) => a.name && isPlausibleArtistName(a.name));
      } catch {
        /* ignore */
      }
    }
  }
  // Si light n’a rien donné (author vide), retenter sans light
  if (!artists.length) {
    const firstId = tracks.find((t) => /^[a-zA-Z0-9_-]{11}$/.test(t.id))?.id;
    if (firstId) {
      try {
        const { track } = await fetchTrackMeta(firstId, false);
        artists = (track.artists || []).filter((a) => a.name && isPlausibleArtistName(a.name));
      } catch {
        /* ignore */
      }
    }
  }

  // Enrichir les pistes sans artiste
  if (artists.length) {
    for (const t of tracks) {
      const useful = (t.artists || []).filter((a) => a.name && isPlausibleArtistName(a.name));
      if (!useful.length) t.artists = artists;
      else t.artists = useful;
    }
  }

  const meta: AlbumMeta = {
    id,
    title: String(header.title?.text || header.title || 'Album'),
    year,
    releaseType: inferAlbumReleaseType(header, tracks.length),
    artists,
    thumbnails: cover,
  };

  return { album: meta, tracks };
}

export async function getPlaylist(playlistId: string): Promise<{
  playlist: PlaylistMeta;
  tracks: Track[];
}> {
  const innertube = await getYT();
  const id = playlistId.startsWith('VL') ? playlistId : `VL${playlistId}`;
  const playlist = await innertube.music.getPlaylist(id);
  const header = (playlist as any).header || {};
  const cover = extractThumbs(header, playlist);
  const fromHeaderArtists = artistsFromHeader(header);
  const contents = (playlist as any).contents || (playlist as any).items || [];
  const tracks = contents
    .map((c: any) => mapAny(c, cover))
    .filter(Boolean)
    .map((t: Track) => {
      if (!t.thumbnails?.length && cover.length) t.thumbnails = cover;
      if (!t.artists?.length && fromHeaderArtists.length) t.artists = fromHeaderArtists;
      else if (!t.artists?.length) {
        /* author filled below */
      }
      return t;
    }) as Track[];

  const meta: PlaylistMeta = {
    id: playlistId,
    title: String(header.title?.text || header.title || 'Playlist'),
    author:
      (typeof header.author === 'string' ? header.author : header.author?.name) ||
      fromHeaderArtists[0]?.name ||
      undefined,
    trackCount: parsePlaylistTrackCount(header.song_count, header.second_subtitle?.text, tracks.length),
    thumbnails: cover,
    description: header.description?.text,
  };
  for (const t of tracks) {
    if (!t.artists?.length && meta.author) {
      t.artists = [{ name: String(meta.author) }];
    }
  }
  return { playlist: meta, tracks };
}

/** Extrais un entier depuis song_count ou « … - 27 tracks - … » (jamais le texte brut). */
function parsePlaylistTrackCount(
  songCount: unknown,
  secondSubtitle: unknown,
  fallbackLen: number,
): number | undefined {
  const fromNum = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
    if (typeof v === 'string') {
      const plain = v.trim().match(/^(\d+)$/);
      if (plain) return Number(plain[1]);
      const tracks = v.match(/(\d[\d\s]*)\s*tracks?/i);
      if (tracks) {
        const n = Number(String(tracks[1]).replace(/\s/g, ''));
        if (Number.isFinite(n) && n >= 0) return n;
      }
    }
    return undefined;
  };
  return fromNum(songCount) ?? fromNum(secondSubtitle) ?? (fallbackLen > 0 ? fallbackLen : undefined);
}

async function ytDlpGetUrl(
  videoId: string,
  format: string,
  cookieArgs: string[],
): Promise<string> {
  const { spawn } = await import('node:child_process');
  const ytdlp = join(ROOT, 'bin', 'yt-dlp');
  return new Promise<string>((resolve, reject) => {
    const proxy = (process.env.YOUTUBE_HTTP_PROXY || process.env.HTTPS_PROXY || '').trim();
    const args = [
      '-f',
      format,
      '-g',
      '--no-playlist',
      '--no-warnings',
      // Clients anonymes connus pour éviter LOGIN_REQUIRED / botcheck VPS
      '--extractor-args',
      'youtube:player_client=android_vr,tv,ios,web_embedded,web',
      ...cookieArgs,
      ...(proxy ? ['--proxy', proxy] : []),
      `https://www.youtube.com/watch?v=${videoId}`,
    ];
    const proc = spawn(ytdlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => {
      out += String(c);
    });
    proc.stderr.on('data', (c) => {
      err += String(c);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      const line = out
        .split('\n')
        .map((l) => l.trim())
        .find((l) => /^https?:\/\//.test(l));
      if (code === 0 && line) resolve(line);
      else reject(new Error(err.trim() || `yt-dlp -g exit ${code}`));
    });
  });
}

async function audioFormatViaYtDlp(videoId: string): Promise<AudioFormat> {
  // Anonyme d’abord — cookies optionnels (jamais Premium requis)
  const cookieSets = ytDlpCookieArgSets();

  let lastErr: Error | null = null;
  for (const cookieArgs of cookieSets) {
    for (const format of YTDLP_AUDIO_FORMAT_CANDIDATES) {
      try {
        const url = await ytDlpGetUrl(videoId, format, cookieArgs);
        const abr = (() => {
          try {
            const itag = new URL(url).searchParams.get('itag');
            if (itag === '141' || itag === '774') return 256_000;
            if (itag === '140') return 128_000;
            if (itag === '251') return 160_000;
            if (itag === '250') return 70_000;
            if (itag === '249' || itag === '139') return 50_000;
          } catch {
            /* ignore */
          }
          return undefined;
        })();
        return {
          url,
          mimeType:
            url.includes('mime=audio%2Fmp4') || /[?&]itag=(140|141|139)\b/.test(url)
              ? 'audio/mp4'
              : 'audio/webm',
          bitrate: abr,
          expiresAt: parseExpireMs(url) ?? Date.now() + 3 * 60 * 60 * 1000,
        };
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const msg = lastErr.message;
        // Format absent → essayer le candidat suivant ; sinon aussi
        if (!/format is not available|Requested format/i.test(msg) && cookieArgs.length === 0) {
          /* continue */
        }
      }
    }
  }
  throw lastErr || new Error('yt-dlp audio URL indisponible');
}

export async function getAudioFormat(
  videoId: string,
  opts?: { userId?: string },
): Promise<AudioFormat> {
  const key = audioCacheKey(videoId) + (opts?.userId ? `:u:${opts.userId.slice(0, 8)}` : '');
  const cached = audioFormatCache.get(key);
  // Marge 90 s avant expire pour éviter une URL déjà morte
  if (cached && cached.expiresAt > Date.now() + 90_000) {
    return cached;
  }

  const pending = audioFormatInflight.get(key);
  if (pending) return pending;

  const job = (async (): Promise<AudioFormat> => {
    // Priorité stream sans cookies navigateur :
    // 1) yt-dlp (android_vr/tv/ios) → m4a
    // 2) Innertube clients anonymes (ANDROID_VR / TV / WEB_EMBEDDED / IOS)
    // Les cookies WEB/ANDROID datacenter provoquent souvent LOGIN_REQUIRED — on les évite.
    // Sauf session OAuth TV signée (streamAuth) qui débloque la musique sur VPS.
    const tryInnertube = async (): Promise<AudioFormat | null> => {
      // Session OAuth/cookies signée (VPS) en priorité — débloque LOGIN_REQUIRED musique
      const signed = await getSignedStreamYT(opts?.userId).catch(() => null);
      const innertube = signed || (await getYT());
      // Ordre : clients qui marchent sans session navigateur / sans po_token
      const clients = signed
        ? (['TV', 'ANDROID_VR', 'IOS', 'WEB_EMBEDDED', 'ANDROID'] as const)
        : (['ANDROID_VR', 'TV', 'TV_EMBEDDED', 'WEB_EMBEDDED', 'IOS', 'ANDROID'] as const);
      const tryClient = async (client: (typeof clients)[number]): Promise<AudioFormat> => {
        const format = await Promise.race([
          innertube.getStreamingData(videoId, {
            type: 'audio',
            quality: 'best',
            client,
          }),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error(`innertube ${client} timeout`)), 8_000),
          ),
        ]);
        const url = await format.decipher(innertube.session.player);
        if (!url) throw new Error('empty stream url');
        return {
          url,
          mimeType: format.mime_type,
          bitrate: format.bitrate,
          contentLength: format.content_length,
          expiresAt: parseExpireMs(url) ?? Date.now() + 3 * 60 * 60 * 1000,
        };
      };
      // Essai parallèle sur le sous-ensemble le plus fiable, puis suite
      try {
        const parallel = signed
          ? (['TV', 'ANDROID_VR', 'IOS'] as const)
          : (['ANDROID_VR', 'TV', 'IOS'] as const);
        return await Promise.any(parallel.map((c) => tryClient(c)));
      } catch {
        for (const c of clients) {
          try {
            return await tryClient(c);
          } catch {
            /* next */
          }
        }
        return null;
      }
    };

    const resolveWithCap = async (): Promise<AudioFormat | null> => {
      // Session signée : Innertube d’abord (yt-dlp DC = souvent 0 formats audio)
      const signedFirst = await getSignedStreamYT(opts?.userId).catch(() => null);
      if (signedFirst) {
        const viaSigned = await tryInnertube();
        if (viaSigned) return viaSigned;
      }
      try {
        return await audioFormatViaYtDlp(videoId);
      } catch {
        return await tryInnertube();
      }
    };

    let entry = await Promise.race([
      resolveWithCap(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 14_000)),
    ]);

    if (!entry) {
      try {
        entry = await Promise.race([
          audioFormatViaYtDlp(videoId),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error('yt-dlp format timeout')), 10_000),
          ),
        ]);
      } catch {
        entry = null;
      }
    }

    if (!entry) {
      throw new Error('Audio format indisponible (innertube/yt-dlp)');
    }

    audioFormatCache.set(key, entry);
    if (audioFormatCache.size > 250) {
      const stale = [...audioFormatCache.entries()]
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
        .slice(0, 80);
      for (const [id] of stale) audioFormatCache.delete(id);
    }
    return entry;
  })();

  // Important : le promise exposé (et l’inflight) doit aussi expirer,
  // sinon un 1er appel « abandonné » bloque tous les suivants sur la même clé.
  const capped = Promise.race([
    job,
    new Promise<AudioFormat>((_, rej) =>
      setTimeout(() => rej(new Error('getAudioFormat deadline')), 16_000),
    ),
  ]).finally(() => {
    audioFormatInflight.delete(key);
  });

  audioFormatInflight.set(key, capped);
  return capped;
}

/** Force une URL via yt-dlp (après 403 Innertube / cache pourri). */
export async function getAudioFormatViaYtDlpOnly(videoId: string): Promise<AudioFormat> {
  invalidateAudioFormat(videoId);
  const key = audioCacheKey(videoId);
  const entry = await audioFormatViaYtDlp(videoId);
  audioFormatCache.set(key, entry);
  return entry;
}

const videoFormatCache = new Map<string, AudioFormat>();
const videoFormatInflight = new Map<string, Promise<AudioFormat>>();

async function videoFormatViaYtDlp(videoId: string): Promise<AudioFormat> {
  const { spawn } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const ytdlp = join(ROOT, 'bin', 'yt-dlp');
  if (!existsSync(ytdlp)) throw new Error('yt-dlp introuvable');
  const url = await new Promise<string>((resolve, reject) => {
    const proc = spawn(
      ytdlp,
      [
        '-f',
        '18/22/best[height<=720][acodec!=none][vcodec!=none]/best[height<=480][acodec!=none]/best',
        '-g',
        '--no-playlist',
        '--no-warnings',
        '--extractor-args',
        'youtube:player_client=android_vr,tv,ios,web_embedded',
        ...ytDlpCookieArgs(),
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => {
      out += String(d);
    });
    proc.stderr.on('data', (d) => {
      err += String(d);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      const line = out
        .split('\n')
        .map((l) => l.trim())
        .find((l) => /^https?:\/\//.test(l));
      if (code === 0 && line) resolve(line);
      else reject(new Error(err.trim() || `yt-dlp -g video exit ${code}`));
    });
  });
  return {
    url,
    mimeType: 'video/mp4',
    expiresAt: parseExpireMs(url) ?? Date.now() + 3 * 60 * 60 * 1000,
  };
}

/** Stream progressif vidéo+audio (onglet Vidéo / sync image+son). */
export async function getVideoFormat(videoId: string): Promise<AudioFormat> {
  const cached = videoFormatCache.get(videoId);
  if (cached && cached.expiresAt > Date.now() + 90_000) return cached;

  const pending = videoFormatInflight.get(videoId);
  if (pending) return pending;

  const looksLikeVideo = (url: string, mime?: string) => {
    const u = url.toLowerCase();
    const m = (mime || '').toLowerCase();
    if (m.includes('video/')) return true;
    // itags progressifs courants : 18, 22, 59…
    if (/[?&]itag=(18|22|59|78|83|85|93|94|95|96|132|151)\b/.test(u)) return true;
    if (u.includes('mime=video')) return true;
    // Refuser les itags audio purs
    if (/[?&]itag=(139|140|141|249|250|251|256|258)\b/.test(u)) return false;
    if (m.includes('audio/')) return false;
    return false;
  };

  const job = (async (): Promise<AudioFormat> => {
    // yt-dlp d’abord : formats progressifs fiables (18/22)
    try {
      const entry = await videoFormatViaYtDlp(videoId);
      if (looksLikeVideo(entry.url, entry.mimeType)) {
        videoFormatCache.set(videoId, entry);
        return entry;
      }
    } catch {
      /* try innertube */
    }

    const innertube = await getYT();
    const clients = ['ANDROID_VR', 'TV', 'IOS', 'WEB_EMBEDDED', 'ANDROID'] as const;
    let lastErr: unknown;
    for (const client of clients) {
      try {
        const format = await innertube.getStreamingData(videoId, {
          type: 'video+audio',
          quality: '360p',
          client,
        } as any);
        const url = await format.decipher(innertube.session.player);
        if (!url) throw new Error('empty video url');
        const entry: AudioFormat = {
          url,
          mimeType: format.mime_type || 'video/mp4',
          bitrate: format.bitrate,
          contentLength: format.content_length,
          expiresAt: parseExpireMs(url) ?? Date.now() + 3 * 60 * 60 * 1000,
        };
        if (!looksLikeVideo(entry.url, entry.mimeType)) {
          throw new Error(`not a progressive video format (${entry.mimeType})`);
        }
        videoFormatCache.set(videoId, entry);
        if (videoFormatCache.size > 120) {
          const stale = [...videoFormatCache.entries()]
            .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
            .slice(0, 40);
          for (const [id] of stale) videoFormatCache.delete(id);
        }
        return entry;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Aucun format vidéo progressif');
  })().finally(() => {
    videoFormatInflight.delete(videoId);
  });

  videoFormatInflight.set(videoId, job);
  return job;
}
