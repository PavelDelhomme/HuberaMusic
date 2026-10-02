import { networkInterfaces } from 'node:os';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { db } from '../library/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const APK_PUBLIC_DIR = join(ROOT, 'data', 'public', 'android');
const APK_PATH = join(APK_PUBLIC_DIR, 'ytmusic.apk');
const APK_MANIFEST = join(APK_PUBLIC_DIR, 'manifest.json');
const APK_HUBERA_PATH = join(APK_PUBLIC_DIR, 'hubera-music.apk');
const APK_HUBERA_MANIFEST = join(APK_PUBLIC_DIR, 'hubera-manifest.json');
export const MUSIC_PKG_LEGACY = 'ovh.delhomme.ytmusic';
export const MUSIC_PKG_HUBERA = 'cloud.hubera.music';

mkdirSync(APK_PUBLIC_DIR, { recursive: true });

let buildJob: {
  status: 'idle' | 'running' | 'ok' | 'error';
  startedAt?: number;
  finishedAt?: number;
  log: string;
} = { status: 'idle', log: '' };

let apkJob: {
  status: 'idle' | 'running' | 'ok' | 'error';
  startedAt?: number;
  finishedAt?: number;
  log: string;
  apiBaseUrl?: string;
} = { status: 'idle', log: '' };

export function lanAddresses() {
  const nets = networkInterfaces();
  const out: { address: string; iface: string }[] = [];
  for (const [iface, list] of Object.entries(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) {
        out.push({ address: n.address, iface });
      }
    }
  }
  return out;
}

function isLoopbackUrl(url: string) {
  return /127\.0\.0\.1|localhost/i.test(url);
}

function isPrivateHostUrl(url: string) {
  try {
    const h = new URL(url).hostname;
    if (isLoopbackUrl(url)) return true;
    if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
    if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(h)) return true;
    return false;
  } catch {
    return true;
  }
}

const CANONICAL_MUSIC_URL = 'https://music.hubera.cloud';

function isLegacyMusicHostUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return (
      h === 'plm.delhomme.ovh' ||
      h === 'www.plm.delhomme.ovh' ||
      h === 'ytmusic.delhomme.ovh' ||
      h === 'ytm.delhomme.ovh' ||
      h === 'pue-la-merde.delhomme.ovh' ||
      h === 'peule-la-merde.delhomme.ovh' ||
      h === 'plm.hubera.cloud'
    );
  } catch {
    return /plm\.delhomme\.ovh|ytmusic\.delhomme\.ovh|ytm\.delhomme\.ovh|pue-la-merde\.delhomme\.ovh|peule-la-merde\.delhomme\.ovh|plm\.hubera\.cloud/i.test(url);
  }
}

/** Liens publics (share, install, QR) — music.hubera.cloud ; alias PLM conservés. */
export function canonicalMusicUrl(url?: string | null): string {
  const raw = String(url || '').trim().replace(/\/$/, '');
  if (!raw || isPrivateHostUrl(raw) || isLegacyMusicHostUrl(raw)) return CANONICAL_MUSIC_URL;
  return raw;
}

/** Base publique pour liens APK / QR (jamais IP Docker / LAN privée en prod). */
export function publicDownloadBase(port: number): string {
  const candidates = [
    process.env.PUBLIC_APP_URL,
    process.env.PROD_APP_URL,
    process.env.DEPLOY_URL,
    process.env.WEBAUTHN_ORIGIN,
    process.env.APP_URL,
  ]
    .map((x) => String(x || '').trim().replace(/\/$/, ''))
    .filter(Boolean);
  for (const c of candidates) {
    if (!isPrivateHostUrl(c) && !isLegacyMusicHostUrl(c)) return c;
  }
  const env = (process.env.APP_ENV || 'local').toLowerCase();
  if (env === 'production' || env === 'prod' || env === 'preprod') {
    return CANONICAL_MUSIC_URL;
  }
  const lan = lanAddresses()[0];
  return lan ? `http://${lan.address}:${port}` : `http://127.0.0.1:${port}`;
}

