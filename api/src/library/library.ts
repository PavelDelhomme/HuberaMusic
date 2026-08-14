import { randomUUID } from 'node:crypto';
import { db, getTrackPayload, upsertTrack } from './db.js';
import { sanitizeTrack, sanitizeLibraryItem, isWeakTitle } from '../youtube/mappers.js';
import type { Track } from '../youtube/types.js';

export type LibraryPlaylist = {
  id: string;
  name: string;
  description: string;
  coverUrl?: string;
  createdAt: number;
  updatedAt: number;
  tracks: Track[];
  /** Nombre de titres (utile quand tracks est allégé). */
  trackCount?: number;
};

function parseTrack(row: { payload?: string; track_id?: string }): Track | null {
  if (row.payload) {
    try {
      return sanitizeTrack(JSON.parse(row.payload) as Track);
    } catch {
      /* fallthrough */
    }
  }
  if (row.track_id) {
    const t = getTrackPayload(row.track_id);
    return t ? sanitizeTrack(t) : null;
  }
  return null;
}

function trackFromRow(r: { track_id: string; payload: string | null }): Track {
  if (r.payload) {
    try {
      return sanitizeTrack(JSON.parse(r.payload) as Track);
    } catch {
      /* fallthrough */
    }
  }
  return {
    id: r.track_id,
    title: r.track_id,
    artists: [],
    thumbnails: [],
    type: 'song',
  };
}

export function getFullLibrary(userId: string) {
  // LEFT JOIN : un like/save sans cache ne disparaît plus (placeholder minimal)
  const likedRows = db
    .prepare(
      `SELECT l.track_id AS track_id, t.payload AS payload
       FROM liked_tracks l
       LEFT JOIN tracks_cache t ON t.id = l.track_id
       WHERE l.user_id = ?
       ORDER BY l.created_at DESC`,
    )
    .all(userId) as { track_id: string; payload: string | null }[];

  const songRows = db
    .prepare(
      `SELECT l.track_id AS track_id, t.payload AS payload
       FROM library_tracks l
       LEFT JOIN tracks_cache t ON t.id = l.track_id
       WHERE l.user_id = ?
       ORDER BY l.created_at DESC`,
    )
    .all(userId) as { track_id: string; payload: string | null }[];

  const likedPlaylists = (
    db
      .prepare(
        `SELECT playlist_id, payload FROM liked_playlists WHERE user_id = ? ORDER BY created_at DESC`,
      )
      .all(userId) as { playlist_id: string; payload: string }[]
  ).map((r) => JSON.parse(r.payload));

  const albums = (
    db
      .prepare(`SELECT payload FROM library_albums WHERE user_id = ? ORDER BY created_at DESC`)
      .all(userId) as { payload: string }[]
  ).map((r) => sanitizeLibraryItem(JSON.parse(r.payload)));

  const artists = (
    db
      .prepare(`SELECT payload FROM library_artists WHERE user_id = ? ORDER BY created_at DESC`)
      .all(userId) as { payload: string }[]
  ).map((r) => sanitizeLibraryItem(JSON.parse(r.payload)));

  const mixes = (
    db
      .prepare(`SELECT payload FROM library_mixes WHERE user_id = ? ORDER BY created_at DESC`)
      .all(userId) as { payload: string }[]
  ).map((r) => {
    try {
      const raw = JSON.parse(r.payload) as Record<string, unknown>;
      return {
        ...raw,
        id: String(raw.id || ''),
        title: String(raw.title || 'Mix'),
        type: 'mix',
      };
    } catch {
      return null;
    }
  }).filter(Boolean);

  const playlists = (() => {
    // Garantit la playlist système « Titres J'aime » (sans resync à chaque GET)
    try {
      ensureLikedPlaylistExists(userId);
    } catch (err) {
      console.warn('[library] liked playlist', (err as Error).message);
    }
    // Listing biblio : métadonnées + 1 cover max (pas tous les payloads tracks)
    return listPlaylists(userId, { includeTracks: false });
  })();

  const history = getHistory(userId, 500);
  const recentEntities = getEntityHistory(userId, 40);

  const downloaded = (
    db
      .prepare(`SELECT track_id FROM downloads WHERE user_id = ? AND status = 'ready'`)
      .all(userId) as { track_id: string }[]
  ).map((r) => r.track_id);

  const liked = likedRows.map(trackFromRow);
  const songs = songRows.map(trackFromRow);

  return {
    songs,
    liked,
    likedPlaylists,
    albums,
    artists,
    mixes,
    playlists,
    history,
    recentEntities,
    downloaded,
  };
}

export function toggleLikeTrack(userId: string, track: Track) {
  upsertTrack(track);
  const existing = db
    .prepare('SELECT 1 FROM liked_tracks WHERE user_id = ? AND track_id = ?')
    .get(userId, track.id);
  if (existing) {
    db.prepare('DELETE FROM liked_tracks WHERE user_id = ? AND track_id = ?').run(userId, track.id);
    unlinkLikedPlaylistTrack(userId, track.id);
    return { liked: false };
  }
  db.prepare('INSERT INTO liked_tracks (user_id, track_id, created_at) VALUES (?, ?, ?)').run(
    userId,
    track.id,
    Date.now(),
  );
  // Playlist système « Titres J'aime » — pas de doublon dans library_tracks
  linkLikedPlaylistTrack(userId, track);
  return { liked: true };
}

