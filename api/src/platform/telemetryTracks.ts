/**
 * Extraction + résolution légère des trackId YouTube pour les mails télémétrie.
 * oembed d’abord (rapide, pas d’Innertube) — getTrack light en secours.
 */
import { appUrl } from './mail.js';

export type ResolvedTrack = {
  id: string;
  title: string;
  artist?: string;
  watchUrl: string;
  ytUrl: string;
  streamUrl: string;
  source: 'meta' | 'oembed' | 'getTrack' | 'id-only';
};

const ID_RE = /\b([a-zA-Z0-9_-]{11})\b/g;
/** IDs trop génériques / non-vidéo courants dans les logs. */
const ID_BLOCK = new Set([
  'undefined',
  'null',
  'true',
  'false',
  'Content-Typ',
  'application',
  'Authorization',
]);

export function extractTrackIds(...blobs: Array<string | undefined | null>): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | undefined | null) => {
    if (!id || seen.has(id) || ID_BLOCK.has(id)) return;
    if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) return;
    if (!/[a-zA-Z]/.test(id)) return;
    if (/^[a-z]{11}$/.test(id) || /^[A-Z]{11}$/.test(id) || /^[A-Z_]+$/.test(id)) return;
    seen.add(id);
    found.push(id);
  };
  for (const blob of blobs) {
    if (!blob) continue;
    // Patterns explicites stream / tag serveur
    for (const re of [
      /\[stream\s+([a-zA-Z0-9_-]{11})\]/gi,
      /\/api\/stream\/([a-zA-Z0-9_-]{11})\b/gi,
      /\btrackId[=:]\s*([a-zA-Z0-9_-]{11})\b/gi,
      /\bid=([a-zA-Z0-9_-]{11})\b/gi,
    ]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(blob))) {
        push(m[1]);
        if (found.length >= 12) return found;
      }
    }
    ID_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ID_RE.exec(blob))) {
      push(m[1]);
      if (found.length >= 12) return found;
    }
  }
  return found;
}

function trackIdsFromMeta(meta: unknown): string[] {
  if (!meta || typeof meta !== 'object') return [];
  const m = meta as Record<string, unknown>;
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(v)) out.push(v);
  };
  push(m.trackId);
  push(m.id);
  if (Array.isArray(m.trackIds)) m.trackIds.forEach(push);
  if (Array.isArray(m.failedIds)) m.failedIds.forEach(push);
  return out;
}

