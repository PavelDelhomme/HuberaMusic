import { useRegisterSW } from 'virtual:pwa-register/react';
import { RefreshCw, X } from 'lucide-react';

/** Bandeau discret : nouvelle version PWA — rechargement volontaire (pas de force reload). */
export function UpdateBanner() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(registration: ServiceWorkerRegistration | undefined) {
      if (!registration) return;
      // Vérif périodique (~30 min) sans bloquer l'utilisateur
      setInterval(() => {
        void registration.update().catch(() => {
          /* SW mort / réseau — ignorer */
        });
      }, 30 * 60 * 1000);
    },
    onRegisterError() {
      // Évite unhandledrejection « ServiceWorker script at …/sw.js » en mail
    },
  });

  if (!needRefresh) return null;

  return (
    <div
      className="fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] left-3 right-3 z-[60] mx-auto flex max-w-lg items-center gap-3 rounded-xl border border-white/10 bg-[#1a1a1a]/95 px-4 py-3 text-sm text-white shadow-lg backdrop-blur-md md:left-auto md:right-6"
      role="status"
    >
      <RefreshCw className="h-4 w-4 shrink-0 text-yt-accent" aria-hidden />
      <p className="min-w-0 flex-1">
        Nouvelle version PLM disponible — recharge pour appliquer la mise à jour.
      </p>
      <button
        type="button"
        className="shrink-0 rounded-lg bg-yt-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
        onClick={() => {
          void updateServiceWorker(true);
        }}
      >
        Recharger
      </button>
      <button
        type="button"
        className="shrink-0 rounded-lg p-1 text-yt-muted hover:text-white"
        aria-label="Fermer"
        onClick={() => setNeedRefresh(false)}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
