/**
 * Plafond global de processus yt-dlp simultanés.
 * Sans ça, warm/prefetch + multi-proxy × formats → 30–40 proc / ~2 Go / 100%+ CPU.
 */
const MAX = Math.max(1, Math.min(12, Number(process.env.YTDLP_MAX_CONCURRENT || 4) || 4));

let active = 0;
const waiters: Array<() => void> = [];

export function ytDlpActiveCount(): number {
  return active;
}

export function ytDlpMaxConcurrent(): number {
  return MAX;
}

export async function withYtDlpSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  }
}
