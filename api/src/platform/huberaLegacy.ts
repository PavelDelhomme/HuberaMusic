import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendMail } from './mail.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STORE = join(ROOT, 'data', 'hubera-legacy-pings.json');
const STALE_MS = Number(process.env.HUBERA_LEGACY_STALE_DAYS || 21) * 86400000;

export type HuberaNotice = {
  brand: string;
  message: string;
  canonical_url: string;
  legacy_url: string;
  keep_package: string;
  channel: string;
};

export function huberaNotice(): HuberaNotice {
  return {
    brand: 'Hubera Music',
    channel: 'music',
    keep_package: 'ovh.delhomme.ytmusic',
    canonical_url: 'https://music.hubera.cloud',
    legacy_url: 'https://plm.delhomme.ovh',
    message:
      'PLM fait partie de Hubera Music. Ton compte, tes playlists et tes données restent. ' +
      'Nouveau domaine : music.hubera.cloud — plm.delhomme.ovh et ytmusic.delhomme.ovh continuent de marcher. ' +
      'Même application (package inchangé), pas de réinstallation Play Store.',
  };
}

type Ping = {
  version: string;
  versionCode: number;
  huberaAware: boolean;
  lastSeen: string;
  userAgent: string;
};

type Store = {
  clients: Record<string, Ping>;
  clearedMailSentAt: string | null;
};

function load(): Store {
  if (!existsSync(STORE)) return { clients: {}, clearedMailSentAt: null };
  try {
    const raw = JSON.parse(readFileSync(STORE, 'utf8')) as Store;
    return {
      clients: raw.clients || {},
      clearedMailSentAt: raw.clearedMailSentAt || null,
    };
  } catch {
    return { clients: {}, clearedMailSentAt: null };
  }
}

function save(store: Store) {
  mkdirSync(dirname(STORE), { recursive: true });
  writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

function alertTo(): string[] {
  const raw =
    process.env.HUBERA_ALERT_TO ||
    process.env.TELEMETRY_ALERT_TO ||
    process.env.ADMIN_EMAILS ||
    '';
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.includes('@'));
}

export function recordHuberaPing(input: {
  install?: string | null;
  version?: string | null;
  versionCode?: number | null;
  huberaAware?: boolean;
  userAgent?: string | null;
}): Store {
  const id = String(input.install || '').trim() || 'anonymous';
  const store = load();
  store.clients[id] = {
    version: String(input.version || '').trim() || 'unknown',
    versionCode: Number(input.versionCode) || 0,
    huberaAware: Boolean(input.huberaAware),
    lastSeen: new Date().toISOString(),
    userAgent: String(input.userAgent || '').slice(0, 180),
  };
  save(store);
  void maybeNotifyCleared(store);
  return store;
}

export function huberaLegacyStatus() {
  const store = load();
  const now = Date.now();
  const active = Object.values(store.clients).filter(
    (c) => now - Date.parse(c.lastSeen) < STALE_MS,
  );
  const legacy = active.filter((c) => !c.huberaAware);
  const aware = active.filter((c) => c.huberaAware);
  return {
    app: 'music',
    name: 'Hubera Music / PLM',
    package: 'ovh.delhomme.ytmusic',
    stale_days: STALE_MS / 86400000,
    active_installs: active.length,
    legacy_installs: legacy.length,
    hubera_aware_installs: aware.length,
    cleared: active.length > 0 && legacy.length === 0,
    cleared_mail_sent_at: store.clearedMailSentAt,
    notice: huberaNotice(),
  };
}

async function maybeNotifyCleared(store: Store) {
  const status = huberaLegacyStatus();
  if (!status.cleared || store.clearedMailSentAt) return;
  const to = alertTo();
  if (!to.length) {
    console.warn('[hubera-legacy] cleared mais HUBERA_ALERT_TO / ADMIN_EMAILS vide');
    return;
  }
  const n = huberaNotice();
  try {
    await sendMail({
      to: to.join(', '),
      subject: 'Hubera — plus aucun client PLM sur l’ancienne app',
      text:
        `Plus aucun install actif (vu < ${status.stale_days} j) n’utilise une version PLM sans Hubera.\n` +
        `Installs Hubera-aware : ${status.hubera_aware_installs}.\n` +
        `Package inchangé : ${n.keep_package}. Stack ytmusic / volume ytmusic_data inchangés.\n` +
        `Canonique : ${n.canonical_url}`,
      html:
        `<p>Plus aucun install actif (vu &lt; ${status.stale_days} j) n’utilise une version PLM sans Hubera.</p>` +
        `<p>Installs Hubera-aware : <strong>${status.hubera_aware_installs}</strong>.</p>` +
        `<p>Package inchangé : <code>${n.keep_package}</code>. Stack <code>ytmusic</code> conservée.</p>` +
        `<p>Canonique : <a href="${n.canonical_url}">${n.canonical_url}</a></p>`,
    });
    store.clearedMailSentAt = new Date().toISOString();
    save(store);
  } catch (err) {
    console.error('[hubera-legacy] mail', err);
  }
}

export function pingFromRequest(query: Record<string, unknown>, ua: string | undefined) {
  const awareRaw = String(query.huberaAware ?? query.hubera_aware ?? '');
  return recordHuberaPing({
    install: String(query.install || query.installId || ''),
    version: String(query.clientVersion || query.version || ''),
    versionCode: Number(query.clientVersionCode || query.versionCode || 0),
    huberaAware: awareRaw === '1' || awareRaw === 'true',
    userAgent: ua,
  });
}
