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

const BETWEEN_TRACK_MS = Math.max(
  250,
  Math.min(5_000, Number(process.env.OFFLINE_JOB_GAP_MS || 800) || 800),
);

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Attend la fin du cooldown yt-dlp (max ~cooldown restant + marge). */
async function waitIfYtDlpCoolingDown(): Promise<boolean> {
  const { isYtDlpCoolingDown, ytDlpCooldownRemainingMs } = await import('../media/ytDlpGate.js');
  if (!isYtDlpCoolingDown()) return false;
  const wait = Math.min(ytDlpCooldownRemainingMs() + 1_000, 310_000);
  console.warn(`[offline] job en pause ${Math.round(wait / 1000)}s (yt-dlp cooldown)`);
  await sleep(wait);
  return true;
}

async function downloadMany(userId: string, jobId: string, tracks: Track[]) {
  let done = 0;
  for (const track of tracks) {
    if (!/^[a-zA-Z0-9_-]{11}$/.test(track.id)) {
      done++;
      updateOfflineJob(jobId, done);
      continue;
    }
    try {
      await waitIfYtDlpCoolingDown();
      upsertTrack(track);
      const path = await downloadTrack(track.id);
      markDownloaded(userId, track.id, path);
    } catch (err) {
      console.error('offline download fail', track.id, err);
      // Bot / rate-limit : laisse le gate poser le cooldown, pause avant le titre suivant
      void import('../media/ytDlpGate.js').then((m) => m.noteYtDlpFailure(err)).catch(() => {});
      await waitIfYtDlpCoolingDown();
    }
    done++;
    updateOfflineJob(jobId, done);
    if (done < tracks.length) await sleep(BETWEEN_TRACK_MS);
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
