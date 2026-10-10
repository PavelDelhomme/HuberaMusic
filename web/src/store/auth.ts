import { create } from 'zustand';
import { api, setRefreshToken, setToken, type User } from '../api';
import { sessionSocket } from '../lib/auth/session';
import { useSession } from './session';
import {
  detectHuberaSession,
  quickLoginWithHuberaId,
  clearHuberaSession,
  type HuberaDetectResult,
} from '../lib/huberaId';

type AuthState = {
  user: User | null;
  googleEnabled: boolean;
  googleClientId: string | null;
  allowRegister: boolean;
  loaded: boolean;
  huberaIdDetected: HuberaDetectResult | null;
  init: () => Promise<void>;
  login: (email: string, password: string, totp?: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  loginGoogle: (credential: string) => Promise<void>;
  logout: () => Promise<void>;
  checkHuberaId: () => Promise<HuberaDetectResult | null>;
  continueWithHuberaId: () => Promise<boolean>;
};

function reconnectSession() {
  sessionSocket.close();
  useSession.getState().init();
}

function applySession(r: { user: User; token: string; refreshToken?: string }) {
  setToken(r.token);
  if (r.refreshToken) setRefreshToken(r.refreshToken);
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  googleEnabled: false,
  googleClientId: null,
  allowRegister: false,
  loaded: false,
  huberaIdDetected: null,

  init: async () => {
    const failSafe = window.setTimeout(() => {
      set((s) => (s.loaded ? s : { ...s, loaded: true, user: s.user }));
    }, 12_000);
    try {
      const cfg = await api.authConfig();
      set({
        googleEnabled: cfg.googleEnabled,
        googleClientId: cfg.googleClientId,
        allowRegister: Boolean(cfg.allowRegister),
      });
      try {
        const me = await api.me();
        if (me.user) {
          set({ user: me.user, loaded: true });
          return;
        }
      } catch {
        /* try refresh below */
      }
      try {
        const r = await api.refresh();
        applySession(r);
        set({ user: r.user, loaded: true });
        reconnectSession();
      } catch {
        // Dernier recours : cookies httpOnly seuls (localStorage vide / périmé)
        try {
          const r = await api.refresh('');
          applySession(r);
          set({ user: r.user, loaded: true });
          reconnectSession();
        } catch {
          set({ user: null, loaded: true });
        }
      }
    } catch {
      set({ loaded: true, user: null });
    } finally {
      window.clearTimeout(failSafe);
    }
  },

  login: async (email, password, totp) => {
    const r = await api.login(email, password, totp);
    applySession(r);
    set({ user: r.user });
    reconnectSession();
  },

  register: async (email, password, name) => {
    const r = await api.register(email, password, name);
    applySession(r);
    set({ user: r.user });
    reconnectSession();
  },

  loginGoogle: async (credential) => {
    const r = await api.google(credential);
    applySession(r);
    set({ user: r.user });
    reconnectSession();
  },

  logout: async () => {
    await api.logout().catch(() => undefined);
    setToken(null);
    setRefreshToken(null);
    clearHuberaSession();
    set({ user: null, huberaIdDetected: null });
    const { clearPinsLocalCache } = await import('./pins');
    clearPinsLocalCache();
    try {
      sessionStorage.removeItem('ytm_home_v1');
      localStorage.removeItem('ytm_pins_cache_v1');
    } catch {
      /* ignore */
    }
    reconnectSession();
  },

  checkHuberaId: async () => {
    if (get().user) return null;
    try {
      const detected = await detectHuberaSession();
      set({ huberaIdDetected: detected.found ? detected : null });
      return detected.found ? detected : null;
    } catch {
      return null;
    }
  },

  continueWithHuberaId: async () => {
    try {
      const result = await quickLoginWithHuberaId();
      if (!result) return false;

      setToken(result.accessToken);
      setRefreshToken(result.refreshToken);

      const user: User = {
        id: result.userId,
        email: result.email,
        name: result.email.split('@')[0],
      };

      set({ user, huberaIdDetected: null });
      reconnectSession();

      try {
        const me = await api.me();
        if (me.user) {
          set({ user: me.user });
        }
      } catch {
        /* use basic user from quick login */
      }

      return true;
    } catch (error) {
      console.error('[HuberaID] continueWithHuberaId error:', error);
      return false;
    }
  },
}));
