/**
 * Sélecteur de paroles multi-sources.
 * Prend le meilleur texte (score titre + artiste), sinon propose des
 * alternatives + liens de recherche. Ne vole jamais un hit « ADHD »
 * d’un autre artiste pour InTheLight.
 */
import { looksLikeLyrics } from './lyricsTiming.js';
import {
  artistMatchScore,
  fetchGeniusLyrics,
  geniusSearchUrl,
  listGeniusNearMisses,
  titleMatchScore,
} from './lyricsGenius.js';
import {
  catalogSearchLinks,
  fetchSpotifyLyrics,
  resolveStreamingCatalog,
} from './lyricsSpotify.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export type LyricSuggestion = {
  title: string;
  artist: string;
  url: string;
  source: string;
  reason: string;
  score?: number;
};

export type LyricSearchLink = { label: string; url: string };

export type WebLyricsPick = {
  lyrics: string;
  source: 'genius' | 'lyrics.ovh' | 'musixmatch' | 'web' | 'lyrist' | 'azlyrics' | 'spotify' | 'lrclib';
  url?: string;
};

function fold(s: string) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\badah\b/g, 'adhd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function unique(xs: string[]): string[] {
  return [...new Set(xs.map((s) => s.trim()).filter(Boolean))];
}

function artistVariants(artist: string): string[] {
  const a = artist.trim();
  if (!a) return [];
  const spaced = a.replace(/([a-z])([A-Z])/g, '$1 $2');
  return unique([a, spaced, spaced.replace(/\s+/g, '')]);
}

function titleVariants(title: string): string[] {
  const t = title.replace(/\s*[\[(【].*?[\])】]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!t) return [];
  return unique([t, t.replace(/\badhd\b/gi, 'ADAH'), t.replace(/\badah\b/gi, 'ADHD')]);
}

function slugPath(s: string) {
  return fold(s).replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function matchScore(wantA: string, wantT: string, gotA: string, gotT: string): number {
  return titleMatchScore(fold(wantT), fold(gotT)) + artistMatchScore(fold(wantA), fold(gotA));
}

/** Titre exact + artiste compact → on prend. Titre seul trop court → non. */
function acceptScore(wantA: string, wantT: string, score: number): boolean {
  const toks = fold(wantT).split(' ').filter((x) => x.length > 1);
  if (score >= 72) return true;
  if (score >= 50 && toks.length >= 2) return true;
  if (score >= 40 && toks.length >= 3 && fold(wantA).length >= 5) return true;
  return false;
}

async function fetchText(
  url: string,
  opts?: { timeoutMs?: number; accept?: string },
): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 6000),
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      Accept: opts?.accept || 'text/html,application/json,*/*',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    },
  }).catch(() => null);
  if (!res) return { ok: false, status: 0, text: '' };
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, text };
}

function decodeHtml(s: string) {
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractLyricsFromHtml(html: string, pageUrl: string): string | null {
  if (!html || html.length < 80) return null;
  if (/data-lyrics-container="true"/i.test(html)) {
    const blocks = [...html.matchAll(/data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/gi)]
      .map((m) => decodeHtml(m[1] || ''))
      .filter(Boolean);
    const joined = blocks.join('\n\n');
    if (looksLikeLyrics(joined)) return joined;
  }
  const mxm = html.match(
    /<(?:span|p|div)[^>]+class="[^"]*(?:lyrics__content|mxm-lyrics)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|p|div)>/i,
  );
  if (mxm?.[1]) {
    const t = decodeHtml(mxm[1]);
    if (looksLikeLyrics(t)) return t;
  }
  const az = html.match(
    /Usage of azlyrics\.com content[\s\S]*?-->\s*([\s\S]*?)\s*<br><br>\s*<!--/i,
  );
  if (az?.[1]) {
    const t = decodeHtml(az[1]);
    if (looksLikeLyrics(t)) return t;
  }
  if (/lyrical-nonsense|lyrics\.lol|sing365|lyricsmode/i.test(pageUrl)) {
    const body = html.match(/<(?:div|article)[^>]*(?:lyrics|lyric-body)[^>]*>([\s\S]*?)<\/(?:div|article)>/i);
    if (body?.[1]) {
      const t = decodeHtml(body[1]);
      if (looksLikeLyrics(t)) return t;
    }
  }
  return null;
}

function sourceFromUrl(url: string): WebLyricsPick['source'] {
  if (/genius\.com/i.test(url)) return 'genius';
  if (/musixmatch\.com/i.test(url)) return 'musixmatch';
  if (/azlyrics\.com/i.test(url)) return 'azlyrics';
  return 'web';
}

