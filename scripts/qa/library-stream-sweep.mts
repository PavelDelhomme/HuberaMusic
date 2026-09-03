/**
 * Balaye un large échantillon de la bibliothèque et interroge /api/stream pour
 * chaque titre : détecte les erreurs serveur (502/503/504/416/403) avant qu'elles
 * ne se manifestent sur l'appareil.
 *
 *   API=https://ytmusic.delhomme.ovh SAMPLE=200 npx tsx scripts/qa/library-stream-sweep.mts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const API = (process.env.API || 'https://ytmusic.delhomme.ovh').replace(/\/$/, '');
const SAMPLE = Number(process.env.SAMPLE || 200);
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const HEAD_TIMEOUT_MS = Number(process.env.HEAD_TIMEOUT_MS || 60_000);

type Track = { id: string; title: string; artist: string; source: string };
type Result = Track & {
  status: number;
  bytes: number;
  ms: number;
  cache: string;
  detail: string;
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

  // Playlists de la bibliothèque → pistes
  const playlists = Array.isArray(lib.playlists) ? (lib.playlists as { id?: string; title?: string }[]) : [];
  for (const p of playlists.slice(0, 12)) {
    if (!p?.id) continue;
    try {
      const r = await fetch(`${API}/api/library/playlists/${encodeURIComponent(p.id)}/tracks`, {
        headers: H,
        signal: AbortSignal.timeout(20_000),
      });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      pushTracks(out, j.tracks || j.songs || j, `playlist:${p.title || p.id}`);
    } catch {
      /* playlist illisible — ignorée */
    }
  }

  // Albums de la bibliothèque → pistes
  const albums = Array.isArray(lib.albums) ? (lib.albums as { id?: string; title?: string }[]) : [];
  for (const a of albums.slice(0, 10)) {
    if (!a?.id) continue;
    try {
      const r = await fetch(`${API}/api/album/${encodeURIComponent(a.id)}`, {
        headers: H,
        signal: AbortSignal.timeout(20_000),
      });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      pushTracks(out, j.tracks || j.songs, `album:${a.title || a.id}`);
    } catch {
      /* album illisible — ignoré */
    }
  }

  return [...out.values()];
}

async function probe(token: string, t: Track): Promise<Result> {
  const H = { Authorization: `Bearer ${token}`, 'X-YTM-Client': 'android' };
  const t0 = Date.now();
  try {
    const r = await fetch(`${API}/api/stream/${t.id}`, {
      headers: { ...H, Range: 'bytes=0-65535' },
      redirect: 'follow',
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const ok = r.status === 200 || r.status === 206;
    let detail = '';
    if (!ok) {
      detail = buf.toString('utf8').slice(0, 200).replace(/\s+/g, ' ');
    }
    return {
      ...t,
      status: r.status,
      bytes: buf.length,
      ms: Date.now() - t0,
      cache: r.headers.get('x-plm-stream-cache') || '-',
      detail,
    };
  } catch (err) {
    return {
      ...t,
      status: 0,
      bytes: 0,
      ms: Date.now() - t0,
      cache: '-',
      detail: String((err as Error).message || err).slice(0, 160),
    };
  }
}

async function main() {
  const token = await login();
  const all = await collect(token);
  // Mélange pour un échantillon représentatif, pas juste les derniers écoutés
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  const pool = all.slice(0, SAMPLE);
  console.log(`bibliothèque=${all.length} échantillon=${pool.length} concurrence=${CONCURRENCY}`);

  const results: Result[] = [];
  let cursor = 0;
  let done = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= pool.length) return;
      const res = await probe(token, pool[i]);
      results.push(res);
      done++;
      const ok = res.status === 200 || res.status === 206;
      const flag = ok ? 'OK  ' : 'FAIL';
      if (!ok || res.ms > 20_000) {
        console.log(
          `${flag} [${done}/${pool.length}] ${res.id} ${res.status} ${res.bytes}b ${res.ms}ms ` +
            `${res.title} — ${res.artist} ${res.detail}`,
        );
      } else if (done % 20 === 0) {
        console.log(`     [${done}/${pool.length}] …`);
      }
    }
  });
  await Promise.all(workers);

  const fails = results.filter((r) => !(r.status === 200 || r.status === 206));
  const slow = results.filter((r) => (r.status === 200 || r.status === 206) && r.ms > 15_000);
  const byStatus = new Map<number, number>();
  for (const r of results) byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1);

  console.log('\n===== RÉSUMÉ =====');
  console.log(`testés=${results.length} échecs=${fails.length} lents(>15s)=${slow.length}`);
  for (const [st, n] of [...byStatus].sort((a, b) => b[1] - a[1])) {
    console.log(`  status ${st}: ${n}`);
  }
  if (fails.length) {
    console.log('\n----- ÉCHECS -----');
    for (const f of fails) {
      console.log(`${f.id} ${f.status} ${f.ms}ms  ${f.title} — ${f.artist}  [${f.source}]  ${f.detail}`);
    }
  }
  if (slow.length) {
    console.log('\n----- LENTS -----');
    for (const s of slow) console.log(`${s.id} ${s.ms}ms ${s.cache}  ${s.title} — ${s.artist}`);
  }

  const outDir = join(ROOT, 'logs', 'sweep');
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(outDir, `library-sweep-${stamp}.json`);
  writeFileSync(file, JSON.stringify({ total: all.length, results }, null, 2));
  console.log(`\nrapport → ${file}`);
  process.exit(fails.length ? 3 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
