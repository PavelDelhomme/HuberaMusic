import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicDownloadBase } from './admin.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PATH = join(ROOT, 'data', 'apk-tickets.json');
const TTL_MS = 30 * 60_000;
const PUBLIC_TTL_MS = 2 * 60 * 60_000;
const MAX_UNUSED = 8;

export type ApkTicketReason = 'download' | 'register' | 'public';

type Ticket = {
  token: string;
  reason: ApkTicketReason;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  createdBy?: string;
  /** Téléchargements restants (prefetch MIUI / Chrome). */
  maxUses: number;
  uses: number;
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
    const tickets = (Array.isArray(raw.tickets) ? raw.tickets : []).map((t) => ({
      ...t,
      maxUses: typeof t.maxUses === 'number' ? t.maxUses : 1,
      uses: typeof t.uses === 'number' ? t.uses : t.usedAt ? 1 : 0,
    }));
    return { tickets };
  } catch {
    return { tickets: [] };
  }
}

function save(store: Store) {
  ensureDir();
  writeFileSync(PATH, `${JSON.stringify(store)}\n`, 'utf8');
}

function prune(tickets: Ticket[], now = Date.now()): Ticket[] {
  const live = tickets.filter(
    (t) => t.expiresAt > now && (t.uses < (t.maxUses || 1) || !t.usedAt),
  );
  const used = tickets.filter((t) => t.usedAt && now - t.usedAt < 24 * 3600_000);
  const unused = live.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_UNUSED);
  return [...unused, ...used].slice(0, 60);
}

export function issueApkTicket(
  reason: ApkTicketReason,
  createdBy?: string,
  port = Number(process.env.PORT || 8787),
  opts: { exclusive?: boolean; maxUses?: number; ttlMs?: number } = {},
) {
  const now = Date.now();
  const store = load();
  const exclusive = opts.exclusive !== false && reason !== 'public';
  // Admin QR exclusif : invalide les précédents non consommés (sauf tickets public)
  if (exclusive) {
    for (const t of store.tickets) {
      if (!t.usedAt && t.reason !== 'public') {
        t.usedAt = now;
        t.uses = t.maxUses || 1;
      }
    }
  }
  const token = randomBytes(18).toString('base64url');
  const maxUses = Math.max(1, opts.maxUses ?? (reason === 'public' ? 8 : 1));
  const ttl = opts.ttlMs ?? (reason === 'public' ? PUBLIC_TTL_MS : TTL_MS);
  const ticket: Ticket = {
    token,
    reason,
    createdAt: now,
    expiresAt: now + ttl,
    usedAt: null,
    createdBy,
    maxUses,
    uses: 0,
  };
  store.tickets = prune([ticket, ...store.tickets], now);
  save(store);
  const base = publicDownloadBase(port);
  const url = `${base}/api/deploy/apk?t=${encodeURIComponent(token)}`;
  return {
    token,
    url,
    reason,
    expiresAt: ticket.expiresAt,
    ttlSec: Math.round(ttl / 1000),
    maxUses,
  };
}

/** Consomme 1 crédit du ticket (plusieurs GET OK pour prefetch MIUI). */
export function consumeApkTicket(
  token: string,
): { ok: true; reason: ApkTicketReason } | { ok: false; error: string } {
  const raw = String(token || '').trim();
  if (!raw) return { ok: false, error: 'ticket manquant' };
  const now = Date.now();
  const store = load();
  const t = store.tickets.find((x) => x.token === raw);
  if (!t) return { ok: false, error: 'lien invalide ou déjà régénéré' };
  if (t.expiresAt <= now) {
    t.usedAt = now;
    save(store);
    return { ok: false, error: 'lien expiré' };
  }
  const max = t.maxUses || 1;
  if (t.uses >= max) {
    return { ok: false, error: 'lien déjà utilisé — ouvre /install pour un nouveau téléchargement' };
  }
  t.uses += 1;
  if (t.uses >= max) t.usedAt = now;
  save(store);
  return { ok: true, reason: t.reason };
}

export function latestLiveApkTicket(port = Number(process.env.PORT || 8787)) {
  const now = Date.now();
  const live = load().tickets.find(
    (t) => t.expiresAt > now && t.uses < (t.maxUses || 1),
  );
  if (!live) return null;
  const base = publicDownloadBase(port);
  return {
    token: live.token,
    url: `${base}/api/deploy/apk?t=${encodeURIComponent(live.token)}`,
    reason: live.reason,
    expiresAt: live.expiresAt,
    remainingUses: (live.maxUses || 1) - live.uses,
  };
}

/** Anti-abus léger pour tickets publics (mémoire process). */
const publicHits = new Map<string, number[]>();

export function allowPublicApkTicket(ip: string, limit = 12, windowMs = 60 * 60_000): boolean {
  const now = Date.now();
  const key = ip || 'unknown';
  const prev = (publicHits.get(key) || []).filter((t) => now - t < windowMs);
  if (prev.length >= limit) {
    publicHits.set(key, prev);
    return false;
  }
  prev.push(now);
  publicHits.set(key, prev);
  return true;
}
