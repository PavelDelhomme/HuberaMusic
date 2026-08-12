import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  Compass,
  Download,
  Home,
  Library,
  ListMusic,
  Menu,
  Mic,
  Music2,
  PanelLeftClose,
  Plus,
  Search,
  Settings2,
  Upload,
  UserRound,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { PlayerBar } from './PlayerBar';
import { QueuePanel } from './QueuePanel';
import { AuthModal } from './AuthModal';
import { DevicePicker } from './DevicePicker';
import { PerfHud } from './PerfHud';
import { InstallBanner } from './InstallBanner';
import { ItemActionsSheet } from './ItemActionsSheet';
import { NowPlaying, type NowPlayingTab } from './NowPlaying';
import { OnboardingWizard } from './OnboardingWizard';
import { BrandLogo } from './BrandLogo';
import { SearchIdentifySheet, startWebSpeechDictation } from './SearchIdentifySheet';
import { useLibrary } from '../store/library';
import { usePlayer, wireRemotePlayer, reportListenProgress, flushPlayerPersist } from '../store/player';
import { useAuth } from '../store/auth';
import { useSession } from '../store/session';
import { appVersionLabel } from '../lib/appVersion';
import { usePins } from '../store/pins';
import { api } from '../api';
import { installMediaKeys } from '../lib/mediaKeys';
import { wireEqualizer, resumeEqContext } from '../lib/equalizer';
import { EqualizerPanel } from './EqualizerPanel';
import { ProxyHealthBanner } from './ProxyHealthBanner';
import { OfflineBanner } from './OfflineBanner';

const links = [
  { to: '/', label: 'Accueil', icon: Home },
  { to: '/explore', label: 'Explorer', icon: Compass },
  { to: '/library', label: 'Bibliothèque', icon: Library },
  { to: '/import', label: 'Importer', icon: Upload },
  { to: '/offline', label: 'Hors ligne', icon: Download },
];

