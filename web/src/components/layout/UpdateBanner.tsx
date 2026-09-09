import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw, X } from 'lucide-react';
import { api } from '../../api';
import { APP_CHANNEL, APP_VERSION, appVersionLabel } from '../../lib/util/appVersion';

/** Bandeau : nouvelle version PWA (SW) ou API `/api/health` plus récente que le bundle. */
export function UpdateBanner() {
  const [apiNewer, setApiNewer] = useState<string | null>(null);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(registration: ServiceWorkerRegistration | undefined) {
      if (!registration) return;
      setInterval(() => {
        void registration.update().catch(() => {
          /* SW mort / réseau — ignorer */
        });
      }, 15 * 60 * 1000);
    },
    onRegisterError() {
      // Évite unhandledrejection « ServiceWorker script at …/sw.js » en mail
    },
  });

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const h = await api.health();
        const remote = (h as { appVersion?: string }).appVersion?.trim();
        if (!remote || cancelled) return;
        const local = appVersionLabel(APP_CHANNEL, APP_VERSION);
        // Compare semver après `d+` / `p+`
        const remoteSem = remote.includes('+') ? remote.split('+')[1] : remote;
        const localSem = APP_VERSION;
        if (remoteSem && localSem && remoteSem !== localSem && remote !== local) {
          setApiNewer(remote);
        }
      } catch {
        /* hors ligne / health KO */
      }
    };
    void check();
    const t = window.setInterval(() => void check(), 20 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  if (!needRefresh && !apiNewer) return null;

  return (
    <div
      className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] left-3 right-3 z-[60] mx-auto flex max-w-lg items-center gap-3 rounded-xl border border-white/10 bg-[#1a1a1a]/95 px-4 py-3 text-sm text-white shadow-lg backdrop-blur-md md:left-auto md:right-6"
      role="status"
    >
      <RefreshCw className="h-4 w-4 shrink-0 text-yt-accent" aria-hidden />
      <p className="min-w-0 flex-1">
        {needRefresh
          ? 'Nouvelle version PLM disponible — recharge pour appliquer la mise à jour.'
          : `Serveur en ${apiNewer} — recharge la page pour aligner l’app.`}
      </p>
      <button
        type="button"
        className="shrink-0 rounded-lg bg-yt-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
        onClick={() => {
          if (needRefresh) {
            void updateServiceWorker(true);
          } else {
            window.location.reload();
          }
        }}
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
