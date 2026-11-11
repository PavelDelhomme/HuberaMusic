/**
 * Rendu d'un diagramme Mermaid.
 *
 * Mermaid est chargé depuis le **bundle local** (dépendance npm) : la CSP de
 * Hubera n'autorise que `'self'` pour les scripts, un CDN serait bloqué.
 * Le CDN reste en second recours pour les contextes sans build (dev isolé).
 * Si tout échoue, on affiche le code source : l'admin garde une vue exploitable.
 */
import { useEffect, useRef, useState } from 'react';

type MermaidApi = {
  initialize: (opts: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string; bindFunctions?: (el: Element) => void }>;
};

/** Repli CDN (bloqué par la CSP en prod Hubera — conservé pour le dev local). */
const CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
let mermaidPromise: Promise<MermaidApi | null> | null = null;
let seq = 0;

/** Charge (une seule fois) Mermaid : bundle npm d'abord, CDN en repli. */
function loadMermaid(): Promise<MermaidApi | null> {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = (async () => {
    const candidates: Array<() => Promise<unknown>> = [
      () => import('mermaid'), // bundlé → servi en 'self', conforme CSP
      () => import(/* @vite-ignore */ CDN),
    ];
    for (const load of candidates) {
      try {
        const mod = (await load()) as { default?: MermaidApi } & MermaidApi;
        const api = (mod.default ?? mod) as MermaidApi;
        if (typeof api?.render !== 'function') continue;
        api.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: {
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
            primaryColor: '#1f2937',
            primaryTextColor: '#f8fafc',
            lineColor: '#6b7280',
          },
        });
        return api;
      } catch {
        /* tentative suivante */
      }
    }
    return null;
  })();
  return mermaidPromise;
}

export function MermaidDiagram({
  code,
  className = '',
}: {
  code: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!code || !host.current) return;
    setFailed(false);
    setReady(false);
    void (async () => {
      const api = await loadMermaid();
      if (cancelled || !host.current) return;
      if (!api) {
        setFailed(true);
        return;
      }
      try {
        seq += 1;
        const { svg } = await api.render(`mermaid-${seq}`, code);
        if (cancelled || !host.current) return;
        host.current.innerHTML = svg;
        setReady(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  return (
    <div className={className}>
      {!ready && (
        <p className="text-xs text-slate-500 mb-2">
          {failed ? 'Rendu Mermaid indisponible — code source affiché.' : 'Rendu du diagramme…'}
        </p>
      )}
      <div ref={host} className={ready ? 'overflow-x-auto' : 'hidden'} />
      {failed && (
        <pre className="overflow-x-auto rounded-lg bg-slate-900 text-slate-100 p-3 text-[11px] leading-relaxed">
          {code}
        </pre>
      )}
    </div>
  );
}

export default MermaidDiagram;
