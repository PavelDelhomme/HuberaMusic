/**
 * Paroles Genius.com — search publique (+ token API optionnel) puis scrape HTML.
 * Depuis un VPS datacenter Genius renvoie souvent 403 : on retente via le pool
 * de proxies HTTP (même source que yt-dlp) + découverte d’URL via DuckDuckGo.
 * Cache côté getLyrics ; timeouts bornés pour ne pas bloquer le lecteur.
 */
import { spawn } from 'node:child_process';
import {
  markYoutubeProxyFailure,
  markYoutubeProxySuccess,
  youtubeProxyAttempts,
} from './youtubeProxy.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function fold(s: string) {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\badah\b/g, 'adhd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function compactFold(s: string) {
  return fold(s).replace(/\s+/g, '');
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

function significantTokens(s: string) {
  return s.split(' ').filter((x) => x.length > 1);
}

/**
 * ADHD ⊂ « ABCD ADHD / ABCD ADAH » ne doit pas gagner.
 * Un titre court populaire ne remplace pas le titre affiché en lecture.
 */
export function titleMatchScore(wantT: string, gotT: string): number {
  if (!wantT || !gotT) return 0;
  if (gotT === wantT) return 50;
  const wantTok = significantTokens(wantT);
  const gotTok = significantTokens(gotT);
  const overlap = tokenOverlap(wantT, gotT);
  const lenRatio =
    Math.min(gotT.length, wantT.length) / Math.max(gotT.length, wantT.length);

  if (gotT.includes(wantT) || wantT.includes(gotT)) {
    if (lenRatio >= 0.72 && Math.abs(wantTok.length - gotTok.length) <= 1) return 30;
    if (wantTok.length && gotTok.length && wantTok.every((t) => gotTok.includes(t))) return 28;
    return 0;
  }
  if (overlap >= 0.8) return Math.round(overlap * 35);
  if (overlap >= 0.5 && Math.abs(wantTok.length - gotTok.length) <= 1) {
    return Math.round(overlap * 28);
  }
  return 0;
}

export function artistMatchScore(wantA: string, gotA: string): number {
  if (!wantA || !gotA) return 0;
  if (gotA === wantA) return 30;
  const cw = compactFold(wantA);
  const cg = compactFold(gotA);
  // InTheLight ↔ In The Light
  if (cw && cg && cw === cg) return 30;
  if (cw.length >= 5 && cg.length >= 5 && (cw.includes(cg) || cg.includes(cw))) return 22;
  if (gotA.includes(wantA) || wantA.includes(gotA)) return 18;
  return Math.round(tokenOverlap(wantA, gotA) * 22);
}

function cleanTitle(title: string) {
  return title
    .replace(/\s*[\[(【].*?[\])】]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Artistes hintés dans le titre (feat. / with / ×). */
function artistsFromTitle(title: string): string[] {
  const out: string[] = [];
  const re =
    /(?:feat\.?|ft\.?|featuring|with|avec|x|×)\s*([^)\]]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(title))) {
    const chunk = (m[1] || '')
      .split(/[,&/]| et /i)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 1 && s.length < 60);
    out.push(...chunk);
  }
  return [...new Set(out)];
}

function mainArtist(artist: string): string {
  return artist.split(/[,&/]| feat\.? | ft\.? | featuring /i)[0]?.trim() || artist;
}

type GeniusHit = { url: string; title: string; artist: string };

type FetchOk = { ok: true; status: number; text: string };
type FetchKo = { ok: false; status: number; text: string };
type FetchRes = FetchOk | FetchKo;

