import { useEffect, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../../api';
import { useAuth } from '../../store/auth';
import { Fingerprint, KeyRound, QrCode, Shield, Smartphone, Sparkles, Trash2 } from 'lucide-react';
import type { User } from '../../api';
import { markLocalPasskeyReady } from '../../lib/auth/passkeyEnrollment';
import { OnboardingWizard } from '../../components/auth/OnboardingWizard';
import { PerfToggleButton } from '../../components/layout/PerfHud';
import { appVersionLabel } from '../../lib/util/appVersion';

function TwoFactorSection({ user, onUpdated }: { user: User; onUpdated: () => Promise<void> }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  return (
    <section className="mb-8 rounded-2xl border border-yt-border bg-yt-surface p-5">
      <div className="mb-4 flex items-center gap-2">
        <Shield className="h-5 w-5 text-yt-red" />
        <h2 className="font-display text-lg font-semibold">Double authentification (2FA)</h2>
      </div>
      <p className="mb-4 text-sm text-yt-muted">
        TOTP (Google Authenticator, Aegis, etc.). Requise à chaque connexion email/mot de passe.
      </p>
      {user.totpEnabled ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setErr('');
            void api
              .totpDisable(code)
              .then(async () => {
                setMsg('2FA désactivée');
                setCode('');
                await onUpdated();
              })
              .catch((ex) => setErr(String(ex.message || ex)))
              .finally(() => setBusy(false));
          }}
        >
          <p className="w-full text-sm text-emerald-400">2FA active</p>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Code pour désactiver"
            className="rounded-xl border border-yt-border bg-yt-bg px-3 py-2 text-sm outline-none"
          />
          <button
            type="submit"
            disabled={busy || code.length < 6}
            className="rounded-full bg-yt-elevated px-4 py-2 text-sm disabled:opacity-50"
          >
            Désactiver
          </button>
        </form>
      ) : secret ? (
        <div className="space-y-3">
          <div className="inline-block rounded-2xl bg-white p-3">
            <QRCodeSVG value={otpauthUrl} size={160} />
          </div>
          <p className="break-all text-xs text-yt-muted">Secret : {secret}</p>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setErr('');
              void api
                .totpEnable(secret, code)
                .then(async () => {
                  setMsg('2FA activée');
                  setSecret(null);
                  setCode('');
                  await onUpdated();
                })
                .catch((ex) => setErr(String(ex.message || ex)))
                .finally(() => setBusy(false));
            }}
          >
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Code à 6 chiffres"
              className="rounded-xl border border-yt-border bg-yt-bg px-3 py-2 text-sm outline-none"
            />
            <button
              type="submit"
              disabled={busy || code.length < 6}
              className="rounded-full bg-yt-red px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              Confirmer
            </button>
          </form>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          className="rounded-full bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-60"
          onClick={() => {
            setBusy(true);
            setErr('');
            void api
              .totpSetup()
              .then((r) => {
                setSecret(r.secret);
                setOtpauthUrl(r.otpauthUrl);
              })
              .catch((ex) => setErr(String(ex.message || ex)))
              .finally(() => setBusy(false));
          }}
        >
          Activer la 2FA
        </button>
      )}
      {err && <p className="mt-2 text-sm text-red-400">{err}</p>}
      {msg && <p className="mt-2 text-sm text-emerald-400">{msg}</p>}
    </section>
  );
}

