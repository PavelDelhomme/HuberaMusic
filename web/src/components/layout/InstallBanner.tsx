import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, MonitorSmartphone, Share2, Smartphone, X } from 'lucide-react';
import { BrandLogo } from './BrandLogo';
import { isNativeApp } from '../../lib/util/native';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

type Platform = 'ios' | 'android' | 'windows' | 'mac' | 'linux' | 'other';

function isStandalone() {
  if (isNativeApp()) return true;
  const mq = window.matchMedia('(display-mode: standalone)').matches;
  const ios = (window.navigator as any).standalone === true;
  const twa = document.referrer.includes('android-app://');
  return mq || ios || twa;
}

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/android/i.test(ua)) return 'android';
  if (/windows/i.test(ua)) return 'windows';
  if (/macintosh|mac os x/i.test(ua)) return 'mac';
  if (/linux/i.test(ua)) return 'linux';
  return 'other';
}

function installSteps(platform: Platform): { title: string; steps: string[] } {
  switch (platform) {
    case 'ios':
      return {
        title: 'iPhone / iPad (Safari)',
        steps: [
          'Ouvre PLM dans Safari (pas Chrome).',
          'Appuie sur Partager (carré avec flèche).',
          'Choisis « Sur l’écran d’accueil » → Ajouter.',
        ],
      };
    case 'android':
      return {
        title: 'Android — APK native',
        steps: [
          'Ouvre la page /install (bouton ci-dessous).',
          'Télécharge PLM.apk — pas « Ajouter à l’écran d’accueil ».',
          'Xiaomi : autorise les sources inconnues, ouvre le fichier dans Téléchargements.',
        ],
      };
    case 'windows':
      return {
        title: 'Windows (Edge / Chrome)',
        steps: [
          'Cherche l’icône ⊕ / « Installer » dans la barre d’adresse.',
          'Ou menu ⋮ → Applications → « Installer PLM ».',
          'Edge : … → Applications → Installer ce site en tant qu’application.',
        ],
      };
    case 'mac':
      return {
        title: 'macOS (Chrome / Edge / Safari)',
        steps: [
          'Chrome/Edge : icône ⊕ dans la barre d’adresse → Installer.',
          'Ou menu ⋮ → Enregistrer et partager → Installer PLM.',
          'Safari : Fichier → Ajouter au Dock (macOS Sonoma+).',
        ],
      };
    case 'linux':
      return {
        title: 'Linux (Chrome / Chromium / Edge)',
        steps: [
          'Icône ⊕ / Installer dans la barre d’adresse.',
          'Ou menu ⋮ → Installer PLM…',
          'L’app apparaît dans ton lanceur d’applications.',
        ],
      };
    default:
      return {
        title: 'Navigateur compatible',
        steps: [
          'Sur téléphone Android : va sur /install pour l’APK native.',
          'Sur ordinateur : menu → Installer l’application (PWA).',
        ],
      };
  }
}

