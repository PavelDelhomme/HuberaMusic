/**
 * Quand aucune source n’a de timings (YouTube Music, LRCLIB, sous-titres),
 * on répartit les lignes sur la durée du morceau. Ce n’est pas un karaoké
 * studio, mais le suivi se comporte comme sur un titre qui en a un :
 * la ligne active avance avec la lecture au lieu de rester un bloc statique.
 */

export type TimedLine = { startMs: number; text: string };

function estMarqueur(line: string): boolean {
  const s = line.trim();
  if (!s) return true;
  if (/^\[.+]$/.test(s)) return true;
  if (/^\(.+\)$/.test(s) && s.length < 28) return true;
  if (
    /^(intro|outro|instrumental|bridge|chorus|refrain|couplet|verse|hook|solo)\b/i.test(s) &&
    s.length < 28
  ) {
    return true;
  }
  return false;
}

export function lignesChantees(raw: string): string[] {
  const out: string[] = [];
  for (const row of raw.split(/\r?\n/)) {
    const s = row.replace(/\u00a0/g, ' ').trim();
    if (estMarqueur(s)) continue;
    out.push(s);
  }
  return out;
}

/**
 * Répartit les lignes sur [intro, durée − outro], pondérées par leur longueur :
 * un refrain long occupe plus de temps qu’un interjet.
 */
export function estimateTimedFromPlain(
  raw: string,
  durationSec?: number | null,
): TimedLine[] {
  const lines = lignesChantees(raw);
  if (lines.length < 2) return [];
  const dur =
    durationSec && durationSec >= 20 ? durationSec : Math.max(lines.length * 3.2, 60);
  const dense = lines.length >= 36;
  const intro = dense
    ? Math.min(Math.max(dur * 0.02, 1.4), 5)
    : Math.min(Math.max(dur * 0.035, 2.0), 8);
  const outro = dense
    ? Math.min(Math.max(dur * 0.04, 2.5), 9)
    : Math.min(Math.max(dur * 0.055, 3.5), 12);
  const window = Math.max(dur - intro - outro, lines.length * 1.2);
  const weights = lines.map((l) => Math.max(8, l.length));
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  return lines.map((text, i) => {
    const startMs = Math.round((intro + (acc / total) * window) * 1000);
    acc += weights[i]!;
    return { startMs, text };
  });
}

