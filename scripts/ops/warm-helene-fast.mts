/**
 * Warm rapide Hélène + candidats admin (sans attendre le gros script seeds).
 *   npx tsx scripts/ops/warm-helene-fast.mts
 */
const API = (process.env.API || 'https://plm.delhomme.ovh').replace(/\/$/, '');
const email = process.env.EMAIL || '[REDACTED]';
const pass = process.env.PASS || '';
const adminEmail = process.env.SEED_EMAIL || '';
const adminPass = process.env.VITE_DEV_PASSWORD || process.env.SEED_PASSWORD || '';

if (!pass) throw new Error('PASS requis');
if (!adminEmail || !adminPass) throw new Error('SEED_EMAIL + password requis');

async function login(e: string, p: string) {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: e, password: p }),
  });
  const j = (await r.json()) as { token?: string; error?: string };
  if (!r.ok || !j.token) throw new Error(`login ${e}: ${j.error || r.status}`);
  return j.token;
}

const helene = await login(email, pass);
const admin = await login(adminEmail, adminPass);
const H = (t: string) => ({ Authorization: `Bearer ${t}`, 'X-YTM-Client': 'android' });

const ids = new Set<string>();
const lib = (await (await fetch(`${API}/api/library`, { headers: H(helene) })).json()) as Record<
  string,
  unknown
>;
for (const k of ['liked', 'songs', 'history', 'downloaded']) {
  for (const t of (lib[k] as Array<{ id?: string; videoId?: string }>) || []) {
    const id = t.id || t.videoId;
    if (id && id.length === 11) ids.add(id);
  }
}
for (const a of ((lib.artists as Array<{ id?: string }>) || []).slice(0, 8)) {
  if (!a.id) continue;
  const j = (await (
    await fetch(`${API}/api/artist/${encodeURIComponent(a.id)}`, {
      headers: H(helene),
      signal: AbortSignal.timeout(20_000),
    })
  )
    .json()
    .catch(() => ({}))) as { songs?: Array<{ id?: string; videoId?: string }> };
  for (const t of (j.songs || []).slice(0, 20)) {
    const id = t.id || t.videoId;
    if (id && id.length === 11) ids.add(id);
  }
}
for (const q of [
  '(G)I-DLE',
  'LiSA',
  'YOASOBI',
  'ReawakeR',
  'Céline Dion',
  'Aitana',
  'Rosalía',
  'ITZY',
  'aespa',
  'NewJeans',
]) {
  const j = (await (
    await fetch(`${API}/api/search?q=${encodeURIComponent(q)}&filter=songs`, {
      headers: H(helene),
      signal: AbortSignal.timeout(25_000),
    })
  )
    .json()
    .catch(() => ({}))) as { songs?: Array<{ id?: string; videoId?: string }>; results?: Array<{ id?: string }> };
  for (const t of (j.songs || j.results || []).slice(0, 10)) {
    const id = t.id || (t as { videoId?: string }).videoId;
    if (id && id.length === 11) ids.add(id);
  }
  console.log('seed', q, 'ids', ids.size);
}

const cand = (await (
  await fetch(`${API}/api/admin/warm-candidates?maxPerUser=40&maxTotal=180`, {
    headers: H(admin),
  })
)
  .json()
  .catch(() => ({}))) as { candidates?: Array<{ trackId: string }> };
for (const c of cand.candidates || []) ids.add(c.trackId);

const list = [...ids];
console.log('total ids', list.length);
let ok = 0;
let disk = 0;
const conc = 2;
let i = 0;
async function worker() {
  while (i < list.length) {
    const idx = i++;
    const id = list[idx]!;
    const t0 = Date.now();
    try {
      await fetch(`${API}/api/stream/warm`, {
        method: 'POST',
        headers: { ...H(admin), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id], wait: true }),
        signal: AbortSignal.timeout(20_000),
      });
      const s = await fetch(`${API}/api/stream/${id}`, {
        headers: { ...H(admin), Range: 'bytes=0-524287' },
        signal: AbortSignal.timeout(30_000),
      });
      await s.arrayBuffer().catch(() => null);
      const d = await fetch(`${API}/api/download/${id}`, {
        method: 'POST',
        headers: H(admin),
        signal: AbortSignal.timeout(45_000),
      });
      if (d.ok) disk += 1;
      if (s.ok || s.status === 206 || d.ok) ok += 1;
      console.log(
        `${idx + 1}/${list.length}`,
        d.ok ? 'DISK' : 'WARM',
        `${Date.now() - t0}ms`,
        id,
        `cache=${s.headers.get('x-plm-stream-cache') || '?'}`,
      );
    } catch (e) {
      console.log(`${idx + 1}/${list.length}`, 'FAIL', `${Date.now() - t0}ms`, id, (e as Error).message);
    }
  }
}
await Promise.all(Array.from({ length: conc }, () => worker()));
console.log('DONE ok', ok, 'disk', disk, 'total', list.length);
