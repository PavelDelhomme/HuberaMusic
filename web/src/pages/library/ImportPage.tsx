import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../../api';
import { useAuth } from '../../store/auth';
import { useLibrary } from '../../store/library';
import { Download, Link2, Loader2, RefreshCw, Unplug, Music2 } from 'lucide-react';

function formatSyncMsg(stats: {
  songs: number;
  librarySongs?: number;
  albums: number;
  artists: number;
  playlists: number;
  history?: number;
}) {
  return (
    `Sync OK — ${stats.songs} likes, ${stats.librarySongs ?? 0} titres, ` +
    `${stats.albums} albums, ${stats.artists} artistes, ${stats.playlists} playlists` +
    (stats.history ? `, ${stats.history} récents` : '')
  );
}

async function waitYtmSync(onAccount: (account: any) => void) {
  const t0 = Date.now();
  const kick = await api.ytmSync();
  if (kick?.stats && kick.running !== true && kick.library) return kick;
  if (kick?.account) onAccount(kick.account);
  while (Date.now() - t0 < 180_000) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await api.ytmStatus();
    onAccount(s.account);
    if (s.account?.syncError) throw new Error(s.account.syncError);
    if (
      s.account?.lastSyncAt &&
      s.account.lastSyncAt >= t0 - 5000 &&
      s.account.syncRunning !== true
    ) {
      const library = await api.library();
      return { account: s.account, library, stats: kick?.stats };
    }
  }
  throw new Error('Google reste lié. L’import continue — réessaie Synchroniser.');
}

