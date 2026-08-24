import { useEffect, useState } from 'react';
import { apiUrl } from '../../api';

type Maint = {
  active?: boolean;
  message?: string | null;
  until?: number | null;
  blockPlayback?: boolean;
};

/** Bannière globale si Admin a activé le mode maintenance. */
export function MaintenanceBanner() {
  const [maint, setMaint] = useState<Maint | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetch(apiUrl('/api/health'))
        .then((r) => r.json())
        .then((d) => {
          if (!cancelled) setMaint(d.maintenance || null);
        })
        .catch(() => {
          /* ignore */
        });
    };
    load();
    const t = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  if (!maint?.active) return null;
  const until =
    maint.until && Number.isFinite(maint.until)
      ? new Date(maint.until).toLocaleString('fr-FR', {
          hour: '2-digit',
          minute: '2-digit',
        })
      : null;

  return (
    <div
      role="status"
      className="border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-center text-sm text-amber-100"
    >
      {maint.message || 'PLM est en maintenance — réessaie dans un instant.'}
      {until ? <span className="text-amber-200/80"> · fin prévue ~{until}</span> : null}
    </div>
  );
}
