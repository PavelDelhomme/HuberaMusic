/**
 * Rendu d'un diagramme Mermaid, sans dépendance npm lourde.
 *
 * Mermaid est chargé à la demande depuis un CDN (ESM) et initialisé en mode
 * strict. Si le réseau est indisponible ou le rendu échoue, on affiche le code
 * source du diagramme : l'admin garde toujours une vue exploitable.
 */
import { useEffect, useRef, useState } from 'react';

type MermaidApi = {
  initialize: (opts: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string; bindFunctions?: (el: Element) => void }>;
};

const CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
let mermaidPromise: Promise<MermaidApi | null> | null = null;
let seq = 0;

/** Charge (une seule fois) Mermaid depuis le CDN. Renvoie null si indisponible. */
function loadMermaid(): Promise<MermaidApi | null> {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = (async () => {
    try {
      const mod = (await import(/* @vite-ignore */ CDN)) as { default?: MermaidApi } & MermaidApi;
      const api = (mod.default ?? mod) as MermaidApi;
      api.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: {
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          primaryColor: '#e0f2fe',
          primaryTextColor: '#0f172a',
          lineColor: '#64748b',
        },
      });
      return api;
    } catch {
      return null;
    }
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
