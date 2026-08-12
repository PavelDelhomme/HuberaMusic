/** Rangées skeleton style YouTube Music (perceived perf). */
export function HomeShelfSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-8" aria-hidden>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r}>
          <div className="mb-3 h-5 w-40 animate-pulse rounded bg-yt-border/50" />
          <div className="flex gap-3 overflow-hidden">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="w-28 shrink-0 sm:w-32">
                <div className="aspect-square animate-pulse rounded-lg bg-yt-border/55" />
                <div className="mt-2 h-3 w-4/5 animate-pulse rounded bg-yt-border/40" />
                <div className="mt-1.5 h-2.5 w-3/5 animate-pulse rounded bg-yt-border/30" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
