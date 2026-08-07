import type { Track } from './types.js';
import { isJunkArtistName, isPlausibleArtistEntity } from './mappers.js';

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
    if (hayTokens.has(t)) hit += 1;
    else if ([...hayTokens].some((h) => h === t || (t.length >= 3 && (h.startsWith(t) || t.startsWith(h)))))
      hit += 0.45;
  }
  return hit / queryTokens.length;
}

/** Chaînes / titres bruit : réactions, lyrics, karaoke, podcasts… */
export function isSpokenWordHit(track: Track): boolean {
  const title = foldText(track.title);
  const artists = (track.artists || []).map((a) => String(a.name || '').trim()).filter(Boolean);
  const artistFold = foldText(artists.join(' '));
  if (/\b(episode|podcast|audiobook|audio\s*book|livre\s*audio|full\s*audiobook)\b/.test(title)) {
    return true;
  }
  if (/\b(episode|podcast|audiobook|livre\s*audio)\b/.test(artistFold)) return true;
  // Sous-titres YTM podcast : artiste = date (ex. « Jul 12, 2024 »)
  if (
    artists.some(
      (n) =>
        /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(n) && /\d{4}/.test(n),
    )
  ) {
    return true;
  }
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
  return false;
}

/** Titre jouable musique (pas album / artiste / podcast). */
export function isMusicPlayableHit(track: Track): boolean {
  if (!track?.id || !/^[a-zA-Z0-9_-]{11}$/.test(track.id)) return false;
  if (track.type === 'album' || track.type === 'artist' || track.type === 'playlist') return false;
  if (isSpokenWordHit(track) || isLowQualitySearchHit(track)) return false;
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
    return f === s || startsWithWord(f, s) || includesWord(f, s);
  });
}

function titleMatchesSpan(title: string, span: string): boolean {
  const s = foldText(span);
  if (!s) return false;
  return title === s || startsWithWord(title, s) || includesWord(title, s);
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
    if (artists === q) score += 1100;
    else if (artistNames.some((n) => foldText(n) === q)) score += 1050;
    else if (artistNames.some((n) => artistNameAliasMatch(foldText(n), q))) {
      const aliased = artistNames.map((n) => foldText(n)).find((n) => artistNameAliasMatch(n, q));
      score += aliased && aliased.length < q.length ? 1120 : 980;
    } else if (startsWithWord(artists, q) || includesWord(artists, q)) score += 700;
    score += tokenCoverage(artistTokens, qTokens) * 220;
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
  // tous les tokens dans le titre mais aucun dans le vrai champ artiste → fortement pénalisé
  const allTokensInTitle =
    type !== 'artist' &&
    qTokens.length > 1 &&
    qTokens.every((t) => titleTokens.has(t) || includesWord(title, t));
  if (allTokensInTitle && artistTokenHits === 0 && qTokens.length >= 2 && !splitMatch) {
    score -= 720;
  } else if (allTokensInTitle && artistTokenHits === 0 && qTokens.length >= 2) {
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

export function rankByQuery<T extends Track>(
  items: T[],
  query: string,
  personalization?: SearchPersonalization,
): T[] {
  if (!items.length) return items;
  return items
    .map((item, index) => {
      const relevance = scoreSearchItem(item, query);
      return {
        item,
        index,
        relevance,
        score: relevance + personalizeBoost(item, personalization, query),
      };
    })
    // Écarte le bruit perso sans match lexical (reste disponible plus bas si vraiment vide)
    .sort((a, b) => b.score - a.score || b.relevance - a.relevance || a.index - b.index)
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

  // Requête courte = nom d’artiste → fiche artiste gagne sur un titre homonyme d’un autre
  // (ex. « Suzanne » → artiste, pas Leonard Cohen ; « Suzane » → artiste FR)
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
    // Fausse fiche « Despacito » (peu de qualité) vs vrai tube → garder le titre
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
      if (!songByThisArtist || qTokens.length === 1) {
        return bestArtist;
      }
    }
  }

  // Titre exact trouvé → prioriser le morceau (sauf conflit artiste géré au-dessus)
  if (exactSongs.length >= 1) {
    const bestExact = rankByQuery(exactSongs, query, personalization)[0];
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
    if (bestScore >= ytScore + 40) return best;
    if (ytRel >= 400 && ytRel >= bestRel - 20 && ytTop.type !== 'video') return ytTop;
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
