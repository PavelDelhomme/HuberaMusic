/**
 * Politiques lecture / paroles — testées avant chaque déploiement prod.
 * Ne pas raccourcir les délais froid : yt-dlp prend ~28–40 s.
 */

export const ANDROID_COLD_DISK_WAIT_MS = 28_000;
export const GET_AUDIO_FORMAT_DEADLINE_MS = 40_000;
export const LYRICS_FULL_WAIT_MS = 12_000;
/** UA Exo / OkHttp — PLM historique + HuberaMusic actuel. */
export const ANDROID_CLIENT_UA_RE = /PLM-Android|HuberaMusic-Android/i;

/** Un échec timeout ne doit pas 503 toutes les retries Exo pendant 30 s. */
export function downloadFailKind(msg: string): 'bot' | 'soft' | 'transient' {
  const m = String(msg || '');
  if (/cooling down|Sign in to confirm|rate-limited|LOGIN_REQUIRED|not a bot/i.test(m)) {
    return 'bot';
  }
  if (/timeout|deadline|pas encore prêt|first-byte|AbortError|aborted/i.test(m)) {
    return 'transient';
  }
  return 'soft';
}

export function downloadFailCooldownMs(kind: ReturnType<typeof downloadFailKind>, botMs: number): number {
  if (kind === 'bot') return Math.max(45_000, Math.min(120_000, botMs));
  if (kind === 'transient') return 3_000;
  return 12_000;
}

/** Réponse API vide / pending : ne pas écraser un cache karaoké déjà bon. */
export function shouldReplaceCachedLyrics(incoming: string | null | undefined): boolean {
  return Boolean(incoming && incoming.trim().length >= 8);
}
