/**
 * Balayage de jouabilité des titres de bibliothèque (tous les comptes).
 *
 * Vérifie qu’un videoId YouTube Music résout un vrai flux audio (pas 403/HTML/vide),
 * que la durée colle, et qu’on peut lire près de la fin. Si KO : recherche Innertube
 * **songs only**, sonde les candidats, upsert l’id canonique, alias l’ancien.
 *
 * Légal : YouTube Music / Innertube uniquement. Pas un dump YouTube, pas de torrent.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, getTrackPayload, upsertTrack, findUserByEmail } from './db.js';
import { upsertIndexedTrack } from './searchIndex.js';
import type { Track } from '../youtube/types.js';
import { artistLine, fingerprint, normalize, scoreCandidate } from '../media/trackMatch.js';
import {
  ensureTrackReplacementSchema,
  getReplacementId,
  recordReplacement,
} from '../media/trackReplacement.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', '..', 'data');
const DEFAULT_PATH = join(DATA_DIR, 'playability.db');
const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;

const STALE_MS = Number(process.env.PLAYABILITY_STALE_MS || 24 * 3600_000);
const INTERVAL_MS = Number(process.env.PLAYABILITY_SWEEP_INTERVAL_MS || 6 * 3600_000);
const START_DELAY_MS = Number(process.env.PLAYABILITY_SWEEP_START_DELAY_MS || 180_000);
const DEFAULT_BATCH = Number(process.env.PLAYABILITY_SWEEP_BATCH || 40);
const DEFAULT_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.PLAYABILITY_CONCURRENCY || 2)));
const SLEEP_MS = Number(process.env.PLAYABILITY_SLEEP_MS || 750);
const PROBE_TIMEOUT_MS = Number(process.env.PLAYABILITY_PROBE_MS || 10_000);
const DURATION_TOLERANCE = 0.18;
const MIN_AUDIO_BYTES = 64;
const ON_DEMAND_DEBOUNCE_MS = 60_000;
const MIN_MATCH_SCORE = 70;

export type PlayabilityStatus = 'ok' | 'fail' | 'replaced';

export type PlayabilityRow = {
  videoId: string;
  status: PlayabilityStatus;
  replacementVideoId: string | null;
  lastChecked: number;
  error: string | null;
  durationMs: number | null;
};

export type LibrarySweepItem = {
  videoId: string;
  title: string;
  artist: string;
  durationMs?: number | null;
  userId?: string;
};

export type StreamResolve = {
  url: string;
  durationMs?: number | null;
};

export type ProbeResult = {
  ok: boolean;
  error?: string;
  durationMs?: number | null;
  bytes?: number;
};

export type SongCandidate = {
  id: string;
  title: string;
  artist: string;
  type: string;
  durationSeconds?: number | null;
  isMusic?: boolean;
};

export type SweepDeps = {
  resolveStream: (videoId: string) => Promise<StreamResolve | null>;
  probeAudio: (url: string, expectedDurationMs?: number | null) => Promise<ProbeResult>;
  searchSongs: (title: string, artist: string) => Promise<SongCandidate[]>;
  listTracks: (opts?: { userId?: string; ids?: string[]; limit?: number }) => Promise<LibrarySweepItem[]>;
  persistReplacement?: (deadId: string, newId: string, title: string, artist: string, score: number) => void;
  remapLibrary?: (oldId: string, newId: string) => void;
  upsertFts?: (track: Track) => void;
  sleep?: (ms: number) => Promise<void>;
};

export type SweepOptions = {
  userId?: string;
  userEmail?: string;
  ids?: string[];
  limit?: number;
  concurrency?: number;
  sleepMs?: number;
  recover?: boolean;
  collapseDuplicates?: boolean;
  dryRun?: boolean;
};

export type TrackSweepResult = {
  videoId: string;
  status: PlayabilityStatus;
  replacementVideoId?: string | null;
  error?: string | null;
  durationMs?: number | null;
  recovered?: boolean;
};

export type SweepSummary = {
  checked: number;
  ok: number;
  fail: number;
  replaced: number;
  collapsed: number;
  skipped: number;
  results: TrackSweepResult[];
};

const NON_MUSIC_RE =
  /\b(podcast|episode|audiobook|interview|gameplay|trailer|tutorial|asmr|vlog|stand[\s-]?up|documentary|explained|full movie|walkthrough|reaction|livestream|live stream)\b/i;

let pdb: Database.Database | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepRunning = false;
const onDemandAt = new Map<string, number>();

function dbPath() {
  return process.env.PLAYABILITY_DB_PATH || DEFAULT_PATH;
}

export function openPlayabilityDb(): Database.Database {
  if (pdb) return pdb;
  const p = dbPath();
  if (p !== ':memory:' && !existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  pdb = new Database(p);
  pdb.pragma('journal_mode = WAL');
  pdb.exec(`
    CREATE TABLE IF NOT EXISTS playability (
      videoId TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      replacementVideoId TEXT,
      lastChecked INTEGER NOT NULL,
      error TEXT,
      durationMs INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_playability_checked ON playability(lastChecked);
    CREATE INDEX IF NOT EXISTS idx_playability_status ON playability(status);
  `);
  return pdb;
}

export function closePlayabilityDb(): void {
  try {
    pdb?.close();
  } catch {
    /* ignore */
  }
  pdb = null;
}

