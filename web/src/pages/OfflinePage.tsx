import { useCallback, useEffect, useState } from 'react';
import { type Track } from '../api';
import { useLibrary } from '../store/library';
import { usePlayer } from '../store/player';
import {
  clearAllCached,
  downloadTracksToDevice,
  getStorageEstimate,
  listCachedTracks,
  removeCached,
  requestPersistentStorage,
} from '../lib/offlineCache';
import { isBrowserOnline, onConnectivityChange } from '../lib/connectivity';
import { Download, HardDrive, Loader2, Play, Trash2, WifiOff } from 'lucide-react';
import { TrackRow } from '../components/TrackRow';

function formatBytes(n: number) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} Go`;
}

export function OfflinePage() {
  const { liked, playlists, refresh } = useLibrary();
  const playQueue = usePlayer((s) => s.playQueue);
  const [localTracks, setLocalTracks] = useState<Track[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [online, setOnline] = useState(isBrowserOnline());
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState(false);

  const reloadLocal = useCallback(async () => {
    try {
      const tracks = await listCachedTracks();
      setLocalTracks(tracks);
      setStorage(await getStorageEstimate());
      try {
        setPersisted(Boolean(await navigator.storage?.persisted?.()));
      } catch {
        setPersisted(false);
      }
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void reloadLocal();
    void requestPersistentStorage().then((ok) => setPersisted(ok));
    return onConnectivityChange((on) => {
      setOnline(on);
      if (on) void refresh().catch(() => undefined);
    });
  }, [reloadLocal, refresh]);

  const cacheTracks = async (label: string, tracks: Track[]) => {
    if (!isBrowserOnline()) {
      setMessage('Connecte-toi pour télécharger sur cet appareil.');
      return;
    }
    setBusy(label);
    setMessage('');
    const ok = await downloadTracksToDevice(tracks, (done, total) => {
      setMessage(`${done}/${total}…`);
    });
    await refresh().catch(() => undefined);
    await reloadLocal();
    setBusy('');
    setMessage(`${ok} titre${ok > 1 ? 's' : ''} disponible${ok > 1 ? 's' : ''} hors ligne sur cet appareil`);
  };

  return (
    <div className="animate-fade-up">
      <h1 className="mb-2 font-display text-3xl font-semibold tracking-tight">Hors ligne</h1>
      <p className="mb-4 text-sm text-yt-muted">
        Même principe que le mobile : les titres téléchargés ici restent jouables sans réseau
        (cache navigateur IndexedDB). Installe l’app (PWA) pour un accès encore plus fluide.
      </p>

      {!online && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          <WifiOff className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">Mode hors ligne actif</div>
            <div className="text-amber-100/80">
              Seuls les titres ci-dessous (et ceux déjà en file) peuvent être lus. Le reste
              reviendra dès la connexion.
            </div>
          </div>
        </div>
      )}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-yt-elevated p-4">
          <HardDrive className="mb-2 h-5 w-5 text-yt-red" />
          <div className="text-2xl font-semibold">{localTracks.length}</div>
          <div className="text-xs text-yt-muted">Sur cet appareil</div>
        </div>
        <div className="rounded-xl bg-yt-elevated p-4">
          <Download className="mb-2 h-5 w-5 text-yt-red" />
          <div className="text-2xl font-semibold">
            {storage ? formatBytes(storage.usage) : '—'}
          </div>
          <div className="text-xs text-yt-muted">
            Espace utilisé
            {storage ? ` / ${formatBytes(storage.quota)}` : ''}
          </div>
        </div>
        <div className="rounded-xl bg-yt-elevated p-4">
          <Loader2 className="mb-2 h-5 w-5 text-yt-red" />
          <div className="text-2xl font-semibold">{persisted ? 'Oui' : 'Non'}</div>
          <div className="text-xs text-yt-muted">Stockage persisté</div>
        </div>
      </div>

      <div className="mb-8 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!!busy || !localTracks.length}
          onClick={() => void playQueue(localTracks, 0, { sourceId: 'offline-device', sourceKind: 'playlist' })}
          className="inline-flex items-center gap-2 rounded-full bg-yt-red px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          <Play className="h-4 w-4" /> Tout lire
        </button>
        <button
          type="button"
          disabled={!!busy || !liked.length || !online}
          onClick={() => void cacheTracks('liked', liked)}
          className="rounded-full bg-yt-elevated px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy === 'liked' ? 'Téléchargement…' : 'Télécharger titres aimés'}
        </button>
        {online &&
          playlists.slice(0, 6).map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={!!busy}
              onClick={() => void cacheTracks(p.id, p.tracks || [])}
              className="rounded-full bg-yt-elevated px-4 py-2 text-sm text-yt-muted hover:text-white disabled:opacity-50"
            >
              ↓ {p.name}
            </button>
          ))}
        {localTracks.length > 0 && (
          <button
            type="button"
            disabled={!!busy}
            onClick={() => {
              if (!confirm('Supprimer tous les titres hors ligne de cet appareil ?')) return;
              void (async () => {
                setBusy('clear');
                await clearAllCached();
                await reloadLocal();
                setBusy('');
                setMessage('Cache local vidé');
              })();
            }}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2 text-sm text-yt-muted hover:text-white disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" /> Tout retirer
          </button>
        )}
      </div>

      {message && <p className="mb-4 text-sm text-emerald-300">{message}</p>}
      {busy && busy !== 'clear' && (
        <p className="mb-4 flex items-center gap-2 text-sm text-yt-muted">
          <Loader2 className="h-4 w-4 animate-spin" /> Téléchargement en cours…
        </p>
      )}

      <section>
        <h2 className="mb-3 font-display text-xl font-semibold">Disponibles hors ligne</h2>
        {!ready && (
          <p className="flex items-center gap-2 text-sm text-yt-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Chargement des titres téléchargés…
          </p>
        )}
        {ready &&
          localTracks.map((t) => (
          <div key={t.id} className="group flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <TrackRow track={t} queue={localTracks} />
            </div>
            <button
              type="button"
              title="Retirer de cet appareil"
              className="mr-2 rounded-full p-2 text-yt-muted opacity-0 hover:bg-white/5 hover:text-white group-hover:opacity-100"
              onClick={() => {
                void (async () => {
                  await removeCached(t.id);
                  await reloadLocal();
                })();
              }}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        {ready && !localTracks.length && (
          <p className="text-sm text-yt-muted">
            Aucun titre sur cet appareil. En ligne : télécharge des aimés, une playlist, ou un
            titre via le menu ⋯.
          </p>
        )}
      </section>

      {online && (
        <p className="mt-8 text-xs text-yt-muted">
          Astuce : le bouton Offline des albums/playlists enregistre aussi les pistes sur{' '}
          <em>cet appareil</em> (IndexedDB), pas seulement côté serveur.
        </p>
      )}
    </div>
  );
}
