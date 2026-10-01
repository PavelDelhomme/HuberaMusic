import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw, X } from 'lucide-react';
import { api } from '../../api';
import { APP_VERSION } from '../../lib/util/appVersion';
import { hardReloadWebApp, webReloadAlreadyTried } from '../../lib/util/hardReload';

function semverOf(label: string): string {
  const s = label.trim();
  return s.includes('+') ? s.slice(s.indexOf('+') + 1) : s;
}

/** Bandeau : SW en attente, ou bundle web plus vieux que /api/health — hard-reload, pas un simple F5. */
export function UpdateBanner() {
  const [apiNewer, setApiNewer] = useState<string | null>(null);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(registration: ServiceWorkerRegistration | undefined) {
      if (!registration) return;
      void registration.update().catch(() => undefined);
      setInterval(() => {
        void registration.update().catch(() => undefined);
      }, 15 * 60 * 1000);
    },
    onRegisterError() {
      /* SW mort / réseau */
    },
  });

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const h = await api.health();
        const remote = (h as { appVersion?: string }).appVersion?.trim();
        if (!remote || cancelled) return;
        const remoteSem = semverOf(remote);
        const localSem = APP_VERSION;
        if (remoteSem && localSem && remoteSem !== localSem) {
          if (webReloadAlreadyTried(remoteSem)) {
            // Déjà hard-reloadé vers cette version : le shell web EST la vérité.
            setApiNewer(null);
            return;
          }
          setApiNewer(remote);
        } else {
          setApiNewer(null);
        }
      } catch {
        /* hors ligne */
      }
    };
    void check();
    const t = window.setInterval(() => void check(), 20 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  const apply = () => {
    const target = apiNewer ? semverOf(apiNewer) : APP_VERSION;
    void (async () => {
      try {
        await updateServiceWorker(true);
      } catch {
        /* pas de SW waiting */
      }
      await hardReloadWebApp(target);
    })();
  };

  useEffect(() => {
    if (!apiNewer && !needRefresh) return;
    const target = apiNewer ? semverOf(apiNewer) : APP_VERSION;
    if (webReloadAlreadyTried(target)) return;
    // Un seul auto-reload par version — évite la boucle « recharge encore ».
    const flag = `hubera-auto-reload:${target}`;
    try {
      if (sessionStorage.getItem(flag) === '1') return;
      sessionStorage.setItem(flag, '1');
    } catch {
      /* private mode */
    }
    apply();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- une fois par version distante
  }, [apiNewer, needRefresh]);

  if (!needRefresh && !apiNewer) return null;
  if (apiNewer && webReloadAlreadyTried(semverOf(apiNewer))) return null;

  return (
    <div
      className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] left-3 right-3 z-[60] mx-auto flex max-w-lg items-center gap-3 rounded-xl border border-white/10 bg-[#1a1a1a]/95 px-4 py-3 text-sm text-white shadow-lg backdrop-blur-md md:left-auto md:right-6"
      role="status"
    >
      <RefreshCw className="h-4 w-4 shrink-0 text-yt-accent" aria-hidden />
      <p className="min-w-0 flex-1">
        {needRefresh
          ? 'Nouvelle version disponible — application du cache…'
          : `Serveur en ${apiNewer} — vidage du cache puis rechargement.`}
      </p>
      <button
        type="button"
        className="shrink-0 rounded-lg bg-yt-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
        onClick={apply}
      >
        Recharger
      </button>
      <button
        type="button"
        className="shrink-0 rounded-lg p-1 text-yt-muted hover:text-white"
        aria-label="Fermer"
        onClick={() => {
          setNeedRefresh(false);
          setApiNewer(null);
        }}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
