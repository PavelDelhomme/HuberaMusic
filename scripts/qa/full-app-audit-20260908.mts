/**
 * Audit complet PLM — API + Blackview + PDF + mail.
 *
 *   node --env-file=.env --import tsx scripts/qa/full-app-audit-20260908.mts
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sendMail } from '../../api/src/platform/mail.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const API = (process.env.API || process.env.PUBLIC_API_URL || 'https://plm.delhomme.ovh').replace(
  /\/$/,
  '',
);
const DEVICE = process.env.DEVICE || 'EEA9700PRO0014587';
const TO = process.env.AUDIT_MAIL_TO || '';
const SAMPLE = Number(process.env.SAMPLE || 40);
const OUT_DIR = join(ROOT, 'tmp', `full-audit-${new Date().toISOString().slice(0, 10)}`);
mkdirSync(OUT_DIR, { recursive: true });

type Check = {
  area: string;
  name: string;
  ok: boolean;
  detail: string;
  ms?: number;
  status?: number;
};

const checks: Check[] = [];
const notes: string[] = [];

function add(c: Check) {
  checks.push(c);
  const mark = c.ok ? 'OK' : 'KO';
  console.log(`[${mark}] ${c.area} · ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}

async function login(): Promise<{ token: string; email: string }> {
  const email = process.env.SEED_EMAIL || process.env.ADMIN_EMAILS?.split(',')[0]?.trim() || '';
  const passwords = [process.env.VITE_DEV_PASSWORD, process.env.SEED_PASSWORD, process.env.ADMIN_PASSWORD]
    .filter(Boolean) as string[];
  for (const password of passwords) {
    const t0 = Date.now();
    const r = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const j = (await r.json().catch(() => ({}))) as { token?: string; error?: string };
    if (r.ok && j.token) {
      add({
        area: 'Auth',
        name: 'login email/password',
        ok: true,
        detail: email,
        ms: Date.now() - t0,
        status: r.status,
      });
      return { token: j.token, email };
    }
  }
  add({ area: 'Auth', name: 'login email/password', ok: false, detail: `échec pour ${email}` });
  throw new Error('login KO');
}

async function hit(
  area: string,
  name: string,
  path: string,
  token: string,
  opts?: { method?: string; body?: unknown; expect?: (status: number, j: unknown) => boolean },
) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${API}${path}`, {
      method: opts?.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-YTM-Client': 'android',
        ...(opts?.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(45_000),
    });
    const text = await r.text();
    let j: unknown = text;
    try {
      j = JSON.parse(text);
    } catch {
      /* raw */
    }
    const ok = opts?.expect ? opts.expect(r.status, j) : r.ok;
    const detail =
      typeof j === 'object' && j && 'error' in (j as object)
        ? String((j as { error: unknown }).error)
        : `HTTP ${r.status} (${text.length}b)`;
    add({ area, name, ok, detail, ms: Date.now() - t0, status: r.status });
    return { ok, status: r.status, j, ms: Date.now() - t0 };
  } catch (e) {
    add({
      area,
      name,
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      ms: Date.now() - t0,
    });
    return { ok: false, status: 0, j: null, ms: Date.now() - t0 };
  }
}

async function streamSample(token: string, ids: string[]) {
  const H = {
    Authorization: `Bearer ${token}`,
    'X-YTM-Client': 'android',
    Range: 'bytes=0-65535',
  };
  let okN = 0;
  let failN = 0;
  const fails: string[] = [];
  for (const id of ids.slice(0, SAMPLE)) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${API}/api/stream/${id}`, {
        headers: H,
        signal: AbortSignal.timeout(60_000),
      });
      const buf = Buffer.from(await r.arrayBuffer());
      const cache = r.headers.get('x-plm-stream-cache') || r.headers.get('x-ytm-stream-cache') || '?';
      const good = (r.status === 200 || r.status === 206) && buf.length > 1000;
      if (good) okN += 1;
      else {
        failN += 1;
        fails.push(`${id} HTTP${r.status} ${buf.length}b ${Date.now() - t0}ms`);
      }
    } catch (e) {
      failN += 1;
      fails.push(`${id} ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  add({
    area: 'Stream',
    name: `sample HEAD/partial ×${Math.min(SAMPLE, ids.length)}`,
    ok: failN === 0 || okN / Math.max(1, okN + failN) >= 0.85,
    detail: `ok=${okN} fail=${failN}${fails.length ? ` · ${fails.slice(0, 5).join(' | ')}` : ''}`,
  });
}

function adb(...args: string[]) {
  return spawnSync('adb', ['-s', DEVICE, ...args], { encoding: 'utf8', timeout: 30_000 });
}

