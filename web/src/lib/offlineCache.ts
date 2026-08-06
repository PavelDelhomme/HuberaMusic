import { openDB } from 'idb';
import { apiUrl, getToken, type Track } from '../api';

const DB_NAME = 'ytmusic-offline';
const STORE = 'audio';
const META = 'meta';

async function db() {
  return openDB(DB_NAME, 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
      if (!database.objectStoreNames.contains(META)) database.createObjectStore(META);
    },
  });
}

export async function cacheAudioBlob(trackId: string, blob: Blob, track?: Track) {
  const database = await db();
  await database.put(STORE, blob, trackId);
  if (track) await database.put(META, track, trackId);
}

export async function getCachedAudio(trackId: string): Promise<Blob | undefined> {
  const database = await db();
  return database.get(STORE, trackId);
}

export async function getCachedMeta(trackId: string): Promise<Track | undefined> {
  const database = await db();
  return database.get(META, trackId);
}

export async function listCachedIds(): Promise<string[]> {
  const database = await db();
  return database.getAllKeys(STORE) as Promise<string[]>;
}

/** Tous les titres réellement jouables hors ligne sur cet appareil. */
export async function listCachedTracks(): Promise<Track[]> {
  const database = await db();
  const ids = (await database.getAllKeys(STORE)) as string[];
  const out: Track[] = [];
  for (const id of ids) {
    const meta = (await database.get(META, id)) as Track | undefined;
    if (meta?.id) out.push(meta);
    else out.push({ id, title: id, artists: [], thumbnails: [], type: 'song' });
  }
  return out;
}

export async function removeCached(trackId: string) {
  const database = await db();
  await database.delete(STORE, trackId);
  await database.delete(META, trackId);
}

export async function clearAllCached() {
  const database = await db();
  await database.clear(STORE);
  await database.clear(META);
}

/** Demande au navigateur de ne pas évincer le cache (Chrome/Android). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function getStorageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est?.quota) return null;
    return { usage: est.usage || 0, quota: est.quota };
  } catch {
    return null;
  }
}

export async function downloadAndCache(track: Track) {
  const token = getToken();
  const headers: HeadersInit = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(apiUrl(`/api/stream/${track.id}`), {
    headers,
    credentials: 'include',
  });
  if (!res.ok) throw new Error('Téléchargement impossible');
  const blob = await res.blob();
  await cacheAudioBlob(track.id, blob, track);
  await fetch(apiUrl(`/api/download/${track.id}`), {
    method: 'POST',
    credentials: 'include',
    headers,
  }).catch(() => undefined);
  return blob;
}

/** Télécharge une liste sur l’appareil (IndexedDB) — vrai hors-ligne navigateur. */
export async function downloadTracksToDevice(
  tracks: Track[],
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const playable = tracks.filter((t) => /^[a-zA-Z0-9_-]{11}$/.test(t.id));
  let ok = 0;
  const total = playable.length;
  for (const t of playable) {
    try {
      await downloadAndCache(t);
      ok++;
    } catch {
      /* continue */
    }
    onProgress?.(ok, total);
  }
  return ok;
}

/** Stream proxy same-origin (sync) — pour lancer play() sans await (geste utilisateur). */
export function streamProxyUrl(trackId: string): string {
  const token = getToken();
  const q = token ? `?access_token=${encodeURIComponent(token)}` : '';
  return apiUrl(`/api/stream/${trackId}${q}`);
}

export async function resolvePlayUrl(trackId: string): Promise<string> {
  const cached = await getCachedAudio(trackId);
  if (cached) return URL.createObjectURL(cached);
  return streamProxyUrl(trackId);
}

export async function hasCachedAudio(trackId: string): Promise<boolean> {
  const blob = await getCachedAudio(trackId);
  return Boolean(blob && blob.size > 0);
}