export function ProfilePage() {
  const user = useAuth((s) => s.user);
  const init = useAuth((s) => s.init);
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [passkeys, setPasskeys] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [deployUrl, setDeployUrl] = useState('');
  const [editReco, setEditReco] = useState(false);
  const [inviteUrl, setInviteUrl] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);

  const isGuest = !user || user.isGuest || user.email.includes('@local.ytmusic');

  useEffect(() => {
    setName(user?.name || '');
    setEmail(user?.email || '');
  }, [user]);

  useEffect(() => {
    if (isGuest) return;
    void api.passkeys().then((r) => setPasskeys(r.passkeys)).catch(() => undefined);
  }, [isGuest]);

  useEffect(() => {
    void api
      .deployInfo()
      .then((r) => {
        const lan = r.urls.find((u) => !u.includes('localhost')) || r.urls[0];
        setDeployUrl(lan || window.location.origin);
      })
      .catch(() => setDeployUrl(window.location.origin));
  }, []);

  if (!user) return <p className="text-yt-muted">Chargement…</p>;

  return (
    <div className="animate-fade-up mx-auto max-w-2xl">
      <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight">Profil</h1>
      <p className="mb-8 text-sm text-yt-muted">
        Compte, passkeys et accès rapide depuis ton téléphone.
      </p>

      {isGuest ? (
        <div className="mb-8 rounded-2xl border border-yt-border bg-yt-elevated p-5">
          <h2 className="font-display text-lg font-semibold">Mode invité</h2>
          <p className="mt-2 text-sm text-yt-muted">
            Tu peux tout utiliser sans compte. Crée un compte (menu Connexion) pour synchroniser
            bibliothèque, historique et passkeys entre appareils.
          </p>
        </div>
      ) : (
        <>
          <section className="mb-8 rounded-2xl border border-yt-border bg-yt-surface p-5">
            <h2 className="mb-4 font-display text-lg font-semibold">Identité</h2>
            {!user.emailVerified && (
              <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm">
                Email non validé.{' '}
                <button
                  type="button"
                  className="text-yt-red underline"
                  onClick={() => {
                    void api
                      .resendVerification()
                      .then(() => setMsg('Email de validation renvoyé'))
                      .catch((ex) => setErr(String(ex.message || ex)));
                  }}
                >
                  Renvoyer le lien
                </button>
              </div>
            )}
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                setBusy(true);
                setErr('');
                setMsg('');
                void api
                  .updateProfile({ name, email })
                  .then(async () => {
                    await init();
                    setMsg('Profil enregistré');
                  })
                  .catch((ex) => setErr(String(ex.message || ex)))
                  .finally(() => setBusy(false));
              }}
            >
              <label className="block text-xs text-yt-muted">
                Nom
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-yt-border bg-yt-bg px-3 py-2.5 text-sm outline-none focus:border-white/30"
                />
              </label>
              <label className="block text-xs text-yt-muted">
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-yt-border bg-yt-bg px-3 py-2.5 text-sm outline-none focus:border-white/30"
                />
              </label>
              {err && <p className="text-sm text-red-400">{err}</p>}
              {msg && <p className="text-sm text-emerald-400">{msg}</p>}
              <button
                type="submit"
                disabled={busy}
                className="rounded-full bg-yt-red px-5 py-2 text-sm font-medium disabled:opacity-60"
              >
                Enregistrer
              </button>
            </form>
          </section>

          <section className="mb-8 rounded-2xl border border-yt-border bg-yt-surface p-5">
            <div className="mb-4 flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-yt-red" />
              <h2 className="font-display text-lg font-semibold">Recommandations</h2>
            </div>
            <p className="mb-4 text-sm text-yt-muted">
              Affiner genres, ambiances, moments d’écoute, biais découverte et artistes suivis —
              ça recalibre l’accueil, Explorer et la radio.
            </p>
            <button
              type="button"
              className="rounded-full bg-yt-red px-5 py-2 text-sm font-medium"
              onClick={() => setEditReco(true)}
            >
              Affiner mes recommandations
            </button>
          </section>

          <TwoFactorSection user={user} onUpdated={init} />

          {editReco && (
            <OnboardingWizard
              mode="edit"
              onCancel={() => setEditReco(false)}
              onDone={() => {
                setEditReco(false);
                setMsg('Recommandations mises à jour');
              }}
            />
          )}

          <section className="mb-8 rounded-2xl border border-yt-border bg-yt-surface p-5">
            <div className="mb-4 flex items-center gap-2">
              <Fingerprint className="h-5 w-5 text-yt-red" />
              <h2 className="font-display text-lg font-semibold">Passkeys</h2>
            </div>
            <p className="mb-4 text-sm text-yt-muted">
              Connexion rapide par empreinte, Face ID ou PIN appareil — sans mot de passe.
            </p>
            <button
              type="button"
              disabled={busy}
              className="mb-4 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-60"
              onClick={() => {
                setBusy(true);
                setErr('');
                void (async () => {
                  try {
                    const options = await api.passkeyRegisterOptions();
                    const cred = await startRegistration({ optionsJSON: options });
                    const r = await api.passkeyRegisterVerify(cred, navigator.platform || 'Appareil');
                    setPasskeys(r.passkeys);
                    markLocalPasskeyReady();
                    setMsg('Passkey enregistrée');
                  } catch (ex) {
                    setErr(String((ex as Error).message || ex));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              <KeyRound className="h-4 w-4" /> Enregistrer cet appareil
            </button>
            <ul className="space-y-2">
              {passkeys.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between rounded-xl bg-yt-elevated px-3 py-2.5 text-sm"
                >
                  <div>
                    <div className="font-medium">{p.name || 'Passkey'}</div>
                    <div className="text-xs text-yt-muted">
                      {p.device_type || 'platform'} ·{' '}
                      {new Date(p.created_at).toLocaleDateString('fr-FR')}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="rounded-full p-2 text-yt-muted hover:text-red-400"
                    onClick={() => {
                      void api.passkeyDelete(p.id).then((r) => setPasskeys(r.passkeys));
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
              {passkeys.length === 0 && (
                <li className="text-sm text-yt-muted">Aucune passkey pour l&apos;instant.</li>
              )}
            </ul>
          </section>

          <section className="mb-8 rounded-2xl border border-yt-border bg-yt-surface p-5">
            <div className="mb-4 flex items-center gap-2">
              <QrCode className="h-5 w-5 text-yt-red" />
              <h2 className="font-display text-lg font-semibold">Connecter un autre appareil</h2>
            </div>
            <p className="mb-4 text-sm text-yt-muted">
              Affiche un QR temporaire : l’autre appareil le scanne (caméra) et se connecte avec ton
              compte — pratique pour téléphone ↔ PC.
            </p>
            <button
              type="button"
              disabled={inviteBusy}
              className="mb-4 rounded-full border border-yt-border bg-yt-elevated px-4 py-2 text-sm hover:bg-white/10 disabled:opacity-60"
              onClick={() => {
                setInviteBusy(true);
                setErr('');
                void api
                  .deviceLoginInvite()
                  .then((r) => {
                    const claim =
                      new URL(r.claimUrl).searchParams.get('claim') ||
                      r.claimToken;
                    setInviteUrl(
                      `${window.location.origin}/login-device?claim=${encodeURIComponent(claim)}`,
                    );
                  })
                  .catch((ex) => setErr(String(ex.message || ex)))
                  .finally(() => setInviteBusy(false));
              }}
            >
              {inviteBusy ? 'Génération…' : inviteUrl ? 'Régénérer le QR' : 'Afficher un QR'}
            </button>
            {inviteUrl && (
              <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
                <div className="rounded-2xl bg-white p-3">
                  <QRCodeSVG value={inviteUrl} size={160} level="M" />
                </div>
                <p className="max-w-xs text-xs text-yt-muted">
                  Valable ~2 minutes. Sur l’autre appareil : ouvre l’appareil photo → scanne → ouvre
                  le lien (navigateur ou app).
                </p>
              </div>
            )}
          </section>
        </>
      )}

      <section className="mb-8 rounded-2xl border border-yt-border bg-yt-surface p-5">
        <h2 className="mb-2 font-display text-lg font-semibold">Performance</h2>
        <p className="mb-3 text-sm text-yt-muted">
          Affiche un panneau avec les timings (play, explore, mix…). Utile pour diagnostiquer les
          lenteurs.
        </p>
        <PerfToggleButton className="rounded-full border border-yt-border bg-yt-elevated px-4 py-2 text-sm hover:bg-white/10" />
      </section>

      <section className="rounded-2xl border border-yt-border bg-yt-surface p-5">
        <div className="mb-4 flex items-center gap-2">
          <Smartphone className="h-5 w-5 text-yt-red" />
          <h2 className="font-display text-lg font-semibold">Ouvrir sur mobile</h2>
        </div>
        <p className="mb-4 text-sm text-yt-muted">
          Scanne ce QR sur le même Wi‑Fi, puis « Installer l&apos;app » dans le navigateur.
        </p>
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <div className="rounded-2xl bg-white p-3">
            <QRCodeSVG value={deployUrl || window.location.origin} size={160} />
          </div>
          <div className="text-sm">
            <div className="break-all font-medium text-white">{deployUrl}</div>
            <p className="mt-2 text-xs text-yt-muted">
              Android : menu ⋮ → Installer. iPhone : Partager → Sur l&apos;écran d&apos;accueil.
            </p>
          </div>
        </div>
      </section>

      <p className="mt-8 text-center text-xs tabular-nums tracking-wide text-yt-muted/70">
        Version {appVersionLabel()}
      </p>
    </div>
  );
}
