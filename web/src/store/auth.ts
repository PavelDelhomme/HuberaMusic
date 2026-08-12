import { create } from 'zustand';
import { api, setRefreshToken, setToken, type User } from '../api';
import { sessionSocket } from '../lib/auth/session';
import { useSession } from './session';

type AuthState = {
  user: User | null;
  googleEnabled: boolean;
  googleClientId: string | null;
  loaded: boolean;
  init: () => Promise<void>;
  login: (email: string, password: string, totp?: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  loginGoogle: (credential: string) => Promise<void>;
  logout: () => Promise<void>;
};

function reconnectSession() {
  sessionSocket.close();
  useSession.getState().init();
}

function applySession(r: { user: User; token: string; refreshToken?: string }) {
  setToken(r.token);
  if (r.refreshToken) setRefreshToken(r.refreshToken);
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  googleEnabled: false,
  googleClientId: null,
  loaded: false,

  init: async () => {
    const failSafe = window.setTimeout(() => {
      set((s) => (s.loaded ? s : { ...s, loaded: true, user: s.user }));
    }, 12_000);
    try {
      const cfg = await api.authConfig();
      set({
        googleEnabled: cfg.googleEnabled,
        googleClientId: cfg.googleClientId,
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
    set({ user: null });
    reconnectSession();
  },
}));
