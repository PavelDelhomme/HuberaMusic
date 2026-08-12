import { create } from 'zustand';
import { api, type LibraryData, type Track } from '../api';

type LibraryState = LibraryData & {
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  applyLibrary: (lib: LibraryData | null | undefined) => void;
  toggleLike: (track: Track) => Promise<boolean>;
  toggleLibrarySong: (track: Track) => Promise<boolean>;
  createPlaylist: (name: string, description?: string) => Promise<import('../api').LibraryPlaylist | undefined>;
  deletePlaylist: (id: string) => Promise<void>;
  addToPlaylist: (playlistId: string, track: Track) => Promise<void>;
  addTracksToPlaylist: (playlistId: string, tracks: Track[]) => Promise<void>;
  recordPlay: (track: Track) => Promise<void>;
  recordEntityPlay: (entity: {
    id: string;
    kind: 'playlist' | 'album' | 'artist' | 'mix';
    title?: string;
    thumbnails?: Track['thumbnails'];
    artists?: Track['artists'];
  }) => Promise<void>;
  isLiked: (id: string) => boolean;
  isInLibrary: (id: string) => boolean;
  hasAlbum: (id: string) => boolean;
  hasArtist: (id: string) => boolean;
  hasMix: (id: string) => boolean;
  isPlaylistLiked: (id: string) => boolean;
  saveMix: (mix: { id: string; title: string; tracks?: Track[]; covers?: Track[] }) => Promise<boolean>;
  removeMix: (id: string) => Promise<void>;
};

const empty: LibraryData = {
  songs: [],
  liked: [],
  likedPlaylists: [],
  albums: [],
  artists: [],
  mixes: [],
  playlists: [],
  history: [],
  recentEntities: [],
  downloaded: [],
};

const LIB_CACHE_KEY = 'ytm_library_v1';

function mergeLibrary(lib: LibraryData): LibraryData {
  const liked = Array.isArray(lib.liked) ? lib.liked : [];
  // Compat anciennes réponses API sans `songs`
  const songs = Array.isArray(lib.songs) ? lib.songs : liked;
  return {
    songs,
    liked,
    likedPlaylists: Array.isArray(lib.likedPlaylists) ? lib.likedPlaylists : [],
    albums: Array.isArray(lib.albums) ? lib.albums : [],
    artists: Array.isArray(lib.artists) ? lib.artists : [],
    mixes: Array.isArray((lib as LibraryData).mixes) ? (lib as LibraryData).mixes : [],
    playlists: Array.isArray(lib.playlists) ? lib.playlists : [],
    history: Array.isArray(lib.history) ? lib.history : [],
    recentEntities: Array.isArray((lib as LibraryData).recentEntities)
      ? (lib as LibraryData).recentEntities
      : [],
    downloaded: Array.isArray(lib.downloaded) ? lib.downloaded : [],
  };
}

