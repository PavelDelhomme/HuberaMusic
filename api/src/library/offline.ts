import type { Request, Response } from 'express';
import { downloadTrack } from '../media/stream.js';
import {
  createOfflineJob,
  listOfflineJobs,
  markDownloaded,
  updateOfflineJob,
  getFullLibrary,
} from './library.js';
import { getAlbum, getPlaylist, getArtist } from '../youtube/yt.js';
import { upsertTrack } from './db.js';
import type { Track } from '../youtube/types.js';

async function downloadMany(userId: string, jobId: string, tracks: Track[]) {
  let done = 0;
  for (const track of tracks) {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(track.id)) {
      done++;
      updateOfflineJob(jobId, done);
      continue;
    }
    try {
      upsertTrack(track);
      const path = await downloadTrack(track.id);
      markDownloaded(userId, track.id, path);
    } catch (err) {
      console.error('offline download fail', track.id, err);
    }
    done++;
    updateOfflineJob(jobId, done);
  }
  updateOfflineJob(jobId, done, 'done');
}

export async function startOfflineCollection(
  userId: string,
  kind: 'album' | 'playlist' | 'artist' | 'liked',
  targetId: string,
) {
  let tracks: Track[] = [];

  if (kind === 'liked') {
    tracks = getFullLibrary(userId).liked;
  } else if (kind === 'album') {
    const { tracks: t, album } = await getAlbum(targetId);
    tracks = t;
    void album;
  } else if (kind === 'playlist') {
    // local playlist id (uuid) or youtube playlist
    const lib = getFullLibrary(userId);
    const local = lib.playlists.find((p) => p.id === targetId);
    if (local) tracks = local.tracks;
    else {
      const { tracks: t } = await getPlaylist(targetId);
      tracks = t;
    }
  } else if (kind === 'artist') {
    const { songs } = await getArtist(targetId);
    tracks = songs.slice(0, 30);
  }

  const playable = tracks.filter((t) => /^[a-zA-Z0-9_-]{11}$/.test(t.id));
  const jobId = createOfflineJob(userId, kind === 'liked' ? 'tracks' : (kind as any), targetId, playable.length);
  void downloadMany(userId, jobId, playable);
  return { jobId, total: playable.length };
}

export function handleOfflineStatus(req: Request, res: Response) {
  res.json({ jobs: listOfflineJobs(req.userId!) });
}
