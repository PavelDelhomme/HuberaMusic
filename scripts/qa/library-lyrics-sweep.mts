/**
 * Balaye la bibliothèque et appelle /api/track/:id/lyrics — mesure taux
 * de récupération + sources (lrclib / genius / captions / …).
 *
 *   API=https://plm.delhomme.ovh SAMPLE=40 CONCURRENCY=3 \
 *     npx tsx scripts/qa/library-lyrics-sweep.mts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const API = (process.env.API || 'https://plm.delhomme.ovh').replace(/\/$/, '');
const SAMPLE = Number(process.env.SAMPLE || 40);
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);

type Track = { id: string; title: string; artist: string; source: string };
type Result = Track & {
  hasLyrics: boolean;
  hasTimed: boolean;
  source: string;
  lines: number;
  timed: number;
  offsetMs: number;
  ms: number;
  err: string;
};

async function login(): Promise<string> {
  const email = process.env.SEED_EMAIL;
  const passwords = [process.env.VITE_DEV_PASSWORD, process.env.SEED_PASSWORD].filter(Boolean);
  for (const password of passwords) {
    const r = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const j = (await r.json().catch(() => ({}))) as { token?: string };
    if (r.ok && j.token) return j.token;
  }
  throw new Error('login KO');
}

function pushTracks(out: Map<string, Track>, list: unknown, source: string) {
  if (!Array.isArray(list)) return;
  for (const raw of list) {
    const t = raw as {
      id?: string;
      videoId?: string;
      title?: string;
      artists?: { name?: string }[];
      artist?: string;
    };
    const id = t.id || t.videoId;
    if (!id || String(id).length !== 11 || out.has(id)) continue;
    const artist = t.artists?.map((a) => a?.name).filter(Boolean).join(', ') || t.artist || '?';
    out.set(id, { id, title: t.title || '?', artist, source });
  }
}

async function collect(token: string): Promise<Track[]> {
  const H = { Authorization: `Bearer ${token}`, 'X-YTM-Client': 'android' };
  const out = new Map<string, Track>();
  const lib = (await (await fetch(`${API}/api/library`, { headers: H })).json()) as Record<
    string,
    unknown
  >;
  for (const key of ['songs', 'liked', 'history', 'downloaded']) {
    pushTracks(out, lib[key], `library.${key}`);
  }
  const playlists = Array.isArray(lib.playlists)
    ? (lib.playlists as { id?: string; title?: string }[])
    : [];
  for (const p of playlists.slice(0, 10)) {
    if (!p?.id) continue;
    try {
      const r = await fetch(`${API}/api/library/playlists/${encodeURIComponent(p.id)}/tracks`, {
        headers: H,
        signal: AbortSignal.timeout(20_000),
      });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      pushTracks(out, j.tracks || j.items || j, `playlist.${p.title || p.id}`);
    } catch {
      /* ignore */
    }
  }
  return [...out.values()];
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

async function one(token: string, t: Track): Promise<Result> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${API}/api/track/${t.id}/lyrics`, {
      headers: { Authorization: `Bearer ${token}`, 'X-YTM-Client': 'android' },
      signal: AbortSignal.timeout(45_000),
    });
    const j = (await r.json().catch(() => ({}))) as {
      lyrics?: string | null;
      timed?: unknown[] | null;
      source?: string | null;
      userOffsetMs?: number;
      syncOffsetMs?: number;
    };
    const lyrics = String(j.lyrics || '').trim();
    const timed = Array.isArray(j.timed) ? j.timed : [];
    return {
      ...t,
      hasLyrics: lyrics.length > 40,
      hasTimed: timed.length >= 4,
      source: String(j.source || 'none'),
      lines: lyrics ? lyrics.split(/\n/).filter((l) => l.trim()).length : 0,
      timed: timed.length,
      offsetMs: Number(j.userOffsetMs ?? j.syncOffsetMs ?? 0) || 0,
      ms: Date.now() - t0,
      err: r.ok ? '' : `HTTP ${r.status}`,
    };
  } catch (e) {
    return {
      ...t,
      hasLyrics: false,
      hasTimed: false,
      source: 'error',
      lines: 0,
      timed: 0,
      offsetMs: 0,
      ms: Date.now() - t0,
      err: String((e as Error).message || e).slice(0, 120),
    };
  }
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()));
  return out;
}

const token = await login();
const all = await collect(token);
const sample = shuffle(all).slice(0, Math.min(SAMPLE, all.length));
console.log(`library=${all.length} sample=${sample.length} api=${API}`);

const results = await pool(sample, CONCURRENCY, (t) => one(token, t));
const ok = results.filter((r) => r.hasLyrics);
const timed = results.filter((r) => r.hasTimed);
const bySrc = new Map<string, number>();
for (const r of results) bySrc.set(r.source, (bySrc.get(r.source) || 0) + 1);

console.log('\n=== résumé ===');
console.log(
  `paroles ${ok.length}/${results.length} (${Math.round((100 * ok.length) / results.length)}%)`,
);
console.log(
  `timed   ${timed.length}/${results.length} (${Math.round((100 * timed.length) / results.length)}%)`,
);
console.log(
  'sources',
  [...bySrc.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(' '),
);

console.log('\n=== misses ===');
for (const r of results.filter((x) => !x.hasLyrics)) {
  console.log(`- ${r.artist} — ${r.title} (${r.id}) ${r.err || r.source} ${r.ms}ms`);
}

console.log('\n=== genius / estimated samples ===');
for (const r of results.filter((x) => x.hasLyrics && /genius|estimated|aligned|lyrics\.ovh/i.test(x.source)).slice(0, 12)) {
  console.log(
    `+ [${r.source}] ${r.artist} — ${r.title} lines=${r.lines} timed=${r.timed} ${r.ms}ms`,
  );
}

const outDir = join(ROOT, 'tmp');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = join(outDir, `lyrics-sweep-${stamp}.json`);
writeFileSync(
  file,
  JSON.stringify(
    {
      at: new Date().toISOString(),
      api: API,
      library: all.length,
      sample: results.length,
      withLyrics: ok.length,
      withTimed: timed.length,
      bySource: Object.fromEntries(bySrc),
      results,
    },
    null,
    2,
  ),
);
console.log('\nécrit', file);
