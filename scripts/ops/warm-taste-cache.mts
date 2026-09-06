/**
 * Précharge cache disque serveur (.m4a déjà compressé) + warm formats
 * pour les goûts d’un compte + seeds artistes + (option) tous les comptes SQL.
 *
 *   EMAIL=[REDACTED] PASS='…' \
 *     SEEDS='(G)I-DLE,LiSA,ReawakeR,Céline Dion,Aitana,Bad Bunny' \
 *     MAX=120 npx tsx scripts/ops/warm-taste-cache.mts
 *
 *   # Tous les comptes (history/likes/library via admin) + seeds Hélène/seed
 *   ALL_USERS=1 MAX_TOTAL=400 MAX_PER_USER=50 \
 *     EMAIL=helene… PASS=… npx tsx scripts/ops/warm-taste-cache.mts
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const API = (process.env.API || 'https://plm.delhomme.ovh').replace(/\/$/, '');
const MAX = Number(process.env.MAX || 100);
const MAX_PER_USER = Number(process.env.MAX_PER_USER || 50);
const MAX_TOTAL = Number(process.env.MAX_TOTAL || 400);
const CONCURRENCY = Math.max(1, Math.min(3, Number(process.env.CONCURRENCY || 2)));
const SEEDS = (process.env.SEEDS || '')
  .split(/[,;|]/)
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_HELENE_SEEDS = [
  '(G)I-DLE',
  'G-IDLE',
  'LiSA',
  'YOASOBI',
  'ReawakeR',
  'Céline Dion',
  'Aitana',
  'Bad Bunny',
  'Rosalía',
  'ITZY',
  'aespa',
  'NewJeans',
  'TWICE',
  'Loïc Nottet',
  'anime opening',
];

const DEFAULT_SEED_SEEDS = ['GIMS', 'Ninho', 'Indochine', 'Aya Nakamura', 'Damso'];

type Track = { id: string; title: string; artist: string; why: string };

async function login(email: string, password: string): Promise<{ token: string; refresh?: string }> {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const j = (await r.json().catch(() => ({}))) as {
    token?: string;
    refreshToken?: string;
    error?: string;
  };
  if (!r.ok || !j.token) throw new Error(`login KO ${email}: ${j.error || r.status}`);
  return { token: j.token, refresh: j.refreshToken };
}

function push(out: Map<string, Track>, id: unknown, title: unknown, artist: unknown, why: string) {
  const vid = String(id || '');
  if (!/^[a-zA-Z0-9_-]{11}$/.test(vid) || out.has(vid)) return;
  out.set(vid, {
    id: vid,
    title: String(title || '?'),
    artist: String(artist || '?'),
    why,
  });
}

async function collectForUser(token: string, seeds: string[]): Promise<Track[]> {
  const H = { Authorization: `Bearer ${token}`, 'X-YTM-Client': 'android' };
  const out = new Map<string, Track>();

  try {
    await fetch(`${API}/api/ytm/sync`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    /* ignore */
  }

  const lib = (await (await fetch(`${API}/api/library`, { headers: H })).json()) as Record<
    string,
    unknown
  >;
  for (const key of ['liked', 'songs', 'history', 'downloaded'] as const) {
    const list = lib[key];
    if (!Array.isArray(list)) continue;
    for (const raw of list.slice(0, 150)) {
      const t = raw as {
        id?: string;
        videoId?: string;
        title?: string;
        artists?: { name?: string }[];
        artist?: string;
      };
      const artist =
        t.artists?.map((a) => a?.name).filter(Boolean).join(', ') || t.artist || '?';
      push(out, t.id || t.videoId, t.title, artist, `library.${key}`);
    }
  }

  const artists = [
    ...(Array.isArray(lib.artists) ? (lib.artists as { id?: string; name?: string }[]) : []),
    ...(Array.isArray(lib.followedArtists)
      ? (lib.followedArtists as { id?: string; name?: string }[])
      : []),
  ];
  for (const a of artists.slice(0, 16)) {
    if (!a?.id) continue;
    try {
      const r = await fetch(`${API}/api/artist/${encodeURIComponent(a.id)}`, {
        headers: H,
        signal: AbortSignal.timeout(20_000),
      });
      const j = (await r.json().catch(() => ({}))) as {
        songs?: unknown[];
        tracks?: unknown[];
      };
      const songs = (j.songs || j.tracks || []) as Array<{
        id?: string;
        videoId?: string;
        title?: string;
        artists?: { name?: string }[];
      }>;
      for (const t of songs.slice(0, 24)) {
        push(
          out,
          t.id || t.videoId,
          t.title,
          t.artists?.map((x) => x?.name).filter(Boolean).join(', ') || a.name,
          `artist.${a.name || a.id}`,
        );
      }
    } catch {
      /* ignore */
    }
  }

  for (const q of seeds) {
    try {
      const r = await fetch(`${API}/api/search?q=${encodeURIComponent(q)}&filter=songs`, {
        headers: H,
        signal: AbortSignal.timeout(25_000),
      });
      const j = (await r.json().catch(() => ({}))) as {
        songs?: unknown[];
        results?: unknown[];
      };
      const songs = (j.songs || j.results || []) as Array<{
        id?: string;
        videoId?: string;
        title?: string;
        artists?: { name?: string }[];
      }>;
      for (const t of songs.slice(0, 14)) {
        push(
          out,
          t.id || t.videoId,
          t.title,
          t.artists?.map((x) => x?.name).filter(Boolean).join(', ') || q,
          `seed.${q}`,
        );
      }
      const ar = await fetch(`${API}/api/search?q=${encodeURIComponent(q)}&filter=artists`, {
        headers: H,
        signal: AbortSignal.timeout(20_000),
      });
      const aj = (await ar.json().catch(() => ({}))) as {
        artists?: { id?: string; name?: string }[];
        results?: { id?: string; name?: string }[];
      };
      const art = (aj.artists || aj.results || [])[0];
      if (art?.id) {
        const det = await fetch(`${API}/api/artist/${encodeURIComponent(art.id)}`, {
          headers: H,
          signal: AbortSignal.timeout(20_000),
        });
        const dj = (await det.json().catch(() => ({}))) as { songs?: unknown[] };
        for (const t of ((dj.songs || []) as Array<{ id?: string; title?: string }>).slice(0, 18)) {
          push(out, t.id, t.title, art.name || q, `seed-artist.${q}`);
        }
      }
    } catch (e) {
      console.warn('seed fail', q, String((e as Error).message || e).slice(0, 80));
    }
  }

  return [...out.values()];
}