async function tryLyricsOvh(artist: string, title: string): Promise<WebLyricsPick | null> {
  const arts = artistVariants(artist);
  const tits = titleVariants(title);
  for (const a of arts.slice(0, 2)) {
    for (const t of tits.slice(0, 2)) {
      const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(a)}/${encodeURIComponent(t)}`;
      const res = await fetchText(url, { timeoutMs: 4500, accept: 'application/json' });
      if (!res.ok) continue;
      try {
        const lyrics = String((JSON.parse(res.text) as { lyrics?: string }).lyrics || '').trim();
        if (looksLikeLyrics(lyrics)) return { lyrics, source: 'lyrics.ovh', url };
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

async function tryLyrist(artist: string, title: string): Promise<WebLyricsPick | null> {
  const a = artistVariants(artist)[0] || artist;
  const t = titleVariants(title)[0] || title;
  if (!a || !t) return null;
  const url = `https://lyrist.vercel.app/api/${encodeURIComponent(a)}/${encodeURIComponent(t)}`;
  const res = await fetchText(url, { timeoutMs: 5000, accept: 'application/json' });
  if (!res.ok) return null;
  try {
    const lyrics = String((JSON.parse(res.text) as { lyrics?: string }).lyrics || '').trim();
    if (looksLikeLyrics(lyrics)) return { lyrics, source: 'lyrist', url };
  } catch {
    /* ignore */
  }
  return null;
}

function guessedLyricPages(artist: string, title: string): string[] {
  const out: string[] = [];
  for (const a of artistVariants(artist)) {
    for (const t of titleVariants(title)) {
      const sa = slugPath(a);
      const st = slugPath(t);
      if (!sa || !st) continue;
      out.push(`https://genius.com/${sa}-${st}-lyrics`);
      out.push(`https://www.musixmatch.com/lyrics/${sa}/${st}`);
      out.push(`https://www.azlyrics.com/lyrics/${sa.replace(/-/g, '')}/${st.replace(/-/g, '')}.html`);
    }
  }
  return unique(out).slice(0, 10);
}

function urlsFromSearchHtml(html: string): string[] {
  const urls: string[] = [];
  for (const m of html.matchAll(/https?:\/\/(?:uddg=)?([^"'\\\s<>]+)/gi)) {
    let u = m[0];
    if (u.includes('uddg=')) {
      try {
        u = decodeURIComponent(m[1] || '');
      } catch {
        continue;
      }
    }
    if (!/^https?:\/\//i.test(u)) continue;
    if (!/genius\.com|musixmatch\.com|azlyrics\.com|lyrics\.lol|lyrical-nonsense/i.test(u)) {
      continue;
    }
    if (/genius\.com\/search|musixmatch\.com\/search/i.test(u)) continue;
    urls.push(u.replace(/&amp;/g, '&').split('&')[0]!);
  }
  for (const m of html.matchAll(/uddg=([^&"]+)/g)) {
    try {
      const u = decodeURIComponent(m[1] || '');
      if (/genius\.com|musixmatch\.com|azlyrics\.com/i.test(u)) urls.push(u);
    } catch {
      /* ignore */
    }
  }
  return unique(urls).slice(0, 8);
}

async function searchWebLyricUrls(artist: string, title: string): Promise<string[]> {
  const q = [artistVariants(artist)[0] || artist, titleVariants(title)[0] || title, 'lyrics']
    .filter(Boolean)
    .join(' ');
  const pages = [
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${q} site:genius.com`)}`,
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  ];
  const found: string[] = [];
  for (const url of pages) {
    const res = await fetchText(url, { timeoutMs: 5500 });
    if (!res.text) continue;
    found.push(...urlsFromSearchHtml(res.text));
    if (found.length >= 6) break;
  }
  return unique(found).slice(0, 8);
}

async function scrapeLyricUrl(
  url: string,
  artist: string,
  title: string,
): Promise<{ pick: WebLyricsPick | null; suggestion?: LyricSuggestion }> {
  const res = await fetchText(url, { timeoutMs: 7000 });
  if (!res.ok && res.status !== 200) {
    return { pick: null };
  }
  const lyrics = extractLyricsFromHtml(res.text, url);
  const pageTitle = (res.text.match(/<title>([^<]+)<\/title>/i)?.[1] || '')
    .replace(/\s*[|\-–].+$/, '')
    .replace(/\s+lyrics.*/i, '')
    .trim();
  const score = matchScore(artist, title, '', pageTitle || title);
  if (lyrics && looksLikeLyrics(lyrics) && acceptScore(artist, title, score >= 50 ? score : 50)) {
    // Page dédiée au slug exact : on fait confiance si le texte est des paroles.
    const slugOk =
      url.toLowerCase().includes(slugPath(title).slice(0, 12)) &&
      url.toLowerCase().includes(slugPath(artistVariants(artist)[0] || artist).slice(0, 8));
    if (slugOk || score >= 50) {
      return { pick: { lyrics, source: sourceFromUrl(url), url } };
    }
  }
  if (lyrics && looksLikeLyrics(lyrics)) {
    return {
      pick: acceptScore(artist, title, Math.max(score, 40)) ? { lyrics, source: sourceFromUrl(url), url } : null,
      suggestion: {
        title: pageTitle || title,
        artist,
        url,
        source: sourceFromUrl(url),
        reason: 'page trouvée, correspondance incertaine',
        score,
      },
    };
  }
  return { pick: null };
}

export function lyricSearchLinks(artist: string, title: string): LyricSearchLink[] {
  const q = [artistVariants(artist)[0] || artist, titleVariants(title)[0] || title]
    .filter(Boolean)
    .join(' ')
    .trim();
  const enc = encodeURIComponent(q);
  const encL = encodeURIComponent(`${q} lyrics`);
  return [
    { label: 'Genius', url: geniusSearchUrl(artist, title) },
    { label: 'Google', url: `https://www.google.com/search?q=${encL}` },
    { label: 'DuckDuckGo', url: `https://duckduckgo.com/?q=${encL}` },
    { label: 'Musixmatch', url: `https://www.musixmatch.com/search/${enc}` },
  ];
}

export async function findBestWebLyrics(
  artist: string,
  title: string,
): Promise<{
  pick: WebLyricsPick | null;
  suggestions: LyricSuggestion[];
  searchUrls: LyricSearchLink[];
}> {
  const searchUrls = lyricSearchLinks(artist, title);
  const suggestions: LyricSuggestion[] = [];
  if (!title.trim()) return { pick: null, suggestions, searchUrls };

  const deadline = Date.now() + 16_000;

  const wave1 = await Promise.all([
    fetchGeniusLyrics(artist, title).catch(() => null),
    tryLyricsOvh(artist, title).catch(() => null),
    tryLyrist(artist, title).catch(() => null),
    listGeniusNearMisses(artist, title).catch(() => []),
    fetchSpotifyLyrics(artist, title).catch(() => null),
    resolveStreamingCatalog(artist, title).catch(() => null),
  ]);

  const genius = wave1[0];
  if (genius?.lyrics && looksLikeLyrics(genius.lyrics)) {
    return {
      pick: { lyrics: genius.lyrics, source: 'genius', url: genius.url },
      suggestions,
      searchUrls,
    };
  }
  const ovh = wave1[1];
  if (ovh) return { pick: ovh, suggestions, searchUrls };
  const lyrist = wave1[2];
  if (lyrist) return { pick: lyrist, suggestions, searchUrls };
  const spotify = wave1[4];
  if (spotify?.lyrics && looksLikeLyrics(spotify.lyrics)) {
    return {
      pick: { lyrics: spotify.lyrics, source: spotify.source === 'lrclib' ? 'lrclib' : spotify.source },
      suggestions,
      searchUrls: [...searchUrls, ...catalogSearchLinks(wave1[5], artist, title)],
    };
  }
  const catalog = wave1[5];
  if (catalog) {
    searchUrls.push(...catalogSearchLinks(catalog, artist, title));
    suggestions.unshift({
      title: catalog.title,
      artist: catalog.artist,
      url: catalog.url || catalogSearchLinks(catalog, artist, title)[0]!.url,
      source: catalog.source,
      reason: 'trouvé sur le catalogue streaming — paroles pas encore indexées',
      score: 60,
    });
  }

  for (const hit of wave1[3] || []) {
    suggestions.push({
      title: hit.title,
      artist: hit.artist,
      url: hit.url,
      source: 'genius',
      reason:
        hit.score >= 40
          ? 'proche sur Genius — à confirmer'
          : 'autre titre trouvé sur Genius (pas celui-ci)',
      score: hit.score,
    });
    if (hit.score >= 72) {
      const scraped = await scrapeLyricUrl(hit.url, artist, title);
      if (scraped.pick) return { pick: scraped.pick, suggestions, searchUrls };
    }
  }

  if (Date.now() > deadline) {
    return { pick: null, suggestions: suggestions.slice(0, 6), searchUrls };
  }

  const pages = unique([...guessedLyricPages(artist, title), ...(await searchWebLyricUrls(artist, title).catch(() => []))]);
  for (const url of pages.slice(0, 8)) {
    if (Date.now() > deadline) break;
    const scraped = await scrapeLyricUrl(url, artist, title).catch(() => ({ pick: null }));
    if (scraped.pick) return { pick: scraped.pick, suggestions: suggestions.slice(0, 6), searchUrls };
    if (scraped.suggestion) suggestions.push(scraped.suggestion);
  }

  return { pick: null, suggestions: suggestions.slice(0, 6), searchUrls };
}
