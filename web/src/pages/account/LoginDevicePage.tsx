import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, setRefreshToken, setToken } from '../../api';
import { useAuth } from '../../store/auth';
import { useLibrary } from '../../store/library';

/**
 * Ouvre depuis le QR scanné :
 * - `?id=&code=` → appareil déjà connecté approuve la session
 * - `?claim=` → appareil non connecté récupère la session (invite)
 */
export function LoginDevicePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user, init } = useAuth();
  const refresh = useLibrary((s) => s.refresh);
  const [msg, setMsg] = useState('Préparation…');
  const [ok, setOk] = useState(false);
  const [needAuth, setNeedAuth] = useState(false);
  const ran = useRef(false);

  const id = params.get('id')?.trim() || '';
  const code = params.get('code')?.trim() || '';
  const claim = params.get('claim')?.trim() || '';

  const isGuest = !user || user.isGuest || user.email.includes('@local.ytmusic');

  useEffect(() => {
    if (ran.current) return;

    if (claim) {
      ran.current = true;
      setMsg('Connexion en cours…');
      void api
        .deviceLoginClaim(claim)
        .then(async (r) => {
          setToken(r.token);
          if (r.refreshToken) setRefreshToken(r.refreshToken);
          await init();
          await refresh();
          setOk(true);
          setMsg('Connecté ! Redirection…');
          setTimeout(() => navigate('/'), 1200);
        })
        .catch((e) => setMsg(String(e.message || e)));
      return;
    }

    if (!id || !code) {
      setMsg('Lien QR invalide');
      return;
    }

    if (isGuest) {
      setNeedAuth(true);
      setMsg('Connecte-toi d’abord (passkey ou mot de passe), puis réouvre ce lien pour autoriser.');
      return;
    }

    ran.current = true;
    setMsg('Autorisation de l’autre appareil…');
    void api
      .deviceLoginApprove(id, code)
      .then(() => {
        setOk(true);
        setMsg('Appareil autorisé — tu peux revenir sur l’autre écran.');
        setTimeout(() => navigate('/'), 1800);
      })
      .catch((e) => setMsg(String(e.message || e)));
  }, [id, code, claim, isGuest, init, refresh, navigate]);

  // Si l’utilisateur vient de se connecter sur cette page, relancer l’approve
  useEffect(() => {
    if (!needAuth || isGuest || !id || !code || ran.current) return;
    ran.current = true;
    setMsg('Autorisation de l’autre appareil…');
    void api
      .deviceLoginApprove(id, code)
      .then(() => {
        setOk(true);
        setNeedAuth(false);
        setMsg('Appareil autorisé — tu peux revenir sur l’autre écran.');
        setTimeout(() => navigate('/'), 1800);
      })
      .catch((e) => setMsg(String(e.message || e)));
  }, [needAuth, isGuest, id, code, navigate]);

  return (
    <div className="mx-auto max-w-md animate-fade-up rounded-2xl border border-yt-border bg-yt-surface p-8 text-center">
      <h1 className="font-display text-2xl font-semibold">Connexion appareil</h1>
      <p className={`mt-4 text-sm ${ok ? 'text-emerald-400' : 'text-yt-muted'}`}>{msg}</p>
      {needAuth && (
        <p className="mt-3 text-xs text-yt-muted">
          Utilise le bouton Connexion en haut à droite, puis reviens sur cette page.
        </p>
      )}
    </div>
  );
}