function mots(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/**
 * Colle une feuille de paroles propre (Genius…) sur les horodatages des
 * sous-titres YouTube. Le texte reste lisible, le suivi suit vraiment le chant.
 */
export function snapPlainToCaptions(plain: string, caps: TimedLine[]): TimedLine[] | null {
  const lines = lignesChantees(plain);
  if (lines.length < 4 || caps.length < 4) return null;
  const capWords = caps.map((c) => mots(c.text));
  let ci = 0;
  const assigned: number[] = [];
  let hits = 0;
  const window = Math.max(6, Math.ceil((caps.length / lines.length) * 2.5));
  for (const line of lines) {
    const words = mots(line);
    let best = ci;
    let bestScore = 0;
    const to = Math.min(caps.length, ci + window);
    for (let j = ci; j < to; j++) {
      const cw = capWords[j]!;
      if (!cw.length || !words.length) continue;
      const score = words.filter((w) => cw.includes(w)).length;
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }
    if (bestScore > 0) hits += 1;
    assigned.push(best);
    ci = best;
  }
  if (hits / lines.length >= 0.25) {
    return lines.map((text, i) => ({ startMs: caps[assigned[i]!].startMs, text }));
  }
  const t0 = caps[0]!.startMs;
  const t1 = caps[caps.length - 1]!.startMs;
  const span = Math.max(t1 - t0, 1_000);
  return lines.map((text, i) => ({
    startMs: Math.round(t0 + (i / Math.max(1, lines.length - 1)) * span),
    text,
  }));
}

/** Captions YouTube « [Music] » / ♪ — pas du chant. */
export function isInstrumentalCaption(text: string): boolean {
  const s = String(text || '')
    .replace(/[♪♫🎵🎤\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return true;
  if (s.length < 2) return true;
  return /^(music|instrumental|applause|intro|outro|sifflement|whistling|laughter)$/i.test(s);
}

/** Première ligne chantée (ms). */
export function firstVocalMs(timed: TimedLine[] | null | undefined): number | null {
  if (!timed?.length) return null;
  for (const l of timed) {
    if (estMarqueur(l.text) || isInstrumentalCaption(l.text)) continue;
    return l.startMs;
  }
  return timed[0]?.startMs ?? null;
}

/**
 * Colle un LRC (souvent 0 = 1ʳᵉ phrase) sur le début réel du chant dans le clip.
 * YouTube le fait via les captions. Ex. Fils de joie : ~+37 s d’intro cinématique.
 */
export function alignTimedToVocalOnset(
  timed: TimedLine[],
  vocalOnsetMs: number | null | undefined,
): { timed: TimedLine[]; offsetMs: number } {
  if (!timed.length || vocalOnsetMs == null || !Number.isFinite(vocalOnsetMs)) {
    return { timed, offsetMs: 0 };
  }
  const first = firstVocalMs(timed);
  if (first == null) return { timed, offsetMs: 0 };
  const offsetMs = Math.round(vocalOnsetMs - first);
  // Uniquement un blanc / intro AVANT le chant (Fils de joie +37 s). Jamais tirer en arrière.
  if (offsetMs < 800) return { timed, offsetMs: 0 };
  if (offsetMs > 120_000) return { timed, offsetMs: 0 };
  return {
    offsetMs,
    timed: timed.map((l) => ({
      ...l,
      startMs: Math.max(0, Math.round(l.startMs + offsetMs)),
    })),
  };
}

/** Intros cinéma où captions / LRCLIB restent collés à 0. */
export const KNOWN_VOCAL_ONSET_MS: Record<string, number> = {
  M7Z2tgJo8Hg: 37_200, // Stromae — Fils de joie (VEVO)
};

export function applyBestVocalOnset(
  timed: TimedLine[],
  captionTimed: TimedLine[] | null | undefined,
  videoId?: string,
): { timed: TimedLine[]; offsetMs: number } {
  const current = firstVocalMs(timed);
  const capOnset = firstVocalMs(captionTimed);
  if (capOnset != null && current != null && capOnset >= current + 800) {
    return alignTimedToVocalOnset(timed, capOnset);
  }
  const known = videoId ? KNOWN_VOCAL_ONSET_MS[videoId] : undefined;
  if (known != null && (current == null || current + 800 < known)) {
    return alignTimedToVocalOnset(timed, known);
  }
  return { timed, offsetMs: 0 };
}

export function looksLikeLyrics(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 40) return false;
  if (/paroles indisponibles|lyrics not available|not available|instrumental/i.test(t)) {
    return false;
  }
  return lignesChantees(t).length >= 4;
}

export function foldLyricMeta(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s*[\[(【].*?[\])】]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenOverlapMeta(a: string, b: string): number {
  const ta = new Set(a.split(' ').filter((x) => x.length > 1));
  const tb = new Set(b.split(' ').filter((x) => x.length > 1));
  if (!ta.size || !tb.size) return 0;
  let n = 0;
  for (const t of ta) if (tb.has(t)) n += 1;
  return n / Math.max(ta.size, tb.size);
}

/** Titre + artiste assez proches pour réutiliser un texte — pas un autre morceau. */
export function lyricsMetaFits(
  wantTitle: string,
  gotTitle: string,
  wantArtist = '',
  gotArtist = '',
): boolean {
  const wt = foldLyricMeta(wantTitle);
  const gt = foldLyricMeta(gotTitle);
  if (!wt || !gt) return false;
  const lenRatio = Math.min(wt.length, gt.length) / Math.max(wt.length, gt.length);
  const titleOk =
    wt === gt ||
    (lenRatio >= 0.78 && tokenOverlapMeta(wt, gt) >= 0.72);
  if (!titleOk) return false;
  const wa = foldLyricMeta(wantArtist);
  if (!wa) return wt === gt;
  const ga = foldLyricMeta(gotArtist);
  if (!ga) return false;
  if (wa === ga) return true;
  const cw = wa.replace(/\s+/g, '');
  const cg = ga.replace(/\s+/g, '');
  if (cw && cg && cw === cg) return true;
  return tokenOverlapMeta(wa, ga) >= 0.6;
}

/** Les horodatages collent à CETTE durée de piste (sinon karaoké d’une autre version). */
export function timedFitsTrack(
  timed: TimedLine[] | null | undefined,
  durationSec?: number | null,
): boolean {
  if (!timed || timed.length < 2) return false;
  if (!durationSec || durationSec < 20) return true;
  const first = timed[0]!.startMs / 1000;
  const last = timed[timed.length - 1]!.startMs / 1000;
  if (first > durationSec * 0.42) return false;
  if (last > durationSec * 1.32 || last < durationSec * 0.45) return false;
  return true;
}