export function isTrackLiked(userId: string, trackId: string) {
  return Boolean(
    db.prepare('SELECT 1 FROM liked_tracks WHERE user_id = ? AND track_id = ?').get(userId, trackId),
  );
}

/** Ajoute / retire un titre de la bibliothèque (indépendant du J’aime). */
export function toggleLibraryTrack(userId: string, track: Track) {
  upsertTrack(track);
  const existing = db
    .prepare('SELECT 1 FROM library_tracks WHERE user_id = ? AND track_id = ?')
    .get(userId, track.id);
  if (existing) {
    // Retrait manuel : coupe aussi les liaisons album (l’user retire explicitement le titre)
    db.prepare('DELETE FROM library_album_tracks WHERE user_id = ? AND track_id = ?').run(
      userId,
      track.id,
    );
    db.prepare('DELETE FROM library_tracks WHERE user_id = ? AND track_id = ?').run(userId, track.id);
    return { saved: false };
  }
  db.prepare(
    'INSERT INTO library_tracks (user_id, track_id, created_at, manual) VALUES (?, ?, ?, 1)',
  ).run(userId, track.id, Date.now());
  return { saved: true };
}

/** Ajoute un titre en biblio sans toggle (idempotent). `manual=false` = via album. */
export function ensureLibraryTrack(
  userId: string,
  track: Track,
  opts: { manual?: boolean } = {},
): boolean {
  if (!track?.id) return false;
  // Uniquement les vrais IDs vidéo/song YouTube
  if (!/^[a-zA-Z0-9_-]{11}$/.test(track.id)) return false;
  upsertTrack(sanitizeTrack(track));
  const manual = opts.manual === true ? 1 : 0;
  if (isTrackInLibrary(userId, track.id)) {
    // Déjà présent (ex. ajout manuel) : si on force manual, remonte le flag
    if (manual) {
      db.prepare(
        'UPDATE library_tracks SET manual = 1 WHERE user_id = ? AND track_id = ?',
      ).run(userId, track.id);
    }
    return false;
  }
  db.prepare(
    'INSERT INTO library_tracks (user_id, track_id, created_at, manual) VALUES (?, ?, ?, ?)',
  ).run(userId, track.id, Date.now(), manual);
  return true;
}

export function isTrackInLibrary(userId: string, trackId: string) {
  return Boolean(
    db
      .prepare('SELECT 1 FROM library_tracks WHERE user_id = ? AND track_id = ?')
      .get(userId, trackId),
  );
}

export function removeLibraryTrack(userId: string, trackId: string) {
  db.prepare('DELETE FROM library_tracks WHERE user_id = ? AND track_id = ?').run(userId, trackId);
}

export function toggleLikePlaylist(userId: string, playlist: Record<string, unknown>) {
  const id = String(playlist.id || '');
  if (!id) throw new Error('playlist id manquant');
  const existing = db
    .prepare('SELECT 1 FROM liked_playlists WHERE user_id = ? AND playlist_id = ?')
    .get(userId, id);
  if (existing) {
    db.prepare('DELETE FROM liked_playlists WHERE user_id = ? AND playlist_id = ?').run(userId, id);
    return { liked: false };
  }
  db.prepare(
    'INSERT INTO liked_playlists (user_id, playlist_id, payload, created_at) VALUES (?, ?, ?, ?)',
  ).run(userId, id, JSON.stringify(playlist), Date.now());
  return { liked: true };
}

export function saveAlbum(userId: string, album: Record<string, unknown>) {
  const id = String(album.id || '');
  if (!id) throw new Error('album id manquant');
  const cleaned = sanitizeLibraryItem(album);
  db.prepare(
    `INSERT INTO library_albums (user_id, album_id, payload, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, album_id) DO UPDATE SET payload = excluded.payload`,
  ).run(userId, id, JSON.stringify(cleaned), Date.now());
  return cleaned;
}

/**
 * Enregistre l’album ET tous ses titres dans « Titres » (library_tracks),
 * sans toucher aux J’aime.
 */
export async function saveAlbumWithTracks(
  userId: string,
  album: Record<string, unknown>,
): Promise<{ album: Record<string, unknown>; tracksAdded: number; tracksTotal: number }> {
  const id = String(album.id || '').trim();
  if (!id) throw new Error('album id manquant');

  let tracks: Track[] = Array.isArray(album.tracks)
    ? (album.tracks as Track[]).filter((t) => t && typeof t === 'object')
    : [];
  let meta = { ...album };

  if (tracks.length < 2) {
    try {
      const { getAlbum } = await import('../youtube/yt.js');
      const full = await getAlbum(id);
      if (full?.tracks?.length) tracks = full.tracks;
      if (full?.album) {
        meta = {
          ...meta,
          id: full.album.id || id,
          title: full.album.title || meta.title || meta.name,
          name: full.album.title || meta.name || meta.title,
          artists: full.album.artists?.length ? full.album.artists : meta.artists,
          thumbnails: full.album.thumbnails?.length ? full.album.thumbnails : meta.thumbnails,
          year: full.album.year || meta.year,
          type: 'album',
        };
      }
    } catch (err) {
      console.warn('[saveAlbum] getAlbum', id, (err as Error).message);
    }
  }

  const saved = saveAlbum(userId, { ...meta, type: 'album', tracks: undefined });
  let tracksAdded = 0;
  let tracksLinked = 0;
  for (const raw of tracks) {
    const t = sanitizeTrack({
      ...raw,
      type: raw.type === 'video' ? 'video' : 'song',
      album: raw.album || {
        name: String(meta.title || meta.name || 'Album'),
        id,
      },
    });
    const inserted = ensureLibraryTrack(userId, t, { manual: false });
    if (inserted) tracksAdded += 1;
    if (linkAlbumTrack(userId, id, t.id)) tracksLinked += 1;
  }
  return {
    album: saved,
    tracksAdded,
    tracksLinked,
    tracksTotal: tracks.length,
  };
}

