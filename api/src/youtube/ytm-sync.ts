import { Innertube, UniversalCache, ClientType } from 'youtubei.js';
import { extractThumbs, mapAny } from './mappers.js';
import {
  addHistory,
  addToPlaylist,
  createPlaylist,
  getFullLibrary,
  isTrackInLibrary,
  isTrackLiked,
  listPlaylists,
  saveAlbumWithTracks,
  saveArtist,
  toggleLikePlaylist,
  toggleLikeTrack,
  toggleLibraryTrack,
} from '../library/library.js';
import { getYtmCredentials, markYtmSynced, saveYtmOauth } from './ytm-account.js';
import type { Track } from './types.js';

const userSessions = new Map<string, Innertube>();

type PendingOauth = {
  yt: Innertube;
  verificationUrl: string;
  userCode: string;
  expiresIn: number;
  done: boolean;
  error?: string;
};

const pendingOauth = new Map<string, PendingOauth>();

export async function getYTForUser(userId: string): Promise<Innertube> {
  const cached = userSessions.get(userId);
  if (cached) return cached;

  const creds = getYtmCredentials(userId);
  if (!creds) throw new Error('Compte YouTube Music non connecté');

  // Google a cassé OAuth pour YTM (browse → 400). Cookies SAPISID requis.
  if (!creds.cookie) {
    throw new Error(
      'Cookies YouTube Music requis pour synchroniser la bibliothèque. ' +
        'OAuth (code appareil) ne suffit plus. Sur music.youtube.com → F12 → Réseau → browse → copie l’en-tête Cookie.',
    );
  }

  const yt = await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
    client_type: ClientType.MUSIC,
    cookie: creds.cookie,
  });

  userSessions.set(userId, yt);
  return yt;
}

/** Vérifie que la session cookies peut lire la biblio YTM. */
export async function probeYtmLibraryAccess(userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    clearYtmSession(userId);
    const yt = await getYTForUser(userId);
    await yt.music.getLibrary();
    return { ok: true };
  } catch (e) {
    clearYtmSession(userId);
    return { ok: false, error: String((e as Error).message || e) };
  }
}

export function clearYtmSession(userId: string) {
  userSessions.delete(userId);
  pendingOauth.delete(userId);
}

function collectItems(lib: any): any[] {
  const out: any[] = [];
  for (const section of lib?.contents || []) {
    const items = section?.contents || section?.items || [];
    if (Array.isArray(items)) out.push(...items);
  }
  if (!out.length && Array.isArray(lib?.contents)) {
    for (const c of lib.contents) {
      if (c?.id || c?.video_id) out.push(c);
    }
  }
  return out;
}

async function collectAllFiltered(yt: Innertube, filterHints: string[]) {
  const base = await yt.music.getLibrary();
  const filters = (base.filters || []).map(String);
  const picked = filterHints.find((h) =>
    filters.some((f) => f.toLowerCase().includes(h.toLowerCase())),
  );

  let page = base;
  if (picked) {
    const match = filters.find((f) => f.toLowerCase().includes(picked.toLowerCase())) || picked;
    try {
      page = await base.applyFilter(match);
    } catch {
      /* keep base */
    }
  }

  const items = collectItems(page);
  let guard = 0;
  let cur: any = page;
  while (cur?.has_continuation && guard < 60) {
    cur = await cur.getContinuation();
    const cont = cur?.contents;
    const more = cont?.contents || cont?.items || collectItems(cur);
    if (Array.isArray(more)) items.push(...more);
    guard += 1;
  }
  return items;
}

async function fetchPlaylistTracks(
  yt: Innertube,
  playlistId: string,
  maxTracks = 500,
): Promise<{ title: string; tracks: Track[] }> {
  const id = playlistId.startsWith('VL') ? playlistId : `VL${playlistId}`;
  let playlist: any = await yt.music.getPlaylist(id);
  const header = playlist.header || {};
  const cover = extractThumbs(header, playlist);
  const title = String(header.title?.text || header.title || 'Playlist');
  const tracks: Track[] = [];
  let guard = 0;
  while (playlist && guard < 40 && tracks.length < maxTracks) {
    const contents = playlist.contents || playlist.items || [];
    for (const c of contents) {
      if (tracks.length >= maxTracks) break;
      const m = mapAny(c, cover);
      if (!m) continue;
      if (!m.thumbnails?.length && cover.length) m.thumbnails = cover;
      tracks.push(m);
    }
    if (!playlist.has_continuation) break;
    try {
      playlist = await playlist.getContinuation();
    } catch {
      break;
    }
    guard += 1;
  }
  return { title, tracks };
}

