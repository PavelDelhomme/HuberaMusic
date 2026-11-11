/**
 * Panneau « User cases & bugs » — Hubera Admin.
 *
 * Affiche, pour chaque app Hubera :
 *  - les parcours recensés (Admin / Utilisateur standard) depuis `user-cases.json` ;
 *  - un diagramme visuel interactif (Mermaid) ;
 *  - les bugs remontés par e-mail (Himalaya) et par Hubera Docs.
 *
 * Lecture seule : aucun secret n'est affiché, seuls les compteurs et les motifs.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { MermaidDiagram } from '../admin/MermaidDiagram';

type UserCase = {
  id: string;
  title: string;
  role: string;
  flow?: string[];
  expected?: string;
  device?: string;
};

type AppCases = {
  app: string;
  repo?: string;
  version?: string;
  cases: number;
  admin: number;
  standard: number;
  error?: string | null;
  mermaid: string;
  userCases: UserCase[];
};

type BugItem = {
  source: 'mail' | 'docs';
  subject: string;
  from?: string;
  date?: string;
  app?: string;
  snippet?: string;
};

const ROLE_BADGE: Record<string, string> = {
  admin: 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30',
  standard: 'bg-sky-500/15 text-sky-300 ring-1 ring-sky-500/30',
};

export function UserCasesPanel() {
  const [apps, setApps] = useState<AppCases[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [bugs, setBugs] = useState<{ mail: any; docs: any } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [uc, bg] = await Promise.all([
          api.adminUserCases(),
          api.adminBugs(10).catch(() => null),
        ]);
        if (cancelled) return;
        setApps(Array.isArray(uc?.apps) ? uc.apps : []);
        setSelected((prev) => prev || uc?.apps?.[0]?.app || '');
        if (bg) setBugs({ mail: bg.mail, docs: bg.docs });
      } catch (e) {
        if (!cancelled) setErr(String((e as Error).message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const current = useMemo(() => apps.find((a) => a.app === selected) || null, [apps, selected]);

  const bugList: BugItem[] = useMemo(() => {
    const m = (bugs?.mail?.items || []) as BugItem[];
    const d = (bugs?.docs?.items || []) as BugItem[];
    return [...m, ...d];
  }, [bugs]);

  if (loading) return <p className="text-sm text-yt-muted">Chargement des user cases…</p>;
  if (err) return <p className="text-sm text-rose-400">Erreur : {err}</p>;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="font-display text-lg font-semibold text-white">User cases par application</h2>
        <span className="text-xs text-yt-muted">{apps.length} app(s) recensée(s)</span>
      </header>

      <div className="flex flex-wrap gap-2">
        {apps.map((a) => (
          <button
            key={a.app}
            type="button"
            onClick={() => setSelected(a.app)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${
              a.app === selected
                ? 'bg-yt-red text-white'
                : 'bg-yt-elevated text-yt-muted hover:bg-yt-elevated/80'
            }`}
          >
            {a.app}
            <span className="ml-1 opacity-60">
              {a.admin}/{a.standard}
            </span>
          </button>
        ))}
      </div>

      {current && (
        <section className="rounded-xl border border-yt-border p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="font-semibold text-white">{current.app}</h3>
            {current.version && <span className="text-xs text-yt-muted">v{current.version}</span>}
            <span className="text-xs text-yt-muted">
              {current.cases} cas · {current.admin} admin · {current.standard} standard
            </span>
            {current.error && <span className="text-xs text-rose-400">{current.error}</span>}
          </div>

          <div className="overflow-x-auto rounded-lg border border-yt-border/70 bg-yt-elevated p-2">
            <MermaidDiagram code={current.mermaid} />
          </div>

          <div className="divide-y divide-yt-border/60">
            {current.userCases.map((c) => (
              <div key={c.id} className="py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11px] text-yt-muted">{c.id}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                      ROLE_BADGE[c.role] || 'bg-yt-elevated text-yt-muted'
                    }`}
                  >
                    {c.role}
                  </span>
                  {c.device && (
                    <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[10px] text-amber-300">
                      {c.device}
                    </span>
                  )}
                  <span className="text-sm text-white/90">{c.title}</span>
                </div>
                {c.expected && <p className="mt-1 text-xs text-yt-muted">{c.expected}</p>}
                {Array.isArray(c.flow) && c.flow.length > 0 && (
                  <p className="mt-1 font-mono text-[10px] text-yt-muted/70">{c.flow.join(' → ')}</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-xl border border-yt-border p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="font-semibold text-white">Bugs remontés</h3>
          <span className="text-xs text-yt-muted">
            mail {bugs?.mail?.ok ? `OK (${bugs.mail.count})` : `KO (${bugs?.mail?.error || '—'})`} ·
            docs {bugs?.docs?.ok ? `OK (${bugs.docs.count})` : `KO (${bugs?.docs?.error || '—'})`}
          </span>
        </div>
        {bugList.length === 0 ? (
          <p className="text-sm text-yt-muted">
            Aucun bug remonté par les sources configurées (Himalaya / Hubera Docs).
          </p>
        ) : (
          <ul className="space-y-1">
            {bugList.slice(0, 40).map((b, i) => (
              <li key={`${b.source}-${i}`} className="flex flex-wrap items-center gap-2 text-sm">
                <span
                  className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${
                    b.source === 'mail'
                      ? 'bg-indigo-500/15 text-indigo-300'
                      : 'bg-emerald-500/15 text-emerald-300'
                  }`}
                >
                  {b.source}
                </span>
                {b.app && <span className="text-xs text-yt-muted">{b.app}</span>}
                <span className="text-white/90">{b.subject}</span>
                {b.from && <span className="text-xs text-yt-muted/70">{b.from}</span>}
                {b.date && <span className="text-xs text-yt-muted/70">{b.date}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export default UserCasesPanel;
