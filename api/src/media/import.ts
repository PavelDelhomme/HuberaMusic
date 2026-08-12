import { getAlbum, getArtist, getPlaylist, getTrack, search } from '../youtube/yt.js';
import {
  addToPlaylist,
  createPlaylist,
  listPlaylists,
  saveArtist,
  toggleLikePlaylist,
} from '../library/library.js';
import type { Track } from '../youtube/types.js';

export type ImportResult = {
  kind: 'track' | 'album' | 'artist' | 'playlist';
  id: string;
  title: string;
  added: {
    album?: boolean;
    artist?: boolean;
    playlist?: boolean;
    tracks?: number;
  };
  tracks?: Track[];
};

function parseYouTubeMusicUrl(input: string): { kind: 'track' | 'album' | 'artist' | 'playlist'; id: string } | null {
  const raw = input.trim();
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, '');
    if (!host.includes('youtube.com') && host !== 'youtu.be' && !host.includes('music.youtube.com')) {
      return null;
    }

    if (host === 'youtu.be') {
      const id = url.pathname.slice(1);
      if (id) return { kind: 'track', id };
    }

    const list = url.searchParams.get('list');
    const v = url.searchParams.get('v');
    if (list) return { kind: 'playlist', id: list };
    if (v) return { kind: 'track', id: v };

    const browse = url.searchParams.get('browseId') || '';
    if (browse) {
      if (browse.startsWith('MPREb_') || browse.startsWith('OLAK5')) return { kind: 'album', id: browse };
      if (browse.startsWith('UC')) return { kind: 'artist', id: browse };
      return { kind: 'playlist', id: browse };
    }

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'channel' && parts[1]) return { kind: 'artist', id: parts[1] };
  } catch {
    /* bare id */
  }

  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return { kind: 'track', id: raw };
  if (raw.startsWith('MPREb_') || raw.startsWith('OLAK5uy')) return { kind: 'album', id: raw };
  if (raw.startsWith('UC')) return { kind: 'artist', id: raw };
  if (raw.startsWith('PL') || raw.startsWith('VL') || raw.startsWith('RD')) return { kind: 'playlist', id: raw };
  return null;
}

export async function importByQueryOrUrl(
  userId: string,
  input: string,
  options?: { likePlaylist?: boolean; createLocalCopy?: boolean },
): Promise<ImportResult> {
  const parsed = parseYouTubeMusicUrl(input);
  if (parsed) return importByKind(userId, parsed.kind, parsed.id, options);

  const results = await search(input);
  if (results.songs[0]) return importByKind(userId, 'track', results.songs[0].id, options);
  if (results.albums[0]) return importByKind(userId, 'album', results.albums[0].id, options);
  if (results.artists[0]) return importByKind(userId, 'artist', results.artists[0].id, options);
  if (results.playlists[0]) return importByKind(userId, 'playlist', results.playlists[0].id, options);
  throw new Error('Aucun résultat à importer');
}

export async function importByKind(
  userId: string,
  kind: 'track' | 'album' | 'artist' | 'playlist',
  id: string,
  options?: { likePlaylist?: boolean; createLocalCopy?: boolean },
): Promise<ImportResult> {
  if (kind === 'track') {
    const { track } = await getTrack(id);
    let playlists = listPlaylists(userId);
    let target = playlists.find((p) => p.name === 'Importés');
    if (!target) target = createPlaylist(userId, 'Importés');
    addToPlaylist(userId, target.id, track);
    return {
      kind: 'track',
      id: track.id,
      title: track.title,
      added: { tracks: 1, playlist: true },
      tracks: [track],
    };
  }

  if (kind === 'album') {
    const { album, tracks } = await getAlbum(id);
    // Album + tous les titres en biblio (pas en likes)
    const { saveAlbumWithTracks } = await import('../library/library.js');
    const saved = await saveAlbumWithTracks(userId, {
      id: album.id,
      title: album.title,
      year: album.year,
      artists: album.artists,
      thumbnails: album.thumbnails,
      type: 'album',
      tracks,
    });
    // Copie locale optionnelle (explicit createLocalCopy) — désactivée par défaut
    let playlistCopy = false;
    if (options?.createLocalCopy === true) {
      const pl = createPlaylist(
        userId,
        album.title,
        `Album · ${album.artists.map((a) => a.name).join(', ')}`,
      );
      for (const t of tracks) addToPlaylist(userId, pl.id, t);
      playlistCopy = true;
    }
    return {
      kind: 'album',
      id: album.id,
      title: album.title,
      added: {
        album: true,
        tracks: saved.tracksTotal,
        playlist: playlistCopy,
      },
      tracks,
    };
  }

  if (kind === 'artist') {
    const { artist, songs, albums } = await getArtist(id);
    saveArtist(userId, {
      id: artist.id,
      name: artist.name,
      subscribers: artist.subscribers,
      thumbnails: artist.thumbnails,
      description: artist.description,
      type: 'artist',
    });
    // Pas d’auto-import albums / playlist « Top » : ça remplissait la biblio de titres
    let copied = 0;
    if (options?.createLocalCopy === true) {
      for (const a of albums.slice(0, 5)) {
        try {
          const full = await getAlbum(a.id);
          const { saveAlbumWithTracks } = await import('../library/library.js');
          await saveAlbumWithTracks(userId, {
            id: full.album.id,
            title: full.album.title,
            year: full.album.year,
            artists: full.album.artists,
            thumbnails: full.album.thumbnails,
            type: 'album',
            tracks: full.tracks,
          });
        } catch {
          /* ignore */
        }
      }
      const pl = createPlaylist(userId, `${artist.name} — Top`, 'Import artiste');
      for (const t of songs.slice(0, 25)) addToPlaylist(userId, pl.id, t);
      copied = Math.min(25, songs.length);
    }
    return {
      kind: 'artist',
      id: artist.id,
      title: artist.name,
      added: { artist: true, tracks: copied, playlist: copied > 0 },
      tracks: copied > 0 ? songs.slice(0, 25) : undefined,
    };
  }

  const { playlist, tracks } = await getPlaylist(id);
  const meta = {
    id: playlist.id,
    title: playlist.title,
    author: playlist.author,
    trackCount: playlist.trackCount,
    thumbnails: playlist.thumbnails,
    description: playlist.description,
    type: 'playlist',
  };
  // Enregistrer = aimer la playlist, sans dupliquer tous les titres en « Titres » / playlist locale
  if (options?.likePlaylist !== false) toggleLikePlaylist(userId, meta);
  let copied = 0;
  if (options?.createLocalCopy === true) {
    const local = createPlaylist(
      userId,
      playlist.title,
      playlist.description || `Import YouTube · ${playlist.author || ''}`,
    );
    for (const t of tracks) addToPlaylist(userId, local.id, t);
    copied = tracks.length;
  }
  return {
    kind: 'playlist',
    id: playlist.id,
    title: playlist.title,
    added: { playlist: true, tracks: copied },
    tracks: copied > 0 ? tracks : undefined,
  };
}
