import { Capacitor } from '@capacitor/core';

/** True dans l’APK Capacitor (pas PWA / navigateur). */
export function isNativeApp() {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export function nativePlatform() {
  try {
    return Capacitor.getPlatform();
  } catch {
    return 'web';
  }
}

/** Initialise le shell Android (status bar, back button, audio arrière-plan). */
export async function initNativeShell() {
  if (!isNativeApp()) return;

  document.documentElement.dataset.native = nativePlatform();
  document.documentElement.classList.add('native-app');

  // Nom d’appareil par défaut pour le cast / sync multi-device
  try {
    const key = 'ytm_device_name';
    if (!localStorage.getItem(key)) {
      localStorage.setItem(key, 'Android · PLM');
    }
  } catch {
    /* ignore */
  }

  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setOverlaysWebView({ overlay: false });
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#030303' });
  } catch {
    /* plugin absent en web */
  }

  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide();
  } catch {
    /* ignore */
  }

  try {
    const { App } = await import('@capacitor/app');
    App.addListener('backButton', ({ canGoBack }) => {
      if (canGoBack) {
        window.history.back();
      } else {
        void App.minimizeApp();
      }
    });
    App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        void import('../../store/player').then((m) => m.flushPlayerPersist());
      }
    });
  } catch {
    /* ignore */
  }

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('stop', () => {
        void import('../../store/player').then((m) => {
          const p = m.usePlayer.getState();
          if (p.isPlaying) p.toggle();
          m.flushPlayerPersist();
        });
      });
    } catch {
      /* ignore */
    }
  }
}