export function ImportPage() {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const applyLibrary = useLibrary((s) => s.applyLibrary);
  const user = useAuth((s) => s.user);
  const isGuest = !user || user.isGuest || user.email.includes('@local.ytmusic');

  const [cookie, setCookie] = useState('');
  const [account, setAccount] = useState<any>(null);
  const [oauthCode, setOauthCode] = useState('');
  const [oauthUrl, setOauthUrl] = useState('');
  const [ytmBusy, setYtmBusy] = useState(false);
  const [ytmMsg, setYtmMsg] = useState('');
  const [ytmErr, setYtmErr] = useState('');

  const refreshStatus = () => {
    if (isGuest) return;
    void api
      .ytmStatus()
      .then((r) => setAccount(r.account))
      .catch(() => undefined);
  };

  useEffect(() => {
    refreshStatus();
  }, [isGuest]);

  useEffect(() => {
    if (!oauthCode) return;
    const t = setInterval(() => {
      void api.ytmOauthStatus().then((s) => {
        if (s.status === 'connected') {
          setOauthCode('');
          setOauthUrl('');
          setYtmMsg(
            'OAuth OK — mais la biblio YTM exige des cookies. Colle-les ci-dessous pour synchroniser.',
          );
          refreshStatus();
        }
        if (s.status === 'error') {
          setYtmErr(s.error || 'OAuth échoué');
          setOauthCode('');
        }
      });
    }, 2500);
    return () => clearInterval(t);
  }, [oauthCode]);

  const run = async () => {
    if (!input.trim()) return;
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const result = await api.import({
        url: input.trim(),
        query: input.trim(),
        options: { createLocalCopy: true },
      });
      applyLibrary(result.library);
      setMessage(
        `Importé : ${result.title} (${result.kind}) — ${JSON.stringify(result.added)}`,
      );
      setInput('');
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setLoading(false);
    }
  };

  const saveCookiesAndSync = () => {
    setYtmBusy(true);
    setYtmErr('');
    setYtmMsg('');
    void api
      .ytmConnectCookie(cookie)
      .then((r) => {
        setAccount(r.account);
        setCookie('');
        setYtmMsg('Google lié — import de la bibliothèque…');
        return waitYtmSync(setAccount);
      })
      .then((r) => {
        if (r.library) applyLibrary(r.library);
        setAccount(r.account);
        setYtmMsg(
          r.stats ? formatSyncMsg(r.stats) : r.account?.lastSyncSummary || 'Bibliothèque importée',
        );
      })
      .catch((e) => setYtmErr(String(e.message || e)))
      .finally(() => setYtmBusy(false));
  };

  const deviceUrl = oauthUrl || 'https://www.google.com/device';
  const canSync = Boolean(account?.canSyncLibrary);
  const needsCookies = account?.connected && !canSync;

  return (
    <div className="animate-fade-up mx-auto max-w-2xl">
      <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight">Importer</h1>
      <p className="mb-6 text-sm text-yt-muted">
        Récupère ta vraie bibliothèque YouTube Music (likes, titres, albums, artistes, playlists,
        récents) — sans Google Cloud Console. Ou importe un lien / une recherche.
      </p>

      {!isGuest && (
        <section className="mb-8 rounded-2xl border border-yt-border bg-yt-surface p-5">
          <div className="mb-3 flex items-center gap-2">
            <Music2 className="h-5 w-5 text-yt-red" />
            <h2 className="font-display text-lg font-semibold">Compte YouTube Music</h2>
          </div>
          <p className="mb-4 text-sm text-yt-muted">
            Mobile : Compte → Compte Google → « Lier Google (compte déjà sur le téléphone) » (OAuth
            appareil, sans MDP), puis session YouTube Music pour la biblio. Web : code appareil +
            cookies ci-dessous. Compte Google <strong>gratuit</strong>, Premium non requis. Voir{' '}
            <code className="text-xs">docs/YTM-GOOGLE-CLIENTS.md</code>.
          </p>

          {account?.hint && (
            <p className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
              {account.hint}
            </p>
          )}

          {canSync ? (
            <div className="mb-4 space-y-3">
              <p className="text-sm text-emerald-400">
                Cookies OK — prêt à synchroniser
                {account.lastSyncAt
                  ? ` · dernière sync ${new Date(account.lastSyncAt).toLocaleString('fr-FR')}`
                  : ''}
              </p>
              {account.lastSyncSummary && (
                <p className="text-xs text-yt-muted">{account.lastSyncSummary}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={ytmBusy}
                  className="inline-flex items-center gap-2 rounded-full bg-yt-red px-4 py-2 text-sm font-medium disabled:opacity-50"
                  onClick={() => {
                    setYtmBusy(true);
                    setYtmErr('');
                    setYtmMsg('');
                    void waitYtmSync(setAccount)
                      .then((r) => {
                        if (r.library) applyLibrary(r.library);
                        setAccount(r.account);
                        setYtmMsg(
                          r.stats
                            ? formatSyncMsg(r.stats)
                            : r.account?.lastSyncSummary || 'Bibliothèque importée',
                        );
                      })
                      .catch((e) => setYtmErr(String(e.message || e)))
                      .finally(() => setYtmBusy(false));
                  }}
                >
                  {ytmBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Synchroniser la bibliothèque
                </button>
                <button
                  type="button"
                  disabled={ytmBusy}
                  className="inline-flex items-center gap-2 rounded-full bg-yt-elevated px-4 py-2 text-sm text-yt-muted hover:text-white"
                  onClick={() => {
                    void api.ytmDisconnect().then((r) => {
                      setAccount(r.account);
                      setYtmMsg('Compte YTM déconnecté');
                    });
                  }}
                >
                  <Unplug className="h-4 w-4" /> Déconnecter
                </button>
              </div>
              <details className="rounded-xl border border-yt-border bg-yt-bg p-3 text-sm">
                <summary className="cursor-pointer text-yt-muted">Renouveler les cookies</summary>
                <textarea
                  value={cookie}
                  onChange={(e) => setCookie(e.target.value)}
                  rows={3}
                  className="mt-2 w-full rounded-xl border border-yt-border bg-yt-elevated px-3 py-2 text-xs outline-none"
                  placeholder="Cookie: SID=…; …; SAPISID=…"
                />
                <button
                  type="button"
                  disabled={ytmBusy || cookie.length < 20}
                  className="mt-2 rounded-full bg-yt-elevated px-4 py-2 text-xs disabled:opacity-50"
                  onClick={saveCookiesAndSync}
                >
                  Mettre à jour & synchroniser
                </button>
              </details>
            </div>
          ) : (
            <div className="space-y-4">
              {needsCookies && (
                <p className="text-sm text-amber-300">
                  Compte partiellement lié (OAuth) — ajoute les cookies pour importer la biblio.
                </p>
              )}

              <div className="rounded-xl border border-yt-border bg-yt-bg p-4">
                <h3 className="mb-2 text-sm font-medium text-white">
                  1. Lier Google (code appareil — lecture)
                </h3>
                <p className="mb-2 text-xs text-yt-muted">
                  Même flux que l’app Android : ouvre google.com/device, choisis ton compte Google
                  (souvent déjà connecté), entre le code. Utile pour des streams stables depuis le VPS.
                  Détail : docs/YTM-GOOGLE-CLIENTS.md
                </p>
                <button
                  type="button"
                  disabled={ytmBusy}
                  className="rounded-full bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-50"
                  onClick={() => {
                    setYtmBusy(true);
                    setYtmErr('');
                    void api
                      .ytmConnectOauth()
                      .then((r) => {
                        setOauthCode(r.userCode);
                        setOauthUrl(r.verificationUrl);
                        setYtmMsg('Ouvre le lien Google (ou scanne le QR), entre le code, puis attends.');
                      })
                      .catch((e) => setYtmErr(String(e.message || e)))
                      .finally(() => setYtmBusy(false));
                  }}
                >
                  Lier via Google (code appareil)
                </button>
                {oauthCode && (
                  <div className="mt-3 flex flex-col gap-4 rounded-xl bg-yt-elevated px-3 py-3 text-sm sm:flex-row sm:items-center">
                    <div className="flex-1">
                      <p>
                        Va sur{' '}
                        <a
                          href={deviceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-yt-red underline"
                        >
                          {deviceUrl.replace(/^https?:\/\//, '')}
                        </a>
                      </p>
                      <p className="mt-2 font-mono text-lg tracking-widest text-white">{oauthCode}</p>
                    </div>
                    <div className="mx-auto rounded-2xl bg-white p-3">
                      <QRCodeSVG value={deviceUrl} size={120} level="M" />
                    </div>
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-yt-border bg-yt-bg p-4">
                <h3 className="mb-2 text-sm font-medium text-white">2. Coller les cookies (biblio)</h3>
                <ol className="mb-3 list-decimal space-y-1 pl-4 text-xs text-yt-muted">
                  <li>
                    Ouvre{' '}
                    <a
                      href="https://music.youtube.com"
                      target="_blank"
                      rel="noreferrer"
                      className="text-yt-red underline"
                    >
                      music.youtube.com
                    </a>{' '}
                    connecté à ton compte Google
                  </li>
                  <li>F12 → onglet Réseau → recharge la page</li>
                  <li>Clique une requête vers music.youtube.com (ex. browse)</li>
                  <li>En-têtes → copie toute la valeur de Cookie (SAPISID / __Secure-1PSID…)</li>
                </ol>
                <textarea
                  value={cookie}
                  onChange={(e) => setCookie(e.target.value)}
                  rows={4}
                  className="w-full rounded-xl border border-yt-border bg-yt-elevated px-3 py-2 text-xs outline-none"
                  placeholder="SID=…; HSID=…; SSID=…; APISID=…; SAPISID=…; __Secure-1PSID=…"
                />
                <button
                  type="button"
                  disabled={ytmBusy || cookie.length < 20}
                  className="mt-2 inline-flex items-center gap-2 rounded-full bg-yt-red px-4 py-2 text-sm font-medium disabled:opacity-50"
                  onClick={saveCookiesAndSync}
                >
                  {ytmBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Enregistrer & synchroniser
                </button>
              </div>

              {account?.connected && (
                <button
                  type="button"
                  disabled={ytmBusy}
                  className="inline-flex items-center gap-2 rounded-full bg-yt-elevated px-4 py-2 text-sm text-yt-muted hover:text-white"
                  onClick={() => {
                    void api.ytmDisconnect().then((r) => {
                      setAccount(r.account);
                      setYtmMsg('Compte YTM déconnecté');
                    });
                  }}
                >
                  <Unplug className="h-4 w-4" /> Déconnecter
                </button>
              )}
            </div>
          )}

          {ytmErr && <p className="mt-3 text-sm text-red-400">{ytmErr}</p>}
          {ytmMsg && <p className="mt-3 text-sm text-emerald-400">{ytmMsg}</p>}
        </section>
      )}

      {isGuest && (
        <p className="mb-6 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm">
          Connecte-toi (compte app) pour lier YouTube Music et synchroniser ta bibliothèque.
        </p>
      )}

      <div className="rounded-2xl border border-yt-border bg-yt-elevated p-4">
        <label className="mb-2 flex items-center gap-2 text-sm text-yt-muted">
          <Link2 className="h-4 w-4" /> URL ou recherche (import unitaire)
        </label>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={3}
          placeholder="https://music.youtube.com/playlist?list=... ou Daft Punk"
          className="w-full resize-none rounded-xl border border-yt-border bg-yt-bg px-3 py-2.5 text-sm outline-none focus:border-white/30"
        />
        <button
          type="button"
          disabled={loading || !input.trim()}
          onClick={() => void run()}
          className="mt-3 inline-flex items-center gap-2 rounded-full bg-yt-red px-5 py-2.5 text-sm font-medium disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Importer dans ma bibliothèque
        </button>
      </div>

      {message && (
        <p className="mt-4 rounded-xl border border-emerald-900/50 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
          {message}
        </p>
      )}
      {error && (
        <p className="mt-4 rounded-xl border border-red-900/50 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