function androidSmoke() {
  const pkg = 'ovh.delhomme.ytmusic';
  const dumpsys = adb('shell', 'dumpsys', 'package', pkg);
  const vn = /versionName=([^\s]+)/.exec(dumpsys.stdout || '')?.[1] || '?';
  const vc = /versionCode=(\d+)/.exec(dumpsys.stdout || '')?.[1] || '?';
  add({
    area: 'Android',
    name: 'package installé Blackview',
    ok: vn.startsWith('p+1.3.'),
    detail: `${vn} (code ${vc}) device=${DEVICE}`,
  });

  adb('logcat', '-c');
  const launch = adb(
    'shell',
    'am',
    'start',
    '-n',
    `${pkg}/ovh.delhomme.ytmusic.MainActivity`,
  );
  add({
    area: 'Android',
    name: 'lancement MainActivity',
    ok: (launch.status ?? 1) === 0 && !/Error/i.test(launch.stderr || ''),
    detail: (launch.stdout || launch.stderr || '').trim().slice(0, 160),
  });

  spawnSync('sleep', ['4']);
  const fg = adb('shell', 'dumpsys', 'activity', 'activities');
  const foreground = (fg.stdout || '').includes(pkg);
  add({
    area: 'Android',
    name: 'app au premier plan',
    ok: foreground,
    detail: foreground ? 'activity visible' : 'pas détectée en foreground',
  });

  const logs = adb('logcat', '-d', '-t', '200', '*:E');
  const lines = (logs.stdout || '')
    .split('\n')
    .filter((l) => /ytmusic|delhomme|ExoPlayer|Playback|PLM/i.test(l))
    .slice(-25);
  add({
    area: 'Android',
    name: 'logcat erreurs liées PLM (200 lignes)',
    ok: lines.length < 8,
    detail: lines.length ? `${lines.length} lignes · ${lines.slice(-3).join(' ¦ ')}` : 'aucune',
  });
}