export function getPlayability(videoId: string): PlayabilityRow | null {
  if (!VIDEO_ID.test(videoId)) return null;
  try {
    const row = openPlayabilityDb()
      .prepare(
        `SELECT videoId, status, replacementVideoId, lastChecked, error, durationMs
         FROM playability WHERE videoId = ?`,
      )
      .get(videoId) as PlayabilityRow | undefined;
    return row || null;
  } catch {
    return null;
  }
}

export function canonicalVideoId(videoId: string): string {
  const row = getPlayability(videoId);
  if (row?.status === 'replaced' && row.replacementVideoId && VIDEO_ID.test(row.replacementVideoId)) {
    return row.replacementVideoId;
  }
  const hop = getReplacementId(videoId);
  return hop && VIDEO_ID.test(hop) ? hop : videoId;
}

export function isPlayableId(videoId: string): boolean {
  const row = getPlayability(videoId);
  if (!row) return true;
  if (row.status === 'ok') return true;
  if (row.status === 'replaced' && row.replacementVideoId) return true;
  return false;
}

export function annotateTrackPlayability<T extends Track>(t: T): T {
  const canon = canonicalVideoId(t.id);
  const playable = isPlayableId(t.id);
  return {
    ...t,
    id: playable && canon !== t.id ? canon : t.id,
    playable,
    canonicalId: canon,
  };
}

