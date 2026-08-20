import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type Track } from '../../api';
import { CoverImage } from '../../components/media/CoverImage';
import { usePlayer } from '../../store/player';

/** Lien de partage PLM : ouvre et lance le titre. */
export function WatchPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const play = usePlayer((s) => s.play);
  const [track, setTrack] = useState<Track | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) {
      setError('Lien invalide');
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const r = await api.track(id);
        if (cancelled) return;
        const t = r.track;
        setTrack(t);
        await play(t, [t], { forceRestart: true });
        if (!cancelled) navigate('/', { replace: true });
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Impossible de charger le titre');
          setBusy(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, navigate, play]);

  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-6 text-center">
      {track ? <CoverImage item={track} size={160} className="rounded-xl" /> : null}
      <h1 className="font-display text-xl font-semibold text-white">
        {track?.title || (busy ? 'Chargement…' : 'Titre')}
      </h1>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      {!busy && error ? (
        <button
          type="button"
          className="rounded-full bg-[#ff0033] px-4 py-2 text-sm font-medium text-white"
          onClick={() => navigate('/')}
        >
          Accueil
        </button>
      ) : null}
    </div>
  );
}