/** Ré-injecte les titres de tous les albums déjà en biblio (backfill). */
export async function expandLibraryAlbumTracks(userId: string) {
  const lib = getFullLibrary(userId);
  let albums = 0;
  let tracksAdded = 0;
  for (const a of lib.albums || []) {
    const id = String(a?.id || '').trim();
    if (!id) continue;
    const r = await saveAlbumWithTracks(userId, a as unknown as Record<string, unknown>);
    albums += 1;
    tracksAdded += r.tracksAdded;
  }
  return { albums, tracksAdded, library: getFullLibrary(userId) };
}

/**
 * Retire l’album. Les titres ajoutés uniquement via cet album (manual=0,
 * plus aucune autre liaison album) sont retirés de library_tracks.
 * Les titres ajoutés manuellement (ou encore liés à un autre album) restent.
 */
export function removeAlbum(userId: string, albumId: string) {
  const linked = db
    .prepare(
      `SELECT track_id FROM library_album_tracks WHERE user_id = ? AND album_id = ?`,
    )
    .all(userId, albumId) as { track_id: string }[];

  db.prepare('DELETE FROM library_album_tracks WHERE user_id = ? AND album_id = ?').run(
    userId,
    albumId,
  );
  db.prepare('DELETE FROM library_albums WHERE user_id = ? AND album_id = ?').run(userId, albumId);

  let tracksRemoved = 0;
  for (const { track_id } of linked) {
    const stillLinked = db
      .prepare(
        `SELECT 1 FROM library_album_tracks WHERE user_id = ? AND track_id = ? LIMIT 1`,
      )
      .get(userId, track_id);
    if (stillLinked) continue;
    const row = db
      .prepare(
        `SELECT manual FROM library_tracks WHERE user_id = ? AND track_id = ?`,
      )
      .get(userId, track_id) as { manual: number } | undefined;
    if (!row) continue;
    if (Number(row.manual) === 1) continue; // ajout manuel : on garde
    db.prepare('DELETE FROM library_tracks WHERE user_id = ? AND track_id = ?').run(
      userId,
      track_id,
    );
    tracksRemoved += 1;
  }
  return { tracksRemoved };
}

function linkAlbumTrack(userId: string, albumId: string, trackId: string): boolean {
  if (!trackId || !albumId) return false;
  const existing = db
    .prepare(
      `SELECT 1 FROM library_album_tracks WHERE user_id = ? AND album_id = ? AND track_id = ?`,
    )
    .get(userId, albumId, trackId);
  if (existing) return false;
  db.prepare(
    `INSERT INTO library_album_tracks (user_id, album_id, track_id, created_at) VALUES (?, ?, ?, ?)`,
  ).run(userId, albumId, trackId, Date.now());
  return true;
}

const LIKED_PLAYLIST_DESC = 'system:liked';
const LIKED_PLAYLIST_NAME = "Titres J'aime";

/** Playlist système dédiée aux J'aime (créée une fois par user). */
export function ensureLikedPlaylistExists(userId: string) {
  const row = db
    .prepare(
      `SELECT id FROM playlists WHERE user_id = ? AND description = ? ORDER BY created_at ASC LIMIT 1`,
    )
    .get(userId, LIKED_PLAYLIST_DESC) as { id: string } | undefined;
  if (row?.id) return row.id;
  return getOrCreateLikedPlaylist(userId).id;
}

