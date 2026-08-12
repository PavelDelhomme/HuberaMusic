import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { WifiOff } from 'lucide-react';
import { isBrowserOnline, onConnectivityChange } from '../../lib/offline/connectivity';
import { listCachedIds } from '../../lib/offline/offlineCache';

/** Bandeau discret quand le site web est hors ligne. */
export function OfflineBanner() {
  const [online, setOnline] = useState(isBrowserOnline());
  const [localCount, setLocalCount] = useState(0);

  useEffect(() => {
    void listCachedIds().then((ids) => setLocalCount(ids.length));
    return onConnectivityChange((on) => {
      setOnline(on);
      if (!on) void listCachedIds().then((ids) => setLocalCount(ids.length));
    });
  }, []);

  if (online) return null;

  return (
    <div className="flex items-center justify-between gap-3 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-50 sm:text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <WifiOff className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">
          Hors ligne
          {localCount > 0
            ? ` — ${localCount} titre${localCount > 1 ? 's' : ''} sur cet appareil`
            : ' — télécharge des titres via Hors ligne pour écouter sans réseau'}
        </span>
      </div>
      <Link
        to="/offline"
        className="shrink-0 rounded-full bg-amber-400/20 px-3 py-1 font-medium text-amber-50 hover:bg-amber-400/30"
      >
        Voir
      </Link>
    </div>
  );
}
