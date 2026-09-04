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

export function looksLikeLyrics(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 40) return false;
  if (/paroles indisponibles|lyrics not available|not available|instrumental/i.test(t)) {
    return false;
  }
  return lignesChantees(t).length >= 4;
}