/** URL API à figer dans l’APK (hors Wi‑Fi = APP_URL / ANDROID_API_BASE_URL). */
export function resolveAndroidApiBaseUrl(
  prefer: 'auto' | 'lan' | 'app_url' | string = 'auto',
  port = Number(process.env.PORT || 8787),
): string {
  const explicit = (process.env.ANDROID_API_BASE_URL || '').trim().replace(/\/$/, '');
  const appUrl = (process.env.APP_URL || '').trim().replace(/\/$/, '');
  const env = (process.env.APP_ENV || 'local').toLowerCase();
  const lan = lanAddresses()[0]?.address;
  const lanUrl = lan ? `http://${lan}:${port}` : `http://127.0.0.1:${port}`;

  if (prefer && prefer !== 'auto' && prefer !== 'lan' && prefer !== 'app_url') {
    return prefer.replace(/\/$/, '');
  }
  if (prefer === 'lan') return lanUrl;
  if (prefer === 'app_url') {
    if (appUrl && !isLoopbackUrl(appUrl)) return appUrl;
    if (explicit && !isLoopbackUrl(explicit)) return explicit;
    return appUrl || lanUrl;
  }

  if (explicit) {
    if (!isPrivateHostUrl(explicit) || env === 'local') return explicit;
  }
  if (
    (env === 'production' || env === 'prod' || env === 'preprod')
  ) {
    if (appUrl && !isPrivateHostUrl(appUrl) && !isLegacyMusicHostUrl(appUrl)) return appUrl;
    return CANONICAL_MUSIC_URL;
  }
  if (appUrl && !isLoopbackUrl(appUrl) && !isPrivateHostUrl(appUrl)) return appUrl;
  if (appUrl && !isLoopbackUrl(appUrl)) return appUrl;
  return lanUrl;
}

export type ApkManifest = {
  file: string;
  apiBaseUrl: string;
  appEnv: string;
  versionName: string;
  versionCode: number;
  sizeBytes: number;
  builtAt: string | null;
  package: string;
};

export function readApkManifest(): ApkManifest | null {
  if (!existsSync(APK_MANIFEST)) return null;
  try {
    return JSON.parse(readFileSync(APK_MANIFEST, 'utf8')) as ApkManifest;
  } catch {
    return null;
  }
}

export function normalizeMusicPackage(pkg?: string | null): string | null {
  const p = String(pkg || '').trim();
  if (p === MUSIC_PKG_HUBERA || p === `${MUSIC_PKG_HUBERA}.dev` || p === `${MUSIC_PKG_HUBERA}.preprod`) {
    return MUSIC_PKG_HUBERA;
  }
  if (p === MUSIC_PKG_LEGACY) return MUSIC_PKG_LEGACY;
  return null;
}

function readNamedManifest(file: string): ApkManifest | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ApkManifest;
  } catch {
    return null;
  }
}

export function apkSlotForPackage(pkg?: string | null): {
  path: string;
  manifestPath: string;
  pkg: string;
  file: string;
} {
  const norm = normalizeMusicPackage(pkg);
  // Par défaut le canal Hubera (cloud.hubera.music). Le legacy n’est servi
  // que si le téléphone envoie explicitement ovh.delhomme.ytmusic.
  if (norm === MUSIC_PKG_LEGACY) {
    return {
      path: APK_PATH,
      manifestPath: APK_MANIFEST,
      pkg: MUSIC_PKG_LEGACY,
      file: 'ytmusic.apk',
    };
  }
  return {
    path: APK_HUBERA_PATH,
    manifestPath: APK_HUBERA_MANIFEST,
    pkg: MUSIC_PKG_HUBERA,
    file: 'hubera-music.apk',
  };
}

export function apkPublicInfo(port: number, pkg?: string | null) {
  const slot = apkSlotForPackage(pkg);
  const manifest = readNamedManifest(slot.manifestPath) || (slot.pkg === MUSIC_PKG_LEGACY ? readApkManifest() : null);
  const ready = existsSync(slot.path);
  const st = ready ? statSync(slot.path) : null;
  const targetApi = resolveAndroidApiBaseUrl('auto', port);
  const appUrl = (process.env.APP_URL || '').trim().replace(/\/$/, '');
  const publicBase = publicDownloadBase(port);
  const q = slot.pkg === MUSIC_PKG_HUBERA ? '?package=cloud.hubera.music' : '?package=ovh.delhomme.ytmusic';
  return {
    ready,
    path: ready ? slot.path : null,
    sizeBytes: st?.size ?? manifest?.sizeBytes ?? null,
    builtAt: manifest?.builtAt ?? (st ? new Date(st.mtimeMs).toISOString() : null),
    apiBaseUrl: manifest?.apiBaseUrl ?? CANONICAL_MUSIC_URL,
    versionName: manifest?.versionName ?? null,
    versionCode: manifest?.versionCode ?? null,
    package: manifest?.package ?? slot.pkg,
    targetApiBaseUrl: targetApi,
    appEnv: process.env.APP_ENV || 'local',
    appUrl: appUrl || null,
    androidApiBaseUrl: (process.env.ANDROID_API_BASE_URL || '').trim() || null,
    downloadPath: `/api/deploy/apk${q}`,
    downloadUrl: `${publicBase}/api/deploy/apk${q}`,
    presets: {
      lan: resolveAndroidApiBaseUrl('lan', port),
      app_url: resolveAndroidApiBaseUrl('app_url', port),
      production: CANONICAL_MUSIC_URL,
      preprod: 'https://ytmusic-preprod.delhomme.ovh',
    },
    job: apkJob,
    sdkReady: existsSync(join(ROOT, 'mobile-android', 'gradlew')),
  };
}

