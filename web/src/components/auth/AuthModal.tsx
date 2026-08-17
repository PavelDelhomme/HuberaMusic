import { useEffect, useRef, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { QRCodeSVG } from 'qrcode.react';
import { api, setRefreshToken, setToken } from '../../api';
import { useAuth } from '../../store/auth';
import { useLibrary } from '../../store/library';
import { Fingerprint, KeyRound, QrCode } from 'lucide-react';
import {
  dismissPasskeyOffer,
  markLocalPasskeyReady,
  passkeyPlatformOk,
  wasPasskeyOfferDismissed,
} from '../../lib/auth/passkeyEnrollment';

declare global {
  interface Window {
    google?: any;
  }
}

const isProdHost =
  typeof window !== 'undefined' &&
  !/^(localhost|127\.0\.0\.1)$/i.test(window.location.hostname);

export function AuthModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { login, register, loginGoogle, googleEnabled, googleClientId, user, init, allowRegister } = useAuth();
  const refresh = useLibrary((s) => s.refresh);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState(() =>
    import.meta.env.DEV && !isProdHost ? String(import.meta.env.VITE_DEV_EMAIL || '') : '',
  );
  // Jamais de mot de passe dans le bundle prod (VITE_* est public au build)
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [name, setName] = useState('');
  const [totp, setTotp] = useState('');
  const [needs2fa, setNeeds2fa] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState('');
  const [step, setStep] = useState<'form' | 'passkey-offer'>('form');
  // Bitwarden / gestionnaires : bouton visible dès que WebAuthn est dispo (pas de flag local)
  const showPasskeyLogin = passkeyPlatformOk();
  const [qr, setQr] = useState<{
    id: string;
    code: string;
    pollSecret: string;
    approveUrl: string;
    expiresAt: number;
  } | null>(null);
  const [qrStatus, setQrStatus] = useState<'idle' | 'waiting' | 'expired'>('idle');
  const googleBtn = useRef<HTMLDivElement>(null);

  const isGuest = !user || user.isGuest || user.email.includes('@local.ytmusic');

  useEffect(() => {
    if (!open) {
      setStep('form');
      setError('');
      setInfo('');
      setQr(null);
      setQrStatus('idle');
    }
  }, [open]);

  // QR login : appareil à connecter poll jusqu’à approbation (téléphone déjà connecté)
  useEffect(() => {
    if (!open || mode !== 'login' || step !== 'form' || !isGuest) return;
    let cancelled = false;
    let pollTimer: number | undefined;
    let refreshTimer: number | undefined;

    const boot = async () => {
      try {
        const s = await api.deviceLoginStart();
        if (cancelled) return;
        // Toujours l’URL publique du navigateur (évite IP Docker / localhost API)
        const approveUrl = `${window.location.origin}/login-device?id=${encodeURIComponent(s.id)}&code=${encodeURIComponent(s.code)}`;
        setQr({ ...s, approveUrl });
        setQrStatus('waiting');
        const poll = () => {
          pollTimer = window.setTimeout(async () => {
            if (cancelled) return;
            try {
              const r = await api.deviceLoginPoll(s.id, s.pollSecret);
              if (cancelled) return;
              if (r.status === 'approved' && r.token) {
                setToken(r.token);
                if (r.refreshToken) setRefreshToken(r.refreshToken);
                await init();
                await refresh();
                onClose();
                return;
              }
              if (r.status === 'expired') {
                setQrStatus('expired');
                return;
              }
              poll();
            } catch {
              poll();
            }
          }, 1500);
        };
        poll();
        refreshTimer = window.setTimeout(() => {
          if (!cancelled) void boot();
        }, Math.max(5_000, s.expiresAt - Date.now() - 5_000));
      } catch {
        if (!cancelled) setQrStatus('idle');
      }
    };
    void boot();
    return () => {
      cancelled = true;
      if (pollTimer) window.clearTimeout(pollTimer);
      if (refreshTimer) window.clearTimeout(refreshTimer);
    };
  }, [open, mode, step, isGuest, init, refresh, onClose]);

  useEffect(() => {
    if (!open || !googleEnabled || !googleClientId) return;
    const scriptId = 'google-gsi';
    const boot = () => {
      if (!window.google || !googleBtn.current) return;
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: async (resp: { credential: string }) => {
          try {
            await loginGoogle(resp.credential);
            await refresh();
            await maybeOfferPasskey();
          } catch (e) {
            setError(String((e as Error).message || e));
          }
        },
      });
      googleBtn.current.innerHTML = '';
      window.google.accounts.id.renderButton(googleBtn.current, {
        theme: 'outline',
        size: 'large',
        width: 320,
        text: 'continue_with',
        shape: 'pill',
      });
    };
    if (!document.getElementById(scriptId)) {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.id = scriptId;
      s.onload = boot;
      document.body.appendChild(s);
    } else boot();
  }, [open, googleEnabled, googleClientId, loginGoogle, refresh]);

  async function maybeOfferPasskey() {
    if (!passkeyPlatformOk() || wasPasskeyOfferDismissed()) {
      onClose();
      return;
    }
    try {
      const { passkeys } = await api.passkeys();
      if ((passkeys?.length || 0) > 0) {
        markLocalPasskeyReady();
        onClose();
        return;
      }
    } catch {
      /* ignore */
    }
    setStep('passkey-offer');
  }

  async function enrollPasskey() {
    setBusy(true);
    setError('');
    try {
      const options = await api.passkeyRegisterOptions();
      const cred = await startRegistration({ optionsJSON: options });
      await api.passkeyRegisterVerify(cred, navigator.platform || 'Web');
      markLocalPasskeyReady();
      setInfo('Passkey enregistrée — tu pourras te connecter sans mot de passe.');
      onClose();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  if (step === 'passkey-offer') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
        <div className="w-full max-w-md rounded-2xl border border-yt-border bg-yt-surface p-6 shadow-2xl">
          <div className="mb-3 flex items-center gap-2">
            <Fingerprint className="h-6 w-6 text-yt-red" />
            <h2 className="font-display text-xl font-semibold">Connexion rapide ?</h2>
          </div>
          <p className="mb-5 text-sm text-yt-muted">
            Enregistre une passkey (Bitwarden, gestionnaire de mots de passe, empreinte / Face ID)
            pour te reconnecter sans retaper ton mot de passe. Tu pourras aussi le faire plus tard
            dans Profil.
          </p>
          {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
          <button
            type="button"
            disabled={busy}
            className="mb-2 flex w-full items-center justify-center gap-2 rounded-full bg-yt-red py-2.5 text-sm font-medium disabled:opacity-60"
            onClick={() => void enrollPasskey()}
          >
            <KeyRound className="h-4 w-4" />
            {busy ? 'Enregistrement…' : 'Enregistrer une passkey'}
          </button>
          <button
            type="button"
            disabled={busy}
            className="w-full rounded-full border border-yt-border py-2.5 text-sm text-yt-muted hover:text-white"
            onClick={() => {
              dismissPasskeyOffer();
              onClose();
            }}
          >
            Plus tard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl border border-yt-border bg-yt-surface p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="font-display text-2xl font-semibold">
              {mode === 'login' ? 'Connexion' : 'Créer un compte'}
            </h2>
            <p className="mt-1 text-sm text-yt-muted">
              Session longue sécurisée (refresh) — web, mobile PWA et desktop.
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-yt-muted hover:text-white">
            ✕
          </button>
        </div>

        {!isGuest && (
          <p className="mb-3 rounded-lg bg-yt-elevated px-3 py-2 text-sm">
            Connecté : {user!.name} ({user!.email})
            {!user!.emailVerified && (
              <button
                type="button"
                className="ml-2 text-yt-red underline"
                onClick={() => void api.resendVerification().then(() => setInfo('Email renvoyé'))}
              >
                Renvoyer validation
              </button>
            )}
          </p>
        )}

        {googleEnabled && (
          <div className="mb-4 flex justify-center">
            <div ref={googleBtn} />
          </div>
        )}

        {mode === 'login' && showPasskeyLogin && passkeyPlatformOk() && (
          <button
            type="button"
            disabled={busy}
            className="mb-3 flex w-full items-center justify-center gap-2 rounded-full border border-yt-border bg-yt-elevated py-2.5 text-sm font-medium hover:bg-yt-hover disabled:opacity-60"
            onClick={() => {
              setBusy(true);
              setError('');
              void (async () => {
                try {
                  const options = await api.passkeyLoginOptions(email || undefined);
                  const cred = await startAuthentication({ optionsJSON: options });
                  const r = await api.passkeyLoginVerify(cred);
                  setToken(r.token);
                  if ((r as any).refreshToken) setRefreshToken((r as any).refreshToken);
                  await init();
                  await refresh();
                  markLocalPasskeyReady();
                  onClose();
                } catch (e) {
                  setError(
                    String((e as Error).message || e) ||
                      'Aucune passkey trouvée — connecte-toi au mot de passe puis enregistre-en une.',
                  );
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            <Fingerprint className="h-4 w-4" /> Continuer avec une passkey
          </button>
        )}

        {mode === 'login' && isGuest && (
          <div className="mb-4 rounded-2xl border border-yt-border bg-yt-elevated/60 p-4 text-center">
            <div className="mb-2 flex items-center justify-center gap-1.5 text-sm font-medium">
              <QrCode className="h-4 w-4 text-yt-red" />
              Connexion rapide (QR)
            </div>
            {qr?.approveUrl ? (
              <div className="mx-auto inline-flex rounded-xl bg-white p-3">
                <QRCodeSVG value={qr.approveUrl} size={168} level="M" />
              </div>
            ) : (
              <div className="mx-auto flex h-[192px] w-[192px] items-center justify-center rounded-xl bg-yt-bg text-xs text-yt-muted">
                Préparation du QR…
              </div>
            )}
            <p className="mt-3 text-xs text-yt-muted">
              {qrStatus === 'expired'
                ? 'QR expiré — un nouveau se génère…'
                : 'Scanne avec ton téléphone déjà connecté (app ou navigateur) pour autoriser cet écran.'}
            </p>
          </div>
        )}

        {mode === 'login' && !showPasskeyLogin && (
          <p className="mb-4 text-center text-xs text-yt-muted">
            Passkey non dispo sur ce navigateur — utilise le mot de passe ou un gestionnaire compatible.
          </p>
        )}

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError('');
            setInfo('');
            void (async () => {
              try {
                if (mode === 'login') {
                  try {
                    await login(email, password, needs2fa ? totp : undefined);
                  } catch (err) {
                    const msg = String((err as Error).message || err);
                    if ((err as any).needs2fa || msg.includes('2FA')) {
                      setNeeds2fa(true);
                      setError('Entre le code 2FA de ton application d’authentification');
                      return;
                    }
                    throw err;
                  }
                  await refresh();
                  await maybeOfferPasskey();
                } else {
                  await register(email, password, name || email.split('@')[0]);
                  setInfo(
                    'Compte créé — un email de validation a été envoyé. En local : Admin → Boîte mail / logs serveur.',
                  );
                  await refresh();
                  await maybeOfferPasskey();
                }
              } catch (err) {
                setError(String((err as Error).message || err));
              }
            })();
          }}
        >
          {mode === 'register' && (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nom"
              className="w-full rounded-xl border border-yt-border bg-yt-bg px-3 py-2.5 text-sm outline-none focus:border-white/30"
            />
          )}
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="w-full rounded-xl border border-yt-border bg-yt-bg px-3 py-2.5 text-sm outline-none focus:border-white/30"
          />
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mot de passe"
              className="w-full rounded-xl border border-yt-border bg-yt-bg px-3 py-2.5 pr-12 text-sm outline-none focus:border-white/30"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-yt-muted hover:text-white"
              aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
            >
              {showPassword ? 'Masquer' : 'Voir'}
            </button>
          </div>
          {needs2fa && (
            <input
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              placeholder="Code 2FA (6 chiffres)"
              inputMode="numeric"
              className="w-full rounded-xl border border-yt-border bg-yt-bg px-3 py-2.5 text-sm outline-none focus:border-white/30"
            />
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}
          {info && <p className="text-sm text-emerald-400">{info}</p>}
          <button type="submit" className="w-full rounded-full bg-yt-red py-2.5 text-sm font-medium">
            {mode === 'login' ? 'Se connecter' : "S'inscrire"}
          </button>
        </form>

        {allowRegister || mode === 'register' ? (
        <button
          type="button"
          className="mt-4 w-full text-center text-sm text-yt-muted hover:text-white"
          onClick={() => {
            if (!allowRegister) {
              setMode('login');
              return;
            }
            setMode((m) => (m === 'login' ? 'register' : 'login'));
            setNeeds2fa(false);
          }}
        >
          {mode === 'login' ? 'Créer un compte' : 'Déjà un compte ? Connexion'}
        </button>
        ) : (
          <p className="mt-4 text-center text-xs text-yt-muted">Inscription fermée — demande un accès à l’admin.</p>
        )}
      </div>
    </div>
  );
}