function buildPdf(report: Record<string, unknown>): Promise<string> {
  const require = createRequire(import.meta.url);
  const PDFDocument = require(
    '/home/pactivisme/Documents/Dev/Perso/GasoilTracking/scripts/reports/node_modules/pdfkit',
  );
  const pdfPath = join(OUT_DIR, 'PLM-audit-complet-2026-09-08.pdf');
  const doc = new PDFDocument({
    margin: 48,
    size: 'A4',
    info: { Title: 'PLM — Audit complet', Author: 'PLM QA' },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));

  const okN = checks.filter((c) => c.ok).length;
  const koN = checks.filter((c) => !c.ok).length;

  doc.fontSize(18).text('PLM — Audit application complet');
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#444').text(`Date : ${new Date().toLocaleString('fr-FR')}`);
  doc.text(`API : ${API}`);
  doc.text(`Version live : ${(report.health as { appVersion?: string })?.appVersion || '?'}`);
  doc.text(`Blackview : ${DEVICE} · ${(report.androidVersion as string) || '?'}`);
  doc.text(`Résultat : ${okN} OK · ${koN} KO · ${checks.length} checks`);
  doc.fillColor('#000');
  doc.moveDown();

  doc.fontSize(13).text('1. Ce qui a été livré récemment (session)', { underline: true });
  doc.moveDown(0.4);
  doc.fontSize(9);
  const delivered = [
    '1.3.179 — Icône téléchargé : clic = supprimer le fichier local',
    '1.3.180 — Téléchargement utilisateur survit au seek / rebuffer',
    '1.3.181 — DL offline progressif (anti-DASH) pour que la coche apparaisse vraiment',
    '1.3.182 — Aléatoire / Tout lire : préchauffe #0–#2 AVANT Exo (fin des 50–60 s à froid)',
    '1.3.183 — Accès rapide Aléatoire vraiment aléatoire (plus le même 1er titre figé ~30 min)',
    '1.3.184 — Accès rapide : file des pins en Tout voir + mix épinglés dans Aléatoire + titres de file',
  ];
  for (const line of delivered) doc.text(`• ${line}`, { indent: 8 });
  doc.moveDown();

  doc.fontSize(13).fillColor('#000').text('2. Matrice de vérification', { underline: true });
  doc.moveDown(0.4);
  const byArea = new Map<string, Check[]>();
  for (const c of checks) {
    const list = byArea.get(c.area) || [];
    list.push(c);
    byArea.set(c.area, list);
  }
  for (const [area, list] of byArea) {
    if (doc.y > 720) doc.addPage();
    doc.fontSize(10).fillColor('#111').text(area, { underline: true });
    doc.fontSize(8);
    for (const c of list) {
      const mark = c.ok ? '[OK]' : '[KO]';
      doc.fillColor(c.ok ? '#0a7a2f' : '#b00020').text(
        `${mark} ${c.name}${c.ms != null ? ` (${c.ms} ms)` : ''}`,
        { indent: 6 },
      );
      doc.fillColor('#333').text(`    ${c.detail.slice(0, 220)}`, { indent: 10 });
    }
    doc.moveDown(0.35);
  }

  if (doc.y > 680) doc.addPage();
  doc.fontSize(13).fillColor('#000').text('3. Périmètre couvert', { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(9);
  for (const line of [
    'Auth login · health · version-notes · deploy APK info',
    'Home / explore / search / suggestions',
    'Library full + light · shuffle-heads (all + recent) · pins',
    'History · prefs · radios / reco',
    'Stream warm + sample streams bibliothèque',
    'Lyrics / track meta (échantillon)',
    'Android Blackview : install, lancement, foreground, logcat erreurs',
  ]) {
    doc.text(`• ${line}`, { indent: 8 });
  }
  doc.moveDown();

  doc.fontSize(13).text('4. Points d’attention / restes', { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(9);
  const restes =
    notes.length > 0
      ? notes
      : [
          'Titres jamais vus restent plus lents la 1ʳᵉ fois (normal) puis entrent en cache partagé.',
          'Gate manuelle : Accès rapide Aléatoire ×3 départs différents sur Blackview.',
          'Samsung réservé Gasoil Tracking — gate YTMusic = Blackview.',
        ];
  for (const r of restes) doc.text(`• ${r}`, { indent: 8 });

  doc.moveDown();
  doc.fontSize(8).fillColor('#666').text(`Rapport JSON : ${join(OUT_DIR, 'report.json')}`);

  return new Promise((resolve, reject) => {
    doc.on('end', () => {
      try {
        writeFileSync(pdfPath, Buffer.concat(chunks));
        resolve(pdfPath);
      } catch (e) {
        reject(e);
      }
    });
    doc.on('error', reject);
    doc.end();
  });
}

async function main() {
  console.log('==> Audit PLM complet', API, 'device', DEVICE);

  const healthR = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(15_000) });
  const health = (await healthR.json()) as Record<string, unknown>;
  add({
    area: 'Serveur',
    name: 'GET /api/health',
    ok: healthR.ok && health.ok === true,
    detail: `appVersion=${health.appVersion} ref=${health.ref}`,
    status: healthR.status,
  });

  const { token, email } = await login();

  await hit('Serveur', 'version-notes', '/api/version-notes', token, {
    expect: (s, j) => s === 200 && Array.isArray((j as { versions?: unknown[] })?.versions),
  });
  await hit('Serveur', 'deploy apk info', '/api/deploy/apk/info', token);
  await hit('Auth', 'auth/me', '/api/auth/me', token);
  await hit('Auth', 'auth/config', '/api/auth/config', token);

  await hit('Accueil', 'home', '/api/home', token, {
    expect: (s, j) => s === 200 && !!(j as { shelves?: unknown })?.shelves,
  });
  await hit('Accueil', 'home/more', '/api/home/more', token);
  await hit('Explorer', 'explore', '/api/explore', token);
  await hit('Recherche', 'search q=test', '/api/search?q=test', token);
  await hit('Recherche', 'suggestions', '/api/search/suggestions?q=a', token);

  const lib = await hit('Bibliothèque', 'library full', '/api/library', token, {
    expect: (s, j) => {
      const o = j as { songs?: unknown[]; liked?: unknown[] };
      return s === 200 && (Array.isArray(o.songs) || Array.isArray(o.liked));
    },
  });
  await hit('Bibliothèque', 'library light', '/api/library?light=1&limit=12', token);
  await hit('Bibliothèque', 'shuffle-heads all', '/api/library/shuffle-heads?warm=1&scope=all', token);
  await hit(
    'Bibliothèque',
    'shuffle-heads recent',
    '/api/library/shuffle-heads?warm=1&scope=recent',
    token,
  );
  await hit('Accès rapide', 'pins', '/api/pins', token);
  await hit('Historique', 'history', '/api/history', token);
  await hit('Historique', 'history detailed', '/api/history/detailed', token);
  await hit('Prefs', 'prefs', '/api/prefs', token);
  await hit('Reco', 'radios', '/api/reco/radios', token);
  await hit('Explorer', 'spoken/podcasts', '/api/explore/spoken', token);
  await hit('Offline', 'offline/downloads', '/api/offline/downloads', token);
  await hit('Install', 'install apk-info', '/api/install/apk-info', token);

  // Warm + sample streams from library
  const libJ = lib.j as {
    songs?: { id?: string; title?: string }[];
    liked?: { id?: string }[];
    history?: { id?: string }[];
  };
  const ids = [
    ...(libJ?.songs || []),
    ...(libJ?.liked || []),
    ...(libJ?.history || []),
  ]
    .map((t) => t.id)
    .filter((id): id is string => !!id && id.length === 11);
  const uniq = [...new Set(ids)];

  if (uniq[0]) {
    await hit('Stream', 'warm wait 1 id', '/api/stream/warm', token, {
      method: 'POST',
      body: { ids: uniq.slice(0, 3), wait: true },
      expect: (s) => s === 200 || s === 202,
    });
    await hit('Track', `track/${uniq[0]}`, `/api/track/${uniq[0]}`, token);
    await hit('Paroles', `lyrics/${uniq[0]}`, `/api/track/${uniq[0]}/lyrics`, token, {
      expect: (s) => s === 200 || s === 404,
    });
  }

  const libFull = lib.j as {
    albums?: { id?: string }[];
    playlists?: { id?: string }[];
    artists?: { id?: string }[];
  };
  const albumId = libFull.albums?.[0]?.id;
  const playlistId = libFull.playlists?.[0]?.id;
  const artistId = libFull.artists?.[0]?.id;
  if (albumId) await hit('Détail', `album/${albumId}`, `/api/album/${albumId}`, token);
  if (playlistId) await hit('Détail', `playlist/${playlistId}`, `/api/playlist/${playlistId}`, token);
  if (artistId) await hit('Détail', `artist/${artistId}`, `/api/artist/${artistId}`, token);

  await streamSample(token, uniq);

  androidSmoke();

  const dumpsys = adb('shell', 'dumpsys', 'package', 'ovh.delhomme.ytmusic');
  const androidVersion = /versionName=([^\s]+)/.exec(dumpsys.stdout || '')?.[1] || '?';

  const ko = checks.filter((c) => !c.ok);
  if (ko.length) {
    notes.push(`${ko.length} check(s) en échec — voir matrice §2.`);
    for (const c of ko.slice(0, 12)) notes.push(`KO ${c.area}/${c.name}: ${c.detail}`);
  } else {
    notes.push('Tous les checks automatisés de cette passe sont OK.');
  }
  notes.push(`Compte test API : ${email}`);
  notes.push('Gate appareil YTMusic = Blackview (Samsung = Gasoil Tracking).');

  const report = {
    at: new Date().toISOString(),
    api: API,
    health,
    androidVersion,
    device: DEVICE,
    checks,
    notes,
    ok: checks.filter((c) => c.ok).length,
    ko: ko.length,
  };
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));

  const pdfPath = await buildPdf(report);
  console.log('PDF →', pdfPath);

  const okN = report.ok;
  const koN = report.ko;
  const subject = `[Hubera Music] Audit complet p+1.3.184 — ${okN} OK / ${koN} KO — Blackview`;
  const text = `PLM — Audit application complet
${report.at}
API: ${API}
Version: ${health.appVersion}
Blackview: ${androidVersion}

Résultat: ${okN} OK · ${koN} KO

Livré récemment:
- 1.3.179→181 téléchargements / offline
- 1.3.182 warm Aléatoire avant play
- 1.3.183 Aléatoire Accès rapide vraiment aléatoire
- 1.3.184 file pins + mix + titres de file

PDF joint: ${pdfPath}
JSON: ${join(OUT_DIR, 'report.json')}
`;

  const html = `<div style="font-family:system-ui,sans-serif;max-width:720px;line-height:1.5;color:#111">
  <h1 style="font-size:1.3rem;margin:0 0 6px">PLM — Audit application complet</h1>
  <p style="color:#555;margin:0 0 16px">${new Date().toLocaleString('fr-FR')} · <code>${health.appVersion}</code> · Blackview <code>${androidVersion}</code></p>
  <p><strong>${okN} OK</strong> · <strong style="color:${koN ? '#b00020' : '#0a7a2f'}">${koN} KO</strong> · ${checks.length} checks</p>
  <h2>Livré récemment</h2>
  <ul>
    <li><b>1.3.179–181</b> — téléchargements (toggle supprimer, survit seek, progressif anti-DASH)</li>
    <li><b>1.3.182</b> — préchauffe Aléatoire avant Exo (plus de 50–60 s à froid)</li>
    <li><b>1.3.183</b> — Accès rapide Aléatoire vraiment aléatoire</li>
    <li><b>1.3.184</b> — file des pins, mix épinglés, titres de file</li>
  </ul>
  <p>Rapport détaillé en <b>PDF joint</b> (matrice OK/KO par zone).</p>
</div>`;

  await sendMail({
    to: TO,
    subject,
    html,
    text,
    attachments: [
      {
        filename: 'PLM-audit-complet-2026-09-08.pdf',
        content: readFileSync(pdfPath),
        contentType: 'application/pdf',
      },
    ],
  });
  console.log('Mail envoyé →', TO);
  console.log('OUT', OUT_DIR);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
