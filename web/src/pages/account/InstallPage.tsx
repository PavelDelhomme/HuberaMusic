import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { Download, Smartphone, ShieldAlert, CheckCircle2, ExternalLink } from 'lucide-react';
import { apiUrl } from '../../api';
import { BrandLogo } from '../../components/layout/BrandLogo';

type ApkInfo = {
  ready?: boolean;
  versionName?: string | null;
  versionCode?: number | null;
  sizeBytes?: number | null;
};

function detectOs(): 'android' | 'ios' | 'desktop' {
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/android/i.test(ua)) return 'android';
  return 'desktop';
}

function formatMb(bytes?: number | null) {
  if (!bytes || bytes < 1) return null;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

/**
 * Landing publique : vraie APK Kotlin (Compose), pas la PWA « Ajouter à l’écran d’accueil ».
 * Crucial Xiaomi/MIUI où « Installer l’app » du navigateur = raccourci web.
 */
export function InstallPage() {
  const os = useMemo(() => detectOs(), []);
  const [info, setInfo] = useState<ApkInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const pageUrl = typeof window !== 'undefined' ? `${window.location.origin}/install` : '/install';

  useEffect(() => {
    void fetch(apiUrl('/api/install/apk-info'))
      .then((r) => r.json())
      .then((j) => setInfo(j))
      .catch(() => setInfo({ ready: false }));
  }, []);

  const startDownload = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await fetch(apiUrl('/api/install/apk-ticket'), { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const url = String(j.url || '');
      if (!url) throw new Error('Lien de téléchargement manquant');
      setDownloadUrl(url);
      setInfo((prev) => ({
        ...prev,
        ready: true,
        versionName: j.versionName ?? prev?.versionName,
        versionCode: j.versionCode ?? prev?.versionCode,
        sizeBytes: j.sizeBytes ?? prev?.sizeBytes,
      }));
      // Navigation directe → Package Installer (évite « ouvrir comme page »)
      window.location.assign(url);
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto min-h-[70vh] max-w-lg px-4 py-10">
      <div className="mb-8 flex flex-col items-center text-center">
        <BrandLogo className="mb-4 h-16 w-16" />
        <h1 className="font-display text-2xl font-bold tracking-tight">Installer PLM</h1>
        <p className="mt-2 text-sm text-yt-muted">
          Application Android <strong className="text-white">native</strong> (APK) — pas un site
          web ajouté à l’écran d’accueil.
        </p>
        {info?.versionName && (
          <p className="mt-2 text-xs tabular-nums text-yt-muted">
            {info.versionName}
            {formatMb(info.sizeBytes) ? ` · ${formatMb(info.sizeBytes)}` : ''}
          </p>
        )}
      </div>

      {os === 'android' && (
        <section className="mb-6 rounded-2xl border border-yt-red/40 bg-yt-surface p-5">
          <div className="mb-3 flex items-center gap-2 font-semibold">
            <Download className="h-5 w-5 text-yt-red" />
            Télécharger l’APK
          </div>
          <p className="mb-4 text-sm text-yt-muted">
            Sur Xiaomi / Redmi / POCO (MIUI) : le menu ⋮ « Installer l’application » du navigateur
            crée souvent un <em>raccourci web</em>. Utilise uniquement le bouton ci-dessous.
          </p>
          <button
            type="button"
            disabled={busy || info?.ready === false}
            onClick={() => void startDownload()}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-yt-red py-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            {busy ? 'Préparation…' : 'Télécharger PLM.apk'}
          </button>
          {downloadUrl && (
            <a
              href={downloadUrl}
              className="mt-3 flex items-center justify-center gap-1 text-xs text-yt-muted underline"
            >
              Relancer le téléchargement <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {err && <p className="mt-3 text-sm text-red-400">{err}</p>}
        </section>
      )}

      {os === 'desktop' && (
        <section className="mb-6 rounded-2xl border border-yt-border bg-yt-surface p-5">
          <div className="mb-3 flex items-center gap-2 font-semibold">
            <Smartphone className="h-5 w-5 text-yt-red" />
            Depuis ton téléphone
          </div>
          <p className="mb-4 text-sm text-yt-muted">
            Scanne ce QR avec la caméra Android, puis appuie sur « Télécharger PLM.apk ».
          </p>
          <div className="mb-4 flex justify-center rounded-2xl bg-white p-3">
            <QRCodeSVG value={pageUrl} size={168} level="M" />
          </div>
          <p className="mb-3 break-all text-center text-xs text-yt-muted">{pageUrl}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void startDownload()}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-white py-2.5 text-sm font-medium text-black disabled:opacity-50"
          >
            <Download className="h-4 w-4" /> Télécharger l’APK (PC → téléphone)
          </button>
          {err && <p className="mt-3 text-sm text-red-400">{err}</p>}
        </section>
      )}

      {os === 'ios' && (
        <section className="mb-6 rounded-2xl border border-yt-border bg-yt-surface p-5 text-sm text-yt-muted">
          <p className="mb-2 font-medium text-white">iPhone / iPad</p>
          Pas d’APK sur iOS. Ouvre PLM dans <strong className="text-white">Safari</strong> → Partager →
          « Sur l’écran d’accueil ».
        </section>
      )}

      <section className="rounded-2xl border border-yt-border bg-yt-elevated/50 p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <ShieldAlert className="h-4 w-4 text-amber-400" />
          Xiaomi / MIUI — installation
        </div>
        <ol className="list-decimal space-y-2 pl-5 text-xs leading-relaxed text-yt-muted">
          <li>Télécharge via le bouton rouge (fichier <code className="text-white">PLM.apk</code>).</li>
          <li>
            Si bloqué : Paramètres → Applications → Gérer les applications → les trois points →
            <strong className="text-white"> Installer via USB / sources inconnues</strong> pour ton
            navigateur ou Fichiers.
          </li>
          <li>
            Ouvre le fichier dans <strong className="text-white">Fichiers / Téléchargements</strong> —
            l’installeur Android s’affiche (pas « Ajouter à l’écran d’accueil »).
          </li>
          <li>
            Vérifie que le package est <code className="text-white">ovh.delhomme.ytmusic</code> et
            l’icône PLM.
          </li>
        </ol>
        <ul className="mt-4 space-y-1.5 text-xs text-yt-muted">
          <li className="flex gap-2">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
            App native Kotlin + Compose (lecteur hors-ligne, notifications média…)
          </li>
          <li className="flex gap-2">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
            Après install : crée ton compte dans l’app, ou connecte-toi avec le même email que le
            site.
          </li>
        </ul>
      </section>

      <p className="mt-8 text-center text-xs text-yt-muted">
        Déjà un compte ?{' '}
        <Link to="/" className="text-white underline">
          Retour à PLM
        </Link>
      </p>
    </div>
  );
}
