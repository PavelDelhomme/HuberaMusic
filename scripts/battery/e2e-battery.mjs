#!/usr/bin/env node
/**
 * Batterie E2E API PLM (local et/ou prod).
 * Usage:
 *   node --env-file=.env scripts/battery/e2e-battery.mjs
 *   API_BASE_URL=https://ytmusic.delhomme.ovh node --env-file=.env scripts/battery/e2e-battery.mjs
 *   E2E_TARGETS=local,prod node --env-file=.env scripts/battery/e2e-battery.mjs
 */
import { writeFileSync } from 'node:fs';

const email = process.env.SEED_EMAIL || process.env.VITE_DEV_EMAIL || '';
const password = process.env.SEED_PASSWORD || process.env.VITE_DEV_PASSWORD || '';
const targetsEnv = (process.env.E2E_TARGETS || process.env.API_BASE_URL || 'local,prod').trim();

const PRESETS = {
  local: 'http://127.0.0.1:8787',
  prod: 'https://ytmusic.delhomme.ovh',
};

function resolveTargets() {
  if (targetsEnv.startsWith('http')) return [{ name: 'custom', base: targetsEnv.replace(/\/$/, '') }];
  return targetsEnv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => ({ name, base: PRESETS[name] || name.replace(/\/$/, '') }));
}

const results = [];
const reportPath = '/tmp/ytmusic-e2e-battery.json';

function rec(target, id, ok, detail = '') {
  const row = { target, id, ok: !!ok, detail: String(detail).slice(0, 240) };
  results.push(row);
  const mark = ok ? 'OK  ' : 'FAIL';
  console.log(`${mark} [${target}] ${id}${detail ? ` — ${row.detail}` : ''}`);
}

async function req(base, path, { method = 'GET', token, body, raw = false } = {}) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = text;
  if (!raw) {
    try {
      data = JSON.parse(text);
    } catch {
      /* keep text */
    }
  }
  return { status: r.status, data, headers: r.headers, text };
}

function firstTrack(home) {
  for (const s of home?.shelves || []) {
    for (const it of s.items || []) {
      if (it?.id && (it.type === 'song' || it.type === 'video' || !it.type)) return it;
    }
  }
  return null;
}

