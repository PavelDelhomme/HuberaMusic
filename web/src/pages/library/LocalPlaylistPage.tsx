import { useParams } from 'react-router-dom';
import { useLibrary } from '../../store/library';
import { TrackRow } from '../../components/media/TrackRow';
import { usePlayer } from '../../store/player';
import { Play } from 'lucide-react';
import { CoverImage } from '../../components/media/CoverImage';
import { BackButton } from '../../components/layout/BackButton';
import { formatTotalDuration, sumTracksDurationSeconds } from '../../lib/util/time';

export function LocalPlaylistPage() {
  const { id = '' } = useParams();
  const playlists = useLibrary((s) => s.playlists);
  const playQueue = usePlayer((s) => s.playQueue);
  const pl = playlists.find((p) => p.id === id);

  if (!pl) {
    return (
      <div>
        <BackButton fallback="/library" />
        <p className="text-yt-muted">Playlist introuvable.</p>
      </div>
    );
  }

  const totalDur = formatTotalDuration(sumTracksDurationSeconds(pl.tracks));

  return (
    <div className="animate-fade-up">
      <BackButton fallback="/library" />
      <div className="mb-8 flex flex-col gap-6 sm:flex-row sm:items-end">
        <div className="h-44 w-44 shrink-0 shadow-2xl sm:h-56 sm:w-56">
          <CoverImage
            item={pl.tracks[0] || { title: pl.name, thumbnails: [] }}
            size={800}
            rounded="lg"
          />
        </div>
        <div>
          <p className="text-xs uppercase tracking-widest text-yt-muted">Playlist locale</p>
          <h1 className="font-display text-4xl font-semibold">{pl.name}</h1>
          <p className="mt-2 text-sm text-yt-muted">
            {[
              `${pl.tracks.length} titre${pl.tracks.length !== 1 ? 's' : ''}`,
              totalDur,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {pl.tracks[0] && (
            <button
              type="button"
              onClick={() => void playQueue(pl.tracks, 0)}
              className="mt-4 inline-flex items-center gap-2 rounded-full bg-yt-red px-5 py-2.5 text-sm font-medium"
            >
              <Play className="h-4 w-4 fill-white" /> Lecture
            </button>
          )}
        </div>
      </div>
      {pl.tracks.map((t, i) => (
        <TrackRow key={t.id} track={t} index={i} queue={pl.tracks} showAlbum />
      ))}
    </div>
  );
}