async function collectFromAdminDb(adminToken: string): Promise<Track[]> {
  const r = await fetch(
    `${API}/api/admin/warm-candidates?maxPerUser=${MAX_PER_USER}&maxTotal=${MAX_TOTAL}`,
    {
      headers: { Authorization: `Bearer ${adminToken}`, 'X-YTM-Client': 'android' },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!r.ok) {
    console.warn('warm-candidates HTTP', r.status, '— endpoint absent ? (déployer d’abord)');
    return [];
  }
  const j = (await r.json()) as {
    candidates?: { trackId: string; why: string; email: string }[];
  };
  const out = new Map<string, Track>();
  for (const c of j.candidates || []) {
    push(out, c.trackId, c.trackId, c.email, `db.${c.why}`);
  }
  console.log(`admin DB candidates=${out.size}`);
  return [...out.values()];
}

async function warmOne(token: string, t: Track): Promise<{
  id: string;
  ok: boolean;
  ms: number;
  disk: boolean;
  warm: boolean;
  detail: string;
}> {
  const H = {
    Authorization: `Bearer ${token}`,
    'X-YTM-Client': 'android',
    'Content-Type': 'application/json',
  };
  const t0 = Date.now();
  let warm = false;
  let disk = false;
  let detail = '';
  try {
    const w = await fetch(`${API}/api/stream/warm`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ ids: [t.id], wait: true }),
      signal: AbortSignal.timeout(22_000),
    });
    warm = w.ok;
    detail += `warm=${w.status};`;
  } catch (e) {
    detail += `warmErr=${String((e as Error).message || e).slice(0, 40)};`;
  }
  try {
    const s = await fetch(`${API}/api/stream/${t.id}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-YTM-Client': 'android',
        Range: 'bytes=0-786431',
      },
      signal: AbortSignal.timeout(35_000),
    });
    detail += `stream=${s.status};cache=${s.headers.get('x-plm-stream-cache') || '?'};`;
    if (s.ok || s.status === 206) warm = true;
    await s.arrayBuffer().catch(() => null);
  } catch (e) {
    detail += `streamErr=${String((e as Error).message || e).slice(0, 40)};`;
  }
  try {
    const d = await fetch(`${API}/api/download/${t.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-YTM-Client': 'android' },
      signal: AbortSignal.timeout(50_000),
    });
    disk = d.ok;
    detail += `disk=${d.status};`;
  } catch (e) {
    detail += `diskErr=${String((e as Error).message || e).slice(0, 40)};`;
  }
  return {
    id: t.id,
    ok: warm || disk,
    ms: Date.now() - t0,
    disk,
    warm,
    detail,
  };
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
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

