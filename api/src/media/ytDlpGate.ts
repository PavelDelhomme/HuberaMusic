/**
 * Plafond global de processus yt-dlp simultanés + cooldown bot / rate-limit.
 * Sans ça, warm/prefetch + multi-proxy × formats → 30–40 proc / ~2 Go / 100%+ CPU
 * et spam ERROR YouTube dans les logs Docker.
 *
 * Important : le cooldown ne doit PAS bloquer la rotation de proxies / relais maison.
 * On ne pose le cooldown qu’après épuisement des tentatives (noteYtDlpFailure explicite).
 */
const MAX = Math.max(1, Math.min(12, Number(process.env.YTDLP_MAX_CONCURRENT || 4) || 4));
/** Garde ≥1 slot pour l’écoute live — le warm ne doit jamais saturer yt-dlp. */
const LIVE_RESERVED = Math.max(
  1,
  Math.min(MAX - 1, Number(process.env.YTDLP_LIVE_RESERVED || 1) || 1),
);
const BOT_COOLDOWN_MS = Math.max(
  30_000,
  Math.min(3_600_000, Number(process.env.YTDLP_BOT_COOLDOWN_MS || 300_000) || 300_000),
);

let active = 0;
const waiters: Array<() => void> = [];
/** File prioritaire pour les requêtes stream live (passe devant le warm). */
const liveWaiters: Array<() => void> = [];
let cooldownUntil = 0;
let lastCooldownLog = 0;

export function ytDlpActiveCount(): number {
  return active;
}

export function ytDlpMaxConcurrent(): number {
  return MAX;
}

export function ytDlpLiveReserved(): number {
  return LIVE_RESERVED;
}

export function isYtDlpCoolingDown(): boolean {
  return Date.now() < cooldownUntil;
}

export function ytDlpCooldownRemainingMs(): number {
  return Math.max(0, cooldownUntil - Date.now());
}

/** Détecte botcheck / rate-limit YouTube et coupe yt-dlp un moment (IP VPS directe). */
export function noteYtDlpFailure(err: unknown): void {
  const msg = String((err as Error)?.message || err || '');
  if (
    !/Sign in to confirm|not a bot|rate-limited|LOGIN_REQUIRED|confirm you.re not a bot|This content isn.t available/i.test(
      msg,
    )
  ) {
    return;
  }
  const until = Date.now() + BOT_COOLDOWN_MS;
  if (until > cooldownUntil) cooldownUntil = until;
  const now = Date.now();
  if (now - lastCooldownLog > 60_000) {
    lastCooldownLog = now;
    console.warn(
      `[ytDlpGate] cooldown ${Math.round(BOT_COOLDOWN_MS / 1000)}s (bot/rate-limit) — ${msg.slice(0, 100)}`,
    );
  }
}

export type YtDlpSlotOpts = {
  /** Continuer même pendant cooldown (ex. autre proxy / IP). */
  bypassCooldown?: boolean;
  /** Si false, ne pas armé le cooldown sur erreur (la boucle appelante décide). */
  noteFailure?: boolean;
  /** Priorité stream live — passe devant le warm/prefetch en file d’attente. */
  live?: boolean;
};

function warmCap(): number {
  return Math.max(1, MAX - LIVE_RESERVED);
}

export async function withYtDlpSlot<T>(
  fn: () => Promise<T>,
  opts: YtDlpSlotOpts = {},
): Promise<T> {
  const bypass = opts.bypassCooldown === true;
  const noteFailure = opts.noteFailure !== false;
  const live = opts.live === true;
  if (!bypass && isYtDlpCoolingDown()) {
    throw new Error(
      `yt-dlp cooling down ${Math.ceil(ytDlpCooldownRemainingMs() / 1000)}s (bot/rate-limit)`,
    );
  }
  const cap = live ? MAX : warmCap();
  if (active >= cap) {
    await new Promise<void>((resolve) => {
      if (live) liveWaiters.push(resolve);
      else waiters.push(resolve);
    });
  }
  if (!bypass && isYtDlpCoolingDown()) {
    throw new Error(
      `yt-dlp cooling down ${Math.ceil(ytDlpCooldownRemainingMs() / 1000)}s (bot/rate-limit)`,
    );
  }
  // Re-check cap after wait (autre live a pu prendre le slot réservé).
  if (!live && active >= warmCap()) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active += 1;
  try {
    return await fn();
  } catch (err) {
    if (noteFailure) noteYtDlpFailure(err);
    throw err;
  } finally {
    active -= 1;
    const next = liveWaiters.shift() || waiters.shift();
    if (next) next();
  }
}
