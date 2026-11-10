/**
 * Bugs remontés par e-mail (Himalaya) et par Hubera Docs.
 *
 * But : dans Hubera Admin, voir à côté de chaque app les incidents signalés —
 * sans se connecter au VPS ni mélanger les secrets.
 *
 * Himalaya est appelé en JSON (`himalaya envelope list --json`), ce qui donne
 * une sortie stable. Toute erreur (binaire absent, config invalide, réseau
 * filtré, timeout) est capturée et renvoyée en clair, jamais fatale.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Binaire himalaya (surchargeable pour les tests). */
const HIMALAYA_BIN = process.env.HIMALAYA_BIN || 'himalaya';
const TIMEOUT_MS = Math.max(2_000, Number(process.env.HIMALAYA_TIMEOUT_MS || 15_000) || 15_000);
/** Requête de recherche : les incidents produit. */
const QUERY = process.env.HUBERA_BUG_MAIL_QUERY || 'music OR bug OR lecture OR stream';

export type BugItem = {
  source: 'mail' | 'docs';
  id?: string;
  subject: string;
  from?: string;
  date?: string;
  app?: string;
  snippet?: string;
};

export type BugsResult = {
  ok: boolean;
  mail: {
    ok: boolean;
    count: number;
    items: BugItem[];
    error?: string;
    query: string;
    binary: string;
  };
  docs: {
    ok: boolean;
    count: number;
    items: BugItem[];
    error?: string;
    origin: string;
  };
};

/** Détecte quelle app Hubera un sujet concerne (heuristique par mots-clés). */
const APP_HINTS: Array<{ app: string; re: RegExp }> = [
  { app: 'Music', re: /\b(music|musique|lecture|stream|titre|playlist)\b/i },
  { app: 'Fuel', re: /\b(fuel|gasoil|carburant|plein|station|trajet)\b/i },
  { app: 'Jobs', re: /\b(jobs|emploi|jobbing|candidature)\b/i },
  { app: 'Maps', re: /\b(maps|carte|itinéraire|gps|navigation)\b/i },
  { app: 'Docs', re: /\b(docs|documentation|cockpit)\b/i },
  { app: 'Mail', re: /\b(mail|email|imap|smtp|boîte)\b/i },
  { app: 'Drive', re: /\b(drive|fichiers|stockage)\b/i },
  { app: 'Photos', re: /\b(photos|images|galerie)\b/i },
  { app: 'Tasks', re: /\b(tasks|tâches|taskflow)\b/i },
  { app: 'Pass', re: /\b(pass|mots de passe|coffre)\b/i },
];

export function guessApp(text: string): string | undefined {
  const t = String(text || '');
  for (const h of APP_HINTS) if (h.re.test(t)) return h.app;
  return undefined;
}

type HimalayaEnvelope = {
  id?: string | number;
  subject?: string;
  from?: { name?: string; addr?: string } | string;
  date?: string;
  flags?: unknown;
};

function senderOf(from: HimalayaEnvelope['from']): string | undefined {
  if (!from) return undefined;
  if (typeof from === 'string') return from;
  return from.addr ? (from.name ? `${from.name} <${from.addr}>` : from.addr) : from.name;
}

/**
 * Liste les e-mails d'incident via Himalaya (JSON, non interactif).
 * Ne jette jamais : renvoie l'erreur dans `error`.
 */
export async function listBugMails(opts?: { limit?: number }): Promise<BugsResult['mail']> {
  const limit = Math.max(1, Math.min(50, opts?.limit ?? 10));
  const base = {
    ok: false,
    count: 0,
    items: [] as BugItem[],
    query: QUERY,
    binary: HIMALAYA_BIN,
  };
  try {
    const { stdout } = await run(
      HIMALAYA_BIN,
      ['envelope', 'search', '--json', '-s', String(limit), QUERY],
      { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    const parsed = JSON.parse(String(stdout || '[]')) as
      | HimalayaEnvelope[]
      | { envelopes?: HimalayaEnvelope[] };
    const rows = Array.isArray(parsed) ? parsed : parsed?.envelopes || [];
    const items: BugItem[] = rows.map((r) => {
      const subject = String(r.subject || '(sans objet)');
      return {
        source: 'mail' as const,
        id: r.id != null ? String(r.id) : undefined,
        subject,
        from: senderOf(r.from),
        date: r.date ? String(r.date) : undefined,
        app: guessApp(subject),
      };
    });
    return { ...base, ok: true, count: items.length, items };
  } catch (err) {
    const e = err as { message?: string; stderr?: string; killed?: boolean };
    const detail = e.killed
      ? `timeout ${TIMEOUT_MS} ms`
      : String(e.stderr || e.message || err).split('\n')[0].slice(0, 200);
    return { ...base, error: detail };
  }
}

/**
 * Bugs ouverts côté Hubera Docs (projet music ou tous).
 * Utilise le jeton de service s'il est présent ; sinon renvoie une info.
 */
export async function listDocsBugs(opts?: { limit?: number }): Promise<BugsResult['docs']> {
  const origin = (process.env.DOCS_API_URL || 'https://docs.hubera.cloud').replace(/\/$/, '');
  const token =
    process.env.DOCS_SERVICE_TOKEN || process.env.HUBERA_DOCS_TOKEN || process.env.DOCS_API_TOKEN || '';
  const base = { ok: false, count: 0, items: [] as BugItem[], origin };
  if (!token) return { ...base, error: 'DOCS_SERVICE_TOKEN non configuré' };
  try {
    const res = await fetch(`${origin}/api/tasks?category=bug`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { ...base, error: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => ({}))) as { tasks?: Array<Record<string, unknown>> };
    const rows = Array.isArray(body?.tasks) ? body.tasks : [];
    const limit = Math.max(1, Math.min(100, opts?.limit ?? 30));
    const items: BugItem[] = rows.slice(0, limit).map((t) => {
      const subject = String(t.title || '(sans titre)');
      return {
        source: 'docs' as const,
        id: t.id != null ? String(t.id) : undefined,
        subject,
        date: t.created_at ? new Date(Number(t.created_at)).toISOString() : undefined,
        app: String(t.project || guessApp(subject) || ''),
        snippet: String(t.body || '').slice(0, 200),
      };
    });
    return { ...base, ok: true, count: items.length, items };
  } catch (err) {
    return { ...base, error: String((err as Error).message || err).slice(0, 160) };
  }
}

/** Vue consolidée pour l'UI Hubera Admin. */
export async function bugsOverview(opts?: { limit?: number }): Promise<BugsResult> {
  const [mail, docs] = await Promise.all([listBugMails(opts), listDocsBugs(opts)]);
  return { ok: mail.ok || docs.ok, mail, docs };
}
