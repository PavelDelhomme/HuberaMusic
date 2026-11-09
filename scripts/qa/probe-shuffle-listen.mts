/**
 * Simule « Aléatoire biblio » : tire shuffle-heads puis sonde chaque titre
 * (URL stream + premiers octets) comme si on écoutait jusqu’à ce que ça charge.
 *
 *   node --env-file=.env --import tsx scripts/qa/probe-shuffle-listen.mts
 *   API_BASE=https://ytmusic.delhomme.ovh LIMIT=40 SEND_MAIL=1 node …
 *
 * Envoie un mail des titres KO / lents (> seuil) — complémente le digest 12h30.
 */
import { sendMail } from '../../api/src/platform/mail.ts';

const API = (process.env.API_BASE || process.env.APP_URL || 'https://ytmusic.delhomme.ovh').replace(
  /\/$/,
  '',
);
const LIMIT = Math.min(120, Math.max(8, Number(process.env.LIMIT || 48) || 48));
const SLOW_MS = Number(process.env.SLOW_MS || 8_000) || 8_000;
const FAIL_MS = Number(process.env.FAIL_MS || 22_000) || 22_000;
const SEND_MAIL = String(process.env.SEND_MAIL || '1').trim() !== '0';
const TO =
  process.env.PLAYBACK_DIGEST_TO?.trim() ||
  process.env.BATTERY_REPORT_TO?.trim() ||
  process.env.TELEMETRY_ALERT_TO?.trim() ||
  '';

const email = process.env.SEED_EMAIL || process.env.ADMIN_EMAIL || '';
const password =
  process.env.SEED_PASSWORD || process.env.ADMIN_PASSWORD || process.env.VITE_DEV_PASSWORD || '';

type Probe = {
  id: string;
  title?: string;
  artist?: string;
  ok: boolean;
  slow: boolean;
  ms: number;
  status?: number;
  error?: string;
  bytes?: number;
};

async function login(): Promise<string> {
  if (!email || !password) throw new Error('SEED_EMAIL + SEED_PASSWORD requis');
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      deviceLabel: 'qa-shuffle-probe',
    }),
  });
  const j = (await r.json()) as { token?: string; accessToken?: string; error?: string };
  const token = j.token || j.accessToken;
  if (!r.ok || !token) throw new Error(`login ${r.status}: ${j.error || JSON.stringify(j)}`);
  return token;
}