/** Bannière d’install — Android = APK native (/install), iOS/desktop = PWA. */
export function InstallBanner() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const platform = useMemo(() => detectPlatform(), []);
  const guide = useMemo(() => installSteps(platform), [platform]);
  const dismissedKey = `ytm_install_dismissed:${location.host}`;
  const isAndroid = platform === 'android';

  useEffect(() => {
    if (isNativeApp() || isStandalone()) return;
    const forceInstall = new URLSearchParams(location.search).get('install') === '1';
    if (!forceInstall && localStorage.getItem(dismissedKey) === '1') return;
    if (forceInstall) {
      localStorage.removeItem(dismissedKey);
    }

    const onBip = (e: Event) => {
      // Sur Android on pousse l’APK, pas le beforeinstallprompt PWA
      if (isAndroid) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setVisible(true);
      setShowGuide(false);
    };
    window.addEventListener('beforeinstallprompt', onBip);

    const onInstalled = () => {
      localStorage.setItem(dismissedKey, '1');
      setVisible(false);
      if (forceInstall) {
        const u = new URL(location.href);
        u.searchParams.delete('install');
        history.replaceState({}, '', u.pathname + u.search);
      }
    };
    window.addEventListener('appinstalled', onInstalled);

    const delay = forceInstall ? 400 : platform === 'ios' ? 2500 : platform === 'android' ? 1200 : 5000;
    const t = setTimeout(() => {
      if (!isStandalone()) {
        setVisible(true);
        if (forceInstall) setShowGuide(true);
      }
    }, delay);

    return () => {
      clearTimeout(t);
      window.removeEventListener('beforeinstallprompt', onBip);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, [dismissedKey, platform, isAndroid]);

  if (isNativeApp() || !visible || isStandalone()) return null;
  // Déjà sur /install → pas de bannière doublon
  if (location.pathname.startsWith('/install')) return null;

  const dismiss = () => {
    localStorage.setItem(dismissedKey, '1');
    setVisible(false);
    setShowGuide(false);
  };

  const install = async () => {
    if (isAndroid) {
      window.location.assign('/install');
      return;
    }
    if (deferred) {
      try {
        await deferred.prompt();
        const choice = await deferred.userChoice;
        if (choice.outcome === 'accepted') {
          localStorage.setItem(dismissedKey, '1');
          setVisible(false);
        }
      } catch {
        setShowGuide(true);
      }
      setDeferred(null);
      return;
    }
    setShowGuide((v) => !v);
  };

  const isPhone = platform === 'ios' || platform === 'android';

  return (
    <div className="fixed bottom-[calc(var(--ytm-player-h,5.5rem)+var(--ytm-nav-h,0px)+0.75rem)] left-3 right-3 z-40 mx-auto max-w-lg animate-fade-up md:left-auto md:right-4">
      <div className="rounded-2xl border border-yt-border bg-yt-surface/95 p-4 shadow-2xl backdrop-blur-md">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl">
            <BrandLogo className="h-11 w-11" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-display text-sm font-semibold">
              {isAndroid
                ? 'Installer l’app Android (APK)'
                : isPhone
                  ? 'Installer l’app mobile'
                  : 'Installer sur cet ordinateur'}
            </div>
            <p className="mt-0.5 text-xs text-yt-muted">
              {isAndroid
                ? 'Vraie application native — pas un raccourci web (Xiaomi / Chrome).'
                : `${guide.title} · ${location.host}`}
            </p>

            {showGuide && !isAndroid && (
              <ol className="mt-3 list-decimal space-y-1.5 rounded-xl bg-yt-elevated px-3 py-2.5 pl-5 text-[11px] leading-relaxed text-yt-muted">
                {guide.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
                {platform === 'ios' && (
                  <li className="flex items-center gap-1">
                    Bouton <Share2 className="inline h-3 w-3" /> obligatoire dans Safari.
                  </li>
                )}
              </ol>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              {isAndroid ? (
                <Link
                  to="/install"
                  onClick={dismiss}
                  className="inline-flex items-center gap-1.5 rounded-full bg-yt-red px-3.5 py-1.5 text-xs font-medium text-white"
                >
                  <Download className="h-3.5 w-3.5" /> Télécharger l’APK
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={() => void install()}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-1.5 text-xs font-medium text-black"
                >
                  {deferred ? (
                    <>
                      <Download className="h-3.5 w-3.5" /> Installer maintenant
                    </>
                  ) : showGuide ? (
                    'Masquer le guide'
                  ) : (
                    <>
                      {isPhone ? (
                        <Smartphone className="h-3.5 w-3.5" />
                      ) : (
                        <MonitorSmartphone className="h-3.5 w-3.5" />
                      )}
                      Comment installer
                    </>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={dismiss}
                className="rounded-full bg-yt-elevated px-3.5 py-1.5 text-xs text-yt-muted hover:text-white"
              >
                Plus tard
              </button>
            </div>
          </div>
          <button type="button" onClick={dismiss} className="text-yt-muted hover:text-white" aria-label="Fermer">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