function readLibraryCache(): LibraryData | null {
  try {
    const raw =
      localStorage.getItem(LIB_CACHE_KEY) || sessionStorage.getItem(LIB_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LibraryData;
    if (!parsed || typeof parsed !== 'object') return null;
    return mergeLibrary(parsed);
  } catch {
    return null;
  }
}

function writeLibraryCache(lib: LibraryData) {
  try {
    const slim = {
      ...lib,
      // Limite taille localStorage
      songs: lib.songs.slice(0, 200),
      liked: lib.liked.slice(0, 200),
      history: lib.history.slice(0, 80),
      downloaded: lib.downloaded.slice(0, 80),
      playlists: lib.playlists.slice(0, 80).map((p) => ({
        ...p,
        tracks: (p.tracks || []).slice(0, 2),
      })),
    };
    const raw = JSON.stringify(slim);
    localStorage.setItem(LIB_CACHE_KEY, raw);
    sessionStorage.setItem(LIB_CACHE_KEY, raw);
  } catch {
    /* quota / private mode */
  }
}

const bootCache = typeof localStorage !== 'undefined' || typeof sessionStorage !== 'undefined'
  ? readLibraryCache()
  : null;

export const useLibrary = create<LibraryState>((set, get) => ({
  ...(bootCache || empty),
  loaded: Boolean(bootCache),
  error: null,

  applyLibrary: (lib) => {
    if (!lib || typeof lib !== 'object') return;
    const merged = mergeLibrary(lib);
    writeLibraryCache(merged);
    set({ ...merged, loaded: true, error: null });
  },

  refresh: async () => {
    try {
      const data = await api.library();
      const merged = mergeLibrary(data);
      writeLibraryCache(merged);
      set({ ...merged, loaded: true, error: null });
    } catch (e) {
      set({
        loaded: true,
        error: e instanceof Error ? e.message : 'Bibliothèque indisponible',
      });
    }
  },

  toggleLike: async (track) => {
    const wasLiked = get().isLiked(track.id);
    set((s) => ({
      liked: wasLiked
        ? s.liked.filter((t) => t.id !== track.id)
        : [track, ...s.liked.filter((t) => t.id !== track.id)],
    }));
    try {
      const r = await api.like(track);
      if (r.library) get().applyLibrary(r.library);
      else {
        set((s) => ({
          liked: r.liked
            ? [track, ...s.liked.filter((t) => t.id !== track.id)]
            : s.liked.filter((t) => t.id !== track.id),
        }));
      }
      // Réoriente les futures propositions (file déjà chargée intacte)
      try {
        const { usePlayer } = await import('./player');
        usePlayer.getState().refreshRecoAfterFeedback(track.id, r.liked ? 'good' : 'bad');
        void api
          .recoFeedback({
            trackId: track.id,
            verdict: r.liked ? 'good' : 'bad',
            context: 'like_toggle',
          })
          .catch(() => undefined);
      } catch {
        /* ignore */
      }
      return r.liked;
    } catch {
      set((s) => ({
        liked: wasLiked
          ? [track, ...s.liked.filter((t) => t.id !== track.id)]
          : s.liked.filter((t) => t.id !== track.id),
      }));
      throw new Error('like failed');
    }
  },

  toggleLibrarySong: async (track) => {
    const wasSaved = get().isInLibrary(track.id);
    set((s) => ({
      songs: wasSaved
        ? s.songs.filter((t) => t.id !== track.id)
        : [track, ...s.songs.filter((t) => t.id !== track.id)],
    }));
    try {
      const r = await api.toggleLibrarySong(track);
      if (r.library) get().applyLibrary(r.library);
      else {
        set((s) => ({
          songs: r.saved
            ? [track, ...s.songs.filter((t) => t.id !== track.id)]
            : s.songs.filter((t) => t.id !== track.id),
        }));
      }
      return r.saved;
    } catch {
      set((s) => ({
        songs: wasSaved
          ? [track, ...s.songs.filter((t) => t.id !== track.id)]
          : s.songs.filter((t) => t.id !== track.id),
      }));
      throw new Error('library song failed');
    }
  },

  createPlaylist: async (name, description = '') => {
    const pl = await api.createPlaylist(name, description);
    await get().refresh();
    return pl;
  },

  deletePlaylist: async (id) => {
    const { library } = await api.deletePlaylist(id);
    get().applyLibrary(library);
  },

  addToPlaylist: async (playlistId, track) => {
    const updated = await api.addToPlaylist(playlistId, track);
    if (updated?.id) {
      set((s) => ({
        playlists: s.playlists.some((p) => p.id === updated.id)
          ? s.playlists.map((p) => (p.id === updated.id ? updated : p))
          : [updated, ...s.playlists],
      }));
    } else {
      await get().refresh();
    }
  },

  addTracksToPlaylist: async (playlistId, tracks) => {
    const seen = new Set<string>();
    let updated = null as Awaited<ReturnType<typeof api.addToPlaylist>> | null;
    for (const t of tracks) {
      if (!t?.id || seen.has(t.id)) continue;
      seen.add(t.id);
      updated = await api.addToPlaylist(playlistId, t);
    }
    if (updated?.id) {
      set((s) => ({
        playlists: s.playlists.map((p) => (p.id === updated!.id ? updated! : p)),
      }));
    } else {
      await get().refresh();
    }
  },

  recordPlay: async (track: Track) => {
    // Optimistic seulement — l’écriture serveur passe par api.listen (évite double compteur)
    set((s) => ({
      history: [track, ...s.history.filter((t) => t.id !== track.id)].slice(0, 500),
    }));
  },

  recordEntityPlay: async (entity) => {
    const asTrack: Track = {
      id: entity.id,
      title: entity.title || entity.id,
      type: entity.kind,
      artists: entity.artists || [],
      thumbnails: entity.thumbnails || [],
    };
    set((s) => ({
      recentEntities: [asTrack, ...s.recentEntities.filter((t) => t.id !== entity.id)].slice(0, 40),
    }));
    try {
      const { entities } = await api.recordEntityPlay(entity);
      set({ recentEntities: entities });
    } catch {
      /* keep optimistic */
    }
  },

  isLiked: (id) => get().liked.some((t) => t.id === id),
  isInLibrary: (id) => get().songs.some((t) => t.id === id),
  hasAlbum: (id) => get().albums.some((a) => a.id === id),
  hasArtist: (id) => get().artists.some((a) => a.id === id),
  hasMix: (id) => get().mixes.some((m) => m.id === id),
  isPlaylistLiked: (id) => get().likedPlaylists.some((p) => p.id === id),
  saveMix: async (mix) => {
    const r = await api.saveMix(mix);
    if (r.library) get().applyLibrary(r.library);
    return r.saved;
  },
  removeMix: async (id) => {
    const r = await api.removeMix(id);
    get().applyLibrary(r.library);
  },
}));
