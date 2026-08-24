/**
 * Paroles Genius.com — search publique (+ token API optionnel) puis scrape HTML.
 * Cache côté getLyrics ; timeouts courts pour ne pas bloquer le lecteur.
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function fold(s: string) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function geniusSlug(s: string) {
  return fold(s).replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function tokenOverlap(a: string, b: string) {
  const ta = new Set(a.split(' ').filter((x) => x.length > 1));
  const tb = new Set(b.split(' ').filter((x) => x.length > 1));
  if (!ta.size || !tb.size) return 0;
  let n = 0;
  for (const t of ta) if (tb.has(t)) n += 1;
  return n / Math.max(ta.size, tb.size);
}

function cleanTitle(title: string) {
  return title
    .replace(/\s*[\[(【].*?[\])】]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

type GeniusHit = { url: string; title: string; artist: string };

async function searchGenius(artist: string, title: string): Promise<GeniusHit | null> {
  const q = [artist, cleanTitle(title) || title].filter(Boolean).join(' ').slice(0, 120);
  if (!q.trim()) return null;
  const ctrl = AbortSignal.timeout(4500);
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/json',
  };

  const token = String(process.env.GENIUS_ACCESS_TOKEN || '').trim();
  if (token) {
    const res = await fetch(
      `https://api.genius.com/search?q=${encodeURIComponent(q)}`,
      { signal: ctrl, headers: { ...headers, Authorization: `Bearer ${token}` } },
    ).catch(() => null);
    if (res?.ok) {
      const data = (await res.json().catch(() => null)) as {
        response?: { hits?: Array<{ result?: Record<string, unknown> }> };
      } | null;
      const hit = pickBestHit(
        (data?.response?.hits || []).map((h) => h.result || {}),
        artist,
        title,
      );
      if (hit) return hit;
    }
  }

  const res = await fetch(
    `https://genius.com/api/search/multi?q=${encodeURIComponent(q)}`,
    { signal: ctrl, headers },
  ).catch(() => null);
  if (!res?.ok) return null;
  const data = (await res.json().catch(() => null)) as {
    response?: { sections?: Array<{ type?: string; hits?: Array<{ result?: Record<string, unknown> }> }> };
  } | null;
  const songs: Record<string, unknown>[] = [];
  for (const sec of data?.response?.sections || []) {
    if (sec.type !== 'song' && sec.type !== 'top_hit') continue;
    for (const h of sec.hits || []) {
      const r = h.result;
      if (r && (r._type === 'song' || r.url || r.path)) songs.push(r);
    }
  }
  return pickBestHit(songs, artist, title);
}

function pickBestHit(
  rows: Record<string, unknown>[],
  artist: string,
  title: string,
): GeniusHit | null {
  const wantT = fold(cleanTitle(title) || title);
  const wantA = fold(artist);
  let best: { score: number; hit: GeniusHit } | null = null;
  for (const r of rows) {
    const url = String(r.url || (r.path ? `https://genius.com${r.path}` : '')).trim();
    if (!url.includes('genius.com') || !/lyrics/i.test(url)) continue;
    const t = String(r.title || r.full_title || '').replace(/\s+by\s+.+$/i, '').trim();
    const a = String(
      r.artist_names || r.primary_artist_names || (r.primary_artist as { name?: string })?.name || '',
    ).trim();
    let score = 0;
    const ft = fold(t);
    const fa = fold(a);
    if (wantT && ft) {
      if (ft === wantT) score += 50;
      else if (ft.includes(wantT) || wantT.includes(ft)) score += 30;
      else score += Math.round(tokenOverlap(wantT, ft) * 35);
    }
    if (wantA && fa) {
      if (fa === wantA) score += 30;
      else if (fa.includes(wantA) || wantA.includes(fa)) score += 18;
      else score += Math.round(tokenOverlap(wantA, fa) * 22);
    }
    if (score < 18) continue;
    const hit = { url, title: t || title, artist: a || artist };
    if (!best || score > best.score) best = { score, hit };
  }
  return best?.hit ?? null;
}

function parseGeniusHtml(html: string): string | null {
  const blocks = [
    ...html.matchAll(/data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/gi),
  ].map((m) => m[1] || '');
  if (!blocks.length) return null;
  const lines: string[] = [];
  for (const block of blocks) {
    let t = block.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<[^>]+>/g, '');
    t = t
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&#x2F;/gi, '/')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, n) => {
        const code = Number(n);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
      })
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
        const code = parseInt(h, 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
      });
    for (const ln of t.split(/\r?\n/)) {
      const s = ln.replace(/\u00a0/g, ' ').trimEnd();
      if (!s.trim()) {
        if (lines.length && lines[lines.length - 1] !== '') lines.push('');
        continue;
      }
      if (/^\d+\s+Contributors/i.test(s)) continue;
      if (/^Translations?/i.test(s)) continue;
      if (/^(Türkçe|Português|English|Deutsch|Español|Français|Русский)/i.test(s) && s.length < 80) {
        continue;
      }
      lines.push(s.trim());
    }
  }
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 40) return null;
  if (/^you need to enable javascript/i.test(text)) return null;
  return text;
}

async function scrapeGeniusPage(url: string): Promise<string | null> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(6000),
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
  }).catch(() => null);
  if (!res?.ok) return null;
  const html = await res.text();
  return parseGeniusHtml(html);
}

/** Construit une URL Genius plausible (slug) si la search rate-limit / rate. */
function guessGeniusUrl(artist: string, title: string): string | null {
  const a = geniusSlug(artist.split(/[,&/]| feat\.? | ft\.? /i)[0] || artist);
  const t = geniusSlug(cleanTitle(title) || title);
  if (!a || !t || a.length < 2 || t.length < 2) return null;
  return `https://genius.com/${a}-${t}-lyrics`;
}

/**
 * Cherche puis scrape Genius. Retourne texte brut (pas de timed).
 */
export async function fetchGeniusLyrics(
  artist: string,
  title: string,
): Promise<{ lyrics: string; url: string } | null> {
  if (!title.trim()) return null;
  const hit = (await searchGenius(artist, title).catch(() => null)) || null;
  const urls = [
    hit?.url,
    guessGeniusUrl(artist, title),
    guessGeniusUrl(artist.split(/[,&/]/)[0] || artist, title),
  ].filter((u, i, arr): u is string => Boolean(u) && arr.indexOf(u) === i);

  for (const url of urls) {
    const lyrics = await scrapeGeniusPage(url).catch(() => null);
    if (lyrics) return { lyrics, url };
  }
  return null;
}

/** URL de recherche Genius (bouton « Chercher sur le web »). */
export function geniusSearchUrl(artist: string, title: string): string {
  const q = [cleanTitle(title) || title, artist].filter(Boolean).join(' ');
  return `https://genius.com/search?q=${encodeURIComponent(q)}`;
}