export function Layout() {
  const refresh = useLibrary((s) => s.refresh);
  const refreshPins = usePins((s) => s.refresh);
  const initAuth = useAuth((s) => s.init);
  const initSession = useSession((s) => s.init);
  const remoteState = useSession((s) => s.remoteState);
  const isActivePlayer = useSession((s) => s.isActivePlayer);
  const transferHere = useSession((s) => s.transferHere);
  const user = useAuth((s) => s.user);
  const authLoaded = useAuth((s) => s.loaded);
  const logout = useAuth((s) => s.logout);
  const navigate = useNavigate();
  const location = useLocation();
  const isVerifyRoute = location.pathname.startsWith('/verify-email');
  const [q, setQ] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [openSug, setOpenSug] = useState(false);
  /** -1 = texte tapé ; 0..n-1 = suggestion (liste affichée) */
  const [sugIndex, setSugIndex] = useState(-1);
  /** true = dropdown = historique (pas de « Rechercher « … » ») */
  const [historyMode, setHistoryMode] = useState(true);
  /** Texte réellement tapé (les flèches peuvent remplir `q` sans l’écraser) */
  const typedDraftRef = useRef('');
  const [authOpen, setAuthOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [nowPlayingOpen, setNowPlayingOpen] = useState(false);
  const [nowPlayingTab, setNowPlayingTab] = useState<NowPlayingTab>('queue');
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [eqOpen, setEqOpen] = useState(false);
  const [identifyOpen, setIdentifyOpen] = useState(false);
  // Menu gauche en drawer rétractable (persisté — desktop seulement pour l’état ouvert)
  const [navOpen, setNavOpen] = useState(() => {
    if (typeof window === 'undefined') return true;
    const isLg = window.matchMedia('(min-width: 1024px)').matches;
    // Mobile : toujours fermé au démarrage (évite de masquer la page)
    if (!isLg) return false;
    try {
      const v = localStorage.getItem('ytm_nav_open');
      if (v === '0') return false;
      if (v === '1') return true;
    } catch {
      /* ignore */
    }
    return true;
  });
  const playlists = useLibrary((s) => s.playlists);
  const likedPlaylists = useLibrary((s) => s.likedPlaylists);
  const createPlaylist = useLibrary((s) => s.createPlaylist);
  const bindAudio = usePlayer((s) => s.bindAudio);
  const bindStandbyAudio = usePlayer((s) => s.bindStandbyAudio);
  const hydrate = usePlayer((s) => s.hydrate);
  const setProgress = usePlayer((s) => s.setProgress);
  const setDuration = usePlayer((s) => s.setDuration);
  const next = usePlayer((s) => s.next);
  const applyRemoteState = usePlayer((s) => s.applyRemoteState);
  const currentTrack = usePlayer((s) => s.current);
  const hasPlayback = Boolean(currentTrack);
  const audioRef = useRef<HTMLAudioElement>(null);
  const standbyRef = useRef<HTMLAudioElement>(null);
  const lastRemoteAt = useRef(0);
  const sugReq = useRef(0);

  // Garde la barre alignée avec l’URL (évite de resoumettre / suggérer l’ancienne requête Keny…)
  useEffect(() => {
    if (!location.pathname.startsWith('/search')) return;
    const urlQ = new URLSearchParams(location.search).get('q') || '';
    setQ(urlQ);
  }, [location.pathname, location.search]);

  // Échap : ferme d’abord le drawer, sinon file latérale
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (nowPlayingOpen) return;
      if (navOpen && window.matchMedia('(max-width: 1023px)').matches) {
        e.preventDefault();
        setNavOpen(false);
        return;
      }
      const p = usePlayer.getState();
      if (p.showQueue || p.showLyrics) {
        e.preventDefault();
        e.stopPropagation();
        usePlayer.setState({ showQueue: false, showLyrics: false });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [nowPlayingOpen, navOpen]);

  useEffect(() => {
    // Ne persiste l’état ouvert que sur desktop (mobile = drawer ponctuel)
    if (!window.matchMedia('(min-width: 1024px)').matches) return;
    try {
      localStorage.setItem('ytm_nav_open', navOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [navOpen]);

  // Ferme le drawer mobile après navigation
  useEffect(() => {
    if (window.matchMedia('(max-width: 1023px)').matches) setNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    wireRemotePlayer();
    void initAuth().then(() => {
      const u = useAuth.getState().user;
      const guest = !u || u.isGuest || u.email?.includes('@local.ytmusic');
      if (!guest) {
        void refresh();
        void refreshPins();
        initSession();
      }
    });
  }, [initAuth, refresh, refreshPins, initSession]);

  useEffect(() => {
    if (/^\/(album|artist|playlist|local)\//.test(location.pathname)) {
      setNowPlayingOpen(false);
    }
  }, [location.pathname]);

  useEffect(() => {
    if (!authLoaded) return;
    const guest = !user || user.isGuest || user.email.includes('@local.ytmusic');
    if (guest) {
      if (!location.pathname.startsWith('/verify-email')) setAuthOpen(true);
      setNeedsOnboarding(false);
      return;
    }
    // Connecté → jamais laisser la popup login ouverte
    setAuthOpen(false);
    void refresh();
    void refreshPins();
    initSession();
    void api
      .prefs()
      .then((r) => {
        setNeedsOnboarding(!r.prefs?.onboardingDone);
        if (typeof r.prefs?.autoplaySuggestions === 'boolean') {
          void import('../store/player').then((m) => {
            void m.hydrateAutoplayFromPrefs();
          });
        }
      })
      .catch(() => undefined);
  }, [authLoaded, user, refresh, refreshPins, initSession, location.pathname]);

  useEffect(() => {
    const guest = !user || user.isGuest || user.email?.includes('@local.ytmusic');
    if (guest) {
      setSuggestions([]);
      setHistoryMode(false);
      return;
    }
    const id = ++sugReq.current;
    const draft = q.trim();
    // Champ vide → historique seul (pas de propositions YouTube)
    if (!draft) {
      const t = setTimeout(() => {
        api
          .searchHistory()
          .then((r) => {
            if (sugReq.current !== id) return;
            const seen = new Set<string>();
            const out: string[] = [];
            for (const h of r.history || []) {
              const query = String((h as { query?: string })?.query || '').trim();
              if (!query || seen.has(query.toLowerCase())) continue;
              seen.add(query.toLowerCase());
              out.push(query);
              if (out.length >= 12) break;
            }
            setSuggestions(out);
            setHistoryMode(true);
          })
          .catch(() => {
            if (sugReq.current === id) {
              setSuggestions([]);
              setHistoryMode(true);
            }
          });
      }, 80);
      return () => clearTimeout(t);
    }
    // Texte tapé → suggestions API (+ historique filtré côté serveur)
    const t = setTimeout(() => {
      api
        .suggestions(draft)
        .then((r) => {
          if (sugReq.current !== id) return;
          setSuggestions(r.suggestions.slice(0, 10));
          setHistoryMode(false);
        })
        .catch(() => {
          if (sugReq.current === id) {
            setSuggestions([]);
            setHistoryMode(false);
          }
        });
    }, 200);
    return () => clearTimeout(t);
  }, [q, user]);

  useEffect(() => {
    bindAudio(audioRef.current);
    bindStandbyAudio(standbyRef.current);
    // Mémorise l’élément pour l’EQ — ne crée PAS l’AudioContext ici (warning Chrome)
    if (audioRef.current) void wireEqualizer(audioRef.current);
  }, [bindAudio, bindStandbyAudio]);

  // Play/pause, suivant, précédent : clavier + touches média OS, toutes pages
  useEffect(() => installMediaKeys(), []);

  // Reprend AudioContext EQ seulement s’il est déjà activé
  useEffect(() => {
    const resume = () => void resumeEqContext();
    window.addEventListener('pointerdown', resume, { passive: true });
    return () => window.removeEventListener('pointerdown', resume);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void hydrate(), 50);
    return () => clearTimeout(t);
  }, [hydrate]);

  // Persistance lecture à la fermeture / mise en arrière-plan (web + PWA)
  // + refresh biblio au retour (multi-appareils / like≠save)
  useEffect(() => {
    let lastLibRefresh = 0;
    const flush = () => flushPlayerPersist();
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const u = useAuth.getState().user;
      const guest = !u || u.isGuest || u.email?.includes('@local.ytmusic');
      if (guest) return;
      const now = Date.now();
      if (now - lastLibRefresh < 8_000) return;
      lastLibRefresh = now;
      void refresh();
    };
    // Poll léger pour sync playlists créées sur mobile pendant que le drawer est ouvert
    const poll = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const u = useAuth.getState().user;
      const guest = !u || u.isGuest || u.email?.includes('@local.ytmusic');
      if (guest) return;
      const now = Date.now();
      if (now - lastLibRefresh < 20_000) return;
      lastLibRefresh = now;
      void refresh();
    }, 20_000);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onHide);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onHide);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const receiveRemoteSync = useSession((s) => s.receiveRemoteSync);

  useEffect(() => {
    if (!receiveRemoteSync) return;
    if (!remoteState || isActivePlayer) return;
    if (remoteState.updatedAt && remoteState.updatedAt <= lastRemoteAt.current) return;
    lastRemoteAt.current = remoteState.updatedAt || Date.now();
    void applyRemoteState(remoteState, false);
  }, [remoteState, isActivePlayer, applyRemoteState, receiveRemoteSync]);

  // Activation sync → appliquer une fois l’état distant courant
  useEffect(() => {
    if (!receiveRemoteSync || isActivePlayer || !remoteState) return;
    lastRemoteAt.current = remoteState.updatedAt || Date.now();
    void applyRemoteState(remoteState, false);
  }, [receiveRemoteSync]); // eslint-disable-line react-hooks/exhaustive-deps

  const isGuest = !user || user.isGuest || user.email.includes('@local.ytmusic');
  const allowGuestPage = isVerifyRoute;
  /** Hauteur barre lecteur (+ nav bas mobile) — pour ne pas masquer Compte / Admin */
  const playerPad = hasPlayback ? 'pb-40' : 'pb-24';

  const closeNavIfMobile = () => {
    if (window.matchMedia('(max-width: 1023px)').matches) setNavOpen(false);
  };

  const sideNav = (
    <>
      <div className="mb-4 flex shrink-0 items-center justify-between gap-2 px-2">
        <div className="flex min-w-0 items-center gap-2">
          <BrandLogo className="h-8 w-8 shrink-0" />
          <span
            className="font-display text-lg font-semibold tracking-tight"
            title="Pue La Merde"
          >
            PLM
          </span>
        </div>
        <button
          type="button"
          onClick={() => setNavOpen(false)}
          className="rounded-lg p-2 text-yt-muted hover:bg-yt-hover hover:text-white"
          title="Replier le menu"
          aria-label="Replier le menu"
        >
          <PanelLeftClose className="h-5 w-5" />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <nav className="flex flex-col gap-1">
          {links.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={closeNavIfMobile}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                  isActive ? 'bg-yt-elevated text-white' : 'text-yt-muted hover:bg-yt-hover hover:text-white'
                }`
              }
            >
              <Icon className="h-5 w-5" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-4 border-t border-yt-border pt-4">
          <button
            type="button"
            onClick={() => {
              const name = window.prompt('Nom de la playlist');
              if (!name?.trim()) return;
              void createPlaylist(name.trim()).then((pl) => {
                if (pl?.id) {
                  closeNavIfMobile();
                  navigate(`/local-playlist/${pl.id}`);
                }
              });
            }}
            className="mb-2 flex w-full items-center justify-center gap-2 rounded-full border border-yt-border bg-yt-elevated px-3 py-2 text-sm font-medium text-white hover:bg-yt-hover"
          >
            <Plus className="h-4 w-4" /> Nouvelle playlist
          </button>
          <NavLink
            to="/library"
            onClick={closeNavIfMobile}
            className="mb-0.5 flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-yt-muted hover:bg-yt-hover hover:text-white"
          >
            <ListMusic className="h-4 w-4 shrink-0 text-yt-red" />
            <div className="min-w-0">
              <div className="truncate font-medium text-white">Musique « J&apos;aime »</div>
              <div className="truncate text-[11px] text-yt-muted">Titres aimés</div>
            </div>
          </NavLink>
          {playlists.map((p) => (
            <NavLink
              key={p.id}
              to={`/local-playlist/${p.id}`}
              onClick={closeNavIfMobile}
              className={({ isActive }) =>
                `mb-0.5 block rounded-lg px-2 py-2 text-left text-sm transition ${
                  isActive ? 'bg-yt-elevated text-white' : 'text-yt-muted hover:bg-yt-hover hover:text-white'
                }`
              }
            >
              <div className="truncate font-medium text-white">{p.name}</div>
              <div className="truncate text-[11px] text-yt-muted">
                {p.tracks.length} titres · {user?.name || 'Toi'}
              </div>
            </NavLink>
          ))}
          {likedPlaylists.slice(0, 20).map((p: any) => (
            <NavLink
              key={`liked-pl-${p.id}`}
              to={`/playlist/${p.id}`}
              onClick={closeNavIfMobile}
              className={({ isActive }) =>
                `mb-0.5 block rounded-lg px-2 py-2 text-left text-sm transition ${
                  isActive ? 'bg-yt-elevated text-white' : 'text-yt-muted hover:bg-yt-hover hover:text-white'
                }`
              }
            >
              <div className="truncate font-medium text-white">{p.title || p.name}</div>
              <div className="truncate text-[11px] text-yt-muted">Playlist sauvegardée</div>
            </NavLink>
          ))}
        </div>
      </div>

      {/* Pied fixe : Compte / Admin toujours au-dessus de la barre lecteur */}
      <div className={`mt-2 shrink-0 border-t border-yt-border bg-yt-bg pt-3 ${playerPad}`}>
        <NavLink
          to="/profile"
          onClick={closeNavIfMobile}
          className={({ isActive }) =>
            `mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition ${
              isActive ? 'bg-yt-elevated text-white' : 'text-yt-muted hover:bg-yt-hover hover:text-white'
            }`
          }
          title={user?.email || 'Profil'}
        >
          <UserRound className="h-5 w-5 shrink-0" />
          <span className="min-w-0 truncate" title={user?.email || 'Profil'}>
            {isGuest ? 'Profil' : user?.email || user?.name || 'Compte'}
          </span>
        </NavLink>
        {user?.isAdmin && (
          <NavLink
            to="/admin"
            onClick={closeNavIfMobile}
            className={({ isActive }) =>
              `mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition ${
                isActive ? 'bg-yt-elevated text-white' : 'text-yt-muted hover:bg-yt-hover hover:text-white'
              }`
            }
          >
            <Settings2 className="h-5 w-5" />
            Admin / Paramètres
          </NavLink>
        )}
        <button
          type="button"
          onClick={() => {
            closeNavIfMobile();
            setDevicesOpen(true);
          }}
          className="mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-yt-muted hover:bg-yt-hover hover:text-white"
        >
          Appareils / Cast
        </button>
        <button
          type="button"
          onClick={() => {
            closeNavIfMobile();
            if (isGuest) setAuthOpen(true);
            else void logout().then(() => refresh());
          }}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-yt-muted hover:bg-yt-hover hover:text-white"
        >
          {user?.picture ? (
            <img src={user.picture} alt="" className="h-6 w-6 rounded-full" referrerPolicy="no-referrer" />
          ) : (
            <UserRound className="h-5 w-5" />
          )}
          <span className="truncate">{isGuest ? 'Se connecter' : 'Déconnexion'}</span>
        </button>
        <p className="mt-1 px-3 pb-1 text-[11px] tabular-nums tracking-wide text-yt-muted/70" title="Canal + version">
          {appVersionLabel()}
        </p>
      </div>
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-yt-bg">
      <ProxyHealthBanner />
      <OfflineBanner />
      <div className="flex min-h-0 flex-1">
        {/* Overlay drawer (mobile + quand on ouvre par-dessus) */}
        {navOpen && (
          <button
            type="button"
            aria-label="Fermer le menu"
            className="fixed inset-0 z-40 bg-black/50 lg:hidden"
            onClick={() => setNavOpen(false)}
          />
        )}

        {/* Drawer / sidebar */}
        <aside
          className={`fixed inset-y-0 left-0 z-[60] flex w-[min(18rem,88vw)] flex-col overflow-hidden border-r border-yt-border bg-yt-bg px-3 py-4 transition-transform duration-200 ease-out lg:static lg:z-20 lg:w-60 lg:shrink-0 lg:transition-none ${
            navOpen ? 'translate-x-0' : '-translate-x-full lg:hidden'
          }`}
          aria-hidden={!navOpen}
        >
          {sideNav}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-yt-border/60 bg-yt-bg/90 px-3 py-3 backdrop-blur-md sm:gap-3 sm:px-4">
            <button
              type="button"
              onClick={() => setNavOpen((v) => !v)}
              className="shrink-0 rounded-lg p-2 text-yt-muted hover:bg-yt-hover hover:text-white"
              title={navOpen ? 'Replier le menu' : 'Ouvrir le menu'}
              aria-label={navOpen ? 'Replier le menu' : 'Ouvrir le menu'}
              aria-expanded={navOpen}
            >
              {navOpen ? <PanelLeftClose className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
            <form
              className="relative mx-auto w-full max-w-xl"
              onSubmit={(e) => {
                e.preventDefault();
                const query = q.trim();
                if (!query) return;
                setOpenSug(false);
                void api.recordSearch(query);
                navigate(`/search?q=${encodeURIComponent(query)}`);
              }}
            >
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-yt-muted" />
              <input
                value={q}
                onChange={(e) => {
                  const v = e.target.value;
                  setQ(v);
                  typedDraftRef.current = v;
                  setSugIndex(-1);
                  setOpenSug(true);
                }}
                onFocus={() => setOpenSug(true)}
                onKeyDown={(e) => {
                  const draft = typedDraftRef.current.trim();
                  // Historique : uniquement les entrées (pas d’option « texte tapé »)
                  // Suggestions : option tapée en tête si besoin
                  const opts = historyMode
                    ? suggestions
                    : [
                        ...(draft ? [draft] : []),
                        ...suggestions.filter((s) => s.trim().toLowerCase() !== draft.toLowerCase()),
                      ];
                  const n = opts.length;

                  if (e.key === 'ArrowDown' && openSug && n > 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    const next = historyMode
                      ? sugIndex < 0
                        ? 0
                        : (sugIndex + 1) % n
                      : sugIndex < 0
                        ? 0
                        : sugIndex >= n - 1
                          ? -1
                          : sugIndex + 1;
                    setSugIndex(next);
                    if (historyMode) {
                      setQ(opts[next] || '');
                    } else {
                      setQ(next < 0 ? typedDraftRef.current : opts[next] || typedDraftRef.current);
                    }
                    return;
                  }
                  if (e.key === 'ArrowUp' && openSug && n > 0) {
                    e.preventDefault();
                    e.stopPropagation();
                    const next = historyMode
                      ? sugIndex <= 0
                        ? n - 1
                        : sugIndex - 1
                      : sugIndex < 0
                        ? n - 1
                        : sugIndex === 0
                          ? -1
                          : sugIndex - 1;
                    setSugIndex(next);
                    if (historyMode) {
                      setQ(opts[next] || '');
                    } else {
                      setQ(next < 0 ? typedDraftRef.current : opts[next] || typedDraftRef.current);
                    }
                    return;
                  }
                  if (e.key === 'Enter' && openSug && sugIndex >= 0 && opts[sugIndex]) {
                    e.preventDefault();
                    const pick = opts[sugIndex];
                    typedDraftRef.current = pick;
                    setQ(pick);
                    setOpenSug(false);
                    setSugIndex(-1);
                    void api.recordSearch(pick);
                    navigate(`/search?q=${encodeURIComponent(pick)}`);
                    return;
                  }
                  if (e.key !== 'Escape') return;
                  e.preventDefault();
                  e.stopPropagation();
                  setOpenSug(false);
                  setSugIndex(-1);
                  if (q) {
                    setQ('');
                    typedDraftRef.current = '';
                  }
                }}
                onBlur={() => {
                  window.setTimeout(() => {
                    setOpenSug(false);
                    setSugIndex(-1);
                  }, 180);
                }}
                placeholder="Rechercher titres, albums, artistes…"
                className={`w-full rounded-full border border-yt-border bg-yt-surface py-2.5 pl-10 text-sm outline-none transition focus:border-white/30 ${
                  q ? 'pr-24' : 'pr-20'
                }`}
                aria-label="Recherche"
                aria-autocomplete="list"
                aria-expanded={openSug}
              />
              <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                {q ? (
                  <button
                    type="button"
                    aria-label="Effacer la recherche"
                    className="rounded-full p-1.5 text-yt-muted transition hover:bg-white/10 hover:text-white"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setQ('');
                      typedDraftRef.current = '';
                      setSugIndex(-1);
                      setOpenSug(true);
                      if (location.pathname.startsWith('/search')) {
                        navigate('/search');
                      }
                    }}
                  >
                    <X className="h-4 w-4" />
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label="Dictée vocale"
                  title="Dictée"
                  className="rounded-full p-1.5 text-yt-muted transition hover:bg-white/10 hover:text-white"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    startWebSpeechDictation({
                      onResult: (text) => {
                        setQ(text);
                        typedDraftRef.current = text;
                        navigate(`/search?q=${encodeURIComponent(text)}`);
                        void api.recordSearch(text);
                      },
                      onError: (msg) => window.alert(msg),
                    });
                  }}
                >
                  <Mic className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  aria-label="Identifier un titre"
                  title="Écouter / fredonner"
                  className="rounded-full p-1.5 text-yt-muted transition hover:bg-white/10 hover:text-white"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setIdentifyOpen(true)}
                >
                  <Music2 className="h-4 w-4" />
                </button>
              </div>
              {openSug && (suggestions.length > 0 || (!historyMode && (typedDraftRef.current.trim() || q.trim()))) && (
                <div className="absolute left-0 right-0 top-full z-30 mt-2 max-h-80 overflow-y-auto rounded-xl border border-yt-border bg-yt-elevated shadow-2xl">
                  {historyMode && suggestions.length > 0 ? (
                    <p className="px-4 pt-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-yt-muted">
                      Récentes
                    </p>
                  ) : null}
                  {(() => {
                    const draft = typedDraftRef.current.trim() || q.trim();
                    const opts = historyMode
                      ? suggestions.map((s) => ({ label: s, isTyped: false }))
                      : [
                          ...(draft ? [{ label: draft, isTyped: true }] : []),
                          ...suggestions
                            .filter((s) => s.trim().toLowerCase() !== draft.toLowerCase())
                            .map((s) => ({ label: s, isTyped: false })),
                        ];
                    return opts.map((opt, i) => {
                      const hi = historyMode
                        ? sugIndex === i || (sugIndex < 0 && i === 0 && false)
                        : sugIndex < 0
                          ? opt.isTyped
                          : sugIndex === i;
                      return (
                        <button
                          key={`${opt.isTyped ? 'typed' : 'sug'}-${opt.label}`}
                          type="button"
                          className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm ${
                            hi ? 'bg-yt-hover text-white' : 'hover:bg-yt-hover'
                          }`}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            typedDraftRef.current = opt.label;
                            setQ(opt.label);
                            setOpenSug(false);
                            setSugIndex(-1);
                            void api.recordSearch(opt.label);
                            navigate(`/search?q=${encodeURIComponent(opt.label)}`);
                          }}
                        >
                          <Search className="h-3.5 w-3.5 text-yt-muted" />
                          <span className={opt.isTyped ? 'italic text-yt-muted' : undefined}>
                            {opt.isTyped ? `Rechercher « ${opt.label} »` : opt.label}
                          </span>
                        </button>
                      );
                    });
                  })()}
                </div>
              )}
            </form>
            <button
              type="button"
              onClick={() => setDevicesOpen(true)}
              className="hidden shrink-0 rounded-full bg-yt-elevated px-3 py-2 text-xs text-yt-muted hover:text-white sm:inline-flex"
            >
              Cast
            </button>
            <button
              type="button"
              onClick={() => (isGuest ? setAuthOpen(true) : navigate('/profile'))}
              className="hidden max-w-[9rem] shrink-0 truncate rounded-full bg-yt-elevated px-3 py-2 text-xs text-yt-muted hover:text-white sm:inline-flex"
              title={user?.email || 'Compte'}
            >
              {isGuest ? 'Compte' : user?.email?.split('@')[0] || user?.name?.split(' ')[0] || 'Compte'}
            </button>
          </header>

          <main
            className={`min-h-0 flex-1 overflow-y-auto px-4 pt-4 md:px-8 ${
              // Mobile : lecteur + nav bas (~3.25rem) ; desktop/lg : lecteur seul (pas de nav bas)
              hasPlayback
                ? 'pb-[calc(var(--ytm-player-h,8rem)+3.5rem)] lg:pb-[calc(var(--ytm-player-h,5.5rem)+1.25rem)]'
                : 'pb-24 lg:pb-28'
            }`}
          >
            {!authLoaded && <p className="text-yt-muted">Chargement…</p>}
            {authLoaded && isGuest && !allowGuestPage && (
              <div className="mx-auto max-w-md rounded-2xl border border-yt-border bg-yt-elevated p-6 text-center">
                <BrandLogo className="mx-auto mb-3 h-12 w-12" />
                <h1 className="font-display text-xl font-semibold">Compte requis</h1>
                <p className="mt-2 text-sm text-yt-muted">
                  Connecte-toi pour l’accueil, Explorer, la radio et tes recommandations personnelles.
                </p>
                <button
                  type="button"
                  onClick={() => setAuthOpen(true)}
                  className="mt-4 rounded-full bg-yt-red px-5 py-2.5 text-sm font-medium"
                >
                  Se connecter / Créer un compte
                </button>
              </div>
            )}
            {authLoaded && (!isGuest || allowGuestPage) && (
              <>
                {!isActivePlayer && receiveRemoteSync && !allowGuestPage && (
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-yt-red/30 bg-yt-red/10 px-4 py-2 text-sm">
                    <span>La musique joue ailleurs — clique Lecture pour écouter ici.</span>
                    <button
                      type="button"
                      className="shrink-0 rounded-full bg-yt-red px-3 py-1 text-xs font-medium text-white"
                      onClick={() => {
                        transferHere();
                        void usePlayer.getState().toggle();
                      }}
                    >
                      Écouter ici
                    </button>
                  </div>
                )}
                <Outlet />
              </>
            )}
          </main>
        </div>

        {!nowPlayingOpen && <QueuePanel />}
      </div>

      {/* Nav bas : uniquement < lg — au-dessus du lecteur, jamais sur grand écran (drawer gauche) */}
      {!nowPlayingOpen && !navOpen && (
        <nav
          className="fixed inset-x-0 z-40 flex border-t border-yt-border bg-yt-surface lg:hidden"
          style={{
            bottom: 'var(--ytm-player-h, 0px)',
            // Safe-area seulement sans lecteur (sinon déjà géré par PlayerBar)
            paddingBottom: hasPlayback ? 0 : 'env(safe-area-inset-bottom)',
          }}
          aria-label="Navigation principale"
        >
          {links.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex min-w-0 flex-1 flex-col items-center gap-0.5 px-1 py-2 text-[10px] leading-tight ${
                  isActive ? 'text-white' : 'text-yt-muted'
                }`
              }
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span className="max-w-full truncate">{label}</span>
            </NavLink>
          ))}
        </nav>
      )}

      {/* Lecteur : toujours visible s’il y a un titre (y compris restauré) ; sinon compact desktop only */}
      {(hasPlayback || !isGuest) && (
        <PlayerBar
          expanded={nowPlayingOpen}
          compactEmpty={!hasPlayback}
          onOpenDevices={() => setDevicesOpen(true)}
          onExpand={(tab) => {
            setNowPlayingTab(tab || 'queue');
            setNowPlayingOpen(true);
          }}
          onCollapse={() => setNowPlayingOpen(false)}
        />
      )}
      <NowPlaying
        open={nowPlayingOpen}
        initialTab={nowPlayingTab}
        onClose={() => setNowPlayingOpen(false)}
      />
      <InstallBanner />
      <SearchIdentifySheet open={identifyOpen} onClose={() => setIdentifyOpen(false)} />
      <AuthModal
        open={(authOpen || (authLoaded && isGuest && !allowGuestPage)) && !needsOnboarding}
        onClose={() => {
          if (!isGuest) setAuthOpen(false);
        }}
      />
      {needsOnboarding && !isGuest && (
        <OnboardingWizard
          onDone={() => {
            setNeedsOnboarding(false);
            setAuthOpen(false);
            void refresh();
            // Recharge l’accueil avec les nouvelles prefs
            if (location.pathname === '/' || location.pathname === '') {
              window.location.assign('/');
            }
          }}
        />
      )}
      <DevicePicker open={devicesOpen} onClose={() => setDevicesOpen(false)} />
      <PerfHud />
      <ItemActionsSheet onOpenEqualizer={() => setEqOpen(true)} />
      <EqualizerPanel open={eqOpen} onClose={() => setEqOpen(false)} />

      <audio
        ref={audioRef}
        preload="auto"
        playsInline
        onPlay={(e) => {
          if (e.currentTarget !== usePlayer.getState().audioEl) return;
          usePlayer.setState({ isPlaying: true });
          void resumeEqContext();
        }}
        onPlaying={(e) => {
          if (e.currentTarget !== usePlayer.getState().audioEl) return;
          usePlayer.setState({ isPlaying: true });
        }}
        onPause={(e) => {
          if (e.currentTarget !== usePlayer.getState().audioEl) return;
          usePlayer.setState({ isPlaying: false });
        }}
        onEnded={(e) => {
          if (e.currentTarget !== usePlayer.getState().audioEl) return;
          const s = usePlayer.getState();
          if (s.sleepUntilEnd) {
            s.setSleepTimer(null, null);
            usePlayer.setState({ isPlaying: false });
            return;
          }
          if (s.sleepUntilQueueEnd && s.queueIndex >= s.queue.length - 1) {
            s.setSleepTimer(null, null);
            usePlayer.setState({ isPlaying: false });
            return;
          }
          if (s.playError) {
            usePlayer.setState({ isPlaying: false });
            return;
          }
          usePlayer.setState({ isPlaying: false });
          void next({ fromEnded: true });
        }}
        onTimeUpdate={(e) => {
          if (e.currentTarget !== usePlayer.getState().audioEl) return;
          const t = e.currentTarget.currentTime;
          const d = e.currentTarget.duration || 0;
          setProgress(t);
          reportListenProgress(t, d);
        }}
        onLoadedMetadata={(e) => {
          if (e.currentTarget !== usePlayer.getState().audioEl) return;
          const sec = e.currentTarget.duration || 0;
          setDuration(sec);
          const id = e.currentTarget.dataset.trackId;
          if (!(sec > 0) || !id) return;
          const clock = `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
          usePlayer.setState((s) => ({
            current:
              s.current?.id === id && !s.current.durationSeconds
                ? { ...s.current, durationSeconds: Math.floor(sec), duration: s.current.duration || clock }
                : s.current,
            queue: s.queue.map((t) =>
              t.id === id && !t.durationSeconds
                ? { ...t, durationSeconds: Math.floor(sec), duration: t.duration || clock }
                : t,
            ),
          }));
        }}
      />
      {/* Standby : préchauffe format / blob uniquement (pas de double-stream) */}
      <audio
        ref={standbyRef}
        preload="none"
        playsInline
        onPlay={(e) => {
          if (e.currentTarget !== usePlayer.getState().audioEl) return;
          usePlayer.setState({ isPlaying: true });
          void resumeEqContext();
        }}
        onPlaying={(e) => {
          if (e.currentTarget !== usePlayer.getState().audioEl) return;
          usePlayer.setState({ isPlaying: true });
        }}
        onPause={(e) => {
          if (e.currentTarget !== usePlayer.getState().audioEl) return;
          usePlayer.setState({ isPlaying: false });
        }}
        onEnded={(e) => {
          if (e.currentTarget !== usePlayer.getState().audioEl) return;
          const s = usePlayer.getState();
          if (s.sleepUntilEnd) {
            s.setSleepTimer(null, null);
            usePlayer.setState({ isPlaying: false });
            return;
          }
          if (s.sleepUntilQueueEnd && s.queueIndex >= s.queue.length - 1) {
            s.setSleepTimer(null, null);
            usePlayer.setState({ isPlaying: false });
            return;
          }
          if (s.playError) {
            usePlayer.setState({ isPlaying: false });
            return;
          }
          usePlayer.setState({ isPlaying: false });
          void next({ fromEnded: true });
        }}
        onTimeUpdate={(e) => {
          if (e.currentTarget !== usePlayer.getState().audioEl) return;
          const t = e.currentTarget.currentTime;
          const d = e.currentTarget.duration || 0;
          setProgress(t);
          reportListenProgress(t, d);
        }}
        onLoadedMetadata={(e) => {
          if (e.currentTarget !== usePlayer.getState().audioEl) return;
          setDuration(e.currentTarget.duration || 0);
        }}
      />
    </div>
  );
}
