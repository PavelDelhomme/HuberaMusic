import { useEffect, useRef, useState } from 'react';
import { Mic, Music2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';

type Mode = 'listen' | 'hum';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    reader.onerror = () => reject(reader.error || new Error('lecture audio'));
    reader.readAsDataURL(blob);
  });
}

/** Sheet écoute / fredonnement → POST /api/search/identify → navigation résultats. */
export function SearchIdentifySheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('listen');
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('Écoute ambiante ~10 s, ou fredonne un air.');
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!open) {
      stopAll();
      setError('');
      setBusy(false);
      setRecording(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const stopAll = () => {
    try {
      mediaRef.current?.stop();
    } catch {
      /* ignore */
    }
    mediaRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const startRecording = async () => {
    setError('');
    setBusy(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        void finishIdentify(rec.mimeType || mime || 'audio/webm');
      };
      mediaRef.current = rec;
      rec.start(250);
      setRecording(true);
      setHint(mode === 'hum' ? 'Fredonne clairement…' : 'Écoute en cours…');
      window.setTimeout(() => {
        if (mediaRef.current && mediaRef.current.state === 'recording') {
          mediaRef.current.stop();
        }
      }, 10_000);
    } catch (e) {
      setError(String((e as Error).message || e) || 'Micro indisponible');
      setRecording(false);
    }
  };

  const finishIdentify = async (mimeType: string) => {
    setRecording(false);
    setBusy(true);
    setHint('Identification…');
    try {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      stopAll();
      if (blob.size < 800) {
        setError('Enregistrement trop court — réessaie ~8–12 s');
        setBusy(false);
        return;
      }
      const audioBase64 = await blobToBase64(blob);
      const res = await api.identifySearch({ audioBase64, mimeType, mode });
      if (!res.ok || !res.query) {
        setError(res.error || 'Aucun titre reconnu');
        setHint(res.hint || 'Réessaie plus près de la source ou en fredonnant.');
        setBusy(false);
        return;
      }
      onClose();
      navigate(`/search?q=${encodeURIComponent(res.query)}`);
    } catch (e) {
      setError(String((e as Error).message || e));
      setBusy(false);
    } finally {
      stopAll();
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/60 p-4 sm:items-center">
      <div
        role="dialog"
        aria-modal
        aria-label="Identifier un titre"
        className="w-full max-w-md rounded-2xl border border-yt-border bg-yt-elevated p-5 shadow-2xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-xl font-semibold">Identifier un titre</h2>
            <p className="mt-1 text-sm text-yt-muted">{hint}</p>
          </div>
          <button
            type="button"
            className="rounded-lg p-2 text-yt-muted hover:bg-white/10 hover:text-white"
            onClick={() => {
              stopAll();
              onClose();
            }}
            aria-label="Fermer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mb-4 flex gap-2">
          <button
            type="button"
            onClick={() => setMode('listen')}
            className={`flex-1 rounded-full px-3 py-2 text-sm ${
              mode === 'listen' ? 'bg-white text-black' : 'bg-yt-surface text-yt-muted'
            }`}
          >
            Écouter
          </button>
          <button
            type="button"
            onClick={() => setMode('hum')}
            className={`flex-1 rounded-full px-3 py-2 text-sm ${
              mode === 'hum' ? 'bg-white text-black' : 'bg-yt-surface text-yt-muted'
            }`}
          >
            Fredonner
          </button>
        </div>

        {error ? <p className="mb-3 text-sm text-red-300">{error}</p> : null}

        <div className="flex justify-center py-4">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (recording) {
                mediaRef.current?.stop();
              } else {
                void startRecording();
              }
            }}
            className={`flex h-20 w-20 items-center justify-center rounded-full transition ${
              recording ? 'bg-yt-red text-white animate-pulse' : 'bg-white text-black hover:opacity-90'
            } disabled:opacity-50`}
            aria-label={recording ? 'Arrêter' : 'Démarrer'}
          >
            {busy ? (
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-black/30 border-t-black" />
            ) : mode === 'hum' ? (
              <Music2 className="h-8 w-8" />
            ) : (
              <Mic className="h-8 w-8" />
            )}
          </button>
        </div>
        <p className="text-center text-xs text-yt-muted">
          {recording ? 'Appuie pour arrêter (max 10 s)' : 'Appuie pour enregistrer (~10 s max)'}
        </p>
      </div>
    </div>
  );
}

/** Dictée navigateur (Web Speech API) si dispo. */
export function startWebSpeechDictation(opts: {
  onResult: (text: string) => void;
  onError?: (msg: string) => void;
}) {
  const SR =
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SR) {
    opts.onError?.('Dictée non supportée sur ce navigateur');
    return;
  }
  const rec = new SR();
  rec.lang = 'fr-FR';
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onresult = (ev: any) => {
    const text = String(ev.results?.[0]?.[0]?.transcript || '').trim();
    if (text) opts.onResult(text);
    else opts.onError?.('Aucune parole détectée');
  };
  rec.onerror = () => opts.onError?.('Dictée interrompue');
  rec.start();
}