export function getApkPath(pkg?: string | null) {
  const slot = apkSlotForPackage(pkg);
  if (existsSync(slot.path)) return slot.path;
  if (slot.pkg === MUSIC_PKG_HUBERA && existsSync(APK_PATH)) return APK_PATH;
  if (existsSync(APK_PATH)) return APK_PATH;
  return null;
}

export function deployInfo(port: number) {
  const lan = lanAddresses();
  const clientDist = join(ROOT, 'web', 'dist', 'index.html');
  const built = existsSync(clientDist);
  const desktopPkg = join(ROOT, 'desktop', 'package.json');
  const clientPort = Number(process.env.CLIENT_PORT || 5173);
  const servingDist =
    process.env.SERVE_DIST === '1' ||
    (process.env.NODE_ENV === 'production' && built);
  const appPort = servingDist ? port : clientPort;
  const urls = [
    `http://localhost:${appPort}`,
    ...lan.map((l) => `http://${l.address}:${appPort}`),
  ];
  const viteUrls = !servingDist
    ? []
    : lan.map((l) => `http://${l.address}:${clientPort}`);
  return {
    port,
    clientPort,
    appPort,
    mode: servingDist ? 'production' : 'development',
    built,
    builtAt: built ? statSync(clientDist).mtimeMs : null,
    lan,
    urls: [...urls, ...viteUrls.filter((u) => !urls.includes(u))],
    desktopReady: existsSync(desktopPkg),
    ytdlp: existsSync(join(ROOT, 'bin', 'yt-dlp')),
    users: (
      db.prepare('SELECT COUNT(*) as c FROM users WHERE email NOT LIKE ?').get('%@local.ytmusic') as {
        c: number;
      }
    ).c,
    guests: (
      db.prepare('SELECT COUNT(*) as c FROM users WHERE email LIKE ?').get('%@local.ytmusic') as {
        c: number;
      }
    ).c,
    buildJob,
    apk: apkPublicInfo(port, MUSIC_PKG_HUBERA),
    tip: servingDist
      ? 'Prod : ouvre le domaine NPM ou les URLs ci-dessus'
      : 'Mobile LAN : PWA via QR, ou APK natif (URL API figée, hors Wi‑Fi OK)',
  };
}

export function getBuildJob() {
  return buildJob;
}

export function startBuild() {
  if (buildJob.status === 'running') return buildJob;
  buildJob = { status: 'running', startedAt: Date.now(), log: '' };
  const child = spawn('npm', ['run', 'build'], {
    cwd: ROOT,
    shell: true,
    env: process.env,
  });
  child.stdout?.on('data', (d) => {
    buildJob.log += d.toString();
    if (buildJob.log.length > 20000) buildJob.log = buildJob.log.slice(-16000);
  });
  child.stderr?.on('data', (d) => {
    buildJob.log += d.toString();
    if (buildJob.log.length > 20000) buildJob.log = buildJob.log.slice(-16000);
  });
  child.on('close', (code) => {
    buildJob.status = code === 0 ? 'ok' : 'error';
    buildJob.finishedAt = Date.now();
  });
  return buildJob;
}

export function getApkJob() {
  return { ...apkJob, apk: apkPublicInfo(Number(process.env.PORT || 8787)) };
}