function curlFetch(
  url: string,
  opts: { proxy?: string | null; headers?: Record<string, string>; timeoutMs?: number },
): Promise<FetchRes> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const args = [
    '-sL',
    '--connect-timeout',
    '4',
    '--max-time',
    String(Math.max(5, Math.ceil(timeoutMs / 1000))),
    '-w',
    '\n__HTTP__%{http_code}',
  ];
  if (opts.proxy) {
    args.push('-x', opts.proxy);
  }
  for (const [k, v] of Object.entries(opts.headers || {})) {
    args.push('-H', `${k}: ${v}`);
  }
  args.push(url);

  return new Promise((resolve) => {
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, status: 0, text: '' });
    }, timeoutMs + 1500);
    child.stdout.on('data', (d: Buffer) => chunks.push(d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, status: 0, text: '' });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const marker = raw.lastIndexOf('\n__HTTP__');
      if (marker < 0) {
        resolve({ ok: false, status: 0, text: raw });
        return;
      }
      const text = raw.slice(0, marker);
      const status = Number(raw.slice(marker + '\n__HTTP__'.length).trim()) || 0;
      resolve({ ok: status >= 200 && status < 300, status, text });
    });
  });
}

async function directFetch(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number },
): Promise<FetchRes> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
    headers: opts.headers,
    redirect: 'follow',
  }).catch(() => null);
  if (!res) return { ok: false, status: 0, text: '' };
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, text };
}

/**
 * Fetch Genius : direct d’abord, puis proxies HTTP (curl -x) en course
 * parallèle (lots de 3) pour éviter 45 s de timeouts séquentiels.
 */
async function geniusHttpGet(
  url: string,
  opts?: { accept?: string; timeoutMs?: number; maxProxies?: number },
): Promise<FetchRes> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: opts?.accept || 'text/html,application/xhtml+xml,application/json',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    Referer: 'https://genius.com/',
  };
  const timeoutMs = opts?.timeoutMs ?? 6000;

  const direct = await directFetch(url, { headers, timeoutMs: Math.min(timeoutMs, 3500) });
  if (direct.ok) return direct;
  if (direct.status === 404) return direct;

  const proxies = (
    await youtubeProxyAttempts({
      max: opts?.maxProxies ?? 4,
      includeDirect: false,
      shuffle: true,
    })
  ).filter((p): p is string => Boolean(p));

  // Un proxy à la fois (timeout → suivant) — évite de saturer le pool.
  for (const proxy of proxies) {
    const r = await curlFetch(url, { proxy, headers, timeoutMs });
    if (r.ok) {
      markYoutubeProxySuccess(proxy);
      return r;
    }
    if (r.status === 403 || r.status === 429 || r.status === 0 || r.status >= 500) {
      markYoutubeProxyFailure(proxy);
    }
  }
  return direct.status ? direct : { ok: false, status: 0, text: '' };
}

export function pickBestHit(
  rows: Record<string, unknown>[],
  artist: string,
  title: string,
): GeniusHit | null {
  const wantT = fold(cleanTitle(title) || title);
  const wantA = fold(mainArtist(artist) || artist);
  let best: { score: number; hit: GeniusHit } | null = null;
  for (const r of rows) {
    const url = String(r.url || (r.path ? `https://genius.com${r.path}` : '')).trim();
    if (!url.includes('genius.com') || !/lyrics/i.test(url)) continue;
    const t = String(r.title || r.full_title || '').replace(/\s+by\s+.+$/i, '').trim();
    const a = String(
      r.artist_names ||
        r.primary_artist_names ||
        (r.primary_artist as { name?: string })?.name ||
        '',
    ).trim();
    const ft = fold(t);
    const fa = fold(a);
    const tScore = titleMatchScore(wantT, ft);
    const aScore = artistMatchScore(wantA, fa);
    const score = tScore + aScore;
    if (wantA.length >= 3) {
      const distinctiveTitle =
        tScore >= 50 && significantTokens(wantT).length >= 3;
      if (aScore < 10 && !distinctiveTitle) continue;
    }
    if (wantT && tScore < 22 && !(tScore >= 18 && aScore >= 18)) continue;
    const minScore = tScore >= 50 ? 50 : 28;
    if (score < minScore) continue;
    const hit = { url, title: t || title, artist: a || artist };
    if (!best || score > best.score) best = { score, hit };
  }
  return best?.hit ?? null;
}

function hitsFromMultiSearch(data: unknown): Record<string, unknown>[] {
  const songs: Record<string, unknown>[] = [];
  const sections =
    (data as { response?: { sections?: Array<{ type?: string; hits?: Array<{ result?: Record<string, unknown> }> }> } })
      ?.response?.sections || [];
  for (const sec of sections) {
    if (sec.type && sec.type !== 'song' && sec.type !== 'top_hit') continue;
    for (const h of sec.hits || []) {
      const r = h.result;
      if (r && (r._type === 'song' || r.url || r.path)) songs.push(r);
    }
  }
  return songs;
}

