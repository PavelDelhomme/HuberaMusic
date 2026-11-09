import type { Track } from '../youtube/types.js';
import { isJunkArtistName, isPlausibleArtistEntity } from '../youtube/mappers.js';

/** Normalise pour comparaison : minuscules, sans accents, ponctuation allégée. */
export function foldText(s: string): string {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[''`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(s: string): string[] {
  return foldText(s)
    .split(' ')
    .filter((t) => t.length > 0);
}

function includesWord(hay: string, needle: string): boolean {
  if (!needle) return false;
  if (hay === needle) return true;
  return ` ${hay} `.includes(` ${needle} `);
}

/** Orthographes proches pour noms d’artistes courts (suzanne / suzane). */
export function artistNameAliasMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 2) return false;
  if (a.length < 4 || b.length < 4) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (longer.startsWith(shorter) && longer.length - shorter.length <= 2) return true;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  edits += a.length - i + (b.length - j);
  return edits <= 1;
}

/**
 * Distance de Damerau-Levenshtein bornée.
 * « bine » / « bien » (transposition) et « ostromae » / « stromae » (lettre en trop) = 1.
 * Au-delà de `max`, renvoie `max + 1` sans finir le tableau.
 */
export function damerauWithin(a: string, b: string, max: number): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb || Math.abs(la - lb) > max || la > 32 || lb > 32) return max + 1;
  const dp: number[][] = Array.from({ length: la + 1 }, () => new Array<number>(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) dp[i][0] = i;
  for (let j = 0; j <= lb; j++) dp[0][j] = j;
  for (let i = 1; i <= la; i++) {
    let rowMin = max + 1;
    for (let j = 1; j <= lb; j++) {
      const sub = dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      let v = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, sub);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, dp[i - 2][j - 2] + 1);
      }
      dp[i][j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
  }
  return dp[la][lb];
}

/** 1 = égal, 0.85 = une édition, 0 = trop loin. Jamais sur les mots de moins de 4 lettres. */
function fuzzyTokenScore(hayTokens: Set<string>, token: string): number {
  if (!token) return 0;
  if (hayTokens.has(token)) return 1;
  if (token.length < 4) return 0;
  const max = token.length >= 8 ? 2 : 1;
  let best = max + 1;
  for (const h of hayTokens) {
    if (h.length < 4 || Math.abs(h.length - token.length) > max) continue;
    const d = damerauWithin(token, h, max);
    if (d < best) best = d;
    if (best === 0) break;
  }
  if (best === 0) return 1;
  if (best === 1) return 0.85;
  if (best === 2 && max >= 2) return 0.7;
  return 0;
}

/** Préfixe de mot entier : « poto » matche « poto remix », pas « potomac ». */
function startsWithWord(hay: string, needle: string): boolean {
  if (!needle || !hay.startsWith(needle)) return false;
  if (hay.length === needle.length) return true;
  return hay[needle.length] === ' ';
}

function tokenCoverage(hayTokens: Set<string>, queryTokens: string[]): number {
  if (!queryTokens.length) return 0;
  let hit = 0;
  for (const t of queryTokens) {
    const fuzzy = fuzzyTokenScore(hayTokens, t);
    if (fuzzy >= 1) hit += 1;
    else if (fuzzy > 0) hit += fuzzy;
    else if ([...hayTokens].some((h) => h === t || (t.length >= 3 && (h.startsWith(t) || t.startsWith(h)))))
      hit += 0.45;
  }
  return hit / queryTokens.length;
}

/**
 * Réécrit les tokens fautifs s’ils sont à une édition d’un mot du lexique
 * (titres / artistes déjà connus ou renvoyés). Ne change rien si tout est déjà juste.
 */
/**
 * Réécrit les tokens fautifs s’ils sont à une édition d’un mot du lexique.
 * `looseLexicon` (tubes connus) n’accepte qu’un ajout, un retrait ou une transposition :
 * pas « bine » → « mine » juste parce que « mine » est dans un alias.
 * Le lexique principal (résultats déjà là, suggestions) accepte aussi une lettre changée.
 */
export function repairQuery(query: string, lexicon: string[], looseLexicon: string[] = []): string | null {
  const tokens = tokenize(query);
  if (tokens.length < 2) return null;
  const primary = [...new Set(lexicon.map((t) => foldText(t)).filter((t) => t.length >= 3))];
  const loose = [...new Set(looseLexicon.map((t) => foldText(t)).filter((t) => t.length >= 3))];
  if (!primary.length && !loose.length) return null;
  const primarySet = new Set(primary);
  const overlap = (a: string, b: string) => {
    const bag = new Map<string, number>();
    for (const ch of a) bag.set(ch, (bag.get(ch) || 0) + 1);
    let n = 0;
    for (const ch of b) {
      const c = bag.get(ch) || 0;
      if (c > 0) {
        bag.set(ch, c - 1);
        n += 1;
      }
    }
    return n;
  };
  const looseOk = (token: string, cand: string, dist: number) => {
    if (token.length !== cand.length) return dist === Math.abs(token.length - cand.length);
    return overlap(token, cand) === token.length;
  };
  let changed = false;
  const next = tokens.map((t) => {
    if (t.length < 4 || primarySet.has(t)) return t;
    const max = t.length >= 8 ? 2 : 1;
    let best = '';
    let bestD = max + 1;
    let bestOverlap = -1;
    const consider = (cand: string, fromLoose: boolean) => {
      if (Math.abs(cand.length - t.length) > max || cand === t) return;
      const d = damerauWithin(t, cand, max);
      if (d > max || d === 0) return;
      if (fromLoose && !looseOk(t, cand, d)) return;
      const shared = overlap(t, cand);
      const better =
        d < bestD ||
        (d === bestD && shared > bestOverlap) ||
        (d === bestD &&
          shared === bestOverlap &&
          !!best &&
          Math.abs(cand.length - t.length) < Math.abs(best.length - t.length));
      if (!best || better) {
        bestD = d;
        best = cand;
        bestOverlap = shared;
      }
    };
    for (const cand of primary) consider(cand, false);
    for (const cand of loose) {
      if (!primarySet.has(cand)) consider(cand, true);
    }
    if (!best || best === t) return t;
    changed = true;
    return best;
  });
  if (!changed) return null;
  const repaired = next.join(' ');
  return repaired === foldText(query) ? null : repaired;
}

/** Chaînes / titres bruit : réactions, lyrics, karaoke, podcasts… */
export function isSpokenWordHit(track: Track): boolean {
  const title = foldText(track.title);
  const artists = (track.artists || []).map((a) => String(a.name || '').trim()).filter(Boolean);
  const artistFold = foldText(artists.join(' '));
  if (
    /\b(episode|podcast|audiobook|audio\s*book|livre\s*audio|full\s*audiobook|stand\s*up|standup|interview|documentary|documentaire|explained|lecture|sermon|speech|techtalk|ted\s*talk)\b/.test(
      title,
    )
  ) {
    return true;
  }
  if (/\b(episode|podcast|audiobook|livre\s*audio|interview|stand\s*up)\b/.test(artistFold)) {
    return true;
  }
  // Sous-titres YTM podcast : artiste = date (ex. « Jul 12, 2024 »)
  if (
    artists.some(
      (n) =>
        /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(n) && /\d{4}/.test(n),
    )
  ) {
    return true;
  }
  // Vidéos très longues typées « song » par erreur (talk / film)
  const dur = Number(track.durationSeconds || 0);
  if (dur >= 25 * 60 && track.type !== 'song') return true;
  return false;
}

export function isLowQualitySearchHit(track: Track): boolean {
  const title = foldText(track.title);
  const artists = (track.artists || []).map((a) => String(a.name || '').trim()).filter(Boolean);
  const artistFold = foldText(artists.join(' '));

  if (artists.some((n) => isJunkArtistName(n))) return true;
  if (isSpokenWordHit(track)) return true;
  if (/\b(reacts?|reaction|first time reaction)\b/.test(title)) return true;
  if (/\b(medley\s+reaction|mv\s+reaction|song\s+reaction)\b/.test(title)) return true;
  if (/\b(lyrics?|karaoke|soundlyrics|lyric\s*video)\b/.test(artistFold)) return true;
  if (/\b(lyrics?\s*(video|channel)|karaoke|sound\s*lyrics)\b/.test(title)) return true;
  // Hors musique : jeux, trailers, tutos, vlogs, films…
  if (
    /\b(gameplay|let'?s\s*play|walkthrough|speedrun|playthrough|fortnite|minecraft|roblox|gta\s*5|gta\s*v)\b/.test(
      title,
    )
  ) {
    return true;
  }
  if (
    /\b(trailer|teaser|behind\s*the\s*scenes|making\s*of|full\s*movie|entire\s*film|watch\s*along)\b/.test(
      title,
    )
  ) {
    return true;
  }
  if (
    /\b(tutorial|how\s*to|unboxing|vlog|asmr|q\s*&\s*a|q\s*and\s*a|challenge\s*failed|prank)\b/.test(
      title,
    )
  ) {
    return true;
  }
  if (/\b(comedy\s*special|sketch\s*comedy|funny\s*moments|best\s*of\s*fails)\b/.test(title)) {
    return true;
  }
  // Pubs / reels « bientôt dispo » — pas le morceau (ex. Lorette « la maison brûle est dispo… »)
  if (
    /\b(est\s+dispo|bientot\s+dispo|disponible\s+(sur|partout|partout)|toutes\s+les\s+plateformes|plateformes?\b|new\s*music|version\s+complete|#newmusic)\b/.test(
      title,
    )
  ) {
    return true;
  }
  const rawTitle = String(track.title || '');
  if (/[❤️🥹🫂🔥✨]/.test(rawTitle) && /\b(dispo|disponible|partout|plateforme|sorti)/.test(title)) {
    return true;
  }
  // Reels / Shorts bourrés de hashtags (#Cover #chanteuse…) — pas le titre catalogue
  const hashCount = (rawTitle.match(/#/g) || []).length;
  if (hashCount >= 2) return true;
  if (hashCount >= 1 && /\b(cover|covers|piano|voix|chanteuse|chansonfrancaise)\b/.test(title)) {
    return true;
  }
  return false;
}

/**
 * Reprise, fan-made, exclu, live, lyrics, piano… — pas le titre officiel.
 * Si la requête demande elle-même cette version (« dingga piano »), on ne la pénalise pas.
 */
const DERIVATIVE_LATIN =
  /\b(covers?|piano|guitar|drums?|ukulele|karaoke|remix(?:es)?|bootleg|mashups?|nightcore|sped\s*up|slowed|reverb|fitness|bpm|performances?|choreograph\w*|dance\s*practice|practices?|making\s*(?:film|of)|stage\s*mix|fancams?|face\s*cams?|focus\s*cams?|line\s*distributions?|color\s*coded|killing\s*voice|lyrics?|lives?|exclusives?|exclus?|fan\s*made|fanmade|dance\s*covers?|acoustics?|instrumentals?|reactions?|8d|tiktok|shorts|unofficial|visuali[sz]ers?)\b/i;
const DERIVATIVE_HANGUL = /안무|라이브|직캠|교차편집|사복|팬캠|연습|페이스캠/;

export function isDerivativeSearchHit(track: Track, query?: string): boolean {
  const q = foldText(query || '');
  const titleRaw = String(track.title || '');
  const artistRaw = (track.artists || []).map((a) => String(a.name || '')).join(' ');
  let hay = foldText(`${titleRaw} ${artistRaw}`);
  if (q) {
    for (const t of tokenize(q)) {
      if (t.length < 3) continue;
      hay = hay.replace(new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), ' ');
    }
  }
  if (DERIVATIVE_LATIN.test(hay)) return true;
  const raw = `${titleRaw} ${artistRaw}`;
  if (DERIVATIVE_HANGUL.test(raw)) return true;
  if (/踊ってみた|歌ってみた/.test(raw)) return true;
  // « SokolBeats » : instrumental / type beat, pas « Beatles ».
  const artistFold = foldText(artistRaw);
  if (
    tokenize(artistFold).some((t) => /beats$/.test(t) && t !== 'beatles') &&
    !tokenize(q).some((t) => /beats?$/.test(t))
  ) {
    return true;
  }
  return false;
}

/** « Dingga » ou « 딩가딩가 (Dingga) » : le nom demandé est le titre, pas une description. */
export function catalogTitleMatches(rawTitle: string, query: string): boolean {
  const q = foldText(query);
  if (!q) return false;
  const title = foldText(rawTitle);
  if (title === q) return true;
  const parens = [...String(rawTitle).matchAll(/[(\[【]([^)\]】]+)[)\]】]/g)].map((m) => foldText(m[1]));
  if (!parens.some((p) => p === q)) return false;
  const rest = foldText(String(rawTitle).replace(/[(\[【][^)\]】]+[)\]】]/g, ' '));
  if (DERIVATIVE_LATIN.test(rest) || DERIVATIVE_HANGUL.test(rawTitle)) return false;
  return true;
}

/** Titre jouable musique (pas album / artiste / podcast / hors-musique). */
export function isMusicPlayableHit(track: Track): boolean {
  if (!track?.id || !/^[a-zA-Z0-9_-]{11}$/.test(track.id)) return false;
  if (track.type === 'album' || track.type === 'artist' || track.type === 'playlist') return false;
  if (isSpokenWordHit(track) || isLowQualitySearchHit(track)) return false;
  // Reco / autoplay : préférer song ; video OK seulement si pas déjà junk (heuristiques ci-dessus)
  // et durée plausible (pas un short spam ni un film).
  if (track.type === 'video') {
    const dur = Number(track.durationSeconds || 0);
    if (dur > 0 && (dur < 45 || dur > 12 * 60)) return false;
  }
  return track.type === 'song' || track.type === 'video' || track.type === 'unknown' || !track.type;
}

function artistMatchesSpan(artistNames: string[], span: string): boolean {
  const s = foldText(span);
  if (!s) return false;
  const spanTokens = tokenize(s);
  return artistNames.some((n) => {
    const f = foldText(n);
    if (!f) return false;
    // Un seul token : égalité stricte du nom d’artiste (évite « internet » ∈ « Internet du Village »)
    if (spanTokens.length === 1) return f === s;
    return f === s || startsWithWord(f, s) || includesWord(f, s) || tokensAlign(f, s);
  });
}

function tokensAlign(hay: string, span: string): boolean {
  const st = tokenize(span);
  if (!st.length) return false;
  const set = new Set(tokenize(hay));
  return st.every((t) => (t.length < 4 ? set.has(t) : fuzzyTokenScore(set, t) > 0));
}

function titleMatchesSpan(title: string, span: string): boolean {
  const s = foldText(span);
  if (!s) return false;
  return title === s || startsWithWord(title, s) || includesWord(title, s) || tokensAlign(title, s);
}

/**
 * Score de pertinence d’un résultat vs la requête utilisateur.
 * Plus le score est haut, plus le résultat doit remonter.
 */
export function scoreSearchItem(track: Track, query: string): number {
  const q = foldText(query);
  if (!q) return 0;
  const qTokens = tokenize(query);
  const title = foldText(track.title);
  const artistNames = (track.artists || [])
    .map((a) => a.name)
    .filter((n): n is string => Boolean(n) && !isJunkArtistName(String(n)));
  const artists = foldText(artistNames.join(' '));
  const album = foldText(track.album?.name || '');
  const titleTokens = new Set(tokenize(track.title));
  const artistTokens = new Set(tokenize(artists));
  const allTokens = new Set([...titleTokens, ...artistTokens, ...tokenize(album)]);
  const type = track.type || 'unknown';

  let score = 0;

  // —— Titre ——
  // Fiche artiste : le « titre » = nom d’artiste → scoré surtout en section artiste
  // (évite que « Suzanne » exact écrase « Suzane » plus connu via +1200 titre)
  if (type !== 'artist') {
    if (title === q) score += 1200;
    else if (startsWithWord(title, q)) score += 820;
    else if (includesWord(title, q)) score += 640;
    else if (q.length >= 4 && title.includes(q)) score += 280;

    // « Titre : épisode podcast » / « Titre - long clickbait » au-delà de la requête
    if (title !== q && (startsWithWord(title, q) || includesWord(title, q))) {
      const extra = title.length - q.length;
      if (extra >= 10) score -= Math.min(280, 40 + extra * 4);
      if (/[:|•]/.test(String(track.title || '')) && extra >= 6) score -= 220;
    }

    // Tous les tokens de la query dans le titre
    const allTokensInTitle =
      qTokens.length > 1 && qTokens.every((t) => titleTokens.has(t) || includesWord(title, t));
    if (allTokensInTitle) score += 420;
    score += tokenCoverage(titleTokens, qTokens) * 280;
  }

  // —— Artiste ——
  // Ne pas matcher des fragments dans des pseudos (@poto_…) : mots entiers seulement
  if (type === 'artist') {
    const name = title || artists;
    if (name === q) score += 900;
    else if (artistNameAliasMatch(name, q)) {
      // Orthographe corrigée plus courte (suzane ← suzanne) = souvent l’artiste « vrai »
      score += name.length < q.length ? 1180 : 980;
    } else if (startsWithWord(name, q) || includesWord(name, q)) score += 500;
    score += tokenCoverage(new Set(tokenize(name)), qTokens) * 120;
  } else {
    // Le nom d’artiste = la requête (recherche d’un artiste).
    // Pas quand le titre est déjà cette requête : un groupe qui s’appelle
    // comme le morceau (« Second Souffle ») ne doit pas passer devant
    // le même titre par un autre artiste.
    const selfTitled =
      title === q && (artists === q || artistNames.some((n) => foldText(n) === q));
    if (!selfTitled) {
      if (artists === q) score += 1100;
      else if (artistNames.some((n) => foldText(n) === q)) score += 1050;
      else if (artistNames.some((n) => artistNameAliasMatch(foldText(n), q))) {
        const aliased = artistNames.map((n) => foldText(n)).find((n) => artistNameAliasMatch(n, q));
        score += aliased && aliased.length < q.length ? 1120 : 980;
      } else if (startsWithWord(artists, q) || includesWord(artists, q)) score += 700;
      score += tokenCoverage(artistTokens, qTokens) * 220;
    }
  }

  // Combien de tokens query matchent vraiment le champ artiste (pas seulement le titre « Artist - Song »)
  let artistTokenHits = 0;
  for (const t of qTokens) {
    if (t.length < 2) continue;
    if (artistNames.some((n) => foldText(n) === t || startsWithWord(foldText(n), t))) {
      artistTokenHits += 1;
    }
  }

  // —— Titre + artiste (ex. "Poto Demi Portion" ou "pentatonix daft punk") ——
  let splitMatch = false;
  if (type !== 'artist' && qTokens.length >= 2) {
    for (let i = 1; i < qTokens.length; i++) {
      const left = qTokens.slice(0, i).join(' ');
      const right = qTokens.slice(i).join(' ');
      const titleLeft = titleMatchesSpan(title, left);
      const titleRight = titleMatchesSpan(title, right);
      const artistLeft = artistMatchesSpan(artistNames, left);
      const artistRight = artistMatchesSpan(artistNames, right);
      // Match « artiste + titre » propre (ex. artiste Pentatonix, titre Daft Punk)
      if (titleLeft && artistRight) {
        score += 1250;
        splitMatch = true;
      }
      if (titleRight && artistLeft) {
        score += 1220;
        splitMatch = true;
      }
    }
  }

  // Titre descriptif « ARTISTE - TITRE » sur une chaîne tierce (lyrics/reaction) :
  // tous les tokens dans le titre mais aucun dans le vrai champ artiste → fortement pénalisé.
  // Sauf si la requête entière est dans le titre (« Parliament - What Comes Funky ») :
  // ce morceau doit rester devant un titre qui ne partage qu’un mot (« Funky Little Baby »).
  const phraseInTitle = title === q || includesWord(title, q) || startsWithWord(title, q);
  const allTokensInTitle =
    type !== 'artist' &&
    qTokens.length > 1 &&
    qTokens.every((t) => titleTokens.has(t) || includesWord(title, t));
  if (allTokensInTitle && artistTokenHits === 0 && qTokens.length >= 2 && !splitMatch && !phraseInTitle) {
    score -= 720;
  } else if (allTokensInTitle && artistTokenHits === 0 && qTokens.length >= 2 && !phraseInTitle) {
    score -= 280;
  }

  // —— Album ——
  if (album && (album === q || includesWord(album, q) || (q.length >= 4 && album.includes(q)))) {
    score += 180;
  }
  // Album catalogue distinct du titre (ex. Discovery) > single homonyme de cover
  if (type === 'song' && album && title) {
    if (album === title || album === q) score -= 90;
    else if (title === q || foldText(track.title) === q) score += 200;
    else score += 70;
  }

  // « t'es triste » Instagram / hard-techno : jamais le jazz Grace Ellis.
  const qFold = foldText(query);
  if (/\btes triste\b/.test(qFold) || qFold.includes('testriste')) {
    const blob = `${title} ${artistNames.join(' ')} ${album}`;
    if (/\b(grace ellis|sant andreu|alba armengou|nick monteiro|jazz revival)\b/.test(blob)) {
      score -= 5000;
    }
    if (/\b(rekkt|nivk|helen ka|rekktdj|nto|n to|koni)\b/.test(blob)) {
      score += 1800;
    }
    if (/\btes triste\b/.test(title) || title === 'tes triste') score += 900;
  }

  // Fautes : « bine » ≈ « bien », « ostromae » ≈ « stromae ».
  // La phrase du titre (dans le titre, même si l’artiste catalogue est une chaîne)
  // passe devant un autre morceau du même artiste qui n’a pas ces mots.
  // « Je vais bien » d’un autre artiste ne couvre pas le nom mal tapé.
  if (type !== 'artist' && qTokens.length >= 2) {
    const long = qTokens.filter((t) => t.length >= 4);
    let onTitle = 0;
    let onArtistOnly = 0;
    let missed = 0;
    for (const t of long) {
      const artistHit = fuzzyTokenScore(artistTokens, t) >= 0.7;
      const titleHit = fuzzyTokenScore(titleTokens, t) >= 0.7;
      if (titleHit) onTitle += 1;
      else if (artistHit) onArtistOnly += 1;
      else missed += 1;
    }
    if (long.length > 0 && missed === 0 && onTitle >= 2) score += 1900;
    else if (onArtistOnly > 0 && onTitle === 0 && long.length >= 2) score -= 500;
    if (missed > 0 && onArtistOnly === 0) score -= 700 * missed;
    // « je vais bien » Ridsa ne doit pas battre Stromae quand la requête nomme Stromae
    // (typo ostromae) mais qu’aucun titre Stromae exact n’est dans le lot.
    if (onTitle >= 1 && missed >= 1 && onArtistOnly === 0) {
      score -= 1100 * missed;
    }
    // Artiste nommé dans la requête → bonus même si le titre exact manque.
    if (onArtistOnly >= 1 && missed <= 1) score += 650 * onArtistOnly;
  }

  // Couverture globale des tokens
  score += tokenCoverage(allTokens, qTokens) * 160;

  // Bonus type selon l’intention probable — titres musicaux d’abord
  if (type === 'song') score += 120;
  else if (type === 'artist') {
    // Chaîne perso (@handle / Profile) nommée comme un titre → pas un artiste
    if (!isPlausibleArtistEntity(track)) score -= 900;
    else if (artists === q || title === q) score += 200;
    else if (
      artistNameAliasMatch(title, q) ||
      artistNames.some((n) => artistNameAliasMatch(foldText(n), q))
    ) {
      score += 320;
    } else score += 40;
  } else if (type === 'album') score += 40;
  else if (type === 'video') score -= 180;
  else if (type === 'playlist') score -= 80;

  // Titre court exact (ex. « Poto »)
  if (qTokens.length === 1 && title === q && (type === 'song' || type === 'video' || type === 'unknown')) {
    score += 280;
    if (type === 'song') score += 40;
  }

  // Bruit : réactions, lyrics, Episode/podcast
  if (isLowQualitySearchHit(track)) {
    score -= type === 'song' || type === 'video' ? 900 : 400;
  }

  // Titre catalogue (nom exact ou « 원제 (Dingga) ») devant les homonymes d’un mot.
  if (type !== 'artist' && catalogTitleMatches(String(track.title || ''), query) && !isDerivativeSearchHit(track, query)) {
    score += 700;
  }

  // Reprise, fan-made, exclu, performance, lyrics : après l’officiel.
  if (type !== 'artist' && isDerivativeSearchHit(track, query)) {
    score -= 1600;
  }

  // Remix / cover / karaoke : derrière l’original
  if (/\b(remix|bootleg|mashup|nightcore|sped up|slowed|karaoke)\b/.test(title)) {
    score -= 700;
  }
  if (/\b(cover|guitar cover|drum cover|piano cover)\b/.test(title) && artistTokenHits === 0) {
    score -= 260;
  }
  // « (Adele) Hello » / « Artist - Title » par un autre artiste
  if (
    qTokens.length >= 2 &&
    artistTokenHits === 0 &&
    /\([^)]{2,}\)|\s-\s/.test(String(track.title || '')) &&
    allTokensInTitle
  ) {
    score -= 400;
  }

  // « Various Artists » / compilations : derrière l’artiste nommé dans la query
  if (artistNames.some((n) => /^(various artists|varios|artistes vari[eé]s)$/i.test(n.trim()))) {
    score -= 350;
  }

  return score;
}

/**
 * Un artiste qui porte le nom du morceau (« Second Souffle » par Second Souffle)
 * ne passe pas devant le même titre catalogue d’un autre artiste.
 */
function preferDistinctExactTitle<T extends Track>(items: T[], query: string): T[] {
  const q = foldText(query);
  if (!q || items.length < 2) return items;
  if (!items.some((t) => t.type !== 'artist' && (t.artists || []).some((a) => foldText(a.name) === q))) {
    return items;
  }
  const exactOther = items.filter((t) => {
    if (t.type === 'artist' || t.type === 'album' || t.type === 'playlist') return false;
    if ((t.artists || []).some((a) => foldText(a.name) === q)) return false;
    if (isDerivativeSearchHit(t, query)) return false;
    return foldText(t.title) === q || catalogTitleMatches(String(t.title || ''), query);
  });
  if (!exactOther.length) return items;
  const exactIds = new Set(exactOther.map((t) => t.id));
  return [...exactOther, ...items.filter((t) => !exactIds.has(t.id))];
}

/**
 * Même titre catalogue, plusieurs artistes (Diane / Lorette / Séguin…) :
 * un artiste par « tour » en tête pour ne pas noyer les versions récentes.
 */
export function diversifyExactTitleArtists<T extends Track>(items: T[], query: string): T[] {
  const q = foldText(query);
  if (!q || items.length < 3) return items;
  const isExact = (t: T) => {
    if (t.type === 'artist' || t.type === 'album' || t.type === 'playlist') return false;
    if (isDerivativeSearchHit(t, query) || isLowQualitySearchHit(t)) return false;
    return foldText(t.title) === q || catalogTitleMatches(String(t.title || ''), query);
  };
  const exact = items.filter(isExact);
  const artistKeys = new Set(
    exact.map((t) => foldText((t.artists || [])[0]?.name || '')).filter((n) => n.length >= 2),
  );
  if (artistKeys.size < 2) return items;
  const seen = new Set<string>();
  const head: T[] = [];
  for (const t of items) {
    if (!isExact(t)) continue;
    const an = foldText((t.artists || [])[0]?.name || '');
    if (!an || seen.has(an)) continue;
    seen.add(an);
    head.push(t);
    if (seen.size >= 8) break;
  }
  if (head.length < 2) return items;
  const headIds = new Set(head.map((t) => t.id));
  return [...head, ...items.filter((t) => !headIds.has(t.id))];
}

/**
 * Fiches artiste absentes d’Innertube : on les reconstruit depuis les crédits des titres.
 * « Lenaïg », « Lorette » → artiste en tête, pas seulement des clips / albums homonymes.
 */
export function synthesizeArtistsFromSongs(songs: Track[], query: string): Track[] {
  const q = foldText(query);
  if (!q || q.length < 2 || !songs.length) return [];
  type Acc = { name: string; id?: string; thumb?: { url: string; width?: number; height?: number }; n: number };
  const counts = new Map<string, Acc>();
  for (const t of songs) {
    if (!t || isLowQualitySearchHit(t)) continue;
    for (const a of t.artists || []) {
      const name = String(a.name || '').trim();
      const nf = foldText(name);
      if (nf.length < 2 || isJunkArtistName(name)) continue;
      const matches =
        nf === q ||
        artistNameAliasMatch(nf, q) ||
        (q.length >= 4 && nf.length >= 4 && (nf.startsWith(q) || q.startsWith(nf)));
      if (!matches) continue;
      const cur = counts.get(nf) || {
        name,
        id: a.id,
        thumb: t.thumbnails?.[0],
        n: 0,
      };
      cur.n += 1;
      if (!cur.id && a.id) cur.id = a.id;
      if (!cur.thumb && t.thumbnails?.[0]) cur.thumb = t.thumbnails[0];
      // Préférer le libellé avec accents si on l’a (Lenaïg > lenaig)
      if (/[àâäéèêëïîôùûüç]/i.test(name) && !/[àâäéèêëïîôùûüç]/i.test(cur.name)) {
        cur.name = name;
      }
      counts.set(nf, cur);
    }
  }
  return [...counts.values()]
    .filter((c) => c.n >= 1)
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'fr'))
    .slice(0, 8)
    .map((c) => ({
      id: c.id || `synth:${foldText(c.name)}`,
      title: c.name,
      artists: [{ name: c.name, ...(c.id ? { id: c.id } : {}) }],
      type: 'artist' as const,
      thumbnails: c.thumb ? [c.thumb] : [],
      source: 'youtube' as const,
    }));
}

export function rankByQuery<T extends Track>(
  items: T[],
  query: string,
  personalization?: SearchPersonalization,
): T[] {
  if (!items.length) return items;
  const isExactPeer = (t: T) =>
    t.type !== 'artist' &&
    t.type !== 'album' &&
    t.type !== 'playlist' &&
    !isDerivativeSearchHit(t, query) &&
    !isLowQualitySearchHit(t) &&
    (foldText(t.title) === foldText(query) || catalogTitleMatches(String(t.title || ''), query));
  const exactPeerCount = items.filter(isExactPeer).length;
  const ranked = items
    .map((item, index) => {
      const relevance = scoreSearchItem(item, query);
      return {
        item,
        index,
        relevance,
        score: relevance + personalizeBoost(item, personalization, query),
        exact: isExactPeer(item),
      };
    })
    // Entre versions catalogue du même titre (Diane vs Lorette), la perso biblio
    // ne doit pas écraser l’ordre YouTube / tendances (index d’arrivée).
    .sort((a, b) => {
      if (exactPeerCount >= 2 && a.exact && b.exact) {
        return b.relevance - a.relevance || a.index - b.index;
      }
      return b.score - a.score || b.relevance - a.relevance || a.index - b.index;
    })
    .map((x) => x.item);
  return diversifyExactTitleArtists(
    preferDistinctExactTitle(promoteCanonicalRelease(ranked, query), query),
    query,
  );
}

/**
 * L’artiste cité le plus souvent sur ce titre est celui du morceau connu.
 * Son titre catalogue passe devant les reprises, perfs, lives et fan-made.
 */
function titleMentionsQuery(track: Track, query: string): boolean {
  const q = foldText(query);
  const title = foldText(track.title);
  if (!q || !title) return false;
  if (title === q || includesWord(title, q) || catalogTitleMatches(String(track.title || ''), query)) {
    return true;
  }
  return tokenize(query).some((t) => t.length >= 3 && (includesWord(title, t) || title.includes(t)));
}

export function promoteCanonicalRelease<T extends Track>(items: T[], query: string): T[] {
  const q = foldText(query);
  if (!q || items.length < 2) return items;
  const mentions = new Map<string, number>();
  const seenCredit = new Set<string>();
  for (const t of items) {
    if (t.type === 'artist' || t.type === 'album' || t.type === 'playlist') continue;
    if (!titleMentionsQuery(t, query)) continue;
    const titleKey = foldText(t.title);
    const names = new Set(
      (t.artists || [])
        .map((a) => foldText(a.name))
        .filter((n) => n.length >= 2),
    );
    for (const n of names) {
      // Deux copies du même titre par le même nom ne comptent pas comme deux preuves.
      const key = `${n}|${titleKey}`;
      if (seenCredit.has(key)) continue;
      seenCredit.add(key);
      mentions.set(n, (mentions.get(n) || 0) + 1);
    }
  }
  let canonical = '';
  let best = 1;
  for (const [name, count] of mentions) {
    if (count > best) {
      best = count;
      canonical = name;
    }
  }
  if (!canonical) return items;
  const exactNames = new Set<string>();
  for (const t of items) {
    if (t.type === 'artist' || t.type === 'album' || t.type === 'playlist') continue;
    if (isDerivativeSearchHit(t, query)) continue;
    if (!(catalogTitleMatches(String(t.title || ''), query) || foldText(t.title) === q)) continue;
    for (const a of t.artists || []) {
      const n = foldText(a.name);
      if (n.length >= 2) exactNames.add(n);
    }
  }
  // Titre partagé (Intro, Toi, La maison brûle) : plusieurs versions catalogue → garder la diversité.
  if (exactNames.size >= 2) return items;
  if (canonical === q) {
    const otherExact = items.some((t) => {
      if (t.type === 'artist' || t.type === 'album' || t.type === 'playlist') return false;
      const names = (t.artists || []).map((a) => foldText(a.name));
      if (names.some((n) => n === q || includesWord(n, canonical))) return false;
      return catalogTitleMatches(String(t.title || ''), query) || foldText(t.title) === q;
    });
    if (otherExact) return items;
  }
  const tier = (t: T) => {
    if (t.type === 'artist' || t.type === 'album' || t.type === 'playlist') return 1;
    const artistHit = (t.artists || []).some((a) => {
      const n = foldText(a.name);
      return n === canonical || includesWord(n, canonical);
    });
    if (
      artistHit &&
      !isDerivativeSearchHit(t, query) &&
      catalogTitleMatches(String(t.title || ''), query)
    ) {
      return 0;
    }
    return 1;
  };
  return items
    .map((item, index) => ({ item, index, tier: tier(item) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((x) => x.item);
}

export type SearchPersonalization = {
  /** Noms d’artistes (déjà foldés) à booster */
  artistNames: string[];
  trackIds: string[];
};

/**
 * Soft personalization: never override lexical relevance.
 * Boost only when the track already matches the query reasonably.
 */
export function personalizeBoost(
  track: Track,
  p?: SearchPersonalization,
  query?: string,
): number {
  if (!p) return 0;
  const relevance = query ? scoreSearchItem(track, query) : 0;
  // Hors-sujet (ex. favori Keny Arkana sur « tenebro rossi ») → 0
  if (query && relevance < 180) return 0;

  let boost = 0;
  const artists = foldText((track.artists || []).map((a) => a.name).join(' '));
  const title = foldText(track.title);
  const qFold = query ? foldText(query) : '';

  for (const name of p.artistNames) {
    if (!name || name.length < 2) continue;
    const mentionedInQuery = Boolean(qFold) && (qFold.includes(name) || name.includes(qFold));
    if (artists === name || includesWord(artists, name)) {
      boost += mentionedInQuery ? 90 : 45;
    } else if (artists.includes(name) && name.length >= 4) {
      boost += mentionedInQuery ? 50 : 20;
    }
    if (title.includes(name) && track.type === 'artist') boost += 30;
  }
  if (p.trackIds.includes(track.id) && relevance >= 220) boost += 40;

  const cap = Math.max(40, Math.floor(relevance * 0.15));
  return Math.min(boost, cap);
}

function uniqById(arr: Track[]): Track[] {
  const seen = new Set<string>();
  return arr.filter((t) => {
    if (!t?.id || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

/** Qualité d’une fiche artiste pour départager les doublons. */
function artistQuality(a: Track, query?: string): number {
  let q = 0;
  const id = String(a.id || '');
  if (id.startsWith('UC')) q += 80; // channel YouTube canonique
  else if (id.startsWith('MP')) q += 40;
  if (a.type === 'artist') q += 30;
  const thumbs = a.thumbnails?.length || 0;
  q += Math.min(20, thumbs * 4);
  const bestThumb = Math.max(0, ...(a.thumbnails || []).map((t) => t.width || 0));
  q += Math.min(25, Math.floor(bestThumb / 40));
  if (query) q += Math.min(200, scoreSearchItem(a, query));
  return q;
}

/**
 * Déduplique une liste d’artistes : même id OU même nom (foldé).
 * Garde la meilleure fiche (UC id, thumbs, score vs requête).
 */
export function dedupeArtists(items: Track[], query?: string): Track[] {
  type Slot = { track: Track; name: string };
  const slots: Slot[] = [];

  for (const raw of items) {
    if (!raw?.id) continue;
    // Rejette les fausses fiches (chaîne @handle nommée comme un titre)
    if (!isPlausibleArtistEntity(raw)) continue;
    const name = foldText(raw.title || raw.artists?.[0]?.name || '');
    const idx = slots.findIndex(
      (s) => s.track.id === raw.id || (name.length >= 2 && s.name === name),
    );
    if (idx < 0) {
      slots.push({ track: raw, name });
      continue;
    }
    if (artistQuality(raw, query) > artistQuality(slots[idx].track, query)) {
      slots[idx] = { track: raw, name: name || slots[idx].name };
    }
  }

  return slots.map((s) => s.track);
}

export function mergeTracks(...lists: Track[][]): Track[] {
  return uniqById(lists.flat());
}

/**
 * Écarte les résultats hors-sujet (ex. favori Keny sur « tenebro rossi »)
 * tout en gardant un fallback si YouTube ne renvoie que du bruit.
 */
export function filterByRelevance<T extends Track>(
  items: T[],
  query: string,
  minScore = 140,
): T[] {
  if (!items.length || !foldText(query)) return items;
  const scored = items.map((item, index) => ({
    item,
    index,
    s: scoreSearchItem(item, query),
    junk: isLowQualitySearchHit(item),
  }));
  // Préfère les hits non-junk ; ne garde le junk que s’il n’y a presque rien d’autre
  const clean = scored.filter((x) => !x.junk && x.s >= minScore);
  const good = clean.length >= 1 ? clean : scored.filter((x) => x.s >= minScore);
  if (good.length >= 2) return good.map((x) => x.item);
  if (good.length === 1) {
    const near = scored
      .filter((x) => !x.junk && x.s < minScore && x.s >= Math.floor(minScore * 0.55))
      .slice(0, 4);
    return [...good, ...near]
      .sort((a, b) => b.s - a.s || a.index - b.index)
      .map((x) => x.item);
  }
  // Rien de pertinent : top 6 par score (évite page vide), jamais un dump brut
  return [...scored]
    .sort((a, b) => Number(a.junk) - Number(b.junk) || b.s - a.s || a.index - b.index)
    .slice(0, 6)
    .map((x) => x.item);
}

/** Choisit le meilleur « top result » parmi les buckets déjà rankés. */
export function pickTopResult(
  query: string,
  buckets: {
    topResult?: Track | null;
    songs: Track[];
    artists: Track[];
    albums: Track[];
    videos: Track[];
    playlists: Track[];
  },
  personalization?: SearchPersonalization,
): Track | null {
  // Top YT artiste bidon (chaîne @handle = titre de chanson) → ignorer
  const ytTopRaw = buckets.topResult;
  const ytTop =
    ytTopRaw &&
    (ytTopRaw.type !== 'artist' || isPlausibleArtistEntity(ytTopRaw)) &&
    !isLowQualitySearchHit(ytTopRaw)
      ? ytTopRaw
      : null;

  const cleanSongs = buckets.songs.filter((t) => !isLowQualitySearchHit(t));
  const cleanVideos = buckets.videos.filter((t) => !isLowQualitySearchHit(t));

  const candidates: Track[] = [];
  if (ytTop) candidates.push(ytTop);
  candidates.push(...cleanSongs.slice(0, 10));
  candidates.push(...buckets.artists.filter(isPlausibleArtistEntity).slice(0, 4));
  candidates.push(...buckets.albums.slice(0, 3));
  // Vidéos en dernier recours — après les titres
  candidates.push(...cleanVideos.slice(0, 2));

  if (!candidates.length) {
    // Fallback si tout était junk
    candidates.push(...buckets.songs.slice(0, 5), ...buckets.videos.slice(0, 3));
  }
  if (!candidates.length) return null;

  const q = foldText(query);
  const qTokens = tokenize(query);

  const exactSongs = cleanSongs.filter((t) => {
    if (isDerivativeSearchHit(t, query)) return false;
    if (catalogTitleMatches(String(t.title || ''), query)) return true;
    if (foldText(t.title) !== q) return false;
    const raw = String(t.title || '');
    // « Daft Punk - Get Lucky » / « (Adele) Hello » se foldent en la query sans être le titre catalogue
    if (/\s[-–—]\s/.test(raw) || /[()]/.test(raw)) return false;
    return true;
  });

  /** Artiste dont le nom = la requête (Suzane, Stromae…) — y compris alias orthographe. */
  const exactArtists = buckets.artists.filter((a) => {
    if (!isPlausibleArtistEntity(a)) return false;
    const name = foldText(a.title || a.artists?.[0]?.name || '');
    if (!name || name.length < 2) return false;
    if (name === q) return true;
    // Alias proches (suzanne ↔ suzane) : même racine, 1 lettre de diff, pas trop courts
    return artistNameAliasMatch(name, q);
  });

  // Requête courte : si un **titre exact** matche fort (ex. « Bella » → GIMS),
  // il gagne sur la fiche artiste homonyme — l’onglet Titres doit coller au top.
  if (exactArtists.length >= 1 && qTokens.length <= 2) {
    const bestArtist = [...exactArtists].sort((a, b) => {
      const nameA = foldText(a.title || a.artists?.[0]?.name || '');
      const nameB = foldText(b.title || b.artists?.[0]?.name || '');
      const aliasBoost = (name: string) =>
        name !== q && artistNameAliasMatch(name, q) && name.length <= q.length ? 120 : 0;
      return (
        artistQuality(b, query) +
        aliasBoost(nameB) -
        (artistQuality(a, query) + aliasBoost(nameA))
      );
    })[0];
    const bestExactSong = exactSongs.length
      ? rankByQuery(exactSongs, query, personalization)[0]
      : null;
    const songScore = bestExactSong ? scoreSearchItem(bestExactSong, query) : 0;
    const songTitleExact =
      !!bestExactSong &&
      (foldText(bestExactSong.title || '') === q ||
        catalogTitleMatches(String(bestExactSong.title || ''), query));
    // Tube dont le titre = la requête → avant l’artiste (Bella, Despacito, …)
    if (bestExactSong && songTitleExact && songScore >= 500) {
      return bestExactSong;
    }
    // Fausse fiche artiste vs vrai tube
    if (bestExactSong && songScore >= 1400 && artistQuality(bestArtist, query) < 220) {
      /* fall through → exact song */
    } else {
      const songByThisArtist = exactSongs.find((t) =>
        (t.artists || []).some((a) => {
          const an = foldText(a.name);
          const artistName = foldText(bestArtist.title || bestArtist.artists?.[0]?.name || '');
          return an === artistName || an === q || artistNameAliasMatch(an, artistName);
        }),
      );
      // Titre du même artiste bien score → préférer le titre en top (pas la fiche)
      if (songByThisArtist && songScore >= 700) {
        return bestExactSong || songByThisArtist;
      }
      if (!songByThisArtist || qTokens.length === 1) {
        // 1 token sans tube fort → artiste OK ; sinon laisser le titre gagner plus bas
        if (!(bestExactSong && songScore >= 900)) {
          return bestArtist;
        }
      }
    }
  }

  // Titre exact trouvé → le prendre dans l’ordre du classement complet.
  // Un sous-ensemble « exact » seul laissait deux copies d’une réupload
  // passer devant l’unique crédit du morceau (Моя игра).
  if (exactSongs.length >= 1) {
    const ordered = rankByQuery(cleanSongs.slice(0, 12), query, personalization);
    const bestExact = ordered.find((t) => exactSongs.some((e) => e.id === t.id));
    if (bestExact && scoreSearchItem(bestExact, query) >= 200) {
      return bestExact;
    }
  }

  // Si un titre musical matche bien (split artiste+titre), il gagne toujours sur une vidéo
  const bestSong = cleanSongs[0]
    ? rankByQuery(cleanSongs.slice(0, 8), query, personalization)[0]
    : null;
  const bestSongScore = bestSong
    ? scoreSearchItem(bestSong, query) + personalizeBoost(bestSong, personalization, query)
    : -Infinity;

  const ranked = rankByQuery(uniqById(candidates), query, personalization);
  const best = ranked[0];
  if (!best) return null;
  const bestRel = scoreSearchItem(best, query);
  const bestScore = bestRel + personalizeBoost(best, personalization, query);
  const songCarriesQuery = (t: Track | null | undefined) =>
    !!t &&
    t.type !== 'album' &&
    t.type !== 'artist' &&
    t.type !== 'playlist' &&
    !isDerivativeSearchHit(t, query) &&
    (foldText(t.title) === q ||
      includesWord(foldText(t.title), q) ||
      catalogTitleMatches(String(t.title || ''), query));

  // Un album homonyme (ou un homonyme d’un seul mot) ne passe pas devant
  // le morceau dont le titre contient déjà toute la requête.
  if (best.type === 'album' && bestSong && songCarriesQuery(bestSong)) {
    return bestSong;
  }
  // « Lenaïg » album d’un autre artiste vs vraie artiste synthétisée depuis ses titres
  if (best.type === 'album' && exactArtists.length >= 1 && qTokens.length <= 2) {
    const albumArtist = foldText(best.artists?.[0]?.name || '');
    const albumTitle = foldText(best.title || '');
    if (albumTitle === q && albumArtist !== q && !artistNameAliasMatch(albumArtist, q)) {
      return exactArtists[0];
    }
  }

  if (bestSong && bestSongScore >= 600) {
    // Ne pas laisser une vidéo / lyrics channel battre un vrai titre
    if (best.type === 'video' || isLowQualitySearchHit(best) || bestScore <= bestSongScore + 80) {
      // Si le meilleur candidat est un artiste exact, le garder
      if (best.type === 'artist' && exactArtists.some((a) => a.id === best.id)) {
        return best;
      }
      return bestSong;
    }
  }

  // Top YT n’est accepté que s’il matche aussi lexicalement la requête
  if (ytTop) {
    const ytRel = scoreSearchItem(ytTop, query);
    const ytScore = ytRel + personalizeBoost(ytTop, personalization, query);
    // Ne jamais renvoyer un top YT hors-sujet (ex. Keny) si un autre candidat matche mieux
    if (ytRel < 180 || isLowQualitySearchHit(ytTop)) {
      return bestRel >= 120 ? best : null;
    }
    // Vidéo top YT vs titre musical : privilégier le titre
    if (ytTop.type === 'video' && bestSong && bestSongScore >= ytScore - 40) {
      return bestSong;
    }
    if (ytTop.type === 'album' && bestSong && songCarriesQuery(bestSong)) {
      return bestSong;
    }
    if (bestScore >= ytScore + 40) return best;
    if (ytRel >= 400 && ytRel >= bestRel - 20 && ytTop.type !== 'video' && ytTop.type !== 'album') return ytTop;
    if (ytRel >= 400 && ytRel >= bestRel - 20 && !bestSong) return ytTop;
  }

  return bestRel >= 120 ? best : null;
}

/** Libellés de shelf Innertube (EN + FR) → bucket. */
export function shelfBucketFromTitle(title: string): 'songs' | 'videos' | 'albums' | 'artists' | 'playlists' | null {
  const t = foldText(title);
  if (!t) return null;
  if (/\b(song|songs|titre|titres|morceau|morceaux|track|tracks)\b/.test(t)) return 'songs';
  if (/\b(video|videos|video|videos)\b/.test(t) || t.includes('video')) return 'videos';
  if (/\b(album|albums)\b/.test(t)) return 'albums';
  if (/\b(artist|artists|artiste|artistes)\b/.test(t)) return 'artists';
  if (/\b(playlist|playlists|communaut)\b/.test(t)) return 'playlists';
  return null;
}
