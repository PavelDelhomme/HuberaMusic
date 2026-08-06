import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../api';
import { useAuth } from '../store/auth';
import {
  Activity,
  CheckCircle2,
  Construction,
  Copy,
  Download,
  Mail,
  Monitor,
  Radar,
  Rocket,
  Server,
  Smartphone,
} from 'lucide-react';
import { Link } from 'react-router-dom';

export function AdminPage() {
  const user = useAuth((s) => s.user);
  const [status, setStatus] = useState<any>(null);
  const [err, setErr] = useState('');
  const [selectedUrl, setSelectedUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [mobileTab, setMobileTab] = useState<'pwa' | 'apk'>('apk');
  const [apkTarget, setApkTarget] = useState('auto');
  const [apkCustom, setApkCustom] = useState('');
  const [telemetry, setTelemetry] = useState<{ stats: any; events: any[] } | null>(null);
  const [mails, setMails] = useState<any[]>([]);
  const [levelFilter, setLevelFilter] = useState('');
  const [reco, setReco] = useState<any>(null);
  const [recoMode, setRecoMode] = useState('radio');
  const [recoWeights, setRecoWeights] = useState({
    w_content: 0.35,
    w_seq: 0.25,
    w_ctx: 0.2,
    w_bandit: 0.1,
    w_satisf: 0.1,
  });
  const [smtp, setSmtp] = useState<any>(null);
  const [smtpTestTo, setSmtpTestTo] = useState(user?.email || '');
  const [smtpResult, setSmtpResult] = useState<string>('');
  const [smtpBusy, setSmtpBusy] = useState(false);
  const [deployBusy, setDeployBusy] = useState(false);
  const [deployMsg, setDeployMsg] = useState('');
  const [repairMsg, setRepairMsg] = useState('');
  const [ytCookie, setYtCookie] = useState('');
  const [ytCookieMsg, setYtCookieMsg] = useState('');
  const [ytCookieBusy, setYtCookieBusy] = useState(false);

  const refresh = useCallback(() => {
    void api
      .adminStatus()
      .then((s) => {
        setStatus(s);
        setSelectedUrl((prev) => prev || s.urls?.find((u: string) => !u.includes('localhost')) || s.urls?.[0] || '');
      })
      .catch((e) => setErr(String(e.message || e)));
    void api
      .adminTelemetry(levelFilter || undefined)
      .then(setTelemetry)
      .catch(() => undefined);
    void api
      .adminMailOutbox()
      .then((r) => setMails(r.mails || []))
      .catch(() => undefined);
    void api
      .adminSmtp()
      .then((r) => {
        setSmtp(r);
        if (!smtpTestTo && (r as any)?.smtp) setSmtpTestTo(user?.email || '');
      })
      .catch(() => undefined);
    void api
      .adminReco()
      .then((r) => {
        setReco(r);
        const row = (r.weights || []).find((w: any) => w.mode === recoMode) || (r.weights || [])[0];
        if (row) {
          setRecoWeights({
            w_content: row.w_content,
            w_seq: row.w_seq,
            w_ctx: row.w_ctx,
            w_bandit: row.w_bandit,
            w_satisf: row.w_satisf,
          });
          if (row.mode) setRecoMode(row.mode);
        }
      })
      .catch(() => undefined);
  }, [levelFilter, recoMode, user?.email]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  if (!user?.isAdmin) {
    return (
      <div className="animate-fade-up mx-auto max-w-lg rounded-2xl border border-yt-border bg-yt-elevated p-6 text-center">
        <Construction className="mx-auto mb-3 h-10 w-10 text-yt-muted" />
        <h1 className="font-display text-xl font-semibold">Administration</h1>
        <p className="mt-2 text-sm text-yt-muted">
          Réservé aux admins. Connecte-toi avec le premier compte créé, ou définis{' '}
          <code className="text-white">ADMIN_EMAILS</code> dans <code className="text-white">.env</code>.
        </p>
        <Link to="/profile" className="mt-4 inline-block text-sm text-yt-red hover:underline">
          Aller au profil
        </Link>
      </div>
    );
  }

  const stats = telemetry?.stats;

  return (
    <div className="animate-fade-up mx-auto max-w-4xl">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-widest text-yt-muted">Console</p>
          <h1 className="font-display text-3xl font-semibold tracking-tight">Administration</h1>
          <p className="mt-1 text-sm text-yt-muted">
            Déploiement, analytics erreurs/perf/batterie, mails — local · préprod · prod.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="rounded-full bg-yt-elevated px-4 py-2 text-sm text-yt-muted hover:text-white"
        >
          Rafraîchir
        </button>
      </div>

      {err && <p className="mb-4 text-sm text-red-400">{err}</p>}

      <section className="mb-6 rounded-2xl border border-yt-red/40 bg-yt-surface p-5">
        <div className="mb-3 flex items-center gap-2">
          <Rocket className="h-5 w-5 text-yt-red" />
          <h3 className="font-display text-lg font-semibold">Mise en production (depuis ce PC)</h3>
        </div>
        <p className="mb-3 text-sm text-yt-muted">
          Guide pas-à-pas : <code className="text-white">DEPLOY.md</code>. Portainer CE ={' '}
          <strong className="text-white">pas de webhook Pro</strong> → installe la stack{' '}
          <code className="text-white">watchtower</code> une fois (
          <code className="text-white">deploy/watchtower-compose.yml</code>).
        </p>
        <ol className="mb-4 list-decimal space-y-1 pl-5 text-sm text-yt-muted">
          <li>
            DNS A <code className="text-white">ytmusic</code> → IP VPS (
            <code className="text-white">dig +short ytmusic.delhomme.ovh</code>)
          </li>
          <li>
            Portainer : stack <code className="text-white">ytmusic</code> = coller{' '}
            <code className="text-white">deploy/portainer-template.yml</code> + env (
            <code className="text-white">JWT_SECRET</code>, <code className="text-white">SMTP_PASS</code>,
            emails…)
          </li>
          <li>
            Portainer : stack <code className="text-white">watchtower</code> = coller{' '}
            <code className="text-white">deploy/watchtower-compose.yml</code>
          </li>
          <li>
            NPM : <code className="text-white">ytmusic.delhomme.ovh</code> →{' '}
            <code className="text-white">http://ytmusic:8787</code> + SSL +{' '}
            <strong className="text-white">Websockets ON</strong>
          </li>
          <li>
            Ensuite seulement : boutons ci-dessous (Web / APK). Working tree sale → stash auto.
          </li>
        </ol>
        <p className="mb-3 text-sm text-yt-muted">
          Un clic : pousse <code className="text-white">dev → prod</code> (image GHCR), redeploy VPS
          via Watchtower / SSH / Access Token CE, et/ou APK sur le VPS.
        </p>
        <dl className="mb-4 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-yt-muted">Cible</dt>
            <dd className="truncate font-medium">
              {status?.deploy?.prodUrl || 'https://ytmusic.delhomme.ovh'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-yt-muted">Autorisé ici</dt>
            <dd className="font-medium">
              {status?.deploy?.allowed === false
                ? 'Non (API pas en local)'
                : `Oui · env ${status?.deploy?.appEnv || status?.env || '…'}`}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-yt-muted">Redeploy VPS</dt>
            <dd className="font-medium">
              {status?.deploy?.redeploy?.label || 'Watchtower / manuel'}
              {status?.deploy?.redeploy?.ready ? ' ✓' : ' (config optionnelle)'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-yt-muted">Job</dt>
            <dd className="font-medium">
              {status?.deploy?.job?.status || 'idle'}
              {status?.deploy?.job?.mode ? ` · ${status.deploy.job.mode}` : ''}
            </dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['web', 'Web (git → image)'],
              ['apk', 'APK → VPS'],
              ['all', 'Web + APK'],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              disabled={
                deployBusy ||
                status?.deploy?.allowed === false ||
                status?.deploy?.job?.status === 'running'
              }
              className="rounded-full bg-yt-red px-4 py-2 text-sm font-medium disabled:opacity-50"
              onClick={() => {
                if (
                  !window.confirm(
                    mode === 'apk'
                      ? 'Compiler l’APK prod et l’uploader sur le VPS ?'
                      : `Pousser vers prod (${mode}) ?\nÇa merge origin/dev → prod et push GitHub.`,
                  )
                ) {
                  return;
                }
                setDeployBusy(true);
                setDeployMsg('');
                void api
                  .adminDeployStart(mode)
                  .then((j) => {
                    setDeployMsg(`Lancé · ${j.status || 'running'} (${mode})`);
                    refresh();
                  })
                  .catch((e) => setDeployMsg(String(e.message || e)))
                  .finally(() => setDeployBusy(false));
              }}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            className="rounded-full border border-yt-border px-4 py-2 text-sm text-yt-muted hover:text-white"
            onClick={() => {
              void (async () => {
                try {
                  if ('serviceWorker' in navigator) {
                    const regs = await navigator.serviceWorker.getRegistrations();
                    await Promise.all(regs.map((r) => r.unregister()));
                  }
                  if ('caches' in window) {
                    const keys = await caches.keys();
                    await Promise.all(keys.map((k) => caches.delete(k)));
                  }
                  setRepairMsg('Caches / SW nettoyés — recharge avec Ctrl+Shift+R');
                } catch (e) {
                  setRepairMsg(String((e as Error).message || e));
                }
              })();
            }}
          >
            Réparer client local
          </button>
        </div>
        {(deployMsg || repairMsg) && (
          <p className="mt-3 text-sm text-yt-muted">{deployMsg || repairMsg}</p>
        )}
        {status?.deploy?.job?.log && (
          <pre className="mt-3 max-h-56 overflow-auto rounded-xl bg-black/40 p-3 text-[11px] leading-relaxed text-yt-muted">
            {String(status.deploy.job.log).slice(-4000)}
          </pre>
        )}
        <p className="mt-3 text-xs text-yt-muted">
          Redeploy sans Pro : <code className="text-white">deploy/watchtower-compose.yml</code> ·
          ou <code className="text-white">PORTAINER_URL</code> +{' '}
          <code className="text-white">PORTAINER_API_KEY</code> (Access Token CE) · ou{' '}
          <code className="text-white">DEPLOY_SSH</code>. Détail :{' '}
          <code className="text-white">DEPLOY.md</code>.
        </p>
      </section>

      <section className="mb-6 rounded-2xl border border-amber-500/40 bg-yt-surface p-5">
        <div className="mb-3 flex items-center gap-2">
          <Radar className="h-5 w-5 text-amber-400" />
          <h3 className="font-display text-lg font-semibold">Relais stream (VPS)</h3>
        </div>
        <p className="mb-3 text-sm text-yt-muted">
          Sur un VPS, certaines IP datacenter sont bloquées. Solution fiable : relayer le stream
          via ton PC (IP maison).
        </p>
        <pre className="mb-2 overflow-x-auto rounded-xl border border-yt-border bg-black/40 px-3 py-2 text-xs text-emerald-300">
bash scripts/link-home-stream.sh
        </pre>
        <p className="mb-3 text-xs text-yt-muted">
          Laisse le PC allumé. Stop :{' '}
          <code className="text-white">bash scripts/link-home-stream.sh stop</code>.
        </p>
        <dl className="mb-3 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-yt-muted">Session navigateur (ops)</dt>
            <dd className="font-medium">
              {status?.youtubeCookies?.configured ? 'Configuré ✓' : 'Absent (souvent OK)'}
              {status?.youtubeCookies?.source ? ` · ${status.youtubeCookies.source}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-yt-muted">Hint</dt>
            <dd className="text-xs text-yt-muted">{status?.youtubeCookies?.hint || '…'}</dd>
          </div>
        </dl>
        <ol className="mb-3 list-decimal space-y-1 pl-5 text-xs text-yt-muted">
          <li>PC allumé + API locale</li>
          <li>
            <code className="text-white">bash scripts/link-home-stream.sh</code>
          </li>
          <li>Si besoin (anti-bot) : push-youtube-cookies.sh ou collage ci-dessous</li>
        </ol>
        <textarea
          value={ytCookie}
          onChange={(e) => setYtCookie(e.target.value)}
          rows={3}
          placeholder="Header Cookie ou Netscape cookies.txt (ops, optionnel)"
          className="mb-3 w-full rounded-xl border border-yt-border bg-yt-bg px-3 py-2 font-mono text-xs text-white"
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={ytCookieBusy || ytCookie.trim().length < 40}
            className="rounded-full bg-yt-red px-4 py-2 text-sm font-medium disabled:opacity-50"
            onClick={() => {
              setYtCookieBusy(true);
              setYtCookieMsg('');
              void api
                .adminYoutubeCookiesSave(ytCookie)
                .then((r) => {
                  setYtCookieMsg(r.configured ? 'Session enregistrée — reteste la lecture' : 'OK');
                  setYtCookie('');
                  refresh();
                })
                .catch((e) => setYtCookieMsg(String(e.message || e)))
                .finally(() => setYtCookieBusy(false));
            }}
          >
            {ytCookieBusy ? '…' : 'Enregistrer'}
          </button>
          <button
            type="button"
            disabled={ytCookieBusy}
            className="rounded-full border border-yt-border px-4 py-2 text-sm text-yt-muted hover:text-white"
            onClick={() => {
              setYtCookieBusy(true);
              void api
                .adminYoutubeCookiesClear()
                .then(() => {
                  setYtCookieMsg('Session effacée');
                  refresh();
                })
                .catch((e) => setYtCookieMsg(String(e.message || e)))
                .finally(() => setYtCookieBusy(false));
            }}
          >
            Effacer
          </button>
        </div>
        {ytCookieMsg && <p className="mt-3 text-sm text-yt-muted">{ytCookieMsg}</p>}
      </section>

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Stat
          icon={<Server className="h-4 w-4" />}
          label="Serveur"
          value={status ? `:${status.appPort || status.port}` : '…'}
          sub={
            status
              ? `${status.mode === 'development' ? 'Dev (Vite)' : 'Prod'} · env ${status.env || 'local'}`
              : ''
          }
        />
        <Stat
          icon={<Smartphone className="h-4 w-4" />}
          label="Comptes"
          value={status ? String(status.users) : '…'}
          sub={status ? `${status.guests} invités` : ''}
        />
        <Stat
          icon={<Activity className="h-4 w-4" />}
          label="Télémétrie 24h"
          value={stats ? String(stats.last24 ?? '…') : '…'}
          sub={stats ? `${stats.errors24 || 0} erreurs · ${stats.total || 0} total` : ''}
        />
      </div>

      <section className="mb-6 rounded-2xl border border-yt-border bg-yt-surface p-5">
        <div className="mb-3 flex items-center gap-2">
          <Mail className="h-5 w-5 text-yt-red" />
          <h3 className="font-display text-lg font-semibold">SMTP</h3>
        </div>
        <p className="mb-3 text-sm text-yt-muted">
          Envoi via le SMTP configuré dans <code className="text-white">.env</code> (validation
          d’inscription, tests). Voir <code className="text-white">docs/SMTP-MAILY.md</code>.
        </p>
        <dl className="mb-4 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-yt-muted">Mode</dt>
            <dd className="font-medium">{smtp?.smtp?.mode || '…'}</dd>
          </div>
          <div>
            <dt className="text-xs text-yt-muted">Host</dt>
            <dd className="font-medium">
              {smtp?.smtp?.host || '—'}
              {smtp?.smtp?.port ? `:${smtp.smtp.port}` : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-yt-muted">From</dt>
            <dd className="truncate font-medium">{smtp?.smtp?.from || '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-yt-muted">APP_URL</dt>
            <dd className="truncate font-medium">{smtp?.appUrl || '—'}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[12rem] flex-1 text-xs text-yt-muted">
            Destinataire test
            <input
              value={smtpTestTo}
              onChange={(e) => setSmtpTestTo(e.target.value)}
              placeholder="toi@email.com"
              className="mt-1 w-full rounded-xl border border-yt-border bg-yt-bg px-3 py-2 text-sm text-white"
            />
          </label>
          <button
            type="button"
            disabled={smtpBusy}
            className="rounded-full bg-yt-red px-4 py-2 text-sm font-medium disabled:opacity-50"
            onClick={() => {
              setSmtpBusy(true);
              setSmtpResult('');
              void api
                .adminSmtpTest(smtpTestTo || undefined)
                .then((r) => {
                  setSmtpResult(
                    r.ok
                      ? `OK · ${r.mode}${r.sent ? ` · envoyé à ${smtpTestTo}` : ' · verify() OK'}`
                      : `Échec · ${r.error || 'inconnu'}`,
                  );
                  refresh();
                })
                .catch((e) => setSmtpResult(String(e.message || e)))
                .finally(() => setSmtpBusy(false));
            }}
          >
            {smtpBusy ? 'Envoi…' : 'Tester SMTP'}
          </button>
        </div>
        {smtpResult && <p className="mt-3 text-sm text-yt-muted">{smtpResult}</p>}
      </section>

      <section className="mb-6 rounded-2xl border border-yt-border bg-yt-surface p-5">
        <div className="mb-3 flex items-center gap-2">
          <Rocket className="h-5 w-5 text-yt-red" />
          <h3 className="font-display text-lg font-semibold">Rappel NPM / Portainer</h3>
        </div>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-yt-muted">
          <li>
            Stack Portainer : image <code className="text-white">ghcr.io/…/ytmusic:latest</code>, réseau{' '}
            <code className="text-white">nginx-proxy-manager_npm-network</code>, hostname{' '}
            <code className="text-white">ytmusic</code>.
          </li>
          <li>
            Proxy NPM : <code className="text-white">ytmusic.delhomme.ovh</code> →{' '}
            <code className="text-white">http://ytmusic:8787</code> — SSL +{' '}
            <strong className="text-white">Websockets ON</strong>.
          </li>
          <li>
            MAJ quotidienne : bouton <strong className="text-white">Mise en production</strong>{' '}
            ci-dessus. Pas de webhook Pro — Watchtower / Access Token / SSH (voir DEPLOY.md).
          </li>
        </ol>
        <p className="mt-3 text-xs text-yt-muted">
          Détail : <code className="text-white">DEPLOY.md</code>
        </p>
      </section>

      <section className="mb-6 rounded-2xl border border-yt-border bg-yt-surface p-5">
        <div className="mb-3 flex items-center gap-2">
          <Radar className="h-5 w-5 text-yt-red" />
          <h3 className="font-display text-lg font-semibold">Recommandations</h3>
        </div>
        <p className="mb-4 text-sm text-yt-muted">
          Poids du scoring hybride (contenu / séquence / contexte / bandit / satisfaction). Voir{' '}
          <code className="text-white">docs/RECOMMANDATIONS.md</code>.
        </p>
        <div className="mb-3 flex flex-wrap gap-2">
          {['radio', 'discover', 'focus'].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setRecoMode(m);
                const row = (reco?.weights || []).find((w: any) => w.mode === m);
                if (row) {
                  setRecoWeights({
                    w_content: row.w_content,
                    w_seq: row.w_seq,
                    w_ctx: row.w_ctx,
                    w_bandit: row.w_bandit,
                    w_satisf: row.w_satisf,
                  });
                }
              }}
              className={`rounded-full px-3 py-1.5 text-sm ${
                recoMode === m ? 'bg-white text-black' : 'bg-yt-elevated text-yt-muted'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {(
            [
              ['w_content', 'Contenu'],
              ['w_seq', 'Séquence'],
              ['w_ctx', 'Contexte'],
              ['w_bandit', 'Bandit'],
              ['w_satisf', 'Satisfaction'],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="text-xs text-yt-muted">
              {label}
              <input
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={recoWeights[key]}
                onChange={(e) =>
                  setRecoWeights((w) => ({ ...w, [key]: Number(e.target.value) }))
                }
                className="mt-1 w-full rounded-lg border border-yt-border bg-yt-bg px-2 py-1.5 text-sm text-white"
              />
            </label>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-4 text-sm text-yt-muted">
          <button
            type="button"
            className="rounded-full bg-yt-red px-4 py-2 text-sm font-medium text-white"
            onClick={() => {
              void api.adminRecoWeights(recoMode, recoWeights).then(() => refresh());
            }}
          >
            Enregistrer les poids
          </button>
          <span>
            Écoutes 24h : {reco?.listens24h ?? '—'} · Skips : {reco?.skips24h ?? '—'}
          </span>
          <span>
            Feedback 7j :{' '}
            {(reco?.feedback || [])
              .map((f: any) => `${f.verdict}=${f.c}`)
              .join(' · ') || '—'}
          </span>
        </div>
      </section>

      <section className="mb-6 rounded-2xl border border-yt-border bg-yt-surface p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-yt-red" />
            <h3 className="font-display text-lg font-semibold">Analytics & erreurs</h3>
          </div>
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="rounded-xl border border-yt-border bg-yt-bg px-3 py-1.5 text-sm"
          >
            <option value="">Tous niveaux</option>
            <option value="error">Erreurs</option>
            <option value="fatal">Fatal</option>
            <option value="info">Info</option>
          </select>
        </div>
        <p className="mb-4 text-sm text-yt-muted">
          Client web, PWA mobile et desktop envoient erreurs, perf JS heap et batterie (si dispo).
        </p>
        <div className="max-h-80 overflow-auto rounded-xl bg-black/40">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-yt-elevated text-yt-muted">
              <tr>
                <th className="px-3 py-2">Quand</th>
                <th className="px-3 py-2">Niv.</th>
                <th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2">Message</th>
                <th className="px-3 py-2">Batt.</th>
              </tr>
            </thead>
            <tbody>
              {(telemetry?.events || []).slice(0, 80).map((ev: any) => (
                <tr key={ev.id} className="border-t border-yt-border/50 align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-yt-muted">
                    {new Date(ev.created_at).toLocaleString('fr-FR')}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={
                        ev.level === 'error' || ev.level === 'fatal'
                          ? 'text-red-400'
                          : 'text-yt-muted'
                      }
                    >
                      {ev.level}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-yt-muted">{ev.kind}</td>
                  <td className="max-w-xs truncate px-3 py-2" title={ev.message || ''}>
                    {ev.message || '—'}
                  </td>
                  <td className="px-3 py-2 text-yt-muted">
                    {ev.battery_level != null
                      ? `${Math.round(ev.battery_level * 100)}%${ev.battery_charging ? '⚡' : ''}`
                      : '—'}
                  </td>
                </tr>
              ))}
              {(!telemetry?.events || telemetry.events.length === 0) && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-yt-muted">
                    Aucun événement pour l&apos;instant
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-6 rounded-2xl border border-yt-border bg-yt-surface p-5">
        <div className="mb-3 flex items-center gap-2">
          <Mail className="h-5 w-5 text-yt-red" />
          <h3 className="font-display text-lg font-semibold">Boîte mail (outbox)</h3>
        </div>
        <p className="mb-4 text-sm text-yt-muted">
          Sans SMTP, les emails (validation…) sont stockés ici + logs console. Avec SMTP, ils
          partent vraiment.
        </p>
        <ul className="max-h-60 space-y-2 overflow-auto text-sm">
          {mails.slice(0, 30).map((m) => (
            <li key={m.id} className="rounded-xl bg-yt-elevated px-3 py-2">
              <div className="flex justify-between gap-2 text-xs text-yt-muted">
                <span>{m.to_email}</span>
                <span>{new Date(m.created_at).toLocaleString('fr-FR')}</span>
              </div>
              <div className="font-medium">{m.subject}</div>
              <details className="mt-1 text-xs text-yt-muted">
                <summary>Corps</summary>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap">{m.body}</pre>
              </details>
            </li>
          ))}
          {mails.length === 0 && <li className="text-yt-muted">Aucun mail</li>}
        </ul>
      </section>

      <section className="mb-6 overflow-hidden rounded-3xl border border-yt-border bg-gradient-to-br from-[#1a1a1a] via-yt-surface to-[#0d0d0d] p-6">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-2 rounded-full bg-yt-red/20 px-3 py-1 text-xs font-medium text-yt-red">
            <Rocket className="h-3.5 w-3.5" /> Déploiement mobile
          </div>
          <div className="flex rounded-full bg-black/40 p-1 text-xs">
            <button
              type="button"
              onClick={() => setMobileTab('apk')}
              className={`rounded-full px-3 py-1 ${mobileTab === 'apk' ? 'bg-white text-black' : 'text-yt-muted'}`}
            >
              APK natif
            </button>
            <button
              type="button"
              onClick={() => setMobileTab('pwa')}
              className={`rounded-full px-3 py-1 ${mobileTab === 'pwa' ? 'bg-white text-black' : 'text-yt-muted'}`}
            >
              PWA
            </button>
          </div>
        </div>

        {mobileTab === 'apk' ? (
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
            <div className="flex-1">
              <h2 className="font-display text-2xl font-semibold">APK Android (Kotlin)</h2>
              <p className="mt-2 max-w-lg text-sm text-yt-muted">
                L’URL API est figée dans l’APK au build. Hors Wi‑Fi local → utilise{' '}
                <code className="text-white">APP_URL</code> /{' '}
                <code className="text-white">ANDROID_API_BASE_URL</code> (prod / préprod).
              </p>

              <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
                <div className="rounded-xl bg-black/30 px-3 py-2">
                  <dt className="text-xs text-yt-muted">APP_ENV</dt>
                  <dd className="font-medium">{status?.apk?.appEnv || '—'}</dd>
                </div>
                <div className="rounded-xl bg-black/30 px-3 py-2">
                  <dt className="text-xs text-yt-muted">Cible auto</dt>
                  <dd className="truncate font-medium">{status?.apk?.targetApiBaseUrl || '—'}</dd>
                </div>
                <div className="rounded-xl bg-black/30 px-3 py-2">
                  <dt className="text-xs text-yt-muted">APP_URL</dt>
                  <dd className="truncate font-medium">{status?.apk?.appUrl || '—'}</dd>
                </div>
                <div className="rounded-xl bg-black/30 px-3 py-2">
                  <dt className="text-xs text-yt-muted">Dernière APK</dt>
                  <dd className="font-medium">
                    {status?.apk?.ready
                      ? `${status.apk.versionName || '?'} → ${status.apk.apiBaseUrl || '?'}`
                      : 'pas encore publiée'}
                  </dd>
                </div>
              </dl>

              <label className="mt-4 block text-xs text-yt-muted">URL API à figer</label>
              <select
                value={apkTarget}
                onChange={(e) => setApkTarget(e.target.value)}
                className="mt-1 w-full rounded-xl border border-yt-border bg-yt-elevated px-3 py-2 text-sm"
              >
                <option value="auto">Auto (env · ANDROID_API_BASE_URL · APP_URL · LAN)</option>
                <option value="lan">LAN (même Wi‑Fi) — {status?.apk?.presets?.lan || '…'}</option>
                <option value="app_url">APP_URL — {status?.apk?.presets?.app_url || '…'}</option>
                <option value="production">Production — https://ytmusic.delhomme.ovh</option>
                <option value="preprod">Préprod — https://ytmusic-preprod.delhomme.ovh</option>
                <option value="custom">URL personnalisée…</option>
              </select>
              {apkTarget === 'custom' && (
                <input
                  value={apkCustom}
                  onChange={(e) => setApkCustom(e.target.value)}
                  placeholder="https://ytmusic.delhomme.ovh"
                  className="mt-2 w-full rounded-xl border border-yt-border bg-yt-elevated px-3 py-2 text-sm"
                />
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={status?.apk?.job?.status === 'running' || !status?.apk?.sdkReady}
                  onClick={() => {
                    const target =
                      apkTarget === 'custom'
                        ? apkCustom.trim()
                        : apkTarget === 'production' || apkTarget === 'preprod'
                          ? status?.apk?.presets?.[apkTarget]
                          : apkTarget;
                    if (!target) return;
                    void api.adminApkBuild(target).then(() => refresh());
                  }}
                  className="inline-flex items-center gap-2 rounded-full bg-yt-red px-5 py-2 text-sm font-medium disabled:opacity-50"
                >
                  <Smartphone className="h-4 w-4" />
                  {status?.apk?.job?.status === 'running' ? 'Compilation…' : 'Compiler & publier l’APK'}
                </button>
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-yt-border px-5 py-2 text-sm hover:bg-yt-elevated">
                  <Download className="h-4 w-4 rotate-180" />
                  Uploader une APK
                  <input
                    type="file"
                    accept=".apk,application/vnd.android.package-archive"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      const target =
                        apkTarget === 'custom'
                          ? apkCustom.trim()
                          : apkTarget === 'production' || apkTarget === 'preprod'
                            ? status?.apk?.presets?.[apkTarget]
                            : apkTarget === 'lan'
                              ? status?.apk?.presets?.lan
                              : apkTarget === 'app_url'
                                ? status?.apk?.presets?.app_url
                                : status?.apk?.presets?.production ||
                                  status?.apk?.appUrl ||
                                  'https://ytmusic.delhomme.ovh';
                      if (!target) return;
                      void api
                        .adminApkUpload(file, { apiBaseUrl: String(target) })
                        .then(() => refresh())
                        .catch((err) => alert(String(err.message || err)));
                    }}
                  />
                </label>
                {status?.apk?.ready && (
                  <a
                    href={status.apk.downloadUrl}
                    className="inline-flex items-center gap-2 rounded-full border border-yt-border px-5 py-2 text-sm hover:bg-yt-elevated"
                  >
                    <Download className="h-4 w-4" /> Télécharger
                  </a>
                )}
              </div>
              {!status?.apk?.sdkReady && (
                <p className="mt-2 text-xs text-amber-300">
                  Pas de SDK Android ici (normal sur Portainer). Sur ta machine :{' '}
                  <code className="text-white">API_BASE_URL=https://ytmusic.delhomme.ovh make android-publish</code>
                  {' '}puis <strong className="text-white">Uploader une APK</strong> ci-dessus, ou{' '}
                  <code className="text-white">make android-upload-apk</code>.
                </p>
              )}
              {status?.apk?.sdkReady && (
                <p className="mt-2 text-xs text-yt-muted">
                  Tu peux aussi uploader une APK déjà compilée si tu préfères.
                </p>
              )}
              {status?.apk?.job?.status === 'ok' && (
                <p className="mt-2 inline-flex items-center gap-1 text-sm text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" /> APK publiée
                </p>
              )}
              {status?.apk?.job?.status === 'error' && (
                <p className="mt-2 text-sm text-red-400">Échec compilation — voir le log</p>
              )}
              {status?.apk?.job?.log && (
                <pre className="mt-3 max-h-40 overflow-auto rounded-xl bg-black/50 p-3 text-[11px] leading-relaxed text-yt-muted">
                  {String(status.apk.job.log).slice(-3500)}
                </pre>
              )}
              <ol className="mt-4 grid gap-2 text-sm text-yt-muted sm:grid-cols-3">
                <li className="rounded-2xl bg-black/30 p-3">
                  <span className="text-white">1.</span> Choisis l’URL API (prod / LAN)
                </li>
                <li className="rounded-2xl bg-black/30 p-3">
                  <span className="text-white">2.</span> Compile en local ou Uploader l’APK
                </li>
                <li className="rounded-2xl bg-black/30 p-3">
                  <span className="text-white">3.</span> Scanne le QR → installe
                </li>
              </ol>
            </div>
            <div className="mx-auto text-center">
              <div className="rounded-3xl bg-white p-4 shadow-2xl">
                <QRCodeSVG
                  value={status?.apk?.downloadUrl || 'https://localhost'}
                  size={200}
                  level="M"
                />
              </div>
              <p className="mt-2 max-w-[220px] truncate text-xs text-yt-muted">
                {status?.apk?.downloadUrl || 'Compile d’abord'}
              </p>
              <button
                type="button"
                className="mt-2 inline-flex items-center gap-2 text-xs text-yt-muted hover:text-white"
                onClick={() => {
                  const u = status?.apk?.downloadUrl;
                  if (!u) return;
                  void navigator.clipboard.writeText(u).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                {copied ? 'Copié !' : 'Copier le lien APK'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
            <div className="flex-1">
              <h2 className="font-display text-2xl font-semibold">Installe PLM (PWA)</h2>
              <p className="mt-2 max-w-md text-sm text-yt-muted">
                Même Wi‑Fi que cet ordinateur. Scanne le QR, ouvre le lien, puis installe en PWA
                (plein écran, icône, offline).
              </p>
              <div className="mt-4 space-y-2">
                {(status?.urls || []).map((u: string) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => setSelectedUrl(u)}
                    className={`block w-full rounded-xl px-3 py-2 text-left text-sm transition ${
                      selectedUrl === u ? 'bg-white text-black' : 'bg-yt-elevated text-yt-muted hover:text-white'
                    }`}
                  >
                    {u}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="mt-3 inline-flex items-center gap-2 text-xs text-yt-muted hover:text-white"
                onClick={() => {
                  void navigator.clipboard.writeText(selectedUrl).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                {copied ? 'Copié !' : 'Copier le lien'}
              </button>
            </div>
            <div className="mx-auto rounded-3xl bg-white p-4 shadow-2xl">
              <QRCodeSVG value={selectedUrl || 'https://localhost'} size={200} level="M" />
            </div>
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border border-yt-border bg-yt-surface p-5">
          <div className="mb-3 flex items-center gap-2">
            <Construction className="h-5 w-5 text-yt-red" />
            <h3 className="font-display text-lg font-semibold">Build production</h3>
          </div>
          <p className="mb-4 text-sm text-yt-muted">
            Compile le client React/PWA. Ensuite le serveur sert <code>client/dist</code> sur le port{' '}
            {status?.port || 8787}.
          </p>
          <div className="mb-3 flex items-center gap-2 text-sm">
            {status?.buildJob?.status === 'ok' && (
              <span className="inline-flex items-center gap-1 text-emerald-400">
                <CheckCircle2 className="h-4 w-4" /> Build OK
              </span>
            )}
            {status?.buildJob?.status === 'running' && (
              <span className="text-amber-300">Build en cours…</span>
            )}
            {status?.buildJob?.status === 'error' && (
              <span className="text-red-400">Build échoué</span>
            )}
            {status?.built && (
              <span className="text-yt-muted">
                · {status.builtAt ? new Date(status.builtAt).toLocaleString('fr-FR') : 'prêt'}
              </span>
            )}
          </div>
          <button
            type="button"
            disabled={status?.buildJob?.status === 'running'}
            onClick={() => {
              void api.adminBuild().then(() => refresh());
            }}
            className="rounded-full bg-yt-red px-5 py-2 text-sm font-medium disabled:opacity-50"
          >
            Lancer le build
          </button>
          {status?.buildJob?.log && (
            <pre className="mt-4 max-h-48 overflow-auto rounded-xl bg-black/50 p-3 text-[11px] leading-relaxed text-yt-muted">
              {status.buildJob.log.slice(-4000)}
            </pre>
          )}
        </section>

        <section className="rounded-2xl border border-yt-border bg-yt-surface p-5">
          <div className="mb-3 flex items-center gap-2">
            <Monitor className="h-5 w-5 text-yt-red" />
            <h3 className="font-display text-lg font-semibold">Desktop & PWA</h3>
          </div>
          <ul className="space-y-3 text-sm text-yt-muted">
            <li>
              <strong className="text-white">Mobile / tablette</strong> — APK natif (QR Admin) ou
              PWA. Hors Wi‑Fi : figer{' '}
              <code className="text-white">APP_URL</code> /{' '}
              <code className="text-white">ANDROID_API_BASE_URL</code>.
            </li>
            <li>
              <strong className="text-white">Ordinateur</strong> — Chrome/Edge propose « Installer
              PLM » uniquement si pas déjà installé (bannière conditionnelle).
            </li>
            <li>
              <strong className="text-white">Electron</strong> —{' '}
              <code className="text-white">npm run dev:desktop</code>
              {status?.desktopReady ? ' (desktop détecté)' : ''}.
            </li>
            <li>
              Socle réutilisable : <code className="text-white">packages/platform-kit</code>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  sub,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-yt-border bg-yt-surface p-4">
      <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-yt-muted">
        {icon}
        {label}
      </div>
      <div className="font-display text-2xl font-semibold">{value}</div>
      {sub ? <div className="mt-1 text-xs text-yt-muted">{sub}</div> : null}
    </div>
  );
}