export function getOrCreateLikedPlaylist(userId: string): LibraryPlaylist {
  const row = db
    .prepare(
      `SELECT id FROM playlists WHERE user_id = ? AND description = ? ORDER BY created_at ASC LIMIT 1`,
    )
    .get(userId, LIKED_PLAYLIST_DESC) as { id: string } | undefined;
  if (row?.id) {
    syncLikedPlaylistTracks(userId, row.id);
    return listPlaylists(userId).find((p) => p.id === row.id)!;
  }
  const id = `liked-${userId}`;
  const now = Date.now();
  // id stable si libre, sinon UUID
  const taken = db.prepare('SELECT 1 FROM playlists WHERE id = ?').get(id);
  const playlistId = taken ? randomUUID() : id;
  db.prepare(
    `INSERT INTO playlists (id, user_id, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(playlistId, userId, LIKED_PLAYLIST_NAME, LIKED_PLAYLIST_DESC, now, now);
  syncLikedPlaylistTracks(userId, playlistId);
  return listPlaylists(userId).find((p) => p.id === playlistId)!;
}

function syncLikedPlaylistTracks(userId: string, playlistId: string) {
  const liked = db
    .prepare(`SELECT track_id FROM liked_tracks WHERE user_id = ? ORDER BY created_at ASC`)
    .all(userId) as { track_id: string }[];
  db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(playlistId);
  const ins = db.prepare(
    `INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)`,
  );
  const now = Date.now();
  liked.forEach((r, i) => ins.run(playlistId, r.track_id, i, now));
  db.prepare('UPDATE playlists SET updated_at = ?, name = ? WHERE id = ?').run(
    now,
    LIKED_PLAYLIST_NAME,
    playlistId,
  );
}

function linkLikedPlaylistTrack(userId: string, track: Track) {
  const pl = getOrCreateLikedPlaylist(userId);
  upsertTrack(track);
  const max = db
    .prepare('SELECT COALESCE(MAX(position), -1) as m FROM playlist_tracks WHERE playlist_id = ?')
    .get(pl.id) as { m: number };
  db.prepare(
    `INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(playlist_id, track_id) DO NOTHING`,
  ).run(pl.id, track.id, max.m + 1, Date.now());
  db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), pl.id);
}

function unlinkLikedPlaylistTrack(userId: string, trackId: string) {
  const row = db
    .prepare(
      `SELECT id FROM playlists WHERE user_id = ? AND description = ? LIMIT 1`,
    )
    .get(userId, LIKED_PLAYLIST_DESC) as { id: string } | undefined;
  if (!row?.id) return;
  db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').run(
    row.id,
    trackId,
  );
  db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), row.id);
}

export function isSystemLikedPlaylist(playlistId: string, userId: string): boolean {
  const row = db
    .prepare(`SELECT description FROM playlists WHERE id = ? AND user_id = ?`)
    .get(playlistId, userId) as { description: string } | undefined;
  return row?.description === LIKED_PLAYLIST_DESC;
}

export function saveArtist(userId: string, artist: Record<string, unknown>) {
  const id = String(artist.id || '');
  if (!id) throw new Error('artist id manquant');
  db.prepare(
    `INSERT INTO library_artists (user_id, artist_id, payload, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, artist_id) DO UPDATE SET payload = excluded.payload`,
  ).run(userId, id, JSON.stringify(artist), Date.now());
  return artist;
}

export function removeArtist(userId: string, artistId: string) {
  db.prepare('DELETE FROM library_artists WHERE user_id = ? AND artist_id = ?').run(userId, artistId);
}

/** Enregistre un mix radio (catégorie) dans la bibliothèque. */
export function saveMix(userId: string, mix: Record<string, unknown>) {
  const id = String(mix.id || '').trim();
  if (!id) throw new Error('mix id manquant');
  const title = String(mix.title || 'Mix').trim() || 'Mix';
  const tracks = Array.isArray(mix.tracks) ? mix.tracks : [];
  const covers = Array.isArray(mix.covers)
    ? mix.covers
    : tracks.slice(0, 4);
  const payload = {
    id,
    title,
    type: 'mix',
    categoryId: id,
    thumbnails: covers
      .map((t: any) => (Array.isArray(t?.thumbnails) ? t.thumbnails[0] : null))
      .filter(Boolean)
      .slice(0, 4),
    covers,
    tracks: tracks.slice(0, 200),
    trackCount: tracks.length || Number(mix.trackCount) || 0,
  };
  db.prepare(
    `INSERT INTO library_mixes (user_id, mix_id, payload, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, mix_id) DO UPDATE SET payload = excluded.payload`,
  ).run(userId, id, JSON.stringify(payload), Date.now());
  return payload;
}

export function removeMix(userId: string, mixId: string) {
  db.prepare('DELETE FROM library_mixes WHERE user_id = ? AND mix_id = ?').run(userId, mixId);
}

export function isMixSaved(userId: string, mixId: string) {
  return Boolean(
    db.prepare('SELECT 1 FROM library_mixes WHERE user_id = ? AND mix_id = ?').get(userId, mixId),
  );
}

export function addHistory(userId: string, track: Track, opts?: { bumpCount?: boolean }) {
  if (!track?.id) return;
  upsertTrack(track);
  const bumpCount = opts?.bumpCount !== false;
  // Ensure play_count column
  try {
    db.exec('ALTER TABLE history ADD COLUMN play_count INTEGER DEFAULT 1');
  } catch {
    /* already exists */
  }
  const existing = db
    .prepare('SELECT play_count FROM history WHERE user_id = ? AND track_id = ?')
    .get(userId, track.id) as { play_count: number } | undefined;
  if (existing) {
    if (bumpCount) {
      db.prepare(
        `UPDATE history SET played_at = ?, play_count = COALESCE(play_count, 1) + 1 WHERE user_id = ? AND track_id = ?`,
      ).run(Date.now(), userId, track.id);
    } else {
      db.prepare(`UPDATE history SET played_at = ? WHERE user_id = ? AND track_id = ?`).run(
        Date.now(),
        userId,
        track.id,
      );
    }
  } else {
    db.prepare(
      `INSERT INTO history (user_id, track_id, played_at, play_count) VALUES (?, ?, ?, 1)`,
    ).run(userId, track.id, Date.now());
  }
}

export type HistoryEntityKind = 'playlist' | 'album' | 'artist' | 'mix';

export type HistoryEntity = Track & {
  kind?: HistoryEntityKind;
  playedAt?: number;
  playCount?: number;
};

/** Playlist / album / mix / artiste lancé récemment. */
export function recordEntityPlay(
  userId: string,
  entity: {
    id: string;
    kind: HistoryEntityKind;
    title?: string;
    name?: string;
    thumbnails?: Track['thumbnails'];
    artists?: Track['artists'];
    type?: string;
    covers?: string[];
  },
) {
  const id = String(entity?.id || '').trim();
  const kind = entity?.kind;
  if (!id || !kind) return;
  const title = String(entity.title || entity.name || id).trim() || id;
  const type = entity.type || kind;
  const payload = JSON.stringify({
    id,
    title,
    name: title,
    type,
    kind,
    artists: entity.artists || [],
    thumbnails: entity.thumbnails || [],
    covers: entity.covers,
  });
  const now = Date.now();
  const existing = db
    .prepare(
      `SELECT play_count FROM entity_history WHERE user_id = ? AND kind = ? AND entity_id = ?`,
    )
    .get(userId, kind, id) as { play_count: number } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE entity_history SET played_at = ?, play_count = COALESCE(play_count, 1) + 1, payload = ?
       WHERE user_id = ? AND kind = ? AND entity_id = ?`,
    ).run(now, payload, userId, kind, id);
  } else {
    db.prepare(
      `INSERT INTO entity_history (user_id, kind, entity_id, payload, played_at, play_count)
       VALUES (?, ?, ?, ?, ?, 1)`,
    ).run(userId, kind, id, payload, now);
  }
}