/** Liste biblio : un id canonique, les morts restent visibles pour « réparer ». */
export function presentLibraryTracks<T extends Track>(tracks: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const raw of tracks) {
    const t = annotateTrackPlayability(raw);
    if (t.playable === false) {
      out.push(t);
      continue;
    }
    const key = t.canonicalId || t.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export function savePlayability(row: PlayabilityRow): void {
  openPlayabilityDb()
    .prepare(
      `INSERT INTO playability (videoId, status, replacementVideoId, lastChecked, error, durationMs)
       VALUES (@videoId, @status, @replacementVideoId, @lastChecked, @error, @durationMs)
       ON CONFLICT(videoId) DO UPDATE SET
         status = excluded.status,
         replacementVideoId = excluded.replacementVideoId,
         lastChecked = excluded.lastChecked,
         error = excluded.error,
         durationMs = excluded.durationMs`,
    )
    .run({
      videoId: row.videoId,
      status: row.status,
      replacementVideoId: row.replacementVideoId,
      lastChecked: row.lastChecked,
      error: row.error,
      durationMs: row.durationMs,
    });
}

export function isMusicCandidate(c: Pick<SongCandidate, 'type' | 'title' | 'isMusic'>): boolean {
  if (c.isMusic === false) return false;
  const type = String(c.type || 'song').toLowerCase();
  if (type && type !== 'song' && type !== 'unknown') return false;
  if (NON_MUSIC_RE.test(c.title || '')) return false;
  return true;
}

export function durationClose(actualMs: number | null | undefined, expectedMs: number | null | undefined): boolean {
  if (!actualMs || actualMs <= 0 || !expectedMs || expectedMs <= 0) return true;
  const delta = Math.abs(actualMs - expectedMs) / expectedMs;
  return delta <= DURATION_TOLERANCE || Math.abs(actualMs - expectedMs) <= 8_000;
}

export function looksLikeHtml(buf: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(buf.slice(0, 96)).trim().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.includes('<head');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function abortAfter(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms).unref?.();
  return c.signal;
}

function parseDurFromUrl(url: string): number | null {
  try {
    const u = new URL(url);
    const dur = u.searchParams.get('dur');
    if (dur) {
      const s = Number(dur);
      if (s > 1 && s < 86_400) return Math.round(s * 1000);
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function defaultProbeAudio(
  url: string,
  expectedDurationMs?: number | null,
): Promise<ProbeResult> {
  if (!url || /^data:|^file:/.test(url)) return { ok: false, error: 'url-invalide' };
  const signal = abortAfter(PROBE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-2047', Accept: 'audio/*,video/mp4,*/*' },
      redirect: 'follow',
      signal,
    });
  } catch (err) {
    const msg = String((err as Error).message || err);
    if (/abort/i.test(msg)) return { ok: false, error: 'probe-timeout' };
    return { ok: false, error: `probe-net:${msg.slice(0, 80)}` };
  }
  if (res.status === 403 || res.status === 401) {
    return { ok: false, error: `http-${res.status}` };
  }
  if (res.status === 404 || res.status === 410) {
    return { ok: false, error: `http-${res.status}` };
  }
  if (res.status !== 200 && res.status !== 206) {
    return { ok: false, error: `http-${res.status}` };
  }
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (/text\/html|application\/json|text\/plain/.test(ct) && !/audio|mp4|octet-stream/.test(ct)) {
    return { ok: false, error: `content-type:${ct.slice(0, 40)}` };
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < MIN_AUDIO_BYTES) return { ok: false, error: 'empty-body' };
  if (looksLikeHtml(buf)) return { ok: false, error: 'html-body' };

  const range = res.headers.get('content-range') || '';
  const totalMatch = /\/(\d+)\s*$/.exec(range);
  const total = totalMatch ? Number(totalMatch[1]) : Number(res.headers.get('content-length') || 0);
  const urlDur = parseDurFromUrl(url);
  const durationMs = urlDur || expectedDurationMs || null;
  if (!durationClose(durationMs, expectedDurationMs)) {
    return { ok: false, error: 'duration-mismatch', durationMs, bytes: buf.length };
  }

  if (total > 8192) {
    const from = Math.max(0, total - 2048);
    try {
      const end = await fetch(url, {
        method: 'GET',
        headers: { Range: `bytes=${from}-${total - 1}` },
        redirect: 'follow',
        signal: abortAfter(PROBE_TIMEOUT_MS),
      });
      if (end.status === 403 || end.status === 401) {
        return { ok: false, error: `end-http-${end.status}`, durationMs, bytes: total };
      }
      if (end.status !== 200 && end.status !== 206) {
        return { ok: false, error: `end-http-${end.status}`, durationMs, bytes: total };
      }
      const endBuf = new Uint8Array(await end.arrayBuffer());
      if (endBuf.length < 16) return { ok: false, error: 'end-empty', durationMs, bytes: total };
      if (looksLikeHtml(endBuf)) return { ok: false, error: 'end-html', durationMs, bytes: total };
    } catch (err) {
      return { ok: false, error: `end-net:${String((err as Error).message || err).slice(0, 60)}`, durationMs };
    }
  }
  return { ok: true, durationMs, bytes: total || buf.length };
}

async function defaultResolveStream(videoId: string): Promise<StreamResolve | null> {
  const { getAudioFormat } = await import('../youtube/yt.js');
  try {
    const fmt = await Promise.race([
      getAudioFormat(videoId, { live: true }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('resolve-timeout')), 20_000)),
    ]);
    if (!fmt?.url) return null;
    return { url: fmt.url, durationMs: parseDurFromUrl(fmt.url) };
  } catch {
    return null;
  }
}

