/** Barres equalizer style Google Music / YTM — overlay lecture en cours. */
export function PlayingBars({
  className = '',
  size = 'md',
}: {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const h =
    size === 'lg' ? 'h-5 sm:h-7' : size === 'sm' ? 'h-3' : 'h-4 sm:h-5';
  const gap = size === 'lg' ? 'gap-1' : 'gap-0.5';
  const w = size === 'lg' ? 'w-1 sm:w-1.5' : 'w-0.5 sm:w-1';

  return (
    <span
      className={`playing-bars inline-flex items-end justify-center ${gap} ${h} ${className}`}
      aria-hidden
    >
      <span className={`playing-bar ${w} rounded-sm bg-yt-red`} style={{ animationDelay: '0ms' }} />
      <span className={`playing-bar ${w} rounded-sm bg-yt-red`} style={{ animationDelay: '120ms' }} />
      <span className={`playing-bar ${w} rounded-sm bg-yt-red`} style={{ animationDelay: '240ms' }} />
      <span className={`playing-bar ${w} rounded-sm bg-yt-red`} style={{ animationDelay: '80ms' }} />
    </span>
  );
}

/** Voile sombre + barres centrées sur une cover. */
export function PlayingCoverOverlay({
  active,
  playing,
  size = 'md',
}: {
  active: boolean;
  playing: boolean;
  size?: 'sm' | 'md' | 'lg';
}) {
  if (!active) return null;
  return (
    <span
      className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center bg-black/45"
      aria-hidden
    >
      {playing ? (
        <PlayingBars size={size} />
      ) : (
        <span className="h-2 w-2 rounded-full bg-yt-red/90" />
      )}
    </span>
  );
}
