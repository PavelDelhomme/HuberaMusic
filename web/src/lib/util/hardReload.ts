/** Vide SW + caches puis recharge vraiment le shell (sinon le PWA ressert l’ancien index.html). */

const BUST = '_gt';

export function webReloadAlreadyTried(targetVersion: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URL(window.location.href).searchParams.get(BUST) === targetVersion;
  } catch {
    return false;
  }
}

export async function hardReloadWebApp(targetVersion?: string): Promise<void> {
  if (typeof window === 'undefined') return;

  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        regs.map(async (reg) => {
          try {
            if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          } catch {
            /* ignore */
          }
          await reg.unregister();
        }),
      );
    }
  } catch {
    /* ignore */
  }

  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* ignore */
  }

  const url = new URL(window.location.href);
  url.searchParams.delete(BUST);
  url.searchParams.set(BUST, targetVersion || String(Date.now()));
  url.searchParams.set('_cb', String(Date.now()));
  window.location.replace(url.toString());
}