async function defaultSearchSongs(title: string, artist: string): Promise<SongCandidate[]> {
  const { search } = await import('../youtube/yt.js');
  const q = `${title} ${artist}`.trim();
  if (!q) return [];
  const buckets = await search(q, 'song');
  const pool = [...(buckets.songs || []), ...(buckets.topResult ? [buckets.topResult as Track] : [])];
  const out: SongCandidate[] = [];
  const seen = new Set<string>();
  for (const t of pool) {
    if (!t?.id || !VIDEO_ID.test(t.id) || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push({
      id: t.id,
      title: t.title || '',
      artist: artistLine(t),
      type: t.type || 'song',
      durationSeconds: t.durationSeconds ?? null,
      isMusic: t.type === 'song' || t.type === 'unknown' || !t.type,
    });
  }
  return out;
}

function libraryItemFromId(id: string): LibrarySweepItem | null {
  if (!VIDEO_ID.test(id)) return null;
  const t = getTrackPayload(id);
  return {
    videoId: id,
    title: t?.title || id,
    artist: t ? artistLine(t) : '',
    durationMs: t?.durationSeconds ? t.durationSeconds * 1000 : null,
  };
}

function defaultListTracks(opts?: { userId?: string; ids?: string[]; limit?: number }): LibrarySweepItem[] {
  const limit = Math.max(1, Math.min(500, opts?.limit || DEFAULT_BATCH));
  if (opts?.ids?.length) {
    return opts.ids.map((id) => libraryItemFromId(id)).filter(Boolean) as LibrarySweepItem[];
  }
  const cap = Math.max(limit * 8, 200);
  const rows = (
    opts?.userId
      ? (db
          .prepare(
            `SELECT track_id AS id, MAX(created_at) AS created_at FROM (
               SELECT track_id, user_id, created_at FROM library_tracks
               UNION ALL
               SELECT track_id, user_id, created_at FROM liked_tracks
             ) WHERE user_id = ?
             GROUP BY track_id
             ORDER BY created_at DESC
             LIMIT ?`,
          )
          .all(opts.userId, cap) as { id: string }[])
      : (db
          .prepare(
            `SELECT track_id AS id, MAX(created_at) AS created_at FROM (
               SELECT track_id, user_id, created_at FROM library_tracks
               UNION ALL
               SELECT track_id, user_id, created_at FROM liked_tracks
             )
             GROUP BY track_id
             ORDER BY created_at DESC
             LIMIT ?`,
          )
          .all(cap) as { id: string }[])
  );
  const staleCut = Date.now() - STALE_MS;
  const due: LibrarySweepItem[] = [];
  for (const r of rows) {
    const item = libraryItemFromId(r.id);
    if (!item) continue;
    const row = getPlayability(item.videoId);
    if (!row || row.lastChecked < staleCut || row.status === 'fail') {
      due.push(item);
    }
    if (due.length >= limit) break;
  }
  return due;
}

export function remapLibraryTrackId(oldId: string, newId: string): void {
  if (!VIDEO_ID.test(oldId) || !VIDEO_ID.test(newId) || oldId === newId) return;
  const now = Date.now();
  try {
    db.prepare(
      `INSERT OR IGNORE INTO library_tracks (user_id, track_id, created_at, manual)
       SELECT user_id, ?, created_at, manual FROM library_tracks WHERE track_id = ?`,
    ).run(newId, oldId);
    db.prepare(`DELETE FROM library_tracks WHERE track_id = ?`).run(oldId);
  } catch {
    /* pg / déjà mappé */
  }
  try {
    db.prepare(
      `INSERT OR IGNORE INTO liked_tracks (user_id, track_id, created_at)
       SELECT user_id, ?, created_at FROM liked_tracks WHERE track_id = ?`,
    ).run(newId, oldId);
    db.prepare(`DELETE FROM liked_tracks WHERE track_id = ?`).run(oldId);
  } catch {
    /* ignore */
  }
  try {
    db.prepare(
      `INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position, added_at)
       SELECT playlist_id, ?, position, added_at FROM playlist_tracks WHERE track_id = ?`,
    ).run(newId, oldId);
    db.prepare(`DELETE FROM playlist_tracks WHERE track_id = ?`).run(oldId);
  } catch {
    /* ignore */
  }
  try {
    db.prepare(`UPDATE history SET track_id = ? WHERE track_id = ?`).run(newId, oldId);
  } catch {
    /* ignore */
  }
  void now;
}

function persistAlias(deadId: string, newId: string, title: string, artist: string, score: number, deps?: SweepDeps) {
  savePlayability({
    videoId: deadId,
    status: 'replaced',
    replacementVideoId: newId,
    lastChecked: Date.now(),
    error: null,
    durationMs: null,
  });
  savePlayability({
    videoId: newId,
    status: 'ok',
    replacementVideoId: null,
    lastChecked: Date.now(),
    error: null,
    durationMs: null,
  });
  try {
    ensureTrackReplacementSchema();
    (deps?.persistReplacement || recordReplacement)(deadId, newId, title, artist, score);
  } catch {
    /* table absente en test */
  }
  try {
    (deps?.remapLibrary || remapLibraryTrackId)(deadId, newId);
  } catch (err) {
    console.warn('[playability] remap', String((err as Error).message || err).slice(0, 120));
  }
}

async function probeVideo(
  videoId: string,
  expectedDurationMs: number | null | undefined,
  deps: SweepDeps,
): Promise<ProbeResult> {
  const resolved = await deps.resolveStream(videoId);
  if (!resolved?.url) return { ok: false, error: 'no-stream-url' };
  return deps.probeAudio(resolved.url, expectedDurationMs ?? resolved.durationMs);
}

export async function recoverTrack(
  item: LibrarySweepItem,
  deps: SweepDeps,
): Promise<TrackSweepResult> {
  const title = (item.title || '').trim();
  const artist = (item.artist || '').trim();
  if (!title) {
    return { videoId: item.videoId, status: 'fail', error: 'meta-insuffisante' };
  }
  const raw = await deps.searchSongs(title, artist);
  const music = raw.filter(isMusicCandidate);
  const ranked = music
    .map((c) => {
      const t: Track = {
        id: c.id,
        title: c.title,
        artists: c.artist ? [{ name: c.artist }] : [],
        thumbnails: [],
        type: 'song',
        durationSeconds: c.durationSeconds ?? undefined,
      };
      return { c, s: scoreCandidate(t, title, artist, item.durationMs ? item.durationMs / 1000 : null) };
    })
    .filter((x) => x.s >= MIN_MATCH_SCORE && x.c.id !== item.videoId)
    .sort((a, b) => b.s - a.s);

  for (const { c, s } of ranked.slice(0, 6)) {
    const probe = await probeVideo(c.id, item.durationMs, deps);
    if (!probe.ok) continue;
    const candTrack: Track = {
      id: c.id,
      title: c.title || title,
      artists: (c.artist || artist).split(',').map((name) => ({ name: name.trim() })).filter((a) => a.name),
      thumbnails: [],
      type: 'song',
      durationSeconds: c.durationSeconds ?? undefined,
    };
    try {
      upsertTrack(candTrack);
    } catch {
      /* test sans sqlite tracks_cache */
    }
    try {
      (deps.upsertFts || upsertIndexedTrack)(candTrack);
    } catch {
      /* index optionnel */
    }
    persistAlias(item.videoId, c.id, title, artist, s, deps);
    console.info(`[playability] ${item.videoId} → ${c.id} « ${title} — ${artist} » score=${s}`);
    return {
      videoId: item.videoId,
      status: 'replaced',
      replacementVideoId: c.id,
      durationMs: probe.durationMs ?? item.durationMs,
      recovered: true,
    };
  }
  return { videoId: item.videoId, status: 'fail', error: 'aucun-candidat-jouable' };
}

export async function sweepOne(item: LibrarySweepItem, deps: SweepDeps, recover = true): Promise<TrackSweepResult> {
  const probe = await probeVideo(item.videoId, item.durationMs, deps);
  if (probe.ok) {
    const row: PlayabilityRow = {
      videoId: item.videoId,
      status: 'ok',
      replacementVideoId: null,
      lastChecked: Date.now(),
      error: null,
      durationMs: probe.durationMs ?? item.durationMs ?? null,
    };
    savePlayability(row);
    return { videoId: item.videoId, status: 'ok', durationMs: row.durationMs };
  }
  if (!recover) {
    savePlayability({
      videoId: item.videoId,
      status: 'fail',
      replacementVideoId: null,
      lastChecked: Date.now(),
      error: probe.error || 'probe-fail',
      durationMs: item.durationMs ?? null,
    });
    return { videoId: item.videoId, status: 'fail', error: probe.error };
  }
  const recovered = await recoverTrack(item, deps);
  if (recovered.status !== 'replaced') {
    savePlayability({
      videoId: item.videoId,
      status: 'fail',
      replacementVideoId: null,
      lastChecked: Date.now(),
      error: recovered.error || probe.error || 'fail',
      durationMs: item.durationMs ?? null,
    });
  }
  return recovered;
}

export function collapseDuplicateGroups(
  items: LibrarySweepItem[],
  playableById: Map<string, TrackSweepResult>,
): { canonical: string; duds: string[] }[] {
  const groups = new Map<string, LibrarySweepItem[]>();
  for (const it of items) {
    const key = fingerprint(it.title, it.artist);
    if (!key) continue;
    const arr = groups.get(key) || [];
    arr.push(it);
    groups.set(key, arr);
  }
  const out: { canonical: string; duds: string[] }[] = [];
  for (const [, group] of groups) {
    const ids = [...new Set(group.map((g) => g.videoId))];
    if (ids.length < 2) continue;
    const oks = ids.filter((id) => playableById.get(id)?.status === 'ok');
    const replaced = ids.filter((id) => playableById.get(id)?.status === 'replaced');
    const canonical =
      oks[0] ||
      playableById.get(replaced[0] || '')?.replacementVideoId ||
      replaced[0] ||
      ids[0]!;
    const duds = ids.filter((id) => id !== canonical);
    if (duds.length) out.push({ canonical, duds });
  }
  return out;
}

export function productionDeps(): SweepDeps {
  return {
    resolveStream: defaultResolveStream,
    probeAudio: defaultProbeAudio,
    searchSongs: defaultSearchSongs,
    listTracks: async (opts) => defaultListTracks(opts),
    persistReplacement: recordReplacement,
    remapLibrary: remapLibraryTrackId,
    upsertFts: upsertIndexedTrack,
    sleep,
  };
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runPlayabilitySweep(
  opts: SweepOptions = {},
  deps: SweepDeps = productionDeps(),
): Promise<SweepSummary> {
  openPlayabilityDb();
  let userId = opts.userId;
  if (!userId && opts.userEmail) {
    userId = findUserByEmail(opts.userEmail)?.id;
  }
  const items = await deps.listTracks({
    userId,
    ids: opts.ids,
    limit: opts.limit || DEFAULT_BATCH,
  });
  const summary: SweepSummary = {
    checked: 0,
    ok: 0,
    fail: 0,
    replaced: 0,
    collapsed: 0,
    skipped: 0,
    results: [],
  };
  const conc = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const pause = opts.sleepMs ?? SLEEP_MS;
  const recover = opts.recover !== false;
  const byId = new Map<string, TrackSweepResult>();

  const results = await mapPool(items, conc, async (item) => {
    if (pause > 0 && deps.sleep) await deps.sleep(pause);
    if (opts.dryRun) {
      summary.skipped++;
      return { videoId: item.videoId, status: 'ok' as const, error: 'dry-run' };
    }
    const r = await sweepOne(item, deps, recover);
    summary.checked++;
    summary[r.status]++;
    byId.set(item.videoId, r);
    return r;
  });
  summary.results = results;

  if (opts.collapseDuplicates !== false && !opts.dryRun) {
    const groups = collapseDuplicateGroups(items, byId);
    for (const g of groups) {
      for (const dud of g.duds) {
        const src = items.find((i) => i.videoId === dud);
        persistAlias(dud, g.canonical, src?.title || '', src?.artist || '', 80, deps);
        summary.collapsed++;
        const prev = byId.get(dud);
        if (prev) {
          prev.status = 'replaced';
          prev.replacementVideoId = g.canonical;
        }
      }
    }
  }
  console.info(
    `[playability] sweep checked=${summary.checked} ok=${summary.ok} fail=${summary.fail} replaced=${summary.replaced} collapsed=${summary.collapsed}`,
  );
  return summary;
}

export function triggerOnDemandRecover(videoId: string, hints?: { title?: string; artist?: string }): void {
  if (!VIDEO_ID.test(videoId)) return;
  const now = Date.now();
  const last = onDemandAt.get(videoId) || 0;
  if (now - last < ON_DEMAND_DEBOUNCE_MS) return;
  onDemandAt.set(videoId, now);
  const item: LibrarySweepItem = libraryItemFromId(videoId) || {
    videoId,
    title: hints?.title || '',
    artist: hints?.artist || '',
  };
  if (hints?.title) item.title = hints.title;
  if (hints?.artist) item.artist = hints.artist;
  void sweepOne(item, productionDeps(), true).catch((err) => {
    console.warn('[playability] on-demand', String((err as Error).message || err).slice(0, 120));
  });
}

export function playabilitySweepStatus() {
  const n = (() => {
    try {
      return (
        openPlayabilityDb().prepare(`SELECT status, COUNT(*) AS n FROM playability GROUP BY status`).all() as {
          status: string;
          n: number;
        }[]
      );
    } catch {
      return [];
    }
  })();
  const by = Object.fromEntries(n.map((r) => [r.status, r.n]));
  return {
    enabled: String(process.env.PLAYABILITY_SWEEP || '1') !== '0',
    running: sweepRunning,
    intervalMs: INTERVAL_MS,
    staleMs: STALE_MS,
    ok: by.ok || 0,
    fail: by.fail || 0,
    replaced: by.replaced || 0,
  };
}

export function startPlayabilitySweep(): void {
  if (String(process.env.PLAYABILITY_SWEEP || '1').trim() === '0') {
    console.info('[playability] disabled');
    return;
  }
  if (sweepTimer) return;
  const every = Math.max(30 * 60_000, INTERVAL_MS);
  const start = Math.max(20_000, START_DELAY_MS);
  setTimeout(() => {
    void runCronTick();
  }, start).unref?.();
  sweepTimer = setInterval(() => {
    void runCronTick();
  }, every);
  if (typeof sweepTimer === 'object' && sweepTimer && 'unref' in sweepTimer) {
    try {
      (sweepTimer as NodeJS.Timeout).unref?.();
    } catch {
      /* ignore */
    }
  }
  console.info(
    `[playability] cron every ${Math.round(every / 3600_000)} h (start in ${Math.round(start / 1000)} s, batch=${DEFAULT_BATCH})`,
  );
}

async function runCronTick() {
  if (sweepRunning) return;
  try {
    const { isPlaybackHot } = await import('../media/stream.js');
    if (isPlaybackHot(90_000)) {
      console.info('[playability] skip cron — lecture en cours');
      return;
    }
  } catch {
    /* stream module optionnel en test */
  }
  sweepRunning = true;
  try {
    await runPlayabilitySweep({ limit: DEFAULT_BATCH, concurrency: DEFAULT_CONCURRENCY });
  } catch (err) {
    console.warn('[playability] cron KO', String((err as Error).message || err).slice(0, 120));
  } finally {
    sweepRunning = false;
  }
}

function parseArgs(argv: string[]): SweepOptions {
  const opts: SweepOptions = { recover: true, collapseDuplicates: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--once') continue;
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-recover') opts.recover = false;
    else if (a === '--limit') opts.limit = Number(argv[++i] || 8);
    else if (a === '--user') opts.userEmail = argv[++i];
    else if (a === '--user-id') opts.userId = argv[++i];
    else if (a === '--ids') opts.ids = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i] || 2);
    else if (a === '--sleep-ms') opts.sleepMs = Number(argv[++i] || 750);
  }
  return opts;
}

const isMain =
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url) === resolvePath(process.argv[1]!);

if (isMain) {
  const once = process.argv.includes('--once') || !process.argv.includes('--cron');
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.limit && opts.ids?.length) opts.limit = opts.ids.length;
  if (!opts.limit) opts.limit = 8;
  if (once) {
    runPlayabilitySweep(opts)
      .then((s) => {
        console.log(JSON.stringify({ ok: true, ...s, results: s.results.slice(0, 20) }, null, 2));
        process.exit(0);
      })
      .catch((err) => {
        console.error('[playability] CLI', err);
        process.exit(1);
      });
  } else {
    startPlayabilitySweep();
  }
}
