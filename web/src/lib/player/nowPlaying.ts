import { usePlayer } from '../../store/player';
import type { Track } from '../../api';

export type PlaybackSourceKind = 'album' | 'playlist' | 'mix' | 'artist' | 'radio';

/** True si cet item (titre ou collection) est la source / le titre en cours. */
export function useNowPlayingMatch(item: {
  id: string;
  type?: string | null;
  album?: { id?: string } | null;
  tracks?: Track[];
  covers?: Track[];
}): { active: boolean; playing: boolean } {
  const current = usePlayer((s) => s.current);
  const isPlaying = usePlayer((s) => s.isPlaying);
  const sourceId = usePlayer((s) => s.sourceId);
  const sourceKind = usePlayer((s) => s.sourceKind);

  if (!current) return { active: false, playing: false };

  const type = (item.type || '').toLowerCase();
  const isTrack =
    !type ||
    type === 'song' ||
    type === 'video' ||
    type === 'unknown' ||
    /^[a-zA-Z0-9_-]{11}$/.test(item.id);

  if (isTrack && !['album', 'playlist', 'artist', 'mix'].includes(type)) {
    const active = current.id === item.id;
    return { active, playing: active && isPlaying };
  }

  // Collection : source explicite, ou album du titre courant, ou piste membre
  if (sourceId && sourceId === item.id) {
    return { active: true, playing: isPlaying };
  }
  if (type === 'album' && current.album?.id && current.album.id === item.id) {
    return { active: true, playing: isPlaying };
  }
  if (type === 'artist' && sourceKind === 'artist' && sourceId === item.id) {
    return { active: true, playing: isPlaying };
  }
  const members = [...(item.tracks || []), ...(item.covers || [])];
  if (members.some((t) => t.id === current.id)) {
    return { active: true, playing: isPlaying };
  }

  return { active: false, playing: false };
}
