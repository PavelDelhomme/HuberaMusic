#!/usr/bin/env node
/**
 * Smoke + charge légère multi-titres/artistes (local + prod).
 * Usage:
 *   node scripts/test/smoke-load-test.mjs local
 *   node scripts/test/smoke-load-test.mjs prod
 *   node scripts/test/smoke-load-test.mjs both
 * Env: SEED_EMAIL / SEED_PASSWORD (ou AUTH_EMAIL / AUTH_PASSWORD)
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'logs');
mkdirSync(OUT_DIR, { recursive: true });

function loadEnv() {
  const env = { ...process.env };
  const p = join(ROOT, '.env');
  if (!existsSync(p)) return env;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (env[m[1]] == null) env[m[1]] = v;
  }
  return env;
}

const env = loadEnv();
const email = env.SEED_EMAIL || env.AUTH_EMAIL || env.TEST_EMAIL;
const password = env.SEED_PASSWORD || env.AUTH_PASSWORD || env.TEST_PASSWORD;

const ARTISTS = [
  { q: 'Stromae', expect: 'artist' },
  { q: 'Daft Punk', expect: 'artist' },
  { q: 'Sia', expect: 'artist' },
  { q: 'Bo Burnham', expect: 'artist' },
  { q: 'Suzane', expect: 'artist' },
];
const SONGS = [
  'Papaoutai',
  'Get Lucky',
  'Chandelier',
  'Welcome to the Internet',
  'The Weeknd Blinding Lights',
];
const PLAYLISTS = ['chill house', 'lofi hip hop', 'ambiance chill'];

const target = (process.argv[2] || 'both').toLowerCase();
const bases = [];
if (target === 'local' || target === 'both') bases.push({ name: 'local', base: 'http://127.0.0.1:8787' });
if (target === 'prod' || target === 'both') {
  bases.push({ name: 'prod', base: (env.PUBLIC_API_URL || 'https://ytmusic.delhomme.ovh').replace(/\/$/, '') });
}

const findings = [];
const rows = [];

function note(level, envName, area, message, detail = '') {
  findings.push({ level, env: envName, area, message, detail, at: new Date().toISOString() });
}

async function req(base, path, opts = {}) {
  const url = `${base}${path}`;
  const t0 = Date.now();
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { ...opts, headers });
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: String(e), json: null, text: '' };
  }
  const ms = Date.now() - t0;
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* */
  }
  return { ok: res.ok, status: res.status, ms, json, text: text.slice(0, 400), error: null };
}