async function shuffleHeads(token: string): Promise<Array<{ id: string; title?: string; artist?: string }>> {
  const r = await fetch(`${API}/api/library/shuffle-heads?limit=${LIMIT}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = (await r.json()) as {
    ids?: string[];
    tracks?: Array<{ id: string; title?: string; artists?: Array<{ name?: string }> }>;
    heads?: Array<{ id: string; title?: string }>;
  };
  if (!r.ok) throw new Error(`shuffle-heads ${r.status}`);
  if (Array.isArray(j.tracks) && j.tracks.length) {
    return j.tracks.slice(0, LIMIT).map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artists?.map((a) => a.name).filter(Boolean).join(', '),
    }));
  }
  if (Array.isArray(j.heads) && j.heads.length) {
    return j.heads.slice(0, LIMIT).map((t) => ({ id: t.id, title: t.title }));
  }
  const ids = (j.ids || []).slice(0, LIMIT);
  return ids.map((id) => ({ id }));
}

async function probeOne(token: string, id: string): Promise<Omit<Probe, 'title' | 'artist'>> {
  const t0 = Date.now();
  try {
    // 1) resolve URL (format)
    const urlRes = await fetch(`${API}/api/stream/${id}/url`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FAIL_MS),
    });
    const urlMs = Date.now() - t0;
    if (!urlRes.ok) {
      return {
        id,
        ok: false,
        slow: urlMs >= SLOW_MS,
        ms: urlMs,
        status: urlRes.status,
        error: `url ${urlRes.status}`,
      };
    }
    // 2) first bytes of stream (comme Exo qui démarre)
    const streamRes = await fetch(`${API}/api/stream/${id}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Range: 'bytes=0-65535',
      },
      signal: AbortSignal.timeout(FAIL_MS),
    });
    const ms = Date.now() - t0;
    const buf = streamRes.ok || streamRes.status === 206 ? await streamRes.arrayBuffer() : null;
    const bytes = buf?.byteLength ?? 0;
    if (!(streamRes.ok || streamRes.status === 206) || bytes < 2048) {
      return {
        id,
        ok: false,
        slow: ms >= SLOW_MS,
        ms,
        status: streamRes.status,
        bytes,
        error: `stream ${streamRes.status} bytes=${bytes}`,
      };
    }
    return {
      id,
      ok: true,
      slow: ms >= SLOW_MS,
      ms,
      status: streamRes.status,
      bytes,
    };
  } catch (e) {
    const ms = Date.now() - t0;
    return {
      id,
      ok: false,
      slow: true,
      ms,
      error: String((e as Error).message || e).slice(0, 160),
    };
  }
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function main() {
  console.log(`API=${API} LIMIT=${LIMIT} SLOW_MS=${SLOW_MS} FAIL_MS=${FAIL_MS}`);
  const token = await login();
  const heads = await shuffleHeads(token);
  console.log(`heads=${heads.length}`);
  if (!heads.length) throw new Error('aucun shuffle-head');

  // Warm batch (comme Aléatoire)
  await fetch(`${API}/api/stream/warm`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ids: heads.slice(0, 12).map((h) => h.id) }),
  }).catch(() => null);

  const results: Probe[] = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]!;
    process.stdout.write(`[${i + 1}/${heads.length}] ${h.id}… `);
    const p = await probeOne(token, h.id);
    const row: Probe = { ...p, title: h.title, artist: h.artist };
    results.push(row);
    console.log(
      row.ok
        ? `OK ${row.ms}ms${row.slow ? ' SLOW' : ''} (${row.bytes} B)`
        : `KO ${row.ms}ms ${row.error || ''}`,
    );
    // Pause courte — simule enchaînement sans saturer yt-dlp
    await new Promise((r) => setTimeout(r, 350));
  }

  const ko = results.filter((r) => !r.ok);
  const slow = results.filter((r) => r.ok && r.slow);
  const okFast = results.filter((r) => r.ok && !r.slow);

  const subject = `[Hubera Music] Probe Aléatoire — ${ko.length} KO · ${slow.length} lents · ${okFast.length} OK (${results.length})`;
  const text = [
    `Probe shuffle-heads @ ${API}`,
    `Date: ${new Date().toLocaleString('fr-FR')}`,
    `Total: ${results.length} · KO: ${ko.length} · Lents(≥${SLOW_MS}ms): ${slow.length} · OK rapides: ${okFast.length}`,
    '',
    '=== KO (auraient fait passer au titre suivant) ===',
    ...ko.map(
      (r) =>
        `• ${r.title || r.id}${r.artist ? ` — ${r.artist}` : ''} | ${r.ms}ms | ${r.error || r.status} | https://music.youtube.com/watch?v=${r.id}`,
    ),
    '',
    '=== LENTS ===',
    ...slow.map(
      (r) =>
        `• ${r.title || r.id}${r.artist ? ` — ${r.artist}` : ''} | ${r.ms}ms | https://music.youtube.com/watch?v=${r.id}`,
    ),
  ].join('\n');

  const rowsHtml = [...ko, ...slow]
    .slice(0, 60)
    .map((r) => {
      const label = r.title
        ? `<strong>${esc(r.title)}</strong>${r.artist ? ` — ${esc(r.artist)}` : ''}`
        : `<code>${r.id}</code>`;
      const badge = !r.ok
        ? `<span style="background:#7f1d1d;color:#fff;padding:2px 6px;border-radius:4px">KO</span>`
        : `<span style="background:#9a3412;color:#fff;padding:2px 6px;border-radius:4px">LENT</span>`;
      return `<tr><td style="padding:8px;border-bottom:1px solid #eee">${badge} ${label}<div style="font-size:12px;color:#666">${esc(r.error || '')} · ${r.ms}ms</div></td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px"><a href="https://music.youtube.com/watch?v=${r.id}">${r.id}</a></td></tr>`;
    })
    .join('');

  const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"/></head>
  <body style="font-family:Segoe UI,Arial,sans-serif;max-width:720px;margin:20px auto;color:#18181b">
    <h1 style="font-size:20px">Probe Aléatoire bibliothèque</h1>
    <p>Simulation écoute : resolve URL + 64 Ko de stream pour ${results.length} titres (shuffle-heads).</p>
    <p><strong>${ko.length}</strong> KO · <strong>${slow.length}</strong> lents (≥${SLOW_MS} ms) · <strong>${okFast.length}</strong> OK rapides</p>
    <p style="color:#666;font-size:13px">Les KO / lents sont ceux qui font « passer au titre suivant » côté app (buffer stuck / give-up).</p>
    <table style="width:100%;border-collapse:collapse">${rowsHtml || '<tr><td>Aucun KO/lent</td></tr>'}</table>
  </body></html>`;

  console.log('\n' + subject);
  console.log(text.slice(0, 2500));

  if (SEND_MAIL) {
    const r = await sendMail({ to: TO, subject, html, text });
    console.log('mail →', r);
  }
}

await main();
