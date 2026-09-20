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
/** Cooldown bot/429 par compte MHC (pas un seul verrou global). */
const userCooldownUntil = new Map<string, number>();
const recentBotHits: Array<{ userId: string; at: number }> = [];
const GLOBAL_BOT_WINDOW_MS = 120_000;
const GLOBAL_BOT_USER_THRESHOLD = 3;

export function ytDlpActiveCount(): number {
  return active;
}

export function ytDlpMaxConcurrent(): number {
  return MAX;
}

export function ytDlpLiveReserved(): number {
  return LIVE_RESERVED;
}

export function isYtDlpCoolingDown(userId?: string): boolean {
  const now = Date.now();
  if (now < cooldownUntil) return true;
  if (userId) {
    const until = userCooldownUntil.get(userId) || 0;
    return now < until;
  }
  return false;
}

export function ytDlpCooldownRemainingMs(userId?: string): number {
  const now = Date.now();
  const g = Math.max(0, cooldownUntil - now);
  const u = userId ? Math.max(0, (userCooldownUntil.get(userId) || 0) - now) : 0;
  return Math.max(g, u);
}

/** Détecte botcheck / rate-limit YouTube. Cooldown par user ; global si 3+ comptes en 2 min. */
export function noteYtDlpFailure(err: unknown, userId?: string): void {
  const msg = String((err as Error)?.message || err || '');
  if (
    !/Sign in to confirm|not a bot|rate-limited|LOGIN_REQUIRED|confirm you.re not a bot|This content isn.t available/i.test(
      msg,
    )
  ) {
    return;
  }
  const now = Date.now();
  const until = now + BOT_COOLDOWN_MS;
  if (userId) {
    const prev = userCooldownUntil.get(userId) || 0;
    if (until > prev) userCooldownUntil.set(userId, until);
  }
  recentBotHits.push({ userId: userId || '_anon', at: now });
  while (recentBotHits.length && recentBotHits[0]!.at < now - GLOBAL_BOT_WINDOW_MS) {
    recentBotHits.shift();
  }
  const distinct = new Set(recentBotHits.map((h) => h.userId));
  if (distinct.size >= GLOBAL_BOT_USER_THRESHOLD) {
    if (until > cooldownUntil) cooldownUntil = until;
  }
  if (now - lastCooldownLog > 60_000) {
    lastCooldownLog = now;
    console.warn(
      `[ytDlpGate] cooldown ${Math.round(BOT_COOLDOWN_MS / 1000)}s ${
        userId ? `user=${userId.slice(0, 8)}` : 'anon'
      } global=${distinct.size >= GLOBAL_BOT_USER_THRESHOLD} — ${msg.slice(0, 100)}`,
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
  userId?: string;
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
  const userId = opts.userId;
  if (!bypass && isYtDlpCoolingDown(userId)) {
    throw new Error(
      `yt-dlp cooling down ${Math.ceil(ytDlpCooldownRemainingMs(userId) / 1000)}s (bot/rate-limit)`,
    );
  }
  const cap = live ? MAX : warmCap();
  if (active >= cap) {
    await new Promise<void>((resolve) => {
      if (live) liveWaiters.push(resolve);
      else waiters.push(resolve);
    });
  }
  if (!bypass && isYtDlpCoolingDown(userId)) {
    throw new Error(
      `yt-dlp cooling down ${Math.ceil(ytDlpCooldownRemainingMs(userId) / 1000)}s (bot/rate-limit)`,
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
    if (noteFailure) noteYtDlpFailure(err, userId);
    throw err;
  } finally {
    active -= 1;
    const next = liveWaiters.shift() || waiters.shift();
    if (next) next();
  }
}
