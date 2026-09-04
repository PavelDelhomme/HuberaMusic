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
  const intro = Math.min(Math.max(dur * 0.08, 6), 18);
  const outro = Math.min(Math.max(dur * 0.07, 5), 16);
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

export function looksLikeLyrics(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 40) return false;
  if (/paroles indisponibles|lyrics not available|not available|instrumental/i.test(t)) {
    return false;
  }
  return lignesChantees(t).length >= 4;
}
