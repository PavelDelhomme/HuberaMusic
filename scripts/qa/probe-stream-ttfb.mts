/**
 * Probe latence stream (TTFB) — titres file / shuffle / likes.
 * Mesure open-ended vs Range, cold vs 2ᵉ hit, et warm explicite.
 *
 *   node --env-file=.env --import tsx scripts/qa/probe-stream-ttfb.mts
 *   API_BASE=https://plm.delhomme.ovh LIMIT=12 SEND_MAIL=0 node …
 */
import { sendMail } from '../../api/src/platform/mail.ts';

const API = (process.env.API_BASE || process.env.APP_URL || 'https://plm.delhomme.ovh').replace(
  /\/$/,
  '',
);
const LIMIT = Math.min(40, Math.max(6, Number(process.env.LIMIT || 12) || 12));
const SLOW_MS = Number(process.env.SLOW_MS || 3_000) || 3_000;
const FAIL_MS = Number(process.env.FAIL_MS || 12_000) || 12_000;
const SEND_MAIL = String(process.env.SEND_MAIL || '0').trim() === '1';

const email = process.env.SEED_EMAIL || process.env.ADMIN_EMAIL || '';
const password =
  process.env.SEED_PASSWORD || process.env.ADMIN_PASSWORD || process.env.VITE_DEV_PASSWORD || '';

type Hit = {
  id: string;
  title?: string;
  phase: string;
  ms: number;
  ok: boolean;
  status?: number;
  cache?: string;
  bytes?: number;
  error?: string;
};

async function login(): Promise<string> {
  if (!email || !password) throw new Error('SEED_EMAIL + SEED_PASSWORD requis');
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, deviceLabel: 'qa-stream-ttfb' }),
  });
  const j = (await r.json()) as { token?: string; error?: string };
  if (!r.ok || !j.token) throw new Error(`login: ${j.error || r.status}`);
  return j.token;
}

async function probe(
  token: string,
  id: string,
  phase: string,
  opts: { range?: boolean; timeoutMs?: number } = {},
): Promise<Hit> {
  const t0 = Date.now();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'X-YTM-Client': 'android',
    'User-Agent': 'PLM-Android/qa-ttfb',
  };
  if (opts.range !== false) headers.Range = 'bytes=0-65535';
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), opts.timeoutMs ?? FAIL_MS + 2_000);
  try {
    const r = await fetch(`${API}/api/stream/${id}?client=android`, {
      headers,
      signal: ac.signal,
    });
    const buf = new Uint8Array(await r.arrayBuffer());
    const ms = Date.now() - t0;
    return {
      id,
      phase,
      ms,
      ok: r.ok || r.status === 206,
      status: r.status,
      cache: r.headers.get('x-plm-stream-cache') || undefined,
      bytes: buf.byteLength,
    };
  } catch (e) {
    return {
      id,
      phase,
      ms: Date.now() - t0,
      ok: false,
      error: String((e as Error).message || e).slice(0, 120),
    };
  } finally {
    clearTimeout(to);
  }
}

async function warm(token: string, ids: string[]) {
  await fetch(`${API}/api/stream/warm`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-YTM-Client': 'android',
    },
    body: JSON.stringify({ ids, wait: true }),
    signal: AbortSignal.timeout(25_000),
  }).catch(() => null);
}

