import { useEffect } from 'react';
import { usePlayer, wireRemotePlayer } from '../../store/player';
import { useSession } from '../../store/session';
import { useAuth } from '../../store/auth';
import { thumb } from '../../api';
import { setDeviceName } from '../../lib/auth/session';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { ArtistLinks } from '../../components/media/ArtistLinks';

/** Full-screen receiver for Smart TV / second screen */
export function TvPage() {
  const initAuth = useAuth((s) => s.init);
  const initSession = useSession((s) => s.init);
  const renameDevice = useSession((s) => s.renameDevice);
  const isActivePlayer = useSession((s) => s.isActivePlayer);
  const {
    current,
    isPlaying,
    progress,
    duration,
    toggle,
    next,
    prev,
    bindAudio,
  } = usePlayer();

  useEffect(() => {
    setDeviceName('Télé / TV');
    renameDevice('Télé / TV');
    wireRemotePlayer();
    void initAuth().then(() => initSession());
  }, [initAuth, initSession, renameDevice]);

  useEffect(() => {
    const el = document.getElementById('tv-audio') as HTMLAudioElement | null;
    bindAudio(el);
  }, [bindAudio]);

  return (
    <div className="relative flex min-h-full flex-col items-center justify-center overflow-hidden bg-yt-bg px-6 py-10 text-center">
      {current && thumb(current, 800) && (
        <div
          className="pointer-events-none absolute inset-0 scale-110 opacity-30 blur-3xl"
          style={{
            backgroundImage: `url(${thumb(current, 800)})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        />
      )}

      <div className="relative z-10 max-w-3xl">
        <p className="mb-2 text-sm uppercase tracking-[0.3em] text-yt-muted">PLM TV</p>
        <p className="mb-8 text-sm text-yt-muted">
          {isActivePlayer
            ? 'Récepteur actif — contrôle depuis ton téléphone'
            : 'En attente… sélectionne cet appareil depuis Cast'}
        </p>

        {current ? (
          <>
            <img
              src={thumb(current, 800)}
              alt=""
              className="mx-auto mb-8 h-64 w-64 rounded-2xl object-cover shadow-2xl sm:h-80 sm:w-80"
            />
            <h1 className="font-display text-4xl font-semibold tracking-tight sm:text-5xl">{current.title}</h1>
            <p className="mt-3 text-xl text-yt-muted">
              <ArtistLinks track={current} className="text-xl text-yt-muted" />
            </p>
            <div className="mx-auto mt-8 h-1.5 w-full max-w-md overflow-hidden rounded-full bg-yt-border">
              <div
                className="h-full bg-yt-red"
                style={{ width: `${duration ? (progress / duration) * 100 : 0}%` }}
              />
            </div>
            <div className="mt-8 flex items-center justify-center gap-6">
              <button type="button" onClick={() => void prev()} className="rounded-full p-3 text-white">
                <SkipBack className="h-8 w-8 fill-white" />
              </button>
              <button
                type="button"
                onClick={toggle}
                className="flex h-16 w-16 items-center justify-center rounded-full bg-white text-black"
              >
                {isPlaying ? <Pause className="h-8 w-8 fill-black" /> : <Play className="h-8 w-8 fill-black" />}
              </button>
              <button type="button" onClick={() => void next()} className="rounded-full p-3 text-white">
                <SkipForward className="h-8 w-8 fill-white" />
              </button>
            </div>
          </>
        ) : (
          <div className="rounded-2xl border border-yt-border bg-yt-elevated/80 px-8 py-16">
            <h1 className="font-display text-3xl font-semibold">Prêt à recevoir</h1>
            <p className="mt-3 text-yt-muted">
              Connecte-toi avec le même compte sur ton téléphone, ouvre Cast, puis choisis « Télé / TV ».
            </p>
          </div>
        )}
      </div>

      <audio id="tv-audio" playsInline />
    </div>
  );
}