function ensureLiked(userId: string, track: Track) {
  if (!track?.id) return false;
  if (isTrackLiked(userId, track.id)) return false;
  toggleLikeTrack(userId, track);
  return true;
}

/** Ajoute en biblio sans retirer (évite le toggle inverse). */
function ensureSaved(userId: string, track: Track) {
  if (!track?.id) return false;
  if (isTrackInLibrary(userId, track.id)) return false;
  toggleLibraryTrack(userId, track);
  return true;
}

function ensureLikedPlaylist(userId: string, playlist: Record<string, unknown>) {
  const id = String(playlist.id || '');
  if (!id) return false;
  const lib = getFullLibrary(userId);
  if (lib.likedPlaylists.some((p: any) => String(p.id) === id)) return false;
  toggleLikePlaylist(userId, playlist);
  return true;
}

async function upsertLocalPlaylist(userId: string, name: string, ytmId: string, tracks: Track[]) {
  const existing = listPlaylists(userId).find(
    (p) => p.description.includes(`ytm:${ytmId}`) || p.name === name,
  );
  let pl = existing;
  if (!pl) {
    pl = createPlaylist(userId, name, `Importé depuis YouTube Music · ytm:${ytmId}`);
  }
  let added = 0;
  for (const t of tracks) {
    const before = pl.tracks.length;
    pl = await addToPlaylist(userId, pl.id, t);
    if (pl.tracks.length > before) added += 1;
  }
  return { playlistId: pl.id, added };
}

function albumAlreadySaved(userId: string, albumId: string) {
  return getFullLibrary(userId).albums.some((a: any) => String(a.id) === albumId);
}

function artistAlreadySaved(userId: string, artistId: string) {
  return getFullLibrary(userId).artists.some((a: any) => String(a.id) === artistId);
}

export type SyncStats = {
  songs: number;
  librarySongs: number;
  albums: number;
  artists: number;
  playlists: number;
  playlistTracks: number;
  likedSongsPlaylist: number;
  history: number;
};