export function getEntityHistory(userId: string, limit = 40, kind?: HistoryEntityKind): HistoryEntity[] {
  const rows = kind
    ? (db
        .prepare(
          `SELECT kind, entity_id, payload, played_at, play_count FROM entity_history
           WHERE user_id = ? AND kind = ?
           ORDER BY played_at DESC LIMIT ?`,
        )
        .all(userId, kind, limit) as {
        kind: string;
        entity_id: string;
        payload: string;
        played_at: number;
        play_count: number;
      }[])
    : (db
        .prepare(
          `SELECT kind, entity_id, payload, played_at, play_count FROM entity_history
           WHERE user_id = ?
           ORDER BY played_at DESC LIMIT ?`,
        )
        .all(userId, limit) as {
        kind: string;
        entity_id: string;
        payload: string;
        played_at: number;
        play_count: number;
      }[]);

  return rows.map((r) => {
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(r.payload) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
    const title = String(raw.title || raw.name || r.entity_id);
    return {
      id: r.entity_id,
      title,
      type: String(raw.type || r.kind),
      kind: r.kind as HistoryEntityKind,
      artists: Array.isArray(raw.artists) ? (raw.artists as Track['artists']) : [],
      thumbnails: Array.isArray(raw.thumbnails) ? (raw.thumbnails as Track['thumbnails']) : [],
      playedAt: r.played_at,
      playCount: r.play_count,
      ...(raw.covers ? { covers: raw.covers } : {}),
    } as HistoryEntity;
  });
}

export function getTopListened(userId: string, limit = 30): Track[] {
  try {
    db.exec('ALTER TABLE history ADD COLUMN play_count INTEGER DEFAULT 1');
  } catch {
    /* ok */
  }
  return (
    db
      .prepare(
        `SELECT h.track_id AS track_id, t.payload AS payload, COALESCE(h.play_count, 1) as play_count FROM history h
         LEFT JOIN tracks_cache t ON t.id = h.track_id
         WHERE h.user_id = ?
         ORDER BY COALESCE(h.play_count, 1) DESC, h.played_at DESC
         LIMIT ?`,
      )
      .all(userId, limit) as { track_id: string; payload: string | null }[]
  ).map(trackFromRow);
}

