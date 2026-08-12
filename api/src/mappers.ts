import type { Track } from './types.js';

export type Thumb = { url: string; width?: number; height?: number };

/** Normalise un TextRuns / string Innertube en string affichable. */
export function asText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const v = value as { text?: unknown; runs?: Array<{ text?: string }>; toString?: () => string };
    if (typeof v.text === 'string') return v.text;
    if (Array.isArray(v.runs)) {
      const joined = v.runs.map((r) => (typeof r?.text === 'string' ? r.text : '')).join('');
      if (joined) return joined;
    }
    if (typeof v.toString === 'function') {
      const s = v.toString();
      if (s && s !== '[object Object]') return s;
    }
  }
  return '';
}

export function formatDurationClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const total = Math.floor(totalSeconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = s.toString().padStart(2, '0');
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** Corrige les textes type `164:16` → `2:44:16`. */
export function normalizeDurationText(raw: string): string {
  const parts = raw.trim().split(':').map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return raw;
  if (parts.length === 3) return formatDurationClock(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  if (parts.length === 2) {
    const [m, s] = parts;
    if (m >= 60) return formatDurationClock(m * 60 + s);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
  return raw;
}

/**
 * Garantit `duration` string (clients Moshi / JSON strict).
 * Anciens payloads DB peuvent avoir `duration: 212` (secondes).
 */
export function sanitizeTrack(track: Track): Track {
  const raw = track as Track & { duration?: unknown };
  let durationSeconds =
    typeof track.durationSeconds === 'number' && Number.isFinite(track.durationSeconds)
      ? Math.floor(track.durationSeconds)
      : undefined;
  let duration: string | undefined;

  if (typeof raw.duration === 'number' && Number.isFinite(raw.duration)) {
    durationSeconds = durationSeconds ?? Math.floor(raw.duration);
    duration = formatDurationClock(raw.duration);
  } else if (typeof raw.duration === 'string' && raw.duration.trim()) {
    const cleaned = normalizeDurationText(raw.duration.trim());
    // Garde uniquement une horloge lisible (évite TextRuns / labels bruts)
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(cleaned) || /^\d+$/.test(cleaned)) {
      duration = cleaned;
    } else {
      const m = cleaned.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
      duration = m ? normalizeDurationText(m[1]) : undefined;
    }
  } else if (raw.duration && typeof raw.duration === 'object') {
    const t = asText(raw.duration).trim();
    if (t) {
      const cleaned = normalizeDurationText(t);
      if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(cleaned)) duration = cleaned;
      else {
        const m = cleaned.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
        duration = m ? normalizeDurationText(m[1]) : undefined;
      }
    }
  } else if (durationSeconds != null) {
    duration = formatDurationClock(durationSeconds);
  }
  if (duration && durationSeconds == null) {
    const parts = duration.split(':').map((p) => Number(p));
    if (parts.length === 2 && parts.every((n) => Number.isFinite(n))) {
      durationSeconds = parts[0] * 60 + parts[1];
    } else if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      durationSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
  }

  return {
    ...track,
    title: (() => {
      const cleaned = cleanMusicTitle(String(track.title || ''));
      return cleaned || track.title;
    })(),
    artists: Array.isArray(track.artists)
      ? track.artists.filter((a) => a?.name && isPlausibleArtistName(String(a.name)))
      : track.artists,
    duration,
    durationSeconds,
  };
}

/** Nettoie un payload album/artiste de biblio (métadonnées YTM type « 4 songs »). */
export function sanitizeLibraryItem<T extends { artists?: { name: string; id?: string }[]; title?: string; name?: string }>(
  item: T,
): T {
  if (!item || typeof item !== 'object') return item;
  const title = item.title != null ? cleanMusicTitle(String(item.title)) || item.title : item.title;
  if (!Array.isArray(item.artists)) return title !== item.title ? { ...item, title } : item;
  return {
    ...item,
    title,
    artists: item.artists.filter((a) => a?.name && isPlausibleArtistName(String(a.name))),
  };
}

/** Collect every possible thumbnail array from a YT Music node */
export function extractThumbs(...sources: any[]): Thumb[] {
  const out: Thumb[] = [];
  const seen = new Set<string>();

  const pushList = (list: any) => {
    if (!list) return;
    const arr = Array.isArray(list)
      ? list
      : Array.isArray(list.contents)
        ? list.contents
        : Array.isArray(list.thumbnails)
          ? list.thumbnails
          : list.url
            ? [list]
            : [];
    for (const t of arr) {
      const url = String(t?.url || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({
        url,
        width: typeof t.width === 'number' ? t.width : undefined,
        height: typeof t.height === 'number' ? t.height : undefined,
      });
    }
  };

  for (const src of sources) {
    if (!src) continue;
    pushList(src.thumbnails);
    pushList(src.thumbnail);
    pushList(src.thumbnail?.contents);
    pushList(src.thumbnail?.thumbnails);
    pushList(src.header?.thumbnail?.contents);
    pushList(src.header?.thumbnails);
    pushList(src.header?.thumbnail);
    // Cropped / immersive variants
    pushList(src.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails);
    pushList(src.musicThumbnailRenderer?.thumbnail?.thumbnails);
  }

  return out.sort((a, b) => (b.width || 0) - (a.width || 0));
}

/** Upscale / normalize image URL for crisp display */
export function resizeThumbUrl(url: string, size = 544): string {
  if (!url) return '';
  let u = url;

  // googleusercontent / yt3 : =w544-h544-l90-rj or =w544-h544
  if (/=w\d+-h\d+/.test(u)) {
    u = u.replace(/=w\d+-h\d+(-[^=]*)?/, `=w${size}-h${size}$1`);
  } else if (/=s\d+/.test(u)) {
    u = u.replace(/=s\d+(-[^=]*)?/, `=s${size}$1`);
  } else if (/googleusercontent\.com/.test(u) && !/[?&=]/.test(u.split('/').pop() || '')) {
    // bare lh3 id without size — append
    u = `${u}=s${size}`;
  }

  // YouTube video thumbs → highest quality available
  const vi = u.match(/i\.ytimg\.com\/vi\/([^/]+)\//);
  if (vi) {
    const id = vi[1];
    if (size >= 320) return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    return `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  }

  return u;
}

export function bestThumbUrl(thumbs: Thumb[], size = 544): string {
  if (!thumbs?.length) return '';
  const sorted = [...thumbs].sort((a, b) => (b.width || 0) - (a.width || 0));
  return resizeThumbUrl(sorted[0].url, size);
}

export function isJunkArtistName(name: string) {
  const n = String(name || '').trim();
  return (
    !n ||
    n === '•' ||
    n === '·' ||
    // Handle / pseudo YouTube collé comme « artiste »
    /^@[\w.-]+$/i.test(n) ||
    /^profile$/i.test(n) ||
    // Podcast / Episode YTM (ex. « Episode », « Jan 31, 2025 », « May 8 »)
    /^episodes?$/i.test(n) ||
    /^(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\.?\s+\d{1,2}(?:,?\s+\d{4})?$/i.test(
      n,
    ) ||
    /^\d{1,2}\s+(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\.?(?:\s+\d{4})?$/i.test(
      n,
    ) ||
    // « Various Artists » est un vrai libellé YTM — ne pas le jeter (sinon UI → « Artiste »)
    /^(song|album|playlist|video|ep|single|artist|artiste|inconnu|unknown|n\/a|va|divers)$/i.test(
      n,
    ) ||
    /^\d+:\d+$/.test(n) ||
    /^\d{4}$/.test(n) ||
    /^\d+\s*songs?$/i.test(n) ||
    /^\d+\s*titres?$/i.test(n) ||
    /^\d+\s*(min|mins|minutes?|sec|secs|seconds?|h|hr|hrs|hours?)$/i.test(n) ||
    /^\d+\s*(song|album|playlist|video)s?$/i.test(n) ||
    /^\d+\s*hours?(?:,?\s*\d+\s*minutes?)?$/i.test(n) ||
    /^\d+\s*hour,\s*\d+\s*minutes?$/i.test(n) ||
    /^(?:\d+\s*)?(?:hour|hours|minute|minutes|second|seconds)(?:\s*,\s*\d+\s*(?:hour|hours|minute|minutes|second|seconds))?$/i.test(
      n,
    ) ||
    /plays?/i.test(n) ||
    /views?/i.test(n) ||
    /monthly audience/i.test(n)
  );
}

/**
 * Écarte les fausses « fiches artiste » YT :
 * chaînes perso nommées comme un titre de chanson (@handle / Profile en sous-titre).
 */
export function isPlausibleArtistEntity(item: {
  type?: string;
  title?: string;
  id?: string;
  artists?: { name?: string }[];
}): boolean {
  if (item.type && item.type !== 'artist') return true;
  const subs = (item.artists || [])
    .map((a) => String(a?.name || '').trim())
    .filter(Boolean);
  if (subs.some((n) => isJunkArtistName(n) || /^@/.test(n) || /^profile$/i.test(n))) {
    return false;
  }
  // « 347 subscribers » / « 1,2 k abonnés » = chaîne nommée comme un titre, pas un artiste
  if (
    subs.some((n) =>
      /^\d[\d\s.,]*\s*(k|m|md|b)?\s*(subscribers?|abonn[eé]s?)\s*$/i.test(n.trim()),
    )
  ) {
    return false;
  }
  // Sous-titre typique d’une chaîne non-artiste YTM
  const blob = subs.join(' ').toLowerCase();
  if (/\bprofile\b/.test(blob) && subs.length <= 2) return false;
  return true;
}

/** Détecte @handle / « Profile » dans le payload Innertube brut (avant sanitization). */
export function itemHasYoutubeHandleBadge(item: any): boolean {
  if (!item || typeof item !== 'object') return false;
  const texts: string[] = [];
  const walk = (x: unknown, depth = 0) => {
    if (x == null || depth > 6) return;
    if (typeof x === 'string') {
      texts.push(x);
      return;
    }
    if (Array.isArray(x)) {
      for (const v of x.slice(0, 40)) walk(v, depth + 1);
      return;
    }
    if (typeof x === 'object') {
      const o = x as Record<string, unknown>;
      if (o.text != null) texts.push(String(o.text));
      if (o.name != null) texts.push(String(o.name));
      for (const k of [
        'runs',
        'subtitle',
        'second_subtitle',
        'flex_columns',
        'artists',
        'author',
        'title',
        'strapline',
        'byline',
      ]) {
        if (k in o) walk(o[k], depth + 1);
      }
    }
  };
  walk(item.subtitle);
  walk(item.second_subtitle);
  walk(item.flex_columns);
  walk(item.artists);
  walk(item.author);
  walk(item.strapline);
  walk(item.byline);
  const blob = texts.join(' ');
  return /@[A-Za-z0-9._-]{2,}/.test(blob) || /\bProfile\b/.test(blob);
}

/** Écarte le bruit Wikipedia / URLs / pavés collés dans les headers album. */
export function isPlausibleArtistName(name: string) {
  const n = String(name || '').trim();
  if (!n || isJunkArtistName(n)) return false;
  if (n.length > 80) return false;
  if (/\n/.test(n)) return false;
  if (/https?:\/\//i.test(n)) return false;
  if (/wikipedia|creativecommons|creative commons|under creative|from wikipedia/i.test(n)) {
    return false;
  }
  return true;
}

export function isWeakTitle(title: string | undefined | null, id?: string) {
  const t = String(title || '').trim();
  if (!t) return true;
  if (/^(sans titre|untitled|unknown|n\/a)$/i.test(t)) return true;
  if (id && t === id) return true;
  return false;
}

/** Titre « musique » : enlève Official Video / Lyrics / 4K… (vidéos YT en file titre). */
export function cleanMusicTitle(raw: string): string {
  let t = String(raw || '').trim();
  if (!t) return '';
  t = t
    .replace(
      /\s*[\[(【]\s*(official\s*)?(music\s*)?v[ií]d[eé]o(\s*version)?\s*[\]】)]/gi,
      '',
    )
    .replace(
      /\s*[\[(【]\s*official\s*(audio|lyric\s*video|visuali[sz]er|hd|4k(?:\s*(?:upgrade|remaster(?:ed)?))?|remaster(?:ed)?)\s*[\]】)]/gi,
      '',
    )
    .replace(
      /\s*[\[(【]\s*(lyric\s*video|lyrics?|audio|visuali[sz]er|hd|4k(?:\s*(?:upgrade|remaster(?:ed)?))?|remaster(?:ed)?)\s*[\]】)]/gi,
      '',
    )
    .replace(/\s*[\[(【]\s*\d{3,4}p\s*[\]】)]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[-–—]\s*$/g, '')
    .trim();
  return t || String(raw || '').trim();
}

/** Enlève « - Artiste » en fin de titre si déjà dans artists (clips YT). */
export function stripRedundantArtistSuffix(
  title: string,
  artists: { name: string }[] | undefined,
): string {
  let t = String(title || '').trim();
  if (!t || !artists?.length) return t;
  for (const a of artists) {
    const name = String(a?.name || '').trim();
    if (!name || name.length < 2) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\s*[-–—|/]\\s*${escaped}(?:\\s*[/,&].*)?\\s*$`, 'i');
    if (re.test(t)) t = t.replace(re, '').trim();
  }
  return t || String(title || '').trim();
}

function musicVideoTypeOf(item: any): string {
  const paths = [
    item?.endpoint?.payload?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig
      ?.musicVideoType,
    item?.overlay?.content?.endpoint?.payload?.watchEndpointMusicSupportedConfigs
      ?.watchEndpointMusicConfig?.musicVideoType,
    item?.overlay?.endpoint?.payload?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig
      ?.musicVideoType,
    item?.flex_columns?.[0]?.title?.runs?.[0]?.endpoint?.payload?.watchEndpointMusicSupportedConfigs
      ?.watchEndpointMusicConfig?.musicVideoType,
    item?.flex_columns?.[0]?.title?.endpoint?.payload?.watchEndpointMusicSupportedConfigs
      ?.watchEndpointMusicConfig?.musicVideoType,
  ];
  for (const p of paths) {
    if (typeof p === 'string' && p) return p;
  }
  return '';
}

/** Extrait une année propre depuis un sous-titre type « Album • 2026 ». */
export function extractYear(raw: unknown): string | undefined {
  const text =
    typeof raw === 'string'
      ? raw
      : asText(raw) || (raw && typeof raw === 'object' && 'text' in (raw as object)
          ? String((raw as { text?: string }).text || '')
          : '');
  const m = String(text).match(/\b((?:19|20)\d{2})\b/);
  return m?.[1];
}

/** Album / EP / Single depuis le header YTM, sinon heuristique sur le nombre de titres. */
export function inferAlbumReleaseType(
  header: unknown,
  trackCount: number,
): 'Album' | 'EP' | 'Single' {
  const h = (header || {}) as Record<string, unknown>;
  const blob = [h.subtitle, h.second_subtitle, h.strapline, h.year]
    .map((x) => asText(x) || (typeof x === 'string' ? x : ''))
    .filter(Boolean)
    .join(' • ');
  if (/\bsingle\b/i.test(blob)) return 'Single';
  if (/\bEP\b/i.test(blob)) return 'EP';
  if (/\balbum\b/i.test(blob)) return 'Album';
  if (trackCount <= 1) return 'Single';
  if (trackCount <= 6) return 'EP';
  return 'Album';
}

function pageTypeOf(run: any): string {
  return (
    run?.endpoint?.payload?.browseEndpointContextSupportedConfigs
      ?.browseEndpointContextMusicConfig?.pageType ||
    run?.endpoint?.metadata?.page_type ||
    ''
  );
}

function artistsFromRuns(runs: any[] | undefined): { name: string; id?: string }[] {
  if (!Array.isArray(runs)) return [];
  const out: { name: string; id?: string }[] = [];
  for (const r of runs) {
    const name = String(r?.text || '')
      .replace(/^[&,•·]\s*/, '')
      .replace(/\s*[&,•·]\s*$/, '')
      .trim();
    if (isJunkArtistName(name)) continue;
    const browseId = r?.endpoint?.payload?.browseId as string | undefined;
    const pageType = pageTypeOf(r);
    const isArtist =
      Boolean(browseId?.startsWith('UC')) ||
      pageType.includes('ARTIST') ||
      (!pageType &&
        browseId &&
        !browseId.startsWith('MPREb_') &&
        !browseId.startsWith('VL') &&
        !browseId.startsWith('OLAK5'));
    if (browseId && isArtist) {
      out.push({ name, id: browseId });
    } else if (!browseId && name && !/^[•·&|,]+$/.test(name)) {
      if (!out.some((a) => a.name === name)) out.push({ name });
    }
  }
  return out;
}

/** Découpe un sous-titre « Album · Artiste · 2024 » (bullet YTM • ou ·). */
function splitSubtitleParts(text: string): string[] {
  if (!text) return [];
  return text
    .split(/\s*[•·|]\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function splitAuthorString(author: string, channelId?: string): { name: string; id?: string }[] {
  const parts = author
    .split(/\s*(?:&|,| feat\.? | ft\.? | featuring )\s*/i)
    .map((p) => p.trim())
    .filter((p) => p && !isJunkArtistName(p));
  return parts.map((name, i) => ({
    name,
    id: i === 0 ? channelId : undefined,
  }));
}

/** Artists depuis un header album / playlist Innertube (author, subtitle runs, byline…). */
export function artistsFromHeader(header: any): { name: string; id?: string }[] {
  if (!header) return [];

  const collected: { name: string; id?: string }[] = [];
  const push = (list: { name: string; id?: string }[]) => {
    for (const a of list) {
      if (!isPlausibleArtistName(a.name)) continue;
      if (!collected.some((x) => x.name === a.name && x.id === a.id)) collected.push(a);
    }
  };

  push(artistsFrom(header));

  if (header.author) {
    if (typeof header.author === 'string') {
      push(splitAuthorString(header.author, header.channel_id || header.author_id));
    } else if (header.author.name) {
      push(
        splitAuthorString(
          String(header.author.name),
          header.author.channel_id || header.author.id,
        ),
      );
    } else {
      push(artistsFromRuns(header.author?.runs));
    }
  }

  push(artistsFromRuns(header.subtitle?.runs));
  push(artistsFromRuns(header.second_subtitle?.runs));
  // MusicResponsiveHeader (albums récents) : artiste dans strapline_text_one
  push(artistsFromRuns(header.strapline_text_one?.runs));
  push(artistsFromRuns(header.strapline_text?.runs));
  push(artistsFromRuns(header.byline?.runs));
  // Ne PAS parser description : souvent un pavé Wikipedia collé comme « artistes »
  push(artistsFromRuns(header.strapline?.runs));

  // Menu / boutons « Accéder à l'artiste »
  const menuish = [
    ...(Array.isArray(header.menu?.items) ? header.menu.items : []),
    ...(Array.isArray(header.buttons) ? header.buttons : []),
    ...(Array.isArray(header.menu?.top_level_buttons) ? header.menu.top_level_buttons : []),
  ];
  for (const it of menuish) {
    const browseId =
      it?.endpoint?.payload?.browseId ||
      it?.navigationEndpoint?.browseEndpoint?.browseId ||
      it?.default_navigation_endpoint?.browseEndpoint?.browseId;
    const pageType =
      pageTypeOf(it) ||
      String(
        it?.endpoint?.payload?.browseEndpointContextSupportedConfigs
          ?.browseEndpointContextMusicConfig?.pageType || '',
      );
    const label = asText(it?.text) || asText(it?.title) || asText(it?.label);
    if (
      (String(browseId || '').startsWith('UC') || String(pageType).includes('ARTIST')) &&
      label &&
      isPlausibleArtistName(label) &&
      !/^(accéder|go to|view|voir)/i.test(label)
    ) {
      push([{ name: label, id: String(browseId) }]);
    }
  }

  // Sous-titre / strapline texte « Album • Artist • 2026 »
  const subCandidates = [
    asText(header.strapline_text_one),
    asText(header.strapline_text),
    asText(header.subtitle),
    asText(header.second_subtitle),
    asText(header.strapline),
  ].filter(Boolean);
  for (const subText of subCandidates) {
    for (const part of splitSubtitleParts(subText)) {
      if (isJunkArtistName(part)) continue;
      if (/^(album|ep|single|playlist)$/i.test(part)) continue;
      if (extractYear(part) === part) continue;
      push(splitAuthorString(part));
    }
  }

  // Préférer ceux avec id canal UC, puis id quelconque, puis noms utiles
  const plausible = collected.filter((a) => isPlausibleArtistName(a.name));
  const withUc = plausible.filter((a) => String(a.id || '').startsWith('UC'));
  if (withUc.length) {
    const names = new Set(withUc.map((a) => a.name.toLowerCase()));
    for (const a of plausible) {
      if (!a.id && a.name && !names.has(a.name.toLowerCase())) withUc.push(a);
    }
    return withUc;
  }
  const withIds = plausible.filter((a) => a.id);
  if (!withIds.length) return plausible;
  const names = new Set(withIds.map((a) => a.name.toLowerCase()));
  for (const a of plausible) {
    if (!a.id && a.name && !names.has(a.name.toLowerCase())) withIds.push(a);
  }
  return withIds;
}

export function artistsFrom(item: any): { name: string; id?: string }[] {
  if (Array.isArray(item?.artists) && item.artists.length) {
    return item.artists
      .map((a: any) => ({
        name: String(a.name || '').trim(),
        id: a.channel_id || a.id,
      }))
      .filter((a: { name: string }) => isPlausibleArtistName(a.name));
  }

  if (item?.author?.name) {
    return splitAuthorString(String(item.author.name), item.author.channel_id);
  }

  if (typeof item?.author === 'string' && item.author.trim()) {
    return splitAuthorString(item.author, item.channel_id);
  }

  if (Array.isArray(item?.authors) && item.authors.length) {
    return item.authors
      .map((a: any) => ({
        name: String(a.name || '').trim(),
        id: a.channel_id || a.id,
      }))
      .filter((a: { name: string }) => isPlausibleArtistName(a.name));
  }

  const flex = item?.flex_columns || [];
  for (let i = 1; i < flex.length; i++) {
    const fromRuns = artistsFromRuns(flex[i]?.title?.runs);
    const withIds = fromRuns.filter((a) => a.id);
    if (withIds.length) return withIds.filter((a) => isPlausibleArtistName(a.name));
  }
  for (let i = 1; i < flex.length; i++) {
    const fromRuns = artistsFromRuns(flex[i]?.title?.runs).filter(
      (a) => a.id || isPlausibleArtistName(a.name),
    );
    const cleaned = fromRuns.filter((a) => a.id || (a.name.length < 80 && !a.name.includes(' - ')));
    if (cleaned.some((a) => a.id)) return cleaned.filter((a) => a.id);
    if (cleaned.length && cleaned.every((a) => a.name.length < 60)) return cleaned;
  }

  for (let i = 1; i < flex.length; i++) {
    const text = asText(flex[i]?.title);
    const parts = splitSubtitleParts(text);
    if (parts.length < 2) continue;
    const start = /^(song|album|playlist|video|ep|single)$/i.test(parts[0] || '') ? 1 : 0;
    for (let j = start; j < parts.length; j++) {
      const chunk = parts[j];
      if (!chunk || !isPlausibleArtistName(chunk)) continue;
      if (/^\d/.test(chunk) || /views?/i.test(chunk) || extractYear(chunk) === chunk) continue;
      return splitAuthorString(chunk);
    }
  }

  // subtitle runs on two-row / album cards
  const fromSub = artistsFromRuns(item?.subtitle?.runs).filter((a) =>
    isPlausibleArtistName(a.name),
  );
  if (fromSub.length) return fromSub;

  return [];
}

function inferType(id: string, item: any): Track['type'] {
  const explicit = item.item_type;
  const mvt = musicVideoTypeOf(item);
  // ATV = audio track YouTube Music → toujours un titre, pas une « vidéo »
  if (mvt.includes('ATV') && /^[a-zA-Z0-9_-]{11}$/.test(id)) return 'song';
  if (
    explicit === 'song' ||
    explicit === 'video' ||
    explicit === 'album' ||
    explicit === 'playlist' ||
    explicit === 'artist'
  ) {
    // Clip officiel : on garde type video mais le titre est nettoyé à l’affichage
    if (explicit === 'video' && mvt.includes('ATV')) return 'song';
    return explicit;
  }

  const pageType =
    item.endpoint?.payload?.browseEndpointContextSupportedConfigs
      ?.browseEndpointContextMusicConfig?.pageType || '';

  if (pageType.includes('ARTIST') || id.startsWith('UC')) return 'artist';
  if (pageType.includes('ALBUM') || id.startsWith('MPREb_') || id.startsWith('OLAK5')) return 'album';
  if (pageType.includes('PLAYLIST') || id.startsWith('PL') || id.startsWith('VL') || id.startsWith('RD'))
    return 'playlist';
  // Tuiles Moods & genres / Charts (browse FE…) — pas des titres jouables
  if (id.startsWith('mood:') || id.startsWith('FE') || id.includes('moods_and_genres')) return 'playlist';
  if (/^[a-zA-Z0-9_-]{11}$/.test(id)) {
    if (mvt.includes('OMV') || mvt.includes('UGC')) return 'video';
    return 'song';
  }
  return 'unknown';
}

/** Tuiles colorées Explore « Chill / Focus / … » (MusicNavigationButton). */
export function mapNavigationButton(item: any): Track | null {
  if (!item) return null;
  const isNav =
    item.type === 'MusicNavigationButton' ||
    (typeof item.button_text === 'string' && item.endpoint?.payload?.browseId);
  if (!isNav) return null;

  const browseId = String(item.endpoint?.payload?.browseId || '').trim();
  const params = String(item.endpoint?.payload?.params || '').trim();
  const title =
    asText(item.button_text) || asText(item.text) || asText(item.title) || 'Sans titre';
  if (!browseId && !params) return null;

  // Même browseId pour toutes les catégories — l’unicité est dans `params`
  const id = params
    ? `mood:${params}`
    : browseId.startsWith('FE')
      ? `mood:${browseId}`
      : browseId;

  return {
    id,
    title,
    artists: [],
    album: browseId ? { name: title, id: browseId } : undefined,
    thumbnails: [],
    type: 'playlist',
  };
}

export function mapListItem(item: any, fallbackThumbs?: Thumb[]): Track | null {
  if (!item || item.type === 'Message') return null;

  const id =
    item.id ||
    item.endpoint?.payload?.videoId ||
    item.overlay?.content?.endpoint?.payload?.videoId ||
    item.overlay?.endpoint?.payload?.videoId ||
    item.menu?.top_level_buttons?.[0]?.endpoint?.payload?.videoId ||
    item.endpoint?.payload?.browseId ||
    item.endpoint?.payload?.playlistId;

  if (!id) return null;

  let title =
    cleanMusicTitle(asText(item.title) || asText(item.name) || '') ||
    cleanMusicTitle(asText(item.flex_columns?.[0]?.title) || '') ||
    cleanMusicTitle(asText(item.flex_columns?.[0]?.title?.runs) || '') ||
    cleanMusicTitle(asText(item.overlay?.content?.accessibility?.accessibility_data?.label) || '');
  // Accessibilité type « Play SongName by Artist » → tenter d’extraire le titre
  if (!title) {
    const label = asText(item.overlay?.content?.accessibility?.accessibility_data?.label) ||
      asText(item.accessibility?.accessibility_data?.label);
    const m = String(label).match(/^(?:play|écouter|lecture)\s+(.+?)(?:\s+by\s+|\s+de\s+)/i);
    if (m?.[1]) title = cleanMusicTitle(m[1]);
  }
  if (!title && item.item_type === 'artist') {
    title = 'Artiste';
  }
  // Ne pas figer « Sans titre » : titre vide → hydrateTracks/getTrack corrigera
  if (!title) title = '';

  const durationTextRaw =
    asText(item.duration?.text) ||
    asText(item.duration) ||
    asText(item.lengthText) ||
    asText(item.length_text) ||
    asText(item.length?.text) ||
    asText(item.thumbnail_overlays?.find?.((o: any) => o?.text)?.text) ||
    '';
  // Cherche mm:ss / h:mm:ss dans overlays / labels
  let parsedFromLabel: string | undefined;
  if (!durationTextRaw) {
    const blob = [
      asText(item.overlay?.content?.accessibility?.accessibility_data?.label),
      asText(item.accessibility?.accessibility_data?.label),
      ...(Array.isArray(item.thumbnail_overlays)
        ? item.thumbnail_overlays.map((o: any) => asText(o?.text) || asText(o))
        : []),
      ...(Array.isArray(item.flex_columns)
        ? item.flex_columns.map((c: any) => asText(c?.title) || asText(c?.subtitle))
        : []),
    ]
      .filter(Boolean)
      .join(' · ');
    const m = blob.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
    if (m) parsedFromLabel = m[1];
  }
  const durationSecondsRaw =
    typeof item.duration?.seconds === 'number'
      ? item.duration.seconds
      : typeof item.length_seconds === 'number'
        ? item.length_seconds
        : typeof item.lengthSeconds === 'number'
          ? item.lengthSeconds
          : undefined;
  let duration = durationTextRaw || parsedFromLabel || undefined;
  let durationSeconds =
    typeof durationSecondsRaw === 'number' && durationSecondsRaw > 0
      ? Math.floor(durationSecondsRaw)
      : undefined;
  if (typeof durationSeconds === 'number') {
    duration = formatDurationClock(durationSeconds);
  } else if (duration) {
    duration = normalizeDurationText(duration);
    // Remplir durationSeconds depuis le texte normalisé
    const parts = String(duration)
      .split(':')
      .map((p) => Number(p));
    if (parts.length === 2 && parts.every((n) => Number.isFinite(n))) {
      durationSeconds = parts[0] * 60 + parts[1];
    } else if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
      durationSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
  }
  const type = inferType(String(id), item);

  let artists = artistsFrom(item);
  if (type === 'artist' && !artists.length) {
    artists = [{ name: title, id: String(id) }];
  }
  // Chaîne YT @handle / Profile présentée comme artiste (ex. « Welcome to the internet »)
  if (type === 'artist' && itemHasYoutubeHandleBadge(item)) {
    return null;
  }
  if (
    type === 'artist' &&
    !isPlausibleArtistEntity({ type, title, id: String(id), artists })
  ) {
    return null;
  }
  if (title && title !== 'Sans titre' && title !== 'Artiste') {
    title = stripRedundantArtistSuffix(title, artists) || title;
  }

  let thumbnails = extractThumbs(item);
  if (!thumbnails.length && fallbackThumbs?.length) thumbnails = fallbackThumbs;

  // Toujours injecter ytimg pour les vidéos (ggpht 60/120 souvent flaky / trop petit pour les mix)
  if (/^[a-zA-Z0-9_-]{11}$/.test(String(id))) {
    const ytimg: Thumb[] = [
      { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 480, height: 360 },
      { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, width: 320, height: 180 },
    ];
    const seen = new Set(thumbnails.map((t) => t.url));
    for (const t of ytimg) {
      if (!seen.has(t.url)) {
        thumbnails = [...thumbnails, t];
        seen.add(t.url);
      }
    }
  }

  return {
    id: String(id),
    title,
    artists,
    album: item.album
      ? { name: String(item.album.name), id: item.album.id }
      : undefined,
    duration,
    durationSeconds,
    thumbnails,
    type,
  };
}

export function mapTwoRowItem(item: any, fallbackThumbs?: Thumb[]): Track | null {
  if (!item) return null;
  const id =
    item.id ||
    item.endpoint?.payload?.browseId ||
    item.endpoint?.payload?.videoId ||
    item.endpoint?.payload?.playlistId ||
    item.navigationEndpoint?.browseEndpoint?.browseId ||
    item.navigationEndpoint?.watchEndpoint?.videoId ||
    item.endpoint?.browseEndpoint?.browseId ||
    item.endpoint?.watchEndpoint?.videoId;
  if (!id) return null;

  const title =
    cleanMusicTitle(
      asText(item.title) ||
        asText(item.title?.runs) ||
        (Array.isArray(item.title?.runs)
          ? item.title.runs.map((r: any) => r.text || '').join('')
          : '') ||
        asText(item.name) ||
        '',
    ) || '';
  // Normalise endpoint pour inferType
  if (!item.endpoint?.payload && (item.navigationEndpoint || item.endpoint?.browseEndpoint)) {
    const ne = item.navigationEndpoint || item.endpoint;
    item = {
      ...item,
      endpoint: {
        payload: {
          browseId: ne.browseEndpoint?.browseId || ne.payload?.browseId,
          videoId: ne.watchEndpoint?.videoId || ne.payload?.videoId,
          playlistId: ne.watchEndpoint?.playlistId || ne.payload?.playlistId,
          browseEndpointContextSupportedConfigs:
            ne.browseEndpoint?.browseEndpointContextSupportedConfigs ||
            ne.payload?.browseEndpointContextSupportedConfigs,
          watchEndpointMusicSupportedConfigs:
            ne.watchEndpoint?.watchEndpointMusicSupportedConfigs ||
            ne.payload?.watchEndpointMusicSupportedConfigs,
        },
      },
    };
  }
  const type = inferType(String(id), item);
  let artists = artistsFrom(item);
  if (type === 'artist' && !artists.length) {
    artists = [{ name: title, id: String(id) }];
  }
  if (type === 'artist' && itemHasYoutubeHandleBadge(item)) {
    return null;
  }
  if (
    type === 'artist' &&
    !isPlausibleArtistEntity({ type, title, id: String(id), artists })
  ) {
    return null;
  }
  const finalTitle =
    title !== 'Sans titre' ? stripRedundantArtistSuffix(title, artists) || title : title;

  let thumbnails = extractThumbs(item);
  if (!thumbnails.length && fallbackThumbs?.length) thumbnails = fallbackThumbs;
  if (!thumbnails.length && /^[a-zA-Z0-9_-]{11}$/.test(String(id))) {
    thumbnails = [
      { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 1280, height: 720 },
      { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 480, height: 360 },
    ];
  }

  return {
    id: String(id),
    title: finalTitle,
    artists,
    thumbnails,
    type,
    duration: item.duration?.text,
  };
}

export function mapAny(item: any, fallbackThumbs?: Thumb[]): Track | null {
  if (!item) return null;
  if (item.type === 'MusicCardShelf') {
    const nested = item.contents?.[0] || item.header;
    return mapAny(nested, fallbackThumbs);
  }
  if (item.type === 'ItemSection') {
    const nested = item.contents?.[0];
    return mapAny(nested, fallbackThumbs);
  }
  const nav = mapNavigationButton(item);
  if (nav) return nav;
  if (item.type === 'MusicResponsiveListItem' || item.flex_columns) {
    return mapListItem(item, fallbackThumbs);
  }
  if (item.type === 'MusicTwoRowItem') return mapTwoRowItem(item, fallbackThumbs);
  return mapListItem(item, fallbackThumbs) || mapTwoRowItem(item, fallbackThumbs);
}

export function parseAuthorField(author: string, channelId?: string) {
  return splitAuthorString(author, channelId);
}

export function bestThumb(track: Track, size = 544): string {
  return bestThumbUrl(track.thumbnails || [], size);
}
