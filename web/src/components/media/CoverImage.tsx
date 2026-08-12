import { useEffect, useMemo, useState } from 'react';
import { thumbCandidates, type Track } from '../../api';

type Props = {
  item:
    | Track
    | { thumbnails?: Track['thumbnails']; title?: string; name?: string; type?: string; id?: string };
  size?: number;
  className?: string;
  rounded?: 'md' | 'lg' | 'full' | 'none';
  alt?: string;
};

function initialOf(item: Props['item']) {
  const t = (item as Track).title || (item as { name?: string }).name || '?';
  return t.trim().charAt(0).toUpperCase() || '?';
}

/** Couleurs type tuiles YTM pour moods sans cover. */
function moodTint(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 55% 32%)`;
}

function radiusClass(rounded: Props['rounded']) {
  if (rounded === 'full') return 'rounded-full';
  if (rounded === 'lg') return 'rounded-lg';
  if (rounded === 'none') return '';
  return 'rounded-md';
}

export function CoverImage({ item, size = 200, className = '', rounded = 'md', alt = '' }: Props) {
  const itemId = (item as { id?: string }).id || '';
  const isMood = itemId.startsWith('mood:') || itemId.includes('moods_and_genres');
  const title = (item as Track).title || (item as { name?: string }).name || '';
  const thumbKey = (item.thumbnails || []).map((t) => t.url).join('|');
  const candidates = useMemo(
    () => thumbCandidates(item, size),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clés stables plutôt que ref objet
    [itemId, thumbKey, size],
  );
  const [idx, setIdx] = useState(0);
  const r = radiusClass(rounded);
  const eager = size >= 320;

  useEffect(() => {
    setIdx(0);
  }, [candidates.join('|')]);

  const src = candidates[idx] || '';
  const advance = () => setIdx((i) => (i + 1 < candidates.length ? i + 1 : i));
  const tint = isMood ? moodTint(itemId || title) : undefined;

  return (
    <div className={`relative h-full w-full overflow-hidden bg-yt-elevated ${r} ${className}`}>
      <div
        className={`absolute inset-0 flex items-center justify-center text-lg font-semibold ${
          tint ? 'text-white/90' : 'bg-gradient-to-br from-[#3a3a3a] to-[#1a1a1a] text-white/70'
        }`}
        style={tint ? { background: `linear-gradient(145deg, ${tint}, #121212)` } : undefined}
        aria-hidden
      >
        <span className="relative px-2 text-center text-sm font-semibold leading-tight sm:text-base">
          {isMood ? title || initialOf(item) : initialOf(item)}
        </span>
      </div>
      {src ? (
        <img
          key={src}
          src={src}
          alt={alt}
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full object-cover"
          loading={eager ? 'eager' : 'lazy'}
          fetchPriority={eager ? 'high' : 'auto'}
          decoding="async"
          onError={advance}
          onLoad={(e) => {
            // Placeholder YouTube / image trop petite → candidat suivant
            const img = e.currentTarget;
            if (img.naturalWidth > 0 && img.naturalWidth < 120 && idx + 1 < candidates.length) {
              advance();
            }
          }}
        />
      ) : null}
    </div>
  );
}