export async function syncYtmLibrary(userId: string): Promise<{
  stats: SyncStats;
  library: ReturnType<typeof getFullLibrary>;
}> {
  const probe = await probeYtmLibraryAccess(userId);
  if (!probe.ok) {
    throw new Error(
      probe.error.includes('Cookies')
        ? probe.error
        : `Impossible d’accéder à la bibliothèque YTM (${probe.error}). Recolle des cookies frais depuis music.youtube.com (session navigateur).`,
    );
  }

  const yt = await getYTForUser(userId);
  const stats: SyncStats = {
    songs: 0,
    librarySongs: 0,
    albums: 0,
    artists: 0,
    playlists: 0,
    playlistTracks: 0,
    likedSongsPlaylist: 0,
    history: 0,
  };

  try {
    const liked = await fetchPlaylistTracks(yt, 'LM', 2000);
    for (const t of liked.tracks || []) {
      if (ensureLiked(userId, t)) {
        stats.songs += 1;
        stats.likedSongsPlaylist += 1;
      }
    }
  } catch (e) {
    console.warn('sync LM', e);
  }

  try {
    const songItems = await collectAllFiltered(yt, ['song', 'titre', 'track', 'morceau']);
    for (const item of songItems) {
      const m = mapAny(item);
      if (!m || (m.type !== 'song' && m.type !== 'video' && m.type !== 'unknown')) continue;
      if (ensureSaved(userId, m)) stats.librarySongs += 1;
    }
  } catch (e) {
    console.warn('sync songs', e);
  }

  try {
    const albumItems = await collectAllFiltered(yt, ['album']);
    for (const item of albumItems) {
      const m = mapAny(item);
      if (!m?.id) continue;
      if (!(m.type === 'album' || String(m.id).startsWith('MPREb'))) continue;
      const wasNew = !albumAlreadySaved(userId, m.id);
      const { tracksAdded } = await saveAlbumWithTracks(userId, {
        id: m.id,
        title: m.title,
        artists: m.artists,
        thumbnails: m.thumbnails,
        type: 'album',
      });
      if (wasNew) stats.albums += 1;
      stats.librarySongs += tracksAdded;
    }
  } catch (e) {
    console.warn('sync albums', e);
  }

  try {
    const artistItems = await collectAllFiltered(yt, ['artist', 'artiste']);
    for (const item of artistItems) {
      const m = mapAny(item);
      if (!m?.id) continue;
      if (!(m.type === 'artist' || String(m.id).startsWith('UC'))) continue;
      const wasNew = !artistAlreadySaved(userId, m.id);
      saveArtist(userId, {
        id: m.id,
        title: m.title,
        name: m.title,
        thumbnails: m.thumbnails,
        type: 'artist',
      });
      if (wasNew) stats.artists += 1;
    }
  } catch (e) {
    console.warn('sync artists', e);
  }

  try {
    const playlistItems = await collectAllFiltered(yt, ['playlist', 'liste']);
    for (const item of playlistItems) {
      const m = mapAny(item);
      if (!m?.id) continue;
      if (
        !(
          m.type === 'playlist' ||
          m.id.startsWith('PL') ||
          m.id.startsWith('VL') ||
          m.id.startsWith('RD')
        )
      ) {
        continue;
      }
      if (
        ensureLikedPlaylist(userId, {
          id: m.id,
          title: m.title,
          thumbnails: m.thumbnails,
          type: 'playlist',
        })
      ) {
        stats.playlists += 1;
      }
      try {
        const full = await fetchPlaylistTracks(yt, m.id, 500);
        const mirror = await upsertLocalPlaylist(userId, full.title || m.title, m.id, full.tracks || []);
        stats.playlistTracks += mirror.added;
      } catch {
        /* playlist privée / indispo */
      }
    }
  } catch (e) {
    console.warn('sync playlists', e);
  }

  try {
    const recentItems = await collectAllFiltered(yt, [
      'recent',
      'récents',
      'history',
      'historique',
      'écoute',
      'activity',
    ]);
    for (const item of recentItems) {
      const m = mapAny(item);
      if (!m?.id || (m.type !== 'song' && m.type !== 'video' && m.type !== 'unknown')) continue;
      if (!/^[a-zA-Z0-9_-]{11}$/.test(m.id)) continue;
      addHistory(userId, m);
      stats.history += 1;
    }
  } catch (e) {
    console.warn('sync history', e);
  }

  const summary =
    `+${stats.songs} likes, ${stats.librarySongs} titres biblio, ${stats.albums} albums, ` +
    `${stats.artists} artistes, ${stats.playlists} playlists, ${stats.history} récents`;
  markYtmSynced(userId, summary);
  return { stats, library: getFullLibrary(userId) };
}

/** Démarre OAuth device YouTube ; le client affiche le code puis poll /oauth/status. */
export async function startYtmDeviceOauth(userId: string) {
  clearYtmSession(userId);
  const yt = await Innertube.create({
    cache: new UniversalCache(false),
    generate_session_locally: true,
    client_type: ClientType.WEB,
  });

  const pending: PendingOauth = {
    yt,
    verificationUrl: '',
    userCode: '',
    expiresIn: 0,
    done: false,
  };
  pendingOauth.set(userId, pending);

  yt.session.on('auth-pending', (data) => {
    pending.verificationUrl = data.verification_url;
    pending.userCode = data.user_code;
    pending.expiresIn = data.expires_in;
  });

  yt.session.on('auth', ({ credentials }) => {
    saveYtmOauth(userId, credentials as unknown as Record<string, unknown>);
    userSessions.set(userId, yt);
    pending.done = true;
  });

  yt.session.on('auth-error', (err) => {
    pending.error = String(err?.message || err);
    pending.done = true;
  });

  void yt.session.signIn().catch((err) => {
    pending.error = String(err?.message || err);
    pending.done = true;
  });

  for (let i = 0; i < 50; i++) {
    if (pending.userCode) break;
    if (pending.error) throw new Error(pending.error);
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!pending.userCode) throw new Error('Impossible d’obtenir le code Google TV');

  return {
    verificationUrl: pending.verificationUrl,
    userCode: pending.userCode,
    expiresIn: pending.expiresIn,
  };
}

export function getYtmOauthStatus(userId: string) {
  const account = getYtmCredentials(userId);
  if (account) return { status: 'connected' as const };
  const pending = pendingOauth.get(userId);
  if (!pending) return { status: 'idle' as const };
  if (pending.error) return { status: 'error' as const, error: pending.error };
  if (pending.done) return { status: 'connected' as const };
  return {
    status: 'pending' as const,
    verificationUrl: pending.verificationUrl,
    userCode: pending.userCode,
  };
}