/** Lance la compilation + publication APK (nécessite Android SDK sur la machine). */
export function startApkBuild(
  prefer: 'auto' | 'lan' | 'app_url' | string = 'auto',
  port = Number(process.env.PORT || 8787),
) {
  if (apkJob.status === 'running') return getApkJob();
  const apiBaseUrl = resolveAndroidApiBaseUrl(prefer, port);
  mkdirSync(APK_PUBLIC_DIR, { recursive: true });
  apkJob = {
    status: 'running',
    startedAt: Date.now(),
    log: `API_BASE_URL=${apiBaseUrl}\n`,
    apiBaseUrl,
  };
  const script = join(ROOT, 'scripts', 'android', 'android-publish-apk.sh');
  const child = spawn('bash', [script], {
    cwd: ROOT,
    env: {
      ...process.env,
      API_BASE_URL: apiBaseUrl,
    },
  });
  child.stdout?.on('data', (d) => {
    apkJob.log += d.toString();
    if (apkJob.log.length > 40000) apkJob.log = apkJob.log.slice(-32000);
  });
  child.stderr?.on('data', (d) => {
    apkJob.log += d.toString();
    if (apkJob.log.length > 40000) apkJob.log = apkJob.log.slice(-32000);
  });
  child.on('close', (code) => {
    apkJob.status = code === 0 ? 'ok' : 'error';
    apkJob.finishedAt = Date.now();
    if (code === 0 && !existsSync(APK_MANIFEST)) {
      try {
        const st = existsSync(APK_PATH) ? statSync(APK_PATH) : null;
        writeFileSync(
          APK_MANIFEST,
          JSON.stringify(
            {
              file: 'ytmusic.apk',
              apiBaseUrl,
              appEnv: process.env.APP_ENV || 'local',
              versionName: 'unknown',
              versionCode: 0,
              sizeBytes: st?.size ?? 0,
              builtAt: new Date().toISOString(),
              package: 'ovh.delhomme.ytmusic',
            },
            null,
            2,
          ),
        );
      } catch {
        /* ignore */
      }
    }
  });
  child.on('error', (err) => {
    apkJob.status = 'error';
    apkJob.finishedAt = Date.now();
    apkJob.log += `\n${String(err)}\n`;
  });
  return getApkJob();
}

function writeApkManifest(meta: {
  apiBaseUrl: string;
  versionName?: string;
  versionCode?: number;
  sizeBytes: number;
  package?: string;
}) {
  const slot = apkSlotForPackage(meta.package);
  const payload = {
    file: slot.file,
    apiBaseUrl: (meta.apiBaseUrl || CANONICAL_MUSIC_URL).replace(/\/$/, ''),
    appEnv: process.env.APP_ENV || 'production',
    versionName: meta.versionName || 'upload',
    versionCode: meta.versionCode ?? 0,
    sizeBytes: meta.sizeBytes,
    builtAt: new Date().toISOString(),
    package: slot.pkg,
  };
  writeFileSync(slot.manifestPath, JSON.stringify(payload, null, 2) + '\n');
  return payload;
}

/**
 * Publie une APK déjà compilée (upload Admin / Portainer sans SDK Android).
 * Le fichier vit dans le volume `ytmusic_data` → `/app/data/public/android/`.
 */
export function publishApkBuffer(
  buffer: Buffer,
  meta: { apiBaseUrl: string; versionName?: string; versionCode?: number; package?: string },
) {
  if (!buffer?.length || buffer.length < 1024) {
    throw new Error('Fichier APK vide ou trop petit');
  }
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('Fichier invalide (pas une APK/ZIP)');
  }
  mkdirSync(APK_PUBLIC_DIR, { recursive: true });
  const slot = apkSlotForPackage(meta.package);
  writeFileSync(slot.path, buffer);
  const manifest = writeApkManifest({
    apiBaseUrl: meta.apiBaseUrl || CANONICAL_MUSIC_URL,
    versionName: meta.versionName,
    versionCode: meta.versionCode,
    sizeBytes: buffer.length,
    package: slot.pkg,
  });
  apkJob = {
    status: 'ok',
    startedAt: Date.now(),
    finishedAt: Date.now(),
    log: `Upload APK ${buffer.length} octets → ${slot.path}\npackage=${slot.pkg}\napiBaseUrl=${manifest.apiBaseUrl}\n`,
    apiBaseUrl: manifest.apiBaseUrl,
  };
  return { ...manifest, path: slot.path, ready: true, downloadPath: `/api/deploy/apk?package=${encodeURIComponent(slot.pkg)}` };
}