async function resolveOembed(id: string): Promise<{ title?: string; artist?: string } | null> {
  try {
    const oembed = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${id}`,
    )}&format=json`;
    const r = await fetch(oembed, {
      signal: AbortSignal.timeout(5_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PLM/1.0)' },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { title?: string; author_name?: string };
    const title = String(j.title || '').trim();
    let artist = String(j.author_name || '').trim().replace(/\s*-\s*Topic\s*$/i, '');
    if (!title) return null;
    return { title, artist: artist || undefined };
  } catch {
    return null;
  }
}

async function resolveGetTrack(id: string): Promise<{ title?: string; artist?: string } | null> {
  try {
    const { getTrack } = await import('../youtube/yt.js');
    const { track } = await getTrack(id, { light: true });
    const title = String(track?.title || '').trim();
    const artist =
      track?.artists?.map((a: { name?: string }) => a?.name).filter(Boolean).join(', ') ||
      undefined;
    if (!title || title === 'Sans titre') return null;
    return { title, artist };
  } catch {
    return null;
  }
}

function baseUrls(id: string) {
  const origin = appUrl();
  return {
    watchUrl: `${origin}/watch/${id}`,
    ytUrl: `https://music.youtube.com/watch?v=${id}`,
    streamUrl: `${origin}/api/stream/${id}`,
  };
}

/**
 * Résout jusqu’à `limit` IDs (priorité : meta.trackId, puis message, breadcrumbs, logs).
 */
export async function resolveTracksForTelemetry(opts: {
  meta?: unknown;
  message?: string;
  stack?: string;
  breadcrumbs?: string;
  logs?: string;
  limit?: number;
}): Promise<ResolvedTrack[]> {
  const limit = opts.limit ?? 6;
  const preferred = trackIdsFromMeta(opts.meta);
  const rest = extractTrackIds(opts.message, opts.stack, opts.breadcrumbs, opts.logs);
  const ordered = [...preferred, ...rest.filter((id) => !preferred.includes(id))].slice(0, limit);

  const out: ResolvedTrack[] = [];
  for (const id of ordered) {
    const urls = baseUrls(id);
    const fromMetaTitle = (() => {
      const m = opts.meta && typeof opts.meta === 'object' ? (opts.meta as Record<string, unknown>) : null;
      if (!m || String(m.trackId || m.id || '') !== id) return null;
      const title = typeof m.title === 'string' ? m.title.trim() : '';
      const artist =
        typeof m.artist === 'string'
          ? m.artist.trim()
          : typeof m.artists === 'string'
            ? m.artists.trim()
            : '';
      if (title) return { title, artist: artist || undefined };
      return null;
    })();

    if (fromMetaTitle) {
      out.push({ id, ...fromMetaTitle, ...urls, source: 'meta' });
      continue;
    }

    const oem = await resolveOembed(id);
    if (oem?.title) {
      out.push({ id, title: oem.title, artist: oem.artist, ...urls, source: 'oembed' });
      continue;
    }

    const gt = await resolveGetTrack(id);
    if (gt?.title) {
      out.push({ id, title: gt.title, artist: gt.artist, ...urls, source: 'getTrack' });
      continue;
    }

    out.push({
      id,
      title: `(titre inconnu)`,
      ...urls,
      source: 'id-only',
    });
  }
  return out;
}

export function formatTracksText(tracks: ResolvedTrack[]): string {
  if (!tracks.length) return '(aucun trackId détecté)';
  return tracks
    .map((t, i) => {
      const who = t.artist ? ` — ${t.artist}` : '';
      return [
        `${i + 1}. ${t.title}${who}`,
        `   id=${t.id}`,
        `   PLM : ${t.watchUrl}`,
        `   YTM : ${t.ytUrl}`,
        `   stream : ${t.streamUrl}`,
      ].join('\n');
    })
    .join('\n\n');
}

export function formatTracksHtml(tracks: ResolvedTrack[]): string {
  if (!tracks.length) {
    return '<p style="color:#666">(aucun trackId détecté)</p>';
  }
  const items = tracks
    .map((t) => {
      const who = t.artist ? ` <span style="color:#666">— ${esc(t.artist)}</span>` : '';
      return `<li style="margin:0 0 12px">
  <strong>${esc(t.title)}</strong>${who}<br/>
  <code style="font-size:12px">${esc(t.id)}</code><br/>
  <a href="${esc(t.watchUrl)}">Ouvrir dans PLM</a>
  · <a href="${esc(t.ytUrl)}">YouTube Music</a>
  · <a href="${esc(t.streamUrl)}">/api/stream</a>
</li>`;
    })
    .join('\n');
  return `<ol style="padding-left:1.2em;margin:0">${items}</ol>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Remplace les placeholders & IDs bruts dans le texte de diag par des libellés. */
export function enrichDiagnosisWithTracks(
  diagText: string,
  tracks: ResolvedTrack[],
): string {
  let out = diagText;
  for (const t of tracks) {
    const label = t.artist ? `${t.title} — ${t.artist}` : t.title;
    out = out.split(t.id).join(`${t.id} (« ${label} »)`);
  }
  if (tracks[0]) {
    out = out.replace(
      /\/api\/stream\/<trackId>/g,
      `/api/stream/${tracks[0].id}`,
    );
    out = out.replace(
      /curl -I « https:\/\/ytmusic\.delhomme\.ovh\/api\/stream\/<trackId> »/g,
      `curl -I « ${tracks[0].streamUrl} » (Range bytes=0-1)`,
    );
  }
  return out;
}

/** Nettoie les recent logs : garde lignes utiles, drop bruit système. */
export function tidyRecentLogs(raw: string, maxChars = 5_000): string {
  if (!raw?.trim()) return '(aucun)';
  const noise =
    /BufferQueue|SurfaceFlinger|Choreographer|OpenGLRenderer|eglCodec|RenderThread|TrafficStats|StrictMode|GoogleInputMethod|WindowManager|ActivityManager|chatty|taoqiong_wifi/i;
  const keep =
    /YtMusic|Playback|player|offline|stream|Exo|OkHttp|telemetry|FATAL|Exception|←--|→ |http=|crumb|boot:|NetworkMonitor|api\/stream|502|503|504|401|DNS|resolve host/i;
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const filtered = lines.filter((ln) => {
    if (!ln.trim()) return false;
    if (noise.test(ln) && !keep.test(ln)) return false;
    return keep.test(ln) || /\s[EFW]\//.test(ln);
  });
  const body = (filtered.length ? filtered : lines.slice(-80)).join('\n');
  if (body.length <= maxChars) return body;
  return '…[début tronqué]\n' + body.slice(-maxChars);
}

/** Breadcrumbs : une ligne claire par événement. */
export function tidyBreadcrumbs(raw: string, max = 40): string {
  if (!raw?.trim()) return '(aucun)';
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-max);
  return lines
    .map((l) => {
      // "2026-08-23 13:31:55.588 · play · o4rpy5gaUJw idx=1 n=15"
      const m = l.match(
        /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*[·•\-]\s*(\w+)\s*[·•\-]?\s*(.*)$/,
      );
      if (!m) return `• ${l}`;
      const [, ts, kind, rest] = m;
      return `• ${ts}  ${kind}${rest ? `  ${rest}` : ''}`;
    })
    .join('\n');
}

/** Stack : garde l’exception + ~12 frames utiles. */
export function tidyStack(raw: string, maxFrames = 14): string {
  if (!raw?.trim()) return '(aucune stack)';
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let frames = 0;
  for (const ln of lines) {
    if (/^\s*at\s+/.test(ln)) {
      if (/androidx\.|java\.|kotlin\.|okhttp|dalvik|libcore|sun\.|jdk\./i.test(ln) && frames > 4) {
        continue;
      }
      if (frames >= maxFrames) continue;
      frames++;
      out.push(ln.replace(/\s+/g, ' ').trim());
    } else if (ln.trim()) {
      out.push(ln.trim());
    }
  }
  if (frames >= maxFrames) out.push('  … [frames tronquées]');
  return out.join('\n');
}