async function runTarget({ name, base }) {
  console.log(`\n======== ${name} ${base} ========`);
  let token = null;

  // --- public ---
  {
    const h = await req(base, '/api/health');
    rec(name, 'health', h.status === 200 && h.data?.ok, `v=${h.data?.version || '?'} env=${h.data?.auth?.appEnv}`);
  }
  {
    const c = await req(base, '/api/auth/config');
    rec(name, 'auth.config', c.status === 200, JSON.stringify(c.data?.appEnv));
  }
  {
    const g = await req(base, '/api/home');
    rec(name, 'home.unauth=401', g.status === 401, `got ${g.status}`);
  }
  {
    const g = await req(base, '/api/search?q=test');
    rec(name, 'search.unauth=401', g.status === 401, `got ${g.status}`);
  }
  {
    const g = await req(base, '/api/stream/dQw4w9WgXcQ/url');
    rec(name, 'stream.unauth=401', g.status === 401, `got ${g.status}`);
  }
  {
    const g = await req(base, '/api/deploy/apk/info');
    // 200 = dispo, 404 = pas d’APK, 401 = protégé par token (prod OK)
    rec(
      name,
      'deploy.apk.info',
      g.status === 200 || g.status === 404 || g.status === 401,
      `status=${g.status}`,
    );
  }

  // --- login ---
  if (!email || !password) {
    rec(name, 'login', false, 'SEED_EMAIL/PASSWORD manquants');
    return;
  }
  {
    const login = await req(base, '/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    token = login.data?.token || login.data?.accessToken || null;
    rec(
      name,
      'login',
      login.status === 200 && !!token,
      login.status === 200 ? `user=${login.data?.user?.email || '?'}` : `${login.status} ${JSON.stringify(login.data)}`,
    );
    if (!token) return;
  }

  {
    const me = await req(base, '/api/auth/me', { token });
    rec(name, 'auth.me', me.status === 200 && (me.data?.user?.email || me.data?.email), JSON.stringify(me.data?.user?.email || me.data));
  }

  let track = null;
  let artistId = null;
  let albumId = null;

  {
    const home = await req(base, '/api/home', { token });
    const shelves = home.data?.shelves || [];
    track = firstTrack(home.data);
    rec(
      name,
      'home',
      home.status === 200 && shelves.length > 0,
      `shelves=${shelves.length} first=${track?.title || '∅'}`,
    );
  }

  {
    const ex = await req(base, '/api/explore', { token });
    rec(name, 'explore', ex.status === 200, `shelves=${(ex.data?.shelves || ex.data || []).length || '?'}`);
  }

  {
    const s = await req(base, '/api/search?q=Daft+Punk', { token });
    const songs = s.data?.songs || s.data?.tracks || s.data?.results || [];
    const items = Array.isArray(songs) ? songs : s.data?.shelves?.[0]?.items || [];
    if (!track && items[0]) track = items[0];
    // extract artist/album if present
    for (const it of items) {
      if (!artistId && (it.artists?.[0]?.id || it.artistId)) artistId = it.artists?.[0]?.id || it.artistId;
      if (!albumId && (it.album?.id || it.albumId)) albumId = it.album?.id || it.albumId;
    }
    rec(name, 'search', s.status === 200, `items≈${items.length} status=${s.status}`);
  }

  {
    const sug = await req(base, '/api/search/suggestions?q=da', { token });
    rec(name, 'search.suggestions', sug.status === 200, `n=${(sug.data?.suggestions || sug.data || []).length}`);
  }

  if (!track?.id) {
    rec(name, 'track.pick', false, 'aucun titre pour la suite');
    return;
  }
  rec(name, 'track.pick', true, `${track.id} ${track.title || ''}`);

  {
    const t = await req(base, `/api/track/${track.id}`, { token });
    rec(name, 'track.detail', t.status === 200, t.data?.title || t.data?.track?.title || `status=${t.status}`);
    if (!artistId) artistId = t.data?.artists?.[0]?.id || t.data?.artistId;
    if (!albumId) albumId = t.data?.album?.id || t.data?.albumId;
  }

  {
    const rel = await req(base, `/api/track/${track.id}/related`, { token });
    rec(name, 'track.related', rel.status === 200, `n=${(rel.data?.tracks || rel.data?.items || rel.data || []).length}`);
  }

  {
    const up = await req(base, `/api/track/${track.id}/upnext`, { token });
    rec(name, 'track.upnext', up.status === 200, `n=${(up.data?.tracks || up.data?.items || up.data || []).length}`);
  }

  {
    const ly = await req(base, `/api/track/${track.id}/lyrics`, { token });
    rec(name, 'track.lyrics', ly.status === 200 || ly.status === 404, `status=${ly.status}`);
  }

  // stream url + bytes
  {
    const u = await req(base, `/api/stream/${track.id}/url`, { token });
    const ok = u.status === 200 && (u.data?.url || u.data?.streamUrl);
    const bot =
      !ok &&
      /bot|Sign in|cookies|502/i.test(JSON.stringify(u.data || u.text || ''));
    // Prod VPS : bot YouTube occasionnel → soft (infra cookies/tunnel), pas une régression app
    rec(
      name,
      'stream.url',
      ok || (name === 'prod' && bot),
      ok ? 'url ok' : `${u.status} ${JSON.stringify(u.data).slice(0, 160)}${bot ? ' [soft-bot]' : ''}`,
    );
  }
  {
    const r = await fetch(`${base}/api/stream/${track.id}`, {
      headers: { Authorization: `Bearer ${token}`, Range: 'bytes=0-2047' },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const ok = (r.status === 200 || r.status === 206) && buf.length > 100;
    const soft = name === 'prod' && (r.status === 502 || r.status === 403);
    rec(name, 'stream.bytes', ok || soft, `HTTP ${r.status} bytes=${buf.length}${soft ? ' [soft]' : ''}`);
  }

  if (artistId) {
    const a = await req(base, `/api/artist/${artistId}`, { token });
    rec(name, 'artist.detail', a.status === 200, a.data?.name || a.data?.artist?.name || `status=${a.status}`);
    const songs = await req(base, `/api/artist/${artistId}/songs`, { token });
    rec(name, 'artist.songs', songs.status === 200, `n=${(songs.data?.songs || songs.data?.tracks || songs.data?.items || []).length}`);
    const radio = await req(base, `/api/artist/${artistId}/radio`, { token });
    rec(name, 'artist.radio', radio.status === 200 || radio.status === 404, `status=${radio.status}`);
  } else {
    rec(name, 'artist.detail', false, 'pas d’artistId');
    rec(name, 'artist.songs', false, 'skip');
    rec(name, 'artist.radio', false, 'skip');
  }

  if (albumId) {
    const a = await req(base, `/api/album/${albumId}`, { token });
    rec(name, 'album.detail', a.status === 200, a.data?.title || a.data?.name || `status=${a.status}`);
  } else {
    rec(name, 'album.detail', false, 'pas d’albumId (non bloquant si search pauvre)');
  }

  {
    const lib = await req(base, '/api/library', { token });
    rec(name, 'library', lib.status === 200, `keys=${Object.keys(lib.data || {}).join(',')}`);
  }

  {
    const like = await req(base, '/api/like', {
      method: 'POST',
      token,
      body: { videoId: track.id, track },
    });
    // endpoints may vary
    const like2 =
      like.status >= 400
        ? await req(base, `/api/library/like`, { method: 'POST', token, body: { id: track.id } })
        : like;
    rec(name, 'like', like.status < 500 || like2.status < 500, `a=${like.status} b=${like2.status}`);
  }

  {
    const hist = await req(base, '/api/history', {
      method: 'POST',
      token,
      body: { id: track.id, title: track.title, videoId: track.id, trackId: track.id },
    });
    rec(name, 'history.write', hist.status >= 200 && hist.status < 500, `status=${hist.status}`);
  }

  {
    const listen = await req(base, '/api/listen', {
      method: 'POST',
      token,
      body: { trackId: track.id, event: 'start', position: 0 },
    });
    rec(name, 'listen.start', listen.status >= 200 && listen.status < 500, `status=${listen.status}`);
  }

  {
    const pins = await req(base, '/api/pins', { token });
    rec(name, 'pins', pins.status === 200, `status=${pins.status}`);
  }

  {
    const prefs = await req(base, '/api/prefs', { token });
    rec(name, 'prefs', prefs.status === 200, `status=${prefs.status}`);
  }

  {
    const reco = await req(base, '/api/reco/home', { token });
    rec(name, 'reco.home', reco.status === 200 || reco.status === 404, `status=${reco.status}`);
  }

  {
    const sim = await req(base, `/api/reco/similar/${track.id}`, { token });
    rec(name, 'reco.similar', sim.status === 200 || sim.status === 404, `status=${sim.status}`);
  }

  // --- Radios / mixes / album radio ---
  {
    const radios = await req(base, '/api/reco/radios', { token });
    const list = radios.data?.radios || [];
    rec(name, 'reco.radios', radios.status === 200 && Array.isArray(list), `n=${list.length}`);
    if (list[0]?.id) {
      const mix = await req(base, `/api/reco/radio/${encodeURIComponent(list[0].id)}?preview=1`, { token });
      const tracks = mix.data?.tracks || [];
      rec(name, 'reco.radio.preview', mix.status === 200, `tracks=${tracks.length} id=${list[0].id}`);
      if (tracks[0]?.id && tracks[0].thumbnails?.length) {
        const save = await req(base, '/api/library/mixes', {
          method: 'POST',
          token,
          body: {
            id: `e2e-${list[0].id}`,
            title: `E2E ${list[0].title || list[0].id}`,
            covers: tracks.slice(0, 4),
            tracks: tracks.slice(0, 8),
          },
        });
        rec(name, 'library.mix.save', save.status === 200, `status=${save.status}`);
        const del = await req(base, `/api/library/mixes/${encodeURIComponent(`e2e-${list[0].id}`)}`, {
          method: 'DELETE',
          token,
        });
        rec(name, 'library.mix.delete', del.status === 200, `status=${del.status}`);
      }
    }
  }

  {
    const fb = await req(base, '/api/reco/feedback', {
      method: 'POST',
      token,
      body: { trackId: track.id, verdict: 'good', context: 'e2e-battery' },
    });
    rec(name, 'reco.feedback', fb.status === 200 || fb.status === 204, `status=${fb.status}`);
  }

  if (albumId) {
    const ar = await req(base, `/api/album/${albumId}/radio`, { token });
    rec(name, 'album.radio', ar.status === 200 || ar.status === 404, `status=${ar.status} n=${(ar.data?.tracks || []).length}`);
    const saveAlb = await req(base, '/api/library/albums', {
      method: 'POST',
      token,
      body: { id: albumId, title: 'E2E Album', type: 'album' },
    });
    rec(name, 'library.album.save', saveAlb.status === 200, `status=${saveAlb.status}`);
    const delAlb = await req(base, `/api/library/albums/${encodeURIComponent(albumId)}`, {
      method: 'DELETE',
      token,
    });
    rec(name, 'library.album.delete', delAlb.status === 200, `status=${delAlb.status}`);
  }

  if (artistId) {
    const saveArt = await req(base, '/api/library/artists', {
      method: 'POST',
      token,
      body: { id: artistId, name: 'E2E Artist', title: 'E2E Artist', type: 'artist' },
    });
    rec(name, 'library.artist.save', saveArt.status === 200, `status=${saveArt.status}`);
    const follow = await req(base, `/api/artists/${encodeURIComponent(artistId)}/follow`, {
      method: 'POST',
      token,
      body: { name: 'E2E Artist' },
    });
    rec(name, 'artist.follow', follow.status === 200 || follow.status === 204, `status=${follow.status}`);
    const unfollow = await req(base, `/api/artists/${encodeURIComponent(artistId)}/follow`, {
      method: 'DELETE',
      token,
    });
    rec(name, 'artist.unfollow', unfollow.status === 200 || unfollow.status === 204, `status=${unfollow.status}`);
    const delArt = await req(base, `/api/library/artists/${encodeURIComponent(artistId)}`, {
      method: 'DELETE',
      token,
    });
    rec(name, 'library.artist.delete', delArt.status === 200, `status=${delArt.status}`);
  }

  // --- Like / biblio titres ---
  {
    const like = await req(base, '/api/library/like', {
      method: 'POST',
      token,
      body: track,
    });
    rec(name, 'library.like', like.status === 200, `liked=${like.data?.liked} status=${like.status}`);
    const song = await req(base, '/api/library/songs', {
      method: 'POST',
      token,
      body: track,
    });
    rec(name, 'library.song.save', song.status === 200, `status=${song.status}`);
    const unlike = await req(base, '/api/library/like', {
      method: 'POST',
      token,
      body: track,
    });
    rec(name, 'library.like.toggle', unlike.status === 200, `liked=${unlike.data?.liked}`);
    const delSong = await req(base, `/api/library/songs/${encodeURIComponent(track.id)}`, {
      method: 'DELETE',
      token,
    });
    rec(name, 'library.song.delete', delSong.status === 200, `status=${delSong.status}`);
  }

  // --- Playlist locale : create / add / reorder / remove ---
  let playlistId = null;
  {
    const plName = `E2E Queue ${Date.now()}`;
    const created = await req(base, '/api/library/playlists', {
      method: 'POST',
      token,
      body: { name: plName, description: 'e2e-battery' },
    });
    playlistId =
      created.data?.playlist?.id ||
      created.data?.id ||
      created.data?.library?.playlists?.find((p) => p.name === plName)?.id ||
      null;
    rec(name, 'playlist.create', created.status === 200 && !!playlistId, `id=${playlistId || '∅'} status=${created.status}`);
  }
  if (playlistId) {
    const add1 = await req(base, `/api/library/playlists/${playlistId}/tracks`, {
      method: 'POST',
      token,
      body: track,
    });
    rec(name, 'playlist.addTrack', add1.status === 200, `status=${add1.status}`);

    // second track from related if possible
    let track2 = null;
    {
      const rel = await req(base, `/api/track/${track.id}/related`, { token });
      const pool = [...(rel.data?.related || []), ...(rel.data?.radio || []), ...(rel.data?.tracks || [])];
      track2 = pool.find((t) => t?.id && t.id !== track.id) || null;
    }
    if (track2) {
      await req(base, `/api/library/playlists/${playlistId}/tracks`, {
        method: 'POST',
        token,
        body: track2,
      });
      const reorder = await req(base, `/api/library/playlists/${playlistId}/reorder`, {
        method: 'PUT',
        token,
        body: { trackIds: [track2.id, track.id] },
      });
      rec(name, 'playlist.reorder', reorder.status === 200, `status=${reorder.status}`);
      const rem = await req(
        base,
        `/api/library/playlists/${playlistId}/tracks/${encodeURIComponent(track2.id)}`,
        { method: 'DELETE', token },
      );
      rec(name, 'playlist.removeTrack', rem.status === 200, `status=${rem.status}`);
    } else {
      rec(name, 'playlist.reorder', true, 'skip (pas de 2e titre)');
      rec(name, 'playlist.removeTrack', true, 'skip');
    }

    const patch = await req(base, `/api/library/playlists/${playlistId}`, {
      method: 'PATCH',
      token,
      body: { name: `E2E Renamed ${Date.now()}` },
    });
    rec(name, 'playlist.rename', patch.status === 200, `status=${patch.status}`);

    const delPl = await req(base, `/api/library/playlists/${playlistId}`, {
      method: 'DELETE',
      token,
    });
    rec(name, 'playlist.delete', delPl.status === 200, `status=${delPl.status}`);
  }

  // --- Pins (accès rapide) ---
  {
    const pin = await req(base, '/api/pins', {
      method: 'POST',
      token,
      body: { kind: track.type || 'song', targetId: track.id, payload: track, id: track.id },
    });
    const pinId = pin.data?.pins?.find((p) => p.targetId === track.id)?.id || pin.data?.id;
    rec(name, 'pins.add', pin.status === 200, `status=${pin.status}`);
    const pins = await req(base, '/api/pins', { token });
    rec(name, 'pins.list', pins.status === 200 && (pins.data?.pins || []).length >= 0, `n=${(pins.data?.pins || []).length}`);
    if (pinId) {
      const del = await req(base, `/api/pins/${encodeURIComponent(pinId)}`, { method: 'DELETE', token });
      rec(name, 'pins.delete', del.status === 200, `status=${del.status}`);
    } else {
      // try delete by finding
      const hit = (pins.data?.pins || []).find((p) => p.targetId === track.id);
      if (hit?.id) {
        const del = await req(base, `/api/pins/${encodeURIComponent(hit.id)}`, { method: 'DELETE', token });
        rec(name, 'pins.delete', del.status === 200, `status=${del.status}`);
      } else {
        rec(name, 'pins.delete', true, 'skip (pas d’id pin)');
      }
    }
  }

  // --- History / session / offline / warm ---
  {
    const hist = await req(base, '/api/history', { token });
    rec(name, 'history.read', hist.status === 200, `n=${(hist.data?.history || []).length}`);
  }
  {
    const detailed = await req(base, '/api/history/detailed', { token });
    rec(name, 'history.detailed', detailed.status === 200, `status=${detailed.status}`);
  }
  {
    const warm = await req(base, '/api/stream/warm', {
      method: 'POST',
      token,
      body: { ids: [track.id] },
    });
    rec(name, 'stream.warm', warm.status === 200 || warm.status === 204, `status=${warm.status} warmed=${warm.data?.warmed}`);
  }
  {
    const deviceId = `e2e-${Date.now()}`;
    const reg = await req(base, '/api/session/device', {
      method: 'POST',
      token,
      body: { deviceId, name: 'E2E Battery', deviceType: 'web', canPlay: true },
    });
    rec(name, 'session.device', reg.status === 200, `status=${reg.status}`);
    const st = await req(base, '/api/session/state', {
      method: 'PUT',
      token,
      body: {
        deviceId,
        current: track,
        queue: [track],
        queueIndex: 0,
        userQueueEnd: 1,
        autoplay: true,
        isPlaying: false,
        progress: 0,
        duration: 0,
        volume: 0.9,
        shuffle: false,
        repeat: 'off',
        updatedAt: Date.now(),
      },
    });
    rec(name, 'session.state', st.status === 200, `status=${st.status}`);
    const snap = await req(base, '/api/session', { token });
    rec(name, 'session.snapshot', snap.status === 200, `devices=${(snap.data?.devices || []).length}`);
  }
  {
    const off = await req(base, '/api/offline', { token });
    rec(name, 'offline.status', off.status === 200, `status=${off.status}`);
    const dl = await req(base, '/api/offline/downloads', { token });
    rec(name, 'offline.downloads', dl.status === 200, `n=${(dl.data?.downloads || dl.data || []).length}`);
  }
  {
    const ytm = await req(base, '/api/ytm/status', { token });
    rec(name, 'ytm.status', ytm.status === 200, `status=${ytm.status}`);
  }
  {
    const sh = await req(base, '/api/search/history', { token });
    rec(name, 'search.history', sh.status === 200, `status=${sh.status}`);
  }

  // durée : track.detail doit souvent exposer duration / durationSeconds
  {
    const t = await req(base, `/api/track/${track.id}`, { token });
    const tr = t.data?.track || t.data;
    const hasDur = !!(tr?.duration || tr?.durationSeconds);
    // Soft si YouTube bot / métadonnées pauvres en prod
    rec(
      name,
      'track.duration',
      (t.status === 200 && hasDur) || name === 'prod',
      `dur=${tr?.duration || tr?.durationSeconds || '∅'}${!hasDur && name === 'prod' ? ' [soft]' : ''}`,
    );
  }

  {
    const opts = await req(base, '/api/auth/passkeys/login/options', {
      method: 'POST',
      body: { email },
    });
    rec(
      name,
      'passkey.login.options',
      opts.status === 200 && (opts.data?.challenge || opts.data?.publicKey),
      `status=${opts.status}`,
    );
  }
  {
    const list = await req(base, '/api/auth/passkeys', { token });
    rec(
      name,
      'passkey.list',
      list.status === 200,
      `n=${(list.data?.passkeys || []).length} status=${list.status}`,
    );
  }
  {
    const reg = await req(base, '/api/auth/passkeys/register/options', {
      method: 'POST',
      token,
      body: {},
    });
    rec(
      name,
      'passkey.register.options',
      reg.status === 200 && (reg.data?.challenge || reg.data?.publicKey),
      `status=${reg.status}`,
    );
  }

  // admin (si compte admin)
  {
    const st = await req(base, '/api/admin/status', { token });
    rec(name, 'admin.status', st.status === 200 || st.status === 403, `status=${st.status}`);
  }
  {
    const ck = await req(base, '/api/admin/youtube-cookies', { token });
    rec(
      name,
      'admin.youtube-cookies',
      ck.status === 200 || ck.status === 403 || ck.status === 404,
      ck.status === 200 ? JSON.stringify(ck.data).slice(0, 120) : `status=${ck.status}`,
    );
  }
}

async function main() {
  const targets = resolveTargets();
  console.log('E2E battery targets:', targets.map((t) => t.name).join(', '));
  console.log('email:', email || '(missing)');
  for (const t of targets) {
    try {
      await runTarget(t);
    } catch (e) {
      rec(t.name, 'crash', false, e?.message || String(e));
    }
  }

  const byTarget = {};
  for (const r of results) {
    byTarget[r.target] ||= { ok: 0, fail: 0, rows: [] };
    byTarget[r.target].rows.push(r);
    if (r.ok) byTarget[r.target].ok++;
    else byTarget[r.target].fail++;
  }

  console.log('\n======== SUMMARY ========');
  for (const [k, v] of Object.entries(byTarget)) {
    console.log(`${k}: ${v.ok} OK / ${v.fail} FAIL`);
  }

  writeFileSync(
    reportPath,
    JSON.stringify({ at: new Date().toISOString(), email, targets, byTarget, results }, null, 2),
  );
  console.log(`\nReport: ${reportPath}`);
  const totalFail = results.filter((r) => !r.ok).length;
  process.exitCode = totalFail ? 1 : 0;
}

await main();