/** IDs des titres aimés (pour boost reco / satisfaction). */
export function getLikedTrackIds(userId: string, limit = 400): Set<string> {
  const rows = db
    .prepare(
      `SELECT track_id FROM liked_tracks WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, limit) as { track_id: string }[];
  return new Set(rows.map((r) => r.track_id));
}

/**
 * Pool de goûts biblio pour personnaliser les similaires :
 * likes + titres sauvés + échantillon playlists locales + tops écoutés.
 */
export function getLibraryTasteTracks(userId: string, limit = 120): Track[] {
  const byId = new Map<string, Track>();
  const push = (t: Track | null | undefined) => {
    if (!t?.id || byId.has(t.id)) return;
    if (!/^[a-zA-Z0-9_-]{11}$/.test(t.id)) return;
    byId.set(t.id, t);
  };

  const likedRows = db
    .prepare(
      `SELECT l.track_id AS track_id, t.payload AS payload
       FROM liked_tracks l
       LEFT JOIN tracks_cache t ON t.id = l.track_id
       WHERE l.user_id = ?
       ORDER BY l.created_at DESC
       LIMIT 80`,
    )
    .all(userId) as { track_id: string; payload: string | null }[];
  likedRows.forEach((r) => push(trackFromRow(r)));

  const songRows = db
    .prepare(
      `SELECT l.track_id AS track_id, t.payload AS payload
       FROM library_tracks l
       LEFT JOIN tracks_cache t ON t.id = l.track_id
       WHERE l.user_id = ?
       ORDER BY l.created_at DESC
       LIMIT 60`,
    )
    .all(userId) as { track_id: string; payload: string | null }[];
  songRows.forEach((r) => push(trackFromRow(r)));

  const plTracks = db
    .prepare(
      `SELECT pt.track_id AS track_id, t.payload AS payload
       FROM playlist_tracks pt
       JOIN playlists p ON p.id = pt.playlist_id
       LEFT JOIN tracks_cache t ON t.id = pt.track_id
       WHERE p.user_id = ?
       ORDER BY pt.added_at DESC
       LIMIT 80`,
    )
    .all(userId) as { track_id: string; payload: string | null }[];
  plTracks.forEach((r) => push(trackFromRow(r)));

  getTopListened(userId, 40).forEach((t) => push(t));

  return [...byId.values()].slice(0, limit);
}

export function getHistory(userId: string, limit = 500): Track[] {
  const rows = db
    .prepare(
      `SELECT h.track_id AS track_id, t.payload AS payload FROM history h
       LEFT JOIN tracks_cache t ON t.id = h.track_id
       WHERE h.user_id = ?
       ORDER BY h.played_at DESC LIMIT ?`,
    )
    .all(userId, limit) as { track_id: string; payload: string | null }[];
  return rows.map(trackFromRow);
}

/**
 * « Favoris à redécouvrir » (YouTube Music · Forgotten favorites) :
 * titres / albums déjà aimés ou souvent écoutés, mais pas joués récemment.
 * ~8 items, rotation stable par jour.
 */
export function getForgottenFavorites(userId: string, limit = 8): Track[] {
  const DAY = 24 * 60 * 60 * 1000;
  const now = Date.now();
  /** Fenêtre « récent » : exclus si écouté dans les 14 derniers jours. */
  const recentCutoff = now - 14 * DAY;
  /** Un like trop frais n’est pas « oublié ». */
  const likeMatureCutoff = now - 7 * DAY;

  try {
    db.exec('ALTER TABLE history ADD COLUMN play_count INTEGER DEFAULT 1');
  } catch {
    /* ok */
  }

  type Cand = {
    track: Track;
    score: number;
    key: string;
  };
  const byId = new Map<string, Cand>();

  const push = (track: Track, score: number) => {
    if (!track?.id) return;
    const prev = byId.get(track.id);
    if (!prev || score > prev.score) {
      byId.set(track.id, { track, score, key: track.id });
    }
  };

  // 1) Titres aimés non réécoutés récemment
  const likedRows = db
    .prepare(
      `SELECT t.payload AS payload, l.created_at AS liked_at,
              COALESCE(h.play_count, 0) AS play_count,
              COALESCE(h.played_at, 0) AS played_at
       FROM liked_tracks l
       JOIN tracks_cache t ON t.id = l.track_id
       LEFT JOIN history h ON h.user_id = l.user_id AND h.track_id = l.track_id
       WHERE l.user_id = ?`,
    )
    .all(userId) as {
    payload: string;
    liked_at: number;
    play_count: number;
    played_at: number;
  }[];

  for (const row of likedRows) {
    if (row.liked_at > likeMatureCutoff && row.play_count < 2) continue;
    if (row.played_at > recentCutoff) continue;
    const track = JSON.parse(row.payload) as Track;
    const daysSincePlay = row.played_at > 0 ? (now - row.played_at) / DAY : (now - row.liked_at) / DAY;
    const daysSinceLike = (now - row.liked_at) / DAY;
    const score =
      40 +
      Math.min(30, row.play_count * 4) +
      Math.min(25, daysSincePlay / 2) +
      Math.min(15, daysSinceLike / 7);
    push(track, score);
  }

  // 2) Anciens gros hits (même sans like) — oubliés
  const histRows = db
    .prepare(
      `SELECT t.payload AS payload, COALESCE(h.play_count, 1) AS play_count, h.played_at AS played_at
       FROM history h
       JOIN tracks_cache t ON t.id = h.track_id
       WHERE h.user_id = ?
         AND COALESCE(h.play_count, 1) >= 3
         AND h.played_at < ?`,
    )
    .all(userId, recentCutoff) as { payload: string; play_count: number; played_at: number }[];

  for (const row of histRows) {
    const track = JSON.parse(row.payload) as Track;
    const daysSincePlay = (now - row.played_at) / DAY;
    const score = 20 + Math.min(40, row.play_count * 3) + Math.min(20, daysSincePlay / 3);
    push(track, score);
  }

  // 3) Albums enregistrés depuis un moment (YTM mélange titres + albums)
  const albumRows = db
    .prepare(
      `SELECT payload, created_at FROM library_albums WHERE user_id = ? AND created_at < ?`,
    )
    .all(userId, likeMatureCutoff) as { payload: string; created_at: number }[];

  for (const row of albumRows) {
    const raw = JSON.parse(row.payload) as Record<string, unknown>;
    const id = String(raw.id || '');
    if (!id) continue;
    const daysSinceSave = (now - row.created_at) / DAY;
    const track: Track = {
      id,
      title: String(raw.title || raw.name || 'Album'),
      artists: Array.isArray(raw.artists) ? (raw.artists as Track['artists']) : [],
      thumbnails: Array.isArray(raw.thumbnails) ? (raw.thumbnails as Track['thumbnails']) : [],
      type: 'album',
    };
    push(track, 25 + Math.min(20, daysSinceSave / 5));
  }

  const ranked = [...byId.values()].sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return [];

  // Rotation quotidienne stable (pas un mélange aléatoire à chaque refresh)
  const d = new Date();
  const seed = d.getFullYear() * 10_000 + (d.getMonth() + 1) * 100 + d.getDate() + userId.length;
  const pool = ranked.slice(0, Math.max(limit * 3, limit));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = (seed * (i + 3)) % (i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  // Re-trier légèrement par score après shuffle partiel pour garder la pertinence
  pool.sort((a, b) => b.score - a.score + (((seed + a.key.charCodeAt(0)) % 7) - 3));

  return pool.slice(0, limit).map((c) => c.track);
}

export function listPlaylists(
  userId: string,
  opts?: { includeTracks?: boolean },
): LibraryPlaylist[] {
  const includeTracks = opts?.includeTracks !== false;
  const rows = db
    .prepare(
      `SELECT * FROM playlists WHERE user_id = ?
       ORDER BY CASE WHEN description = 'system:liked' THEN 0 ELSE 1 END, updated_at DESC`,
    )
    .all(userId) as {
    id: string;
    name: string;
    description: string;
    cover_url: string | null;
    created_at: number;
    updated_at: number;
  }[];

  return rows.map((p) => {
    const countRow = db
      .prepare(`SELECT COUNT(*) AS c FROM playlist_tracks WHERE playlist_id = ?`)
      .get(p.id) as { c: number };
    const trackCount = Number(countRow?.c || 0);

    if (!includeTracks) {
      let cover = p.cover_url || undefined;
      if (!cover && trackCount > 0) {
        const first = db
          .prepare(
            `SELECT t.payload FROM playlist_tracks pt
             JOIN tracks_cache t ON t.id = pt.track_id
             WHERE pt.playlist_id = ?
             ORDER BY pt.position ASC LIMIT 1`,
          )
          .get(p.id) as { payload: string } | undefined;
        if (first?.payload) {
          try {
            const t = JSON.parse(first.payload) as Track;
            cover = t.thumbnails?.[0]?.url;
          } catch {
            /* ignore */
          }
        }
      }
      return {
        id: p.id,
        name: p.name,
        description: p.description || '',
        coverUrl: cover,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
        tracks: [],
        trackCount,
      };
    }

    const tracks = (
      db
        .prepare(
          `SELECT t.payload FROM playlist_tracks pt
           JOIN tracks_cache t ON t.id = pt.track_id
           WHERE pt.playlist_id = ?
           ORDER BY pt.position ASC`,
        )
        .all(p.id) as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as Track);

    return {
      id: p.id,
      name: p.name,
      description: p.description || '',
      coverUrl: p.cover_url || tracks[0]?.thumbnails?.[0]?.url,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      tracks,
      trackCount: tracks.length || trackCount,
    };
  });
}

export function createPlaylist(userId: string, name: string, description = '') {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO playlists (id, user_id, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, name, description, now, now);
  return listPlaylists(userId).find((p) => p.id === id)!;
}

export function updatePlaylist(
  userId: string,
  playlistId: string,
  patch: { name?: string; description?: string },
) {
  const pl = db
    .prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?')
    .get(playlistId, userId);
  if (!pl) throw new Error('Playlist introuvable');
  db.prepare(
    `UPDATE playlists SET name = COALESCE(?, name), description = COALESCE(?, description), updated_at = ? WHERE id = ?`,
  ).run(patch.name ?? null, patch.description ?? null, Date.now(), playlistId);
  return listPlaylists(userId).find((p) => p.id === playlistId)!;
}

export function deletePlaylist(userId: string, playlistId: string) {
  if (isSystemLikedPlaylist(playlistId, userId)) {
    throw new Error("La playlist « Titres J'aime » ne peut pas être supprimée");
  }
  const pl = db
    .prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?')
    .get(playlistId, userId);
  if (!pl) throw new Error('Playlist introuvable');
  db.prepare('DELETE FROM playlists WHERE id = ?').run(playlistId);
}

export async function addToPlaylist(userId: string, playlistId: string, track: Track) {
  const pl = db
    .prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?')
    .get(playlistId, userId);
  if (!pl) throw new Error('Playlist introuvable');
  let hydrated = track;
  if (isWeakTitle(track?.title, track?.id) || !(track?.artists || []).length) {
    const { hydrateTrack } = await import('../youtube/yt.js');
    hydrated = await hydrateTrack(track);
  }
  upsertTrack(hydrated);
  const max = db
    .prepare('SELECT COALESCE(MAX(position), -1) as m FROM playlist_tracks WHERE playlist_id = ?')
    .get(playlistId) as { m: number };
  db.prepare(
    `INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(playlist_id, track_id) DO NOTHING`,
  ).run(playlistId, hydrated.id, max.m + 1, Date.now());
  db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), playlistId);
  return listPlaylists(userId).find((p) => p.id === playlistId)!;
}

/** Répare les titres « Sans titre » dans la biblio (playlists / likes / songs). */
export async function repairLibraryTrackMeta(userId: string) {
  const { hydrateTracks } = await import('../youtube/yt.js');
  const lib = getFullLibrary(userId);
  const byId = new Map<string, Track>();
  const push = (t: Track | null | undefined) => {
    if (!t?.id || !/^[a-zA-Z0-9_-]{11}$/.test(t.id)) return;
    if (!isWeakTitle(t.title, t.id) && (t.artists || []).length) return;
    byId.set(t.id, t);
  };
  for (const t of lib.liked || []) push(t);
  for (const t of lib.songs || []) push(t);
  for (const p of lib.playlists || []) for (const t of p.tracks || []) push(t);
  for (const t of getHistory(userId, 80)) push(t);
  const fixed = await hydrateTracks([...byId.values()], { limit: 80, concurrency: 5 });
  let repaired = 0;
  for (const t of fixed) {
    if (!isWeakTitle(t.title, t.id)) {
      upsertTrack(t);
      repaired += 1;
    }
  }
  // Albums en biblio → injecter tous leurs titres dans « Titres »
  const expanded = await expandLibraryAlbumTracks(userId);
  return {
    scanned: byId.size,
    repaired,
    albumsExpanded: expanded.albums,
    albumTracksAdded: expanded.tracksAdded,
    library: getFullLibrary(userId),
  };
}

/** Throttle repair hors chemin critique GET /api/library (E4). */
const libraryRepairAt = new Map<string, number>();
const LIBRARY_REPAIR_TTL_MS = Math.max(
  60_000,
  Number(process.env.LIBRARY_REPAIR_TTL_MS || 10 * 60_000) || 10 * 60_000,
);
const libraryRepairInflight = new Set<string>();

export function scheduleLibraryRepair(userId: string): void {
  const last = libraryRepairAt.get(userId) || 0;
  if (Date.now() - last < LIBRARY_REPAIR_TTL_MS) return;
  if (libraryRepairInflight.has(userId)) return;
  libraryRepairAt.set(userId, Date.now());
  libraryRepairInflight.add(userId);
  void repairLibraryTrackMeta(userId)
    .catch((err) => console.warn('[library] background repair', (err as Error).message))
    .finally(() => libraryRepairInflight.delete(userId));
}

export function removeFromPlaylist(userId: string, playlistId: string, trackId: string) {
  const pl = db
    .prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?')
    .get(playlistId, userId);
  if (!pl) throw new Error('Playlist introuvable');
  db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?').run(
    playlistId,
    trackId,
  );
  db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), playlistId);
  return listPlaylists(userId).find((p) => p.id === playlistId)!;
}

export function reorderPlaylist(userId: string, playlistId: string, trackIds: string[]) {
  const pl = db
    .prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?')
    .get(playlistId, userId);
  if (!pl) throw new Error('Playlist introuvable');
  const tx = db.transaction(() => {
    trackIds.forEach((id, i) => {
      db.prepare('UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?').run(
        i,
        playlistId,
        id,
      );
    });
    db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(Date.now(), playlistId);
  });
  tx();
  return listPlaylists(userId).find((p) => p.id === playlistId)!;
}

export function markDownloaded(userId: string, trackId: string, path?: string) {
  db.prepare(
    `INSERT INTO downloads (user_id, track_id, status, path, created_at) VALUES (?, ?, 'ready', ?, ?)
     ON CONFLICT(user_id, track_id) DO UPDATE SET status = 'ready', path = excluded.path`,
  ).run(userId, trackId, path || null, Date.now());
}

/** IDs des playlists locales qui contiennent déjà ce titre (requête SQL rapide). */
export function playlistIdsContainingTrack(userId: string, trackId: string): string[] {
  if (!trackId?.trim()) return [];
  const rows = db
    .prepare(
      `SELECT pt.playlist_id AS id
       FROM playlist_tracks pt
       JOIN playlists p ON p.id = pt.playlist_id
       WHERE p.user_id = ? AND pt.track_id = ?`,
    )
    .all(userId, trackId) as { id: string }[];
  return rows.map((r) => r.id);
}

export function listDownloads(userId: string) {
  return (
    db
      .prepare(
        `SELECT d.track_id, d.status, d.path, t.payload FROM downloads d
         LEFT JOIN tracks_cache t ON t.id = d.track_id
         WHERE d.user_id = ?
         ORDER BY d.created_at DESC`,
      )
      .all(userId) as { track_id: string; status: string; path: string | null; payload: string | null }[]
  ).map((r) => ({
    trackId: r.track_id,
    status: r.status,
    path: r.path,
    track: r.payload ? (JSON.parse(r.payload) as Track) : null,
  }));
}

export function createOfflineJob(
  userId: string,
  kind: 'album' | 'playlist' | 'artist-top' | 'tracks',
  targetId: string,
  total: number,
) {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO offline_jobs (id, user_id, kind, target_id, status, progress, total, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', 0, ?, ?, ?)`,
  ).run(id, userId, kind, targetId, total, now, now);
  return id;
}

export function updateOfflineJob(id: string, progress: number, status?: string) {
  db.prepare(
    `UPDATE offline_jobs SET progress = ?, status = COALESCE(?, status), updated_at = ? WHERE id = ?`,
  ).run(progress, status || null, Date.now(), id);
}

export function listOfflineJobs(userId: string) {
  return db
    .prepare('SELECT * FROM offline_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(userId);
}

// silence unused
void parseTrack;
