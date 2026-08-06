import { useEffect, useState } from 'react';
import { apiUrl } from '../api';

/**
 * Local DEV : Vite proxy mort (/api → HTML SPA)
 */
export function ProxyHealthBanner() {
  const [proxyBroken, setProxyBroken] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (!import.meta.env.DEV) return;
      try {
        const res = await fetch(apiUrl('/api/health'), { cache: 'no-store' });
        const ctype = res.headers.get('content-type') || '';
        const text = await res.text();
        const looksHtml = ctype.includes('text/html') || text.trimStart().startsWith('<!');
        if (!cancelled) setProxyBroken(!res.ok || looksHtml || !text.includes('"ok"'));
      } catch {
        if (!cancelled) setProxyBroken(true);
      }
    };
    void check();
    const t = window.setInterval(check, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  if (proxyBroken) {
    return (
      <div className="fixed inset-x-0 top-0 z-[100] border-b border-red-500/40 bg-red-950 px-4 py-3 text-sm text-red-100 shadow-lg">
        <p className="font-medium">API locale injoignable via Vite (proxy :5173 → :8787 mort)</p>
        <p className="mt-1 text-red-200/90">
          Dans un terminal : <code className="text-white">make ensure-api</code> puis redémarre Vite (
          <code className="text-white">make clean-vite && npm run dev:web</code>), ensuite Ctrl+Shift+R.
        </p>
      </div>
    );
  }

  return null;
}
