/** Affiche une durée en secondes : `m:ss` ou `h:mm:ss` si ≥ 1 h. */
export function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const total = Math.floor(totalSeconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = s.toString().padStart(2, '0');
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** Temps restant compact : `-3:45` (ou `-0:00` si fini). */
export function formatRemaining(progressSec: number, durationSec: number): string {
  if (!(durationSec > 0) || !Number.isFinite(durationSec)) return '-0:00';
  const left = Math.max(0, Math.ceil(durationSec - Math.max(0, progressSec)));
  return `-${formatClock(left)}`;
}

/** Secondes d’une piste (null si inconnue). */
export function trackDurationSeconds(track: {
  duration?: string | number;
  durationSeconds?: number;
}): number | null {
  if (
    typeof track.durationSeconds === 'number' &&
    Number.isFinite(track.durationSeconds) &&
    track.durationSeconds > 0
  ) {
    return Math.floor(track.durationSeconds);
  }
  if (typeof track.duration === 'number' && Number.isFinite(track.duration) && track.duration > 0) {
    return Math.floor(track.duration);
  }
  if (track.duration != null && typeof track.duration === 'object') return null;
  const raw = String(track.duration ?? '').trim();
  if (!raw || raw === '[object Object]') return null;
  // Uniquement horloge pure (évite labels / garbage type « Play … by … »)
  if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(raw) && !/^\d+$/.test(raw)) {
    const m = raw.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
    if (!m) return null;
    return trackDurationSeconds({ duration: m[1] });
  }
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 0 ? n : null;
  }
  const parts = raw.split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 3) {
    const [h, m, s] = parts;
    return h * 3600 + m * 60 + s;
  }
  if (parts.length === 2) {
    const [m, s] = parts;
    return m * 60 + s;
  }
  return null;
}

/** Somme des durées d’une liste de pistes. */
export function sumTracksDurationSeconds(
  tracks: { duration?: string | number; durationSeconds?: number }[],
): number {
  let total = 0;
  for (const t of tracks) {
    const s = trackDurationSeconds(t);
    if (s != null) total += s;
  }
  return total;
}

/**
 * Durée totale lisible : `42 min`, `1 h 24 min`, `2 j 5 h`.
 * Pour albums / playlists / mixes.
 */
export function formatTotalDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '';
  const total = Math.floor(totalSeconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  if (days > 0) {
    if (hours > 0) return `${days} j ${hours} h`;
    return `${days} j`;
  }
  if (hours > 0) {
    if (mins > 0) return `${hours} h ${mins} min`;
    return `${hours} h`;
  }
  if (mins > 0) return `${mins} min`;
  return `${total} s`;
}

/** Normalise une durée texte API (`164:16` → `2:44:16`) ou secondes numériques. */
export function formatTrackDuration(track: {
  duration?: string | number;
  durationSeconds?: number;
}): string {
  const sec = trackDurationSeconds(track);
  if (sec != null) return formatClock(sec);
  return '';
}
