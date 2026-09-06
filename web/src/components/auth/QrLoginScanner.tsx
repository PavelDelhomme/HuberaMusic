import { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';

declare global {
  interface Window {
    BarcodeDetector?: new (opts?: { formats?: string[] }) => {
      detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
    };
  }
}

type Props = {
  title?: string;
  hint?: string;
  onResult: (raw: string) => void;
  onClose: () => void;
};

/** Scanner QR in-page (BarcodeDetector + caméra). Fallback message si non supporté. */
export function QrLoginScanner({
  title = 'Scanner un QR',
  hint = 'Cadre le QR affiché sur l’autre appareil.',
  onResult,
  onClose,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  const [supported, setSupported] = useState(true);
  const handled = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let cancelled = false;

    const stop = () => {
      if (timer) window.clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };

    const boot = async () => {
      if (typeof window.BarcodeDetector !== 'function') {
        setSupported(false);
        setErr(
          'Scanner intégré non supporté sur ce navigateur. Ouvre l’appareil photo, scanne le QR, puis ouvre le lien.',
        );
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (cancelled) {
          stop();
          return;
        }
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        const detector = new window.BarcodeDetector!({ formats: ['qr_code'] });
        timer = window.setInterval(() => {
          if (handled.current || cancelled || video.readyState < 2) return;
          void detector
            .detect(video)
            .then((codes) => {
              const raw = codes.map((c) => c.rawValue?.trim() || '').find((v) => v.length > 0);
              if (!raw || handled.current) return;
              handled.current = true;
              stop();
              onResult(raw);
            })
            .catch(() => {
              /* frame skip */
            });
        }, 350);
      } catch (e) {
        setErr(
          String((e as Error).message || e) ||
            'Caméra indisponible — autorise l’accès ou utilise l’appareil photo.',
        );
        setSupported(false);
      }
    };

    void boot();
    return () => {
      cancelled = true;
      stop();
    };
  }, [onResult]);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-yt-border bg-yt-surface shadow-xl">
        <div className="flex items-center justify-between border-b border-yt-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Camera className="h-4 w-4 text-yt-red" />
            {title}
          </div>
          <button
            type="button"
            className="rounded-full p-1.5 hover:bg-white/10"
            onClick={onClose}
            aria-label="Fermer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4">
          {supported ? (
            <video
              ref={videoRef}
              className="aspect-square w-full rounded-xl bg-black object-cover"
              muted
              playsInline
            />
          ) : (
            <div className="flex aspect-square items-center justify-center rounded-xl bg-yt-bg px-4 text-center text-sm text-yt-muted">
              {err || 'Scanner indisponible'}
            </div>
          )}
          <p className="mt-3 text-center text-xs text-yt-muted">{hint}</p>
          {err && supported && (
            <p className="mt-2 text-center text-xs text-red-400">{err}</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Extrait id/code (approve) ou claim depuis une URL / texte QR PLM. */
export function parseDeviceLoginQr(raw: string): {
  kind: 'approve' | 'claim';
  id?: string;
  code?: string;
  claim?: string;
} | null {
  try {
    const text = raw.trim();
    const url = text.includes('://')
      ? new URL(text)
      : new URL(text, window.location.origin);
    const host = url.hostname.toLowerCase();
    const isCustomScheme = url.protocol === 'ytmusic:' || url.protocol === 'plm:';
    const pathOk =
      url.pathname.startsWith('/login-device') ||
      (isCustomScheme &&
        (url.hostname === 'login-device' || url.pathname.includes('login-device')));
    const hostOk =
      !host ||
      host === 'login-device' ||
      host === 'plm.delhomme.ovh' ||
      host === 'ytmusic.delhomme.ovh' ||
      host === 'pue-la-merde.delhomme.ovh' ||
      host === window.location.hostname.toLowerCase();
    const hasParams =
      !!url.searchParams.get('claim') ||
      (!!url.searchParams.get('id') && !!url.searchParams.get('code'));
    if (!hasParams) return null;
    if (!pathOk && !isCustomScheme) return null;
    if (!hostOk && url.protocol.startsWith('http')) return null;
    const claim = url.searchParams.get('claim')?.trim() || '';
    if (claim) return { kind: 'claim', claim };
    const id = url.searchParams.get('id')?.trim() || '';
    const code = url.searchParams.get('code')?.trim() || '';
    if (id && code) return { kind: 'approve', id, code };
    return null;
  } catch {
    return null;
  }
}