const adminEmail = process.env.SEED_EMAIL || process.env.ADMIN_EMAIL || '';
const adminPass =
  process.env.VITE_DEV_PASSWORD || process.env.SEED_PASSWORD || process.env.ADMIN_PASSWORD || '';

const email = process.env.EMAIL || '';
const pass = process.env.PASS || '';
const allUsers = process.env.ALL_USERS === '1';

type Job = { email: string; password: string; seeds: string[]; max: number; label: string };

const jobs: Job[] = [];
const globalPool = new Map<string, Track>();

if (allUsers) {
  if (!adminEmail || !adminPass) throw new Error('ALL_USERS=1 requires SEED_EMAIL + password');
  const admin = await login(adminEmail, adminPass);
  for (const t of await collectFromAdminDb(admin.token)) {
    push(globalPool, t.id, t.title, t.artist, t.why);
  }
}

if (email && pass) {
  jobs.push({
    email,
    password: pass,
    seeds: SEEDS.length ? SEEDS : DEFAULT_HELENE_SEEDS,
    max: MAX,
    label: 'taste',
  });
} else if (!allUsers) {
  throw new Error('EMAIL + PASS requis (ou ALL_USERS=1)');
}

if (adminEmail && adminPass && adminEmail !== email) {
  jobs.push({
    email: adminEmail,
    password: adminPass,
    seeds: DEFAULT_SEED_SEEDS,
    max: Math.min(MAX, 80),
    label: 'seed',
  });
}

const allResults: unknown[] = [];
let warmToken = '';

for (const job of jobs) {
  console.log(`\n=== ${job.email} [${job.label}] seeds=${job.seeds.join(' | ')} ===`);
  const { token } = await login(job.email, job.password);
  if (!warmToken) warmToken = token;
  const tracks = (await collectForUser(token, job.seeds)).slice(0, job.max);
  console.log(`candidates=${tracks.length} (cap ${job.max})`);
  for (const t of tracks) push(globalPool, t.id, t.title, t.artist, t.why);

  const results = await pool(tracks, CONCURRENCY, async (t) => {
    const r = await warmOne(token, t);
    console.log(
      `${r.disk ? 'DISK' : r.warm ? 'WARM' : 'FAIL'} ${r.ms}ms ${t.why} · ${t.artist} — ${t.title}`.slice(
        0,
        140,
      ),
    );
    return { ...t, ...r };
  });
  const diskOk = results.filter((r) => r.disk).length;
  const warmOk = results.filter((r) => r.warm).length;
  console.log(`résumé ${job.email}: disk ${diskOk}/${results.length} · warm ${warmOk}/${results.length}`);
  allResults.push({ email: job.email, diskOk, warmOk, total: results.length, results });
}

// Deuxième passe : candidats SQL d’autres comptes pas encore chauffés
if (allUsers && warmToken) {
  const already = new Set(
    (allResults as Array<{ results?: { id: string }[] }>).flatMap((x) =>
      (x.results || []).map((r) => r.id),
    ),
  );
  const extra = [...globalPool.values()].filter((t) => !already.has(t.id)).slice(0, MAX_TOTAL);
  if (extra.length) {
    console.log(`\n=== ALL_USERS extra ${extra.length} titres (cache global) ===`);
    const results = await pool(extra, CONCURRENCY, async (t) => {
      const r = await warmOne(warmToken, t);
      console.log(
        `${r.disk ? 'DISK' : r.warm ? 'WARM' : 'FAIL'} ${r.ms}ms ${t.why} · ${t.id}`.slice(0, 120),
      );
      return { ...t, ...r };
    });
    allResults.push({
      email: 'all-users-db',
      diskOk: results.filter((r) => r.disk).length,
      warmOk: results.filter((r) => r.warm).length,
      total: results.length,
      results,
    });
  }
}

const outDir = join(ROOT, 'tmp');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = join(outDir, `warm-taste-${stamp}.json`);
writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), api: API, allResults }, null, 2));
console.log('\nécrit', file);
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
