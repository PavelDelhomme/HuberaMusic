import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicDownloadBase } from './admin.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PATH = join(ROOT, 'data', 'apk-tickets.json');
const TTL_MS = 30 * 60_000;
const MAX_UNUSED = 4;

export type ApkTicketReason = 'download' | 'register';

type Ticket = {
  token: string;
  reason: ApkTicketReason;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  createdBy?: string;
};

type Store = { tickets: Ticket[] };

function ensureDir() {
  const dir = join(ROOT, 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function load(): Store {
  try {
    if (!existsSync(PATH)) return { tickets: [] };
    const raw = JSON.parse(readFileSync(PATH, 'utf8')) as Store;
    return { tickets: Array.isArray(raw.tickets) ? raw.tickets : [] };
  } catch {
    return { tickets: [] };
  }
}

function save(store: Store) {
  ensureDir();
  writeFileSync(PATH, `${JSON.stringify(store)}\n`, 'utf8');
}

function prune(tickets: Ticket[], now = Date.now()): Ticket[] {
  const live = tickets.filter((t) => !t.usedAt && t.expiresAt > now);
  const used = tickets.filter((t) => t.usedAt && now - t.usedAt < 24 * 3600_000);
  const unused = live.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_UNUSED);
  return [...unused, ...used].slice(0, 40);
}

export function issueApkTicket(
  reason: ApkTicketReason,
  createdBy?: string,
  port = Number(process.env.PORT || 8787),
) {
  const now = Date.now();
  const store = load();
  // Un seul lien vivant : les précédents non utilisés meurent
  for (const t of store.tickets) {
    if (!t.usedAt) t.usedAt = now;
  }
  const token = randomBytes(18).toString('base64url');
  const ticket: Ticket = {
    token,
    reason,
    createdAt: now,
    expiresAt: now + TTL_MS,
    usedAt: null,
    createdBy,
  };
  store.tickets = prune([ticket, ...store.tickets], now);
  save(store);
  const base = publicDownloadBase(port);
  const url = `${base}/api/deploy/apk?t=${encodeURIComponent(token)}`;
  return { token, url, reason, expiresAt: ticket.expiresAt, ttlSec: Math.round(TTL_MS / 1000) };
}

/** Consomme le ticket (1er GET gagne, même si le fichier APK manque ensuite). */
export function consumeApkTicket(token: string): { ok: true; reason: ApkTicketReason } | { ok: false; error: string } {
  const raw = String(token || '').trim();
  if (!raw) return { ok: false, error: 'ticket manquant' };
  const now = Date.now();
  const store = load();
  const t = store.tickets.find((x) => x.token === raw);
  if (!t) return { ok: false, error: 'lien invalide ou déjà régénéré' };
  if (t.usedAt) return { ok: false, error: 'lien déjà utilisé — demande un nouveau QR' };
  if (t.expiresAt <= now) {
    t.usedAt = now;
    save(store);
    return { ok: false, error: 'lien expiré' };
  }
  t.usedAt = now;
  save(store);
  return { ok: true, reason: t.reason };
}

export function latestLiveApkTicket(port = Number(process.env.PORT || 8787)) {
  const now = Date.now();
  const live = load().tickets.find((t) => !t.usedAt && t.expiresAt > now);
  if (!live) return null;
  const base = publicDownloadBase(port);
  return {
    token: live.token,
    url: `${base}/api/deploy/apk?t=${encodeURIComponent(live.token)}`,
    reason: live.reason,
    expiresAt: live.expiresAt,
  };
}