function hitsFromSongSearch(data: unknown): Record<string, unknown>[] {
  const sections =
    (data as { response?: { sections?: Array<{ hits?: Array<{ result?: Record<string, unknown> }> }> } })
      ?.response?.sections || [];
  const songs: Record<string, unknown>[] = [];
  for (const sec of sections) {
    for (const h of sec.hits || []) {
      if (h.result) songs.push(h.result);
    }
  }
  // api.genius.com/search shape
  const hits =
    (data as { response?: { hits?: Array<{ result?: Record<string, unknown> }> } })?.response?.hits ||
    [];
  for (const h of hits) if (h.result) songs.push(h.result);
  return songs;
}

async function searchGeniusOnce(q: string, artist: string, title: string): Promise<GeniusHit | null> {
  if (!q.trim()) return null;
  const headersAccept = 'application/json';

  const token = String(process.env.GENIUS_ACCESS_TOKEN || '').trim();
  if (token) {
    const res = await geniusHttpGet(
      `https://api.genius.com/search?q=${encodeURIComponent(q)}`,
      { accept: headersAccept, timeoutMs: 5500, maxProxies: 3 },
    );
    if (res.ok) {
      try {
        const data = JSON.parse(res.text) as unknown;
        const hit = pickBestHit(hitsFromSongSearch(data), artist, title);
        if (hit) return hit;
      } catch {
        /* ignore */
      }
    }
  }

  for (const path of [
    `https://genius.com/api/search/song?q=${encodeURIComponent(q)}`,
    `https://genius.com/api/search/multi?q=${encodeURIComponent(q)}`,
  ]) {
    const res = await geniusHttpGet(path, {
      accept: headersAccept,
      timeoutMs: 5500,
      maxProxies: 3,
    });
    if (!res.ok) continue;
    try {
      const data = JSON.parse(res.text) as unknown;
      const rows = path.includes('/song') ? hitsFromSongSearch(data) : hitsFromMultiSearch(data);
      const hit = pickBestHit(rows, artist, title);
      if (hit) return hit;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** DuckDuckGo HTML → URLs genius.com/…-lyrics (quand l’API Genius est opaque). */
async function searchGeniusViaDdg(artist: string, title: string): Promise<GeniusHit | null> {
  const queries = [
    `${cleanTitle(title) || title} ${mainArtist(artist)} site:genius.com`,
    `${mainArtist(artist)} ${cleanTitle(title) || title} lyrics`,
    `"${cleanTitle(title) || title}" lyrics genius`,
  ].filter((q, i, a) => q.trim() && a.indexOf(q) === i);

  const urls: string[] = [];
  for (const q of queries.slice(0, 2)) {
    const res = await directFetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
      {
        timeoutMs: 6000,
        headers: {
          'User-Agent': UA,
          Accept: 'text/html',
        },
      },
    );
    if (!res.ok && res.status !== 200) continue;
    const html = res.text;
    for (const m of html.matchAll(/uddg=([^&"]+)/g)) {
      try {
        const u = decodeURIComponent(m[1] || '');
        if (/genius\.com\/.+-lyrics/i.test(u)) urls.push(u.split('&')[0]!);
      } catch {
        /* ignore */
      }
    }
    for (const m of html.matchAll(/https?:\/\/genius\.com\/[A-Za-z0-9_-]+-lyrics/g)) {
      urls.push(m[0]!);
    }
    // //duckduckgo.com/l/?uddg=…
    for (const m of html.matchAll(/genius\.com%2F[A-Za-z0-9_%-]+-lyrics/gi)) {
      try {
        urls.push(`https://${decodeURIComponent(m[0]!)}`);
      } catch {
        /* ignore */
      }
    }
  }

  const unique = [...new Set(urls.map((u) => u.replace(/[?#].*$/, '')))];
  if (!unique.length) return null;

  const wantT = fold(cleanTitle(title) || title);
  const wantA = fold(mainArtist(artist));
  let best: { score: number; url: string } | null = null;
  for (const url of unique.slice(0, 8)) {
    const slug = fold(
      url.replace(/^https?:\/\/genius\.com\//i, '').replace(/-lyrics$/i, '').replace(/-/g, ' '),
    );
    const tScore = titleMatchScore(wantT, slug);
    let score = tScore;
    if (wantT && slug.includes(wantT)) score += 20;
    if (wantA) {
      const a0 = wantA.split(' ')[0] || wantA;
      const slugC = compactFold(slug);
      const wantC = compactFold(wantA);
      if (wantC.length >= 5 && slugC.includes(wantC)) score += 22;
      else if (a0.length >= 3 && slug.includes(a0)) score += 20;
      else continue;
    }
    if (!best || score > best.score) best = { score, url };
  }
  if (!best || best.score < 28) return null;
  return { url: best.url, title: cleanTitle(title) || title, artist: mainArtist(artist) || artist };
}

async function searchGenius(artist: string, title: string): Promise<GeniusHit | null> {
  const cleaned = cleanTitle(title) || title;
  const main = mainArtist(artist);
  const featured = artistsFromTitle(title);
  // Jamais le titre seul si l’artiste est connu (ADHD vs InTheLight / ABCD ADAH).
  const spaced = main.replace(/([a-z])([A-Z])/g, '$1 $2');
  const queries = [
    [main, cleaned].filter(Boolean).join(' '),
    [spaced, cleaned].filter(Boolean).join(' '),
    [artist, cleaned].filter(Boolean).join(' '),
    [cleaned, main].filter(Boolean).join(' '),
    [main, title].filter(Boolean).join(' '),
    ...featured.map((f) => [f, cleaned].filter(Boolean).join(' ')),
  ]
    .map((q) => q.slice(0, 120).trim())
    .filter((q, i, a) => q && a.indexOf(q) === i);
  if (!main && !artist && cleaned) queries.unshift(cleaned);

  for (const q of queries.slice(0, 4)) {
    const hit = await searchGeniusOnce(q, artist || main, title).catch(() => null);
    if (hit) return hit;
  }

  return searchGeniusViaDdg(artist, title).catch(() => null);
}

function scoreLooseHit(
  r: Record<string, unknown>,
  artist: string,
  title: string,
): { url: string; title: string; artist: string; score: number } | null {
  const url = String(r.url || (r.path ? `https://genius.com${r.path}` : '')).trim();
  if (!url.includes('genius.com') || !/lyrics/i.test(url)) return null;
  const t = String(r.title || r.full_title || '').replace(/\s+by\s+.+$/i, '').trim();
  const a = String(
    r.artist_names ||
      r.primary_artist_names ||
      (r.primary_artist as { name?: string })?.name ||
      '',
  ).trim();
  const score =
    titleMatchScore(fold(cleanTitle(title) || title), fold(t)) +
    artistMatchScore(fold(mainArtist(artist) || artist), fold(a));
  return { url, title: t || title, artist: a || artist, score };
}

async function rowsForQuery(q: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const path of [
    `https://genius.com/api/search/song?q=${encodeURIComponent(q)}`,
    `https://genius.com/api/search/multi?q=${encodeURIComponent(q)}`,
  ]) {
    const res = await geniusHttpGet(path, {
      accept: 'application/json',
      timeoutMs: 4500,
      maxProxies: 2,
    });
    if (!res.ok) continue;
    try {
      const data = JSON.parse(res.text) as unknown;
      const rows = path.includes('/song') ? hitsFromSongSearch(data) : hitsFromMultiSearch(data);
      out.push(...rows);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Hits Genius même trop faibles pour auto-prendre — pour proposer une alternative. */
export async function listGeniusNearMisses(
  artist: string,
  title: string,
): Promise<Array<{ url: string; title: string; artist: string; score: number }>> {
  const cleaned = cleanTitle(title) || title;
  const main = mainArtist(artist);
  const q = [main, cleaned].filter(Boolean).join(' ').trim() || cleaned;
  if (!q) return [];
  const rows = await rowsForQuery(q).catch(() => []);
  const seen = new Set<string>();
  const scored: Array<{ url: string; title: string; artist: string; score: number }> = [];
  for (const r of rows) {
    const hit = scoreLooseHit(r, artist, title);
    if (!hit || seen.has(hit.url)) continue;
    seen.add(hit.url);
    scored.push(hit);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8);
}

function parseGeniusHtml(html: string): string | null {
  const blocks: string[] = [
    ...html.matchAll(/data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/gi),
  ].map((m) => m[1] || '');
  if (!blocks.length) {
    // Fallback classes React Genius
    const pre = html.match(
      /<div[^>]+class="[^"]*Lyrics__Container[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    );
    if (pre?.length) {
      for (const block of pre) {
        blocks.push(block.replace(/^<div[^>]*>/i, '').replace(/<\/div>$/i, ''));
      }
    }
  }
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
      if (
        /^(Türkçe|Português|English|Deutsch|Español|Français|Русский)/i.test(s) &&
        s.length < 80
      ) {
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
  const res = await geniusHttpGet(url, {
    accept: 'text/html,application/xhtml+xml',
    timeoutMs: 8000,
    maxProxies: 4,
  });
  if (!res.ok) return null;
  return parseGeniusHtml(res.text);
}

function artistNameVariants(artist: string): string[] {
  const main = mainArtist(artist) || artist;
  const spaced = main.replace(/([a-z])([A-Z])/g, '$1 $2');
  return [...new Set([main, artist, spaced].map((s) => s.trim()).filter(Boolean))];
}

function titleVariants(title: string): string[] {
  const cleaned = cleanTitle(title) || title;
  return [
    ...new Set(
      [cleaned, title, cleaned.replace(/\bADAH\b/gi, 'ADHD'), cleaned.replace(/\bADHD\b/gi, 'ADAH')]
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/** Construit une URL Genius plausible (slug) si la search rate-limit / rate. */
function guessGeniusUrl(artist: string, title: string): string | null {
  return guessGeniusUrls(artist, title)[0] || null;
}

function guessGeniusUrls(artist: string, title: string): string[] {
  const out: string[] = [];
  for (const aName of artistNameVariants(artist)) {
    for (const tName of titleVariants(title)) {
      const a = geniusSlug(aName);
      const t = geniusSlug(tName);
      if (!a || !t || a.length < 2 || t.length < 2) continue;
      out.push(`https://genius.com/${a}-${t}-lyrics`);
    }
  }
  return [...new Set(out)].slice(0, 6);
}

/**
 * Cherche puis scrape Genius. Retourne texte brut (pas de timed).
 */
export async function fetchGeniusLyrics(
  artist: string,
  title: string,
): Promise<{ lyrics: string; url: string } | null> {
  if (!title.trim()) return null;
  const deadline = Date.now() + 14_000;
  const guessedUrls = guessGeniusUrls(artist, title);
  const guessed = guessedUrls[0] || null;
  const [hit, firstGuess] = await Promise.all([
    searchGenius(artist, title).catch(() => null),
    guessed ? scrapeGeniusPage(guessed).catch(() => null) : Promise.resolve(null),
  ]);
  if (guessed && firstGuess) return { lyrics: firstGuess, url: guessed };
  if (Date.now() > deadline) return null;
  const urls = [
    hit?.url,
    ...guessedUrls,
    ...artistsFromTitle(title)
      .slice(0, 1)
      .flatMap((f) => guessGeniusUrls(f, title)),
  ].filter((u, i, arr): u is string => Boolean(u) && arr.indexOf(u) === i);

  for (const url of urls) {
    if (Date.now() > deadline) break;
    const lyrics = await scrapeGeniusPage(url).catch(() => null);
    if (lyrics) return { lyrics, url };
  }
  return null;
}

/** URL de recherche Genius (bouton « Chercher sur le web »). */
export function geniusSearchUrl(artist: string, title: string): string {
  const q = [mainArtist(artist) || artist, cleanTitle(title) || title]
    .filter(Boolean)
    .join(' ');
  return `https://genius.com/search?q=${encodeURIComponent(q)}`;
}
