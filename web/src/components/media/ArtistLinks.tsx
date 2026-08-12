import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Track } from '../../api';

/** Noms d'artistes cliquables → page artiste (résout l’id via recherche si absent). */
export function ArtistLinks({
  track,
  className = '',
  separator = ', ',
  onArtistClick,
  emptyLabel = 'Artiste',
}: {
  track: Track | { artists?: { name: string; id?: string }[] };
  className?: string;
  separator?: string;
  onArtistClick?: (id: string) => void;
  /** null / '' = rien si pas d’artiste (évite « Artiste2023 » collé à l’année). */
  emptyLabel?: string | null;
}) {
  const navigate = useNavigate();
  const [busyName, setBusyName] = useState<string | null>(null);
  const artists = (track.artists || []).filter((a) => {
    const n = a?.name?.trim() || '';
    if (!n) return false;
    if (/^(inconnu|unknown|n\/a)$/i.test(n)) return false;
    if (/^\d+\s*songs?$/i.test(n) || /^\d+\s*titres?$/i.test(n)) return false;
    if (/^\d+\s*(min|mins|minutes?|sec|secs|seconds?|h|hr|hrs|hours?)$/i.test(n)) return false;
    if (/^\d+\s*hours?(?:,?\s*\d+\s*minutes?)?$/i.test(n)) return false;
    if (/^(song|album|playlist|video|ep|single)$/i.test(n)) return false;
    return true;
  });
  if (!artists.length) {
    if (!emptyLabel) return null;
    return <span className={className}>{emptyLabel}</span>;
  }

  const go = async (a: { name: string; id?: string }) => {
    if (a.id) {
      if (onArtistClick) onArtistClick(a.id);
      else navigate(`/artist/${a.id}`);
      return;
    }
    setBusyName(a.name);
    try {
      const r = await api.search(a.name, 'artist');
      const hit =
        (r.artists || []).find(
          (x) => x.title.toLowerCase() === a.name.toLowerCase() || x.id.startsWith('UC'),
        ) || r.artists?.[0];
      if (hit?.id) {
        if (onArtistClick) onArtistClick(hit.id);
        else navigate(`/artist/${hit.id}`);
      }
    } catch {
      /* ignore */
    } finally {
      setBusyName(null);
    }
  };

  return (
    <span className={className}>
      {artists.map((a, i) => (
        <span key={`${a.name}-${a.id || i}`}>
          {i > 0 ? separator : null}
          <button
            type="button"
            disabled={busyName === a.name}
            onClick={(e) => {
              e.stopPropagation();
              void go(a);
            }}
            className="hover:underline hover:text-white disabled:opacity-60"
            title={a.id ? `Voir ${a.name}` : `Rechercher ${a.name}`}
          >
            {busyName === a.name ? '…' : a.name}
          </button>
        </span>
      ))}
    </span>
  );
}
