/**
 * Agrégateur des `user-cases.json` de chaque dépôt Hubera + bugs remontés.
 *
 * Chaque produit Hubera dépose un `user-cases.json` (parcours Admin + Standard)
 * à sa racine. Hubera Admin les lit et les affiche en diagramme Mermaid.
 * Les bugs proviennent de deux sources :
 *  - **Hubera Docs** (projet/catégorie `bug`) — via l'API Docs ;
 *  - **e-mails Himalaya** — boîte `INBOX`, recherche « music OR bug ».
 *
 * Aucun secret : les chemins de lecture sont configurables, jamais de mot de passe.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * Racine des dépôts produits. Par défaut, les dépôts Git vivent côte à côte
 * dans `Dev/Perso/` (YTMusic, GasoilTracking…) ; le dossier `products/` de
 * HuberaCloud est un jeu de symlinks vers eux. On accepte les deux, et
 * `HUBERA_PRODUCTS_DIR` force le choix.
 */
function resolveProductsDir(): string {
  const candidates = [
    process.env.HUBERA_PRODUCTS_DIR,
    join(__dirname, '..', '..', '..', '..', 'products'),
    join(__dirname, '..', '..', '..', 'products'),
    join(__dirname, '..', '..', '..', '..'),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (existsSync(join(c, 'YTMusic', 'user-cases.json'))) return c;
    } catch {
      /* ignore */
    }
  }
  return candidates[1] as string;
}
const PRODUCTS_DIR = resolveProductsDir();

export type Role = 'admin' | 'standard';

export type UserCase = {
  id: string;
  title: string;
  role: Role | string;
  flow?: string[];
  expected?: string;
  device?: string;
};

export type AppUserCases = {
  app: string;
  repo?: string;
  version?: string;
  roles?: Record<string, { label?: string; email_env?: string; description?: string }>;
  userCases: UserCase[];
  bugSources?: Array<Record<string, unknown>>;
  error?: string;
};

/** Liste les dossiers produits contenant un user-cases.json (ou pas encore). */
export function listProductDirs(): string[] {
  try {
    return readdirSync(PRODUCTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => join(PRODUCTS_DIR, d.name));
  } catch {
    return [];
  }
}

export function readUserCases(dir: string): AppUserCases | null {
  const file = join(dir, 'user-cases.json');
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as AppUserCases;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.userCases)) return null;
    return raw;
  } catch (err) {
    return {
      app: dir.split('/').pop() || dir,
      userCases: [],
      error: `JSON invalide : ${String((err as Error).message || err).slice(0, 120)}`,
    };
  }
}

/** Charge tous les user-cases des dépôts Hubera. */
export function loadAllUserCases(): AppUserCases[] {
  const out: AppUserCases[] = [];
  for (const dir of listProductDirs()) {
    const parsed = readUserCases(dir);
    if (parsed) out.push({ ...parsed, repo: parsed.repo || dir.split('/').pop() });
  }
  return out.sort((a, b) => a.app.localeCompare(b.app));
}

/** Échappe une étiquette pour Mermaid (évite de casser le diagramme). */
export function mermaidLabel(text: string): string {
  return String(text || '')
    .replace(/["`|<>{}[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** Un nœud Mermaid sûr (id alphanumérique + libellé échappé). */
export function mermaidNodeId(raw: string, prefix = 'n'): string {
  const slug = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return `${prefix}_${slug || 'x'}`;
}

/**
 * Construit un diagramme Mermaid (flowchart TD) pour une application.
 * Les parcours admin et standard sont colorés différemment.
 */
export function buildMermaidFlow(app: AppUserCases): string {
  const lines: string[] = ['flowchart TD'];
  const root = mermaidNodeId(app.app, 'app');
  lines.push(`  ${root}["${mermaidLabel(app.app)}"]`);
  lines.push(`  classDef admin fill:#ffe4e6,stroke:#e11d48,color:#111`);
  lines.push(`  classDef std fill:#e0f2fe,stroke:#0284c7,color:#111`);
  lines.push(`  classDef other fill:#f1f5f9,stroke:#64748b,color:#111`);

  for (const uc of app.userCases.slice(0, 60)) {
    const id = mermaidNodeId(uc.id, 'uc');
    const label = mermaidLabel(`${uc.id} · ${uc.title}`);
    lines.push(`  ${root} --> ${id}["${label}"]`);
    const seq = Array.isArray(uc.flow) ? uc.flow : [];
    let prev = id;
    let i = 0;
    for (const step of seq.slice(0, 8)) {
      const sid = mermaidNodeId(`${uc.id}_${step}_${i}`, 's');
      lines.push(`  ${prev} --> ${sid}("${mermaidLabel(step)}")`);
      prev = sid;
      i += 1;
    }
    const cls = uc.role === 'admin' ? 'admin' : uc.role === 'standard' ? 'std' : 'other';
    lines.push(`  class ${id} ${cls}`);
  }
  return lines.join('\n');
}

/** Vue consolidée pour l'UI : par app + diagramme prêt à rendre. */
export function userCasesOverview() {
  const apps = loadAllUserCases();
  return {
    ok: true,
    productsDir: PRODUCTS_DIR,
    count: apps.length,
    apps: apps.map((a) => ({
      app: a.app,
      repo: a.repo,
      version: a.version,
      roles: a.roles || {},
      cases: a.userCases.length,
      admin: a.userCases.filter((c) => c.role === 'admin').length,
      standard: a.userCases.filter((c) => c.role === 'standard').length,
      error: a.error || null,
      mermaid: buildMermaidFlow(a),
      userCases: a.userCases,
    })),
  };
}
