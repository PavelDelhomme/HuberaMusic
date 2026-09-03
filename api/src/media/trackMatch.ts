/**
 * Appariement titre / artiste pour retrouver un morceau dont l'identifiant YouTube
 * est mort. Séparé de la résolution pour rester testable sans base ni réseau.
 */
import type { Track } from '../youtube/types.js';

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(official|video|lyrics|audio|mv|clip|hd|4k|remaster(ed)?)\b/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const VERSION_MARKERS: [RegExp, string][] = [
  [/\bremix(e|ed)?\b|\bmix\b/i, 'remix'],
  [/\blive\b|\ben concert\b|\bconcert\b|\bsession\b/i, 'live'],
  [/\bacoustic|\bacoustique|\bunplugged\b/i, 'acoustic'],
  [/\binstrumental\b|\bkaraok/i, 'instrumental'],
  [/\bextended\b|\bclub edit\b|\blong version\b/i, 'extended'],
  [/\bradio edit\b|\bshort version\b/i, 'radio'],
  [/\bsped ?up\b|\bnightcore\b|\bslowed\b|\breverb\b/i, 'speed'],
  [/\bcover\b|\breprise\b/i, 'cover'],
  [/\bdemo\b|\bwork in progress\b|\brehearsal\b|\bmaquette\b/i, 'demo'],
];

/**
 * `normalize` supprime les parenthèses, donc « Don't Be So Shy (Filatov & Karas Remix) »
 * et « Don't Be So Shy (Work in Progress) » deviennent identiques. On compare donc à
 * part les mentions de version pour ne pas substituer un remix par l'original.
 */
export function versionTags(title: string): Set<string> {
  const out = new Set<string>();
  for (const [re, tag] of VERSION_MARKERS) if (re.test(title)) out.add(tag);
  return out;
}

export function sameVersion(deadTitle: string, candTitle: string): boolean {
  const want = versionTags(deadTitle);
  const got = versionTags(candTitle);
  if (want.size !== got.size) return false;
  for (const tag of want) if (!got.has(tag)) return false;
  return true;
}

export function artistLine(t: Pick<Track, 'artists'>): string {
  return (t.artists || [])
    .map((a) => a?.name)
    .filter(Boolean)
    .join(', ');
}

/** Les titres de la bibliothèque contiennent des coquilles (« Juqu'à la mort »). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = new Array<number>(cols);
  let cur = new Array<number>(cols);
  for (let j = 0; j < cols; j++) prev[j] = j;
  for (let i = 1; i < rows; i++) {
    cur[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[cols - 1] / Math.max(a.length, b.length);
}

/**
 * YouTube nomme massivement ses vidéos « Artiste - Titre ». Sans retirer le nom
 * de l'artiste, « Shy'm - #ShimiSoldiers » ne vaut qu'une correspondance
 * partielle face à « #ShimiSoldiers », ce qui recalait le bon remplaçant.
 */
export function withoutArtist(normTitle: string, normArtist: string): string {
  if (!normTitle || !normArtist) return '';
  const words = new Set(normArtist.split(' ').filter((w) => w.length > 1));
  if (!words.size) return '';
  const kept = normTitle.split(' ').filter((w) => !words.has(w));
  const out = kept.join(' ').trim();
  return out && out !== normTitle ? out : '';
}

/** Meilleur palier de correspondance de titre entre toutes les écritures possibles. */
export function titleScore(nt: string, ct: string, na: string, ca: string): number {
  const wanted = [nt, withoutArtist(nt, na)].filter(Boolean);
  const got = [ct, withoutArtist(ct, ca), withoutArtist(ct, na)].filter(Boolean);
  let best = 0;
  for (const w of wanted) {
    for (const g of got) {
      let s: number;
      if (g === w) s = 50;
      else if (similarity(w, g) >= 0.85) s = 44;
      else if (g.includes(w) || w.includes(g)) s = 34;
      else {
        const want = new Set(w.split(' ').filter((x) => x.length > 2));
        const words = g.split(' ').filter((x) => x.length > 2);
        const hit = words.filter((x) => want.has(x)).length;
        const ratio = want.size ? hit / want.size : 0;
        s = ratio < 0.7 ? 0 : Math.round(ratio * 26);
      }
      if (s > best) best = s;
    }
  }
  return best;
}

/**
 * Les rééditions par des chaînes tierces nomment l'interprète dans le titre —
 * « Ave Maria païen - NOA » publié par « B Walbyx ». Le nom de la chaîne ne dit
 * alors rien du morceau, contrairement au titre.
 */
export function titleNamesArtist(normCandTitle: string, normArtist: string): boolean {
  const words = normArtist.split(' ').filter((w) => w.length > 2);
  if (!words.length) return false;
  const inTitle = new Set(normCandTitle.split(' '));
  return words.every((w) => inTitle.has(w));
}

/**
 * Exigeant volontairement : un mauvais remplaçant ferait jouer une reprise ou un
 * autre morceau, ce qui est pire qu'une erreur franche.
 */
export function scoreCandidate(
  cand: Track,
  title: string,
  artist: string,
  durationSec?: number | null,
): number {
  const nt = normalize(title);
  const na = normalize(artist);
  const ct = normalize(cand.title || '');
  const ca = normalize(artistLine(cand));
  if (!nt || !ct) return 0;
  if (!sameVersion(title, cand.title || '')) return 0;

  const tScore = titleScore(nt, ct, na, ca);
  if (!tScore) return 0;
  let score = tScore;

  // Sans correspondance d'artiste on refuse : c'est le garde-fou principal.
  if (!na || !ca) return 0;
  if (ca === na) score += 40;
  else if (ca.includes(na) || na.includes(ca)) score += 30;
  else if (titleNamesArtist(ct, na)) score += 28;
  else {
    const want = new Set(na.split(' ').filter((w) => w.length > 2));
    const got = ca.split(' ').filter((w) => w.length > 2);
    if (!got.some((w) => want.has(w))) return 0;
    score += 16;
  }

  if (durationSec && cand.durationSeconds && cand.durationSeconds > 0) {
    const delta = Math.abs(cand.durationSeconds - durationSec) / durationSec;
    if (delta <= 0.05) score += 15;
    else if (delta <= 0.15) score += 8;
    else if (delta > 0.35) return 0;
  }
  return score;
}