async function login(base) {
  if (!email || !password) return { token: null, error: 'no credentials' };
  const r = await req(base, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  const token = r.json?.token || r.json?.accessToken || null;
  return { token, r };
}

function auth(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function runEnv({ name, base }) {
  console.log(`\n═══ ${name} ${base} ═══`);
  const health = await req(base, '/api/health');
  rows.push({ env: name, op: 'health', status: health.status, ms: health.ms });
  if (!health.ok) {
    note('error', name, 'health', `health ${health.status}`, health.error || health.text);
    return;
  }
  console.log(`  health ${health.status} ${health.ms}ms version=${health.json?.version || health.json?.appVersion}`);

  const { token, r: loginR } = await login(base);
  rows.push({ env: name, op: 'login', status: loginR?.status ?? 0, ms: loginR?.ms ?? 0 });
  if (!token) {
    note('error', name, 'auth', 'login failed', loginR?.text || loginR?.error);
    return;
  }
  console.log(`  login OK ${loginR.ms}ms`);

  const H = auth(token);

  // Home
  const home = await req(base, '/api/home', { headers: H });
  rows.push({ env: name, op: 'home', status: home.status, ms: home.ms });
  if (!home.ok) note('error', name, 'home', `home ${home.status}`, home.text);
  else if (home.ms > 8000) note('warn', name, 'home', `home lent ${home.ms}ms`);
  else console.log(`  home ${home.ms}ms`);

  // Library
  const lib = await req(base, '/api/library', { headers: H });
  rows.push({ env: name, op: 'library', status: lib.status, ms: lib.ms, bytes: lib.text?.length });
  if (!lib.ok) note('error', name, 'library', `library ${lib.status}`, lib.text);
  else {
    const songs = lib.json?.songs?.length ?? 0;
    const liked = lib.json?.liked?.length ?? 0;
    const pls = lib.json?.playlists?.length ?? 0;
    console.log(`  library ${lib.ms}ms songs=${songs} liked=${liked} playlists=${pls}`);
    if (lib.ms > 5000) note('warn', name, 'library', `library lent ${lib.ms}ms`, `songs=${songs}`);
    // playlists light check
    const heavy = (lib.json?.playlists || []).filter((p) => (p.tracks || []).length > 0);
    if (heavy.length) {
      note('warn', name, 'library', 'playlists non-light (tracks inclus)', `${heavy.length} playlists`);
    }
  }

  // Prefs
  const prefs = await req(base, '/api/prefs', { headers: H });
  rows.push({ env: name, op: 'prefs', status: prefs.status, ms: prefs.ms });
  if (!prefs.ok) note('error', name, 'prefs', `prefs ${prefs.status}`);
  else if (typeof prefs.json?.prefs?.autoplaySuggestions !== 'boolean') {
    note('warn', name, 'prefs', 'autoplaySuggestions manquant');
  }

  // Search artists + open artist
  for (const a of ARTISTS) {
    const s = await req(base, `/api/search?q=${encodeURIComponent(a.q)}`, { headers: H });
    rows.push({ env: name, op: `search:${a.q}`, status: s.status, ms: s.ms });
    if (!s.ok) {
      note('error', name, 'search', `search ${a.q} → ${s.status}`, s.text);
      continue;
    }
    if (s.ms > 6000) note('warn', name, 'search', `search ${a.q} lent ${s.ms}ms`);
    const artist =
      s.json?.artists?.[0] ||
      (s.json?.topResult?.type === 'artist' ? s.json.topResult : null);
    const aid = artist?.id;
    console.log(`  search "${a.q}" ${s.ms}ms artist=${aid || '—'}`);
    if (!aid) {
      note('warn', name, 'search', `pas d'artiste pour ${a.q}`);
      continue;
    }
    const ar = await req(base, `/api/artist/${encodeURIComponent(aid)}`, { headers: H });
    rows.push({ env: name, op: `artist:${a.q}`, status: ar.status, ms: ar.ms });
    if (!ar.ok) note('error', name, 'artist', `artist ${a.q} ${ar.status}`, ar.text);
    else {
      const n = (ar.json?.songs || ar.json?.tracks || []).length;
      console.log(`    artist ${ar.ms}ms songs≈${n}`);
      if (ar.ms > 10000) note('warn', name, 'artist', `artist ${a.q} lent ${ar.ms}ms`);
      // radio
      const radio = await req(base, `/api/artist/${encodeURIComponent(aid)}/radio`, { headers: H });
      rows.push({ env: name, op: `artistRadio:${a.q}`, status: radio.status, ms: radio.ms });
      if (!radio.ok) note('warn', name, 'radio', `artist radio ${a.q} ${radio.status}`);
      else console.log(`    radio ${radio.ms}ms tracks=${radio.json?.tracks?.length ?? 0}`);
    }
  }

  // Songs → track + related + stream head
  const streamIds = [];
  for (const q of SONGS) {
    const s = await req(base, `/api/search?q=${encodeURIComponent(q)}&filter=song`, { headers: H });
    rows.push({ env: name, op: `searchSong:${q}`, status: s.status, ms: s.ms });
    const track = s.json?.songs?.[0] || (s.json?.topResult?.type === 'song' ? s.json.topResult : null);
    if (!track?.id) {
      note('warn', name, 'search', `pas de titre pour ${q}`);
      continue;
    }
    streamIds.push(track.id);
    const tr = await req(base, `/api/track/${track.id}`, { headers: H });
    rows.push({ env: name, op: `track:${track.id}`, status: tr.status, ms: tr.ms });
    if (!tr.ok) note('error', name, 'track', `track ${track.id} ${tr.status}`);

    const rel = await req(base, `/api/track/${track.id}/related?fast=1`, { headers: H });
    rows.push({ env: name, op: `related:${track.id}`, status: rel.status, ms: rel.ms });
    if (!rel.ok) note('warn', name, 'related', `related ${track.id} ${rel.status}`);
    else {
      const n = (rel.json?.tracks || rel.json?.related || []).length;
      console.log(`  song "${q}" → ${track.id} related=${n} ${rel.ms}ms`);
      if (rel.ms > 5000) note('warn', name, 'related', `related lent ${rel.ms}ms`, q);
    }
  }

  // Parallel stream heads (charge)
  const heads = streamIds.slice(0, 8);
  console.log(`  stream heads parallel n=${heads.length}`);
  const streamResults = await Promise.all(
    heads.map(async (id) => {
      const t0 = Date.now();
      try {
        const res = await fetch(`${base}/api/stream/${id}`, {
          headers: { ...H, Range: 'bytes=0-16383' },
        });
        return { id, status: res.status, ms: Date.now() - t0 };
      } catch (e) {
        return { id, status: 0, ms: Date.now() - t0, error: String(e) };
      }
    }),
  );
  for (const s of streamResults) {
    rows.push({ env: name, op: `stream:${s.id}`, status: s.status, ms: s.ms });
    const ok = s.status === 200 || s.status === 206;
    if (!ok) note('error', name, 'stream', `stream ${s.id} → ${s.status}`, s.error || '');
    else if (s.ms > 8000) note('warn', name, 'stream', `stream lent ${s.ms}ms`, s.id);
    else console.log(`    stream ${s.id} ${s.status} ${s.ms}ms`);
  }

  // Warm batch
  if (heads.length) {
    const warm = await req(base, '/api/stream/warm', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ ids: heads }),
    });
    rows.push({ env: name, op: 'warm', status: warm.status, ms: warm.ms });
    if (!warm.ok) note('warn', name, 'warm', `warm ${warm.status}`);
    else console.log(`  warm ${warm.ms}ms`);
  }

  // Playlists
  for (const q of PLAYLISTS) {
    const s = await req(base, `/api/search?q=${encodeURIComponent(q)}`, { headers: H });
    const pl = (s.json?.playlists || []).find((p) => p?.id);
    if (!pl) {
      note('warn', name, 'playlist', `pas de playlist pour ${q}`);
      continue;
    }
    const detail = await req(base, `/api/playlist/${encodeURIComponent(pl.id)}`, { headers: H });
    rows.push({ env: name, op: `playlist:${pl.id}`, status: detail.status, ms: detail.ms });
    if (!detail.ok) {
      note('error', name, 'playlist', `playlist ${pl.title || pl.id} ${detail.status}`, detail.text);
      continue;
    }
    const tc = detail.json?.playlist?.trackCount;
    if (tc != null && typeof tc !== 'number') {
      note('error', name, 'playlist', `trackCount non-int`, `${pl.title}: ${JSON.stringify(tc)}`);
    } else {
      console.log(
        `  playlist "${pl.title}" trackCount=${tc} tracks=${detail.json?.tracks?.length ?? 0} ${detail.ms}ms`,
      );
      if (detail.ms > 12000) note('warn', name, 'playlist', `playlist lente ${detail.ms}ms`, pl.title);
    }
  }

  // Mix / reco sample (route réelle : /api/reco/radio/:category — pas ?seed=)
  const mix = await req(base, '/api/reco/radio/chill?preview=1', { headers: H });
  rows.push({ env: name, op: 'recoRadio', status: mix.status, ms: mix.ms });
  if (!mix.ok) note('warn', name, 'mix', `reco radio ${mix.status}`, mix.text);
  else {
    const n = mix.json?.tracks?.length ?? 0;
    console.log(`  reco radio ${mix.ms}ms tracks=${n}`);
    if (n === 0) note('warn', name, 'mix', 'reco radio chill vide');
  }
}

for (const b of bases) {
  await runEnv(b);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = join(OUT_DIR, `smoke-${stamp}.json`);
writeFileSync(
  reportPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), rows, findings }, null, 2),
);

console.log('\n═══ RÉSUMÉ ═══');
const errors = findings.filter((f) => f.level === 'error');
const warns = findings.filter((f) => f.level === 'warn');
console.log(`errors=${errors.length} warns=${warns.length}`);
for (const f of findings) {
  console.log(`  [${f.level}] ${f.env}/${f.area}: ${f.message}${f.detail ? ' — ' + f.detail : ''}`);
}
console.log(`report: ${reportPath}`);

// Machine-readable for ERRORS.md merge
writeFileSync(join(OUT_DIR, 'smoke-latest.json'), JSON.stringify({ findings, rows }, null, 2));
process.exit(errors.length ? 1 : 0);