async function main() {
  const token = await login();
  const ids: Array<{ id: string; title?: string }> = [];

  const heads = (await (
    await fetch(`${API}/api/library/shuffle-heads?limit=${LIMIT}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-YTM-Client': 'android' },
    })
  ).json()) as { ids?: string[]; tracks?: Array<{ id: string; title?: string }> };
  for (const id of heads.ids || []) {
    if (/^[a-zA-Z0-9_-]{11}$/.test(id)) ids.push({ id });
  }
  for (const t of heads.tracks || []) {
    if (t.id && /^[a-zA-Z0-9_-]{11}$/.test(t.id)) ids.push({ id: t.id, title: t.title });
  }

  const uniq = [...new Map(ids.map((x) => [x.id, x])).values()].slice(0, LIMIT);
  console.log(`API=${API} LIMIT=${uniq.length} SLOW_MS=${SLOW_MS} FAIL_MS=${FAIL_MS}`);

  const hits: Hit[] = [];
  for (let i = 0; i < uniq.length; i++) {
    const { id, title } = uniq[i]!;
    process.stdout.write(`[${i + 1}/${uniq.length}] ${id}… `);
    // 1) cold-ish open (comme Exo sans Range)
    const open1 = await probe(token, id, 'open1', { range: false });
    open1.title = title;
    hits.push(open1);
    // 2) range immédiat (prefetch)
    const range1 = await probe(token, id, 'range1', { range: true });
    hits.push(range1);
    // 3) warm wait puis open (simule file déjà chauffée)
    await warm(token, [id]);
    const open2 = await probe(token, id, 'open-after-warm', { range: false });
    hits.push(open2);
    const range2 = await probe(token, id, 'range-after-warm', { range: true });
    hits.push(range2);
    const worst = Math.max(open1.ms, range1.ms);
    const after = Math.max(open2.ms, range2.ms);
    const tag =
      !open1.ok && !range1.ok
        ? 'KO'
        : worst >= FAIL_MS
          ? 'FAIL_SLOW'
          : worst >= SLOW_MS
            ? 'SLOW'
            : 'OK';
    console.log(
      `${tag} open1=${open1.ms}ms(${open1.cache || '-'}) → afterWarm=${after}ms(${open2.cache || range2.cache || '-'})`,
    );
  }

  const byPhase = (p: string) => hits.filter((h) => h.phase === p);
  const avg = (arr: Hit[]) =>
    arr.length ? Math.round(arr.reduce((s, h) => s + h.ms, 0) / arr.length) : 0;
  const p95 = (arr: Hit[]) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a.ms - b.ms);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!.ms;
  };

  const summary = {
    open1: { avg: avg(byPhase('open1')), p95: p95(byPhase('open1')), n: byPhase('open1').length },
    range1: {
      avg: avg(byPhase('range1')),
      p95: p95(byPhase('range1')),
      n: byPhase('range1').length,
    },
    openAfter: {
      avg: avg(byPhase('open-after-warm')),
      p95: p95(byPhase('open-after-warm')),
      n: byPhase('open-after-warm').length,
    },
    rangeAfter: {
      avg: avg(byPhase('range-after-warm')),
      p95: p95(byPhase('range-after-warm')),
      n: byPhase('range-after-warm').length,
    },
  };

  const slow = hits.filter((h) => h.ok && h.ms >= SLOW_MS);
  const ko = hits.filter((h) => !h.ok || h.ms >= FAIL_MS);

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`slow(≥${SLOW_MS}ms)=${slow.length} ko/fail(≥${FAIL_MS}ms)=${ko.length}`);

  if (SEND_MAIL && (slow.length || ko.length)) {
    const lines = [
      `[PLM] Probe TTFB stream — slow=${slow.length} ko=${ko.length}`,
      `API ${API}`,
      '',
      'Summary:',
      JSON.stringify(summary, null, 2),
      '',
      ...ko.slice(0, 40).map(
        (h) =>
          `• ${h.id} ${h.phase} ${h.ms}ms ok=${h.ok} cache=${h.cache || '-'} ${h.error || ''}`,
      ),
    ];
    await sendMail({
      to: process.env.PLAYBACK_DIGEST_TO || 'dev@delhomme.ovh',
      subject: `[PLM] TTFB stream slow=${slow.length} ko=${ko.length}`,
      text: lines.join('\n'),
    });
  }

  // Critère gate : après warm, p95 open doit être < 3 s
  if (summary.openAfter.p95 > SLOW_MS || summary.rangeAfter.p95 > SLOW_MS) {
    console.error('GATE FAIL: after-warm p95 trop lent');
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
