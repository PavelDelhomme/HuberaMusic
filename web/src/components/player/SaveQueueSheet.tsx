import { useMemo, useState } from 'react';
import { ListMusic, Plus, X } from 'lucide-react';
import type { Track } from '../../api';
import { useLibrary } from '../../store/library';

function isPlayable(t: Track) {
  return (
    t.type === 'song' ||
    t.type === 'video' ||
    t.type === 'unknown' ||
    /^[a-zA-Z0-9_-]{11}$/.test(t.id)
  );
}

export function SaveQueueSheet({
  open,
  tracks,
  defaultName = 'Ma file d’attente',
  onClose,
}: {
  open: boolean;
  tracks: Track[];
  defaultName?: string;
  onClose: () => void;
}) {
  const playlists = useLibrary((s) => s.playlists);
  const createPlaylist = useLibrary((s) => s.createPlaylist);
  const addTracksToPlaylist = useLibrary((s) => s.addTracksToPlaylist);
  const playable = useMemo(() => tracks.filter(isPlayable), [tracks]);
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [mode, setMode] = useState<'choose' | 'new'>('choose');

  if (!open) return null;

  const run = async (fn: () => Promise<void>, ok: string) => {
    if (!playable.length || busy) return;
    setBusy(true);
    setMsg('');
    try {
      await fn();
      setMsg(ok);
      window.setTimeout(onClose, 700);
    } catch (e) {
      setMsg(String((e as Error)?.message || e || 'Échec'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/55 sm:items-center">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="Fermer" onClick={onClose} />
      <div className="relative z-10 max-h-[85vh] w-full max-w-md overflow-hidden rounded-t-2xl border border-white/10 bg-[#121212] shadow-2xl sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div>
            <h2 className="font-display text-lg font-semibold">Enregistrer la file</h2>
            <p className="text-xs text-yt-muted">
              {playable.length} titre{playable.length > 1 ? 's' : ''} → playlist
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-yt-muted hover:bg-white/10 hover:text-white"
            aria-label="Fermer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-2 py-2" style={{ maxHeight: 'min(60vh, 420px)' }}>
          <button
            type="button"
            disabled={busy || !playable.length}
            onClick={() => setMode('new')}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-white/8 disabled:opacity-50"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10">
              <Plus className="h-5 w-5" />
            </span>
            <span>
              <span className="block text-sm font-medium">Nouvelle playlist</span>
              <span className="text-xs text-yt-muted">Créer et y ajouter toute la file</span>
            </span>
          </button>

          {mode === 'new' && (
            <div className="mx-2 mb-3 rounded-xl border border-white/10 bg-black/30 p-3">
              <label className="mb-1.5 block text-[11px] uppercase tracking-wide text-yt-muted">
                Nom
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mb-3 w-full rounded-lg border border-white/15 bg-yt-elevated px-3 py-2 text-sm outline-none focus:border-white/35"
                placeholder={defaultName}
                autoFocus
              />
              <button
                type="button"
                disabled={busy || !playable.length}
                className="w-full rounded-full bg-white py-2.5 text-sm font-semibold text-black disabled:opacity-50"
                onClick={() =>
                  void run(async () => {
                    const pl = await createPlaylist(name.trim() || defaultName);
                    if (!pl?.id) throw new Error('Playlist non créée');
                    await addTracksToPlaylist(pl.id, playable);
                  }, `Playlist « ${name.trim() || defaultName} » créée`)
                }
              >
                {busy ? 'Enregistrement…' : 'Créer et enregistrer'}
              </button>
            </div>
          )}

          <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-yt-muted">
            Playlists existantes
          </div>
          {playlists.length === 0 && (
            <p className="px-3 py-4 text-sm text-yt-muted">Aucune playlist pour l’instant.</p>
          )}
          {playlists.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={busy || !playable.length}
              onClick={() =>
                void run(
                  () => addTracksToPlaylist(p.id, playable),
                  `Ajouté à « ${p.name} »`,
                )
              }
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-white/8 disabled:opacity-50"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-md bg-white/10">
                <ListMusic className="h-5 w-5 text-yt-muted" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{p.name}</span>
                <span className="text-xs text-yt-muted">
                  {(p.tracks?.length || 0).toLocaleString('fr-FR')} titres
                </span>
              </span>
            </button>
          ))}
        </div>

        {msg ? (
          <div className="border-t border-white/10 px-4 py-2.5 text-center text-sm text-white/80">
            {msg}
          </div>
        ) : null}
      </div>
    </div>
  );
}
