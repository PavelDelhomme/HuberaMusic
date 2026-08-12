import { useEffect, useState } from 'react';
import { artistNames } from '../../api';
import { usePlayer } from '../../store/player';
import { useItemActions } from '../../store/itemActions';
import { TrackRow } from '../media/TrackRow';
import { SaveQueueSheet } from './SaveQueueSheet';
import { SyncedLyrics } from './NowPlaying';
import { ListMusic, MoreVertical, Radio, Repeat, Repeat1, Save, Shuffle, Sparkles, Trash2, X } from 'lucide-react';

type PanelTab = 'queue' | 'similar';

export function QueuePanel() {
  const showQueue = usePlayer((s) => s.showQueue);
  const showLyrics = usePlayer((s) => s.showLyrics);
  const queue = usePlayer((s) => s.queue);
  const queueIndex = usePlayer((s) => s.queueIndex);
  const userQueueEnd = usePlayer((s) => s.userQueueEnd);
  const autoplay = usePlayer((s) => s.autoplay);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const lyrics = usePlayer((s) => s.lyrics);
  const lyricsTimed = usePlayer((s) => s.lyricsTimed);
  const related = usePlayer((s) => s.related);
  const current = usePlayer((s) => s.current);
  const toggleQueue = usePlayer((s) => s.toggleQueue);
  const toggleLyrics = usePlayer((s) => s.toggleLyrics);
  const toggleAutoplay = usePlayer((s) => s.toggleAutoplay);
  const toggleShuffle = usePlayer((s) => s.toggleShuffle);
  const cycleRepeat = usePlayer((s) => s.cycleRepeat);
  const topUpAutoplay = usePlayer((s) => s.topUpAutoplay);
  const playAt = usePlayer((s) => s.playAt);
  const playUpcomingInQueue = usePlayer((s) => s.playUpcomingInQueue);
  const appendRelated = usePlayer((s) => s.appendRelated);
  const addNext = usePlayer((s) => s.addNext);
  const loadRelated = usePlayer((s) => s.loadRelated);
  const relatedLoading = usePlayer((s) => s.relatedLoading);
  const autoRadioLoading = usePlayer((s) => s.autoRadioLoading);
  const relatedError = usePlayer((s) => s.relatedError);
  const clearUpcomingFromQueue = usePlayer((s) => s.clearUpcomingFromQueue);
  const openActions = useItemActions((s) => s.open);
  const [saveOpen, setSaveOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<PanelTab>('queue');

  useEffect(() => {
    if (!showQueue) return;
    topUpAutoplay();
  }, [showQueue, topUpAutoplay, queueIndex]);

  // Similaires se rafraîchissent à chaque titre (comme YTM Related)
  useEffect(() => {
    if (!showQueue || showLyrics || !current?.id) return;
    void loadRelated(current.id);
  }, [showQueue, showLyrics, current?.id, loadRelated]);

  useEffect(() => {
    if (!showQueue && !showLyrics) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (saveOpen) {
        setSaveOpen(false);
        return;
      }
      if (showLyrics) toggleLyrics();
      else toggleQueue();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [showQueue, showLyrics, saveOpen, toggleQueue, toggleLyrics]);

  if (!showQueue && !showLyrics) return null;

  const boundary = Math.min(
    Math.max(userQueueEnd || 0, queueIndex + 1),
    queue.length,
  );
  const playingUser = queueIndex < boundary;
  const playedBefore = queueIndex > 0 ? queue.slice(0, queueIndex) : [];
  const userTracks = queue; // déjà joués + courant + suite déjà chargée/affichée
  const userUpcoming = playingUser ? queue.slice(queueIndex + 1, boundary) : [];
  // « À suivre » = suite auto (toujours affichée) — le switch ne coupe que l’auto-avance
  const autoTracks = playingUser
    ? queue.slice(boundary)
    : queue.slice(queueIndex + 1);
  const autoStart = playingUser ? boundary : queueIndex + 1;

  return (
    <aside className="fixed bottom-[calc(var(--ytm-player-h,5.5rem)+var(--ytm-nav-h,0px))] right-0 top-0 z-30 flex w-full max-w-xl flex-col border-l border-yt-border bg-yt-surface shadow-2xl md:static md:bottom-auto md:z-10 md:max-w-lg lg:max-w-xl">
      <div className="flex items-center justify-between gap-2 border-b border-yt-border px-4 py-3">
        <div className="min-w-0 flex-1">
          {showLyrics ? (
            <>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-yt-muted">Paroles</p>
              <h3 className="truncate font-display text-base font-semibold leading-tight" title={current?.title}>
                {current?.title || 'Paroles'}
              </h3>
              {current && (
                <p className="truncate text-xs text-yt-muted">{artistNames(current)}</p>
              )}
            </>
          ) : (
            <h3 className="min-w-0 truncate font-display text-base font-semibold">
              {panelTab === 'similar' ? 'Similaires' : "File d'attente"}
            </h3>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {showLyrics && current && (
            <button
              type="button"
              onClick={() => openActions(current, { queueIndex })}
              className="flex h-8 w-8 items-center justify-center rounded-full text-yt-muted hover:bg-yt-hover hover:text-white"
              title="Plus d'options"
              aria-label="Plus d'options"
            >
              <MoreVertical className="h-4 w-4" />
            </button>
          )}
          {!showLyrics && panelTab === 'queue' && (
            <>
              <button
                type="button"
                onClick={cycleRepeat}
                title={
                  repeat === 'off'
                    ? 'Boucle désactivée'
                    : repeat === 'all'
                      ? 'Boucler toute la file'
                      : 'Boucler le titre'
                }
                className={`flex h-8 w-8 items-center justify-center rounded-full ${
                  repeat !== 'off' ? 'text-yt-red' : 'text-yt-muted hover:bg-yt-hover hover:text-white'
                }`}
              >
                {repeat === 'one' ? <Repeat1 className="h-4 w-4" /> : <Repeat className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={toggleShuffle}
                title={shuffle ? 'Aléatoire activé' : 'Aléatoire'}
                className={`flex h-8 w-8 items-center justify-center rounded-full ${
                  shuffle ? 'text-yt-red' : 'text-yt-muted hover:bg-yt-hover hover:text-white'
                }`}
              >
                <Shuffle className="h-4 w-4" />
              </button>
              <button
                type="button"
                disabled={queue.length <= 1}
                onClick={() => clearUpcomingFromQueue()}
                className="flex h-8 w-8 items-center justify-center rounded-full text-yt-muted hover:bg-yt-hover hover:text-white disabled:opacity-40"
                title="Vider la file (garde le titre en cours)"
                aria-label="Vider la file"
              >
                <Trash2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                disabled={userTracks.length === 0}
                onClick={() => setSaveOpen(true)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-yt-muted hover:bg-yt-hover hover:text-white disabled:opacity-40"
                title="Enregistrer la file"
              >
                <Save className="h-4 w-4" />
              </button>
            </>
          )}
          {!showLyrics && panelTab === 'similar' && related.length > 0 && (
            <button
              type="button"
              onClick={() => appendRelated(related)}
              className="inline-flex items-center gap-1 rounded-full bg-white/8 px-2.5 py-1.5 text-xs text-white hover:bg-white/14"
              title="Tout ajouter à la file"
            >
              Tout ajouter
            </button>
          )}
          <button
            type="button"
            onClick={() => (showLyrics ? void toggleLyrics() : toggleQueue())}
            className="rounded-full p-1.5 text-yt-muted hover:bg-yt-hover hover:text-white"
            title={showLyrics ? 'Fermer les paroles' : 'Fermer'}
            aria-label={showLyrics ? 'Fermer les paroles' : 'Fermer'}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {!showLyrics && (
        <div
          className="flex border-b border-yt-border touch-pan-y"
          onTouchStart={(e) => {
            (e.currentTarget as HTMLElement & { _sx?: number })._sx = e.touches[0]?.clientX;
          }}
          onTouchEnd={(e) => {
            const el = e.currentTarget as HTMLElement & { _sx?: number };
            const sx = el._sx;
            const x = e.changedTouches[0]?.clientX;
            if (sx == null || x == null) return;
            const dx = x - sx;
            if (Math.abs(dx) < 56) return;
            if (dx < 0) setPanelTab('similar');
            else setPanelTab('queue');
          }}
        >          <button
            type="button"
            onClick={() => setPanelTab('queue')}
            className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-2 py-2.5 text-xs font-semibold uppercase tracking-wide transition ${
              panelTab === 'queue'
                ? 'border-white text-white'
                : 'border-transparent text-yt-muted hover:text-white'
            }`}
          >
            <ListMusic className="h-3.5 w-3.5" />
            File
          </button>
          <button
            type="button"
            onClick={() => setPanelTab('similar')}
            className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-2 py-2.5 text-xs font-semibold uppercase tracking-wide transition ${
              panelTab === 'similar'
                ? 'border-white text-white'
                : 'border-transparent text-yt-muted hover:text-white'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Similaires
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {showLyrics ? (
          <SyncedLyrics text={lyrics} timed={lyricsTimed} />
        ) : panelTab === 'similar' ? (
          <div className="space-y-1 pt-1">
            <div className="mb-3 px-2">
              <h4 className="font-display text-sm font-semibold">Découvrez également</h4>
              <p className="text-[11px] text-yt-muted">
                Même style · mis à jour avec « {current?.title || 'titre en cours'} »
              </p>
            </div>
            {relatedLoading && related.length === 0 ? (
              <p className="px-2 py-4 text-sm text-yt-muted">Chargement des suggestions…</p>
            ) : relatedError && related.length === 0 ? (
              <div className="px-2 py-4">
                <p className="text-sm text-yt-muted">{relatedError}</p>
                {current?.id && (
                  <button
                    type="button"
                    className="mt-2 text-xs font-medium text-white underline"
                    onClick={() => void loadRelated(current.id)}
                  >
                    Réessayer
                  </button>
                )}
              </div>
            ) : related.length === 0 ? (
              <p className="px-2 py-4 text-sm text-yt-muted">Aucune suggestion pour l’instant.</p>
            ) : (
              related.slice(0, 24).map((track) => (
                <TrackRow
                  key={`sim-${track.id}`}
                  track={track}
                  queue={related}
                  hideIndex
                  alwaysActions
                  onPlay={() => {
                    addNext(track);
                    void playUpcomingInQueue(queueIndex + 1);
                  }}
                />
              ))
            )}
          </div>
        ) : (
          <>
            {playedBefore.length > 0 && (
              <div className="mb-2 opacity-70">
                <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-yt-muted">
                  Déjà joués
                </p>
                {playedBefore.map((track, i) => (
                  <TrackRow
                    key={`played-${track.id}-${i}`}
                    track={track}
                    queue={queue}
                    queueIndex={i}
                    hideIndex
                    draggable
                    alwaysActions
                    onPlay={() => void playAt(i)}
                  />
                ))}
              </div>
            )}

            <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-yt-muted">
              En cours
            </p>
            {current && (
              <div className="mb-2 rounded-lg bg-[#ff0033]/15 ring-1 ring-yt-red/40">
                <TrackRow
                  track={current}
                  queue={queue}
                  queueIndex={queueIndex}
                  hideIndex
                  draggable
                  alwaysActions
                />
              </div>
            )}

            {userUpcoming.length > 0 && (
              <div className="mb-2">
                <p className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wide text-yt-muted">
                  Ensuite dans ta file
                </p>
                {userUpcoming.map((track, i) => {
                  const abs = queueIndex + 1 + i;
                  return (
                    <TrackRow
                      key={`u-next-${track.id}-${abs}`}
                      track={track}
                      queue={queue}
                      queueIndex={abs}
                      hideIndex
                      draggable
                      alwaysActions
                      onPlay={() => void playAt(abs)}
                    />
                  );
                })}
              </div>
            )}

            <section className="mt-4 border-t border-yt-border pt-3">
              <div className="mb-2 flex items-center justify-between gap-2 px-2">
                <div className="min-w-0">
                  <h4 className="flex items-center gap-2 font-display text-sm font-semibold">
                    <Radio className="h-4 w-4 text-yt-red" /> À suivre
                  </h4>
                  <p className="text-[11px] text-yt-muted">Lecture automatique</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoplay}
                  onClick={() => toggleAutoplay()}
                  className={`relative h-7 w-12 shrink-0 rounded-full transition ${
                    autoplay ? 'bg-yt-red' : 'bg-white/15'
                  }`}
                  title={autoplay ? 'Désactiver la lecture auto' : 'Activer la lecture auto'}
                >
                  <span
                    className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition ${
                      autoplay ? 'left-5' : 'left-0.5'
                    }`}
                  />
                </button>
              </div>
              {!autoplay && (
                <p className="px-2 text-xs text-yt-muted">
                  Lecture auto désactivée — stop en fin de file ; Suivant charge la suite.
                </p>
              )}
              {autoTracks.map((track, i) => {
                  const abs = autoStart + i;
                  return (
                    <TrackRow
                      key={`a-${track.id}-${abs}`}
                      track={track}
                      queue={queue}
                      queueIndex={abs}
                      hideIndex
                      draggable
                      alwaysActions
                      onPlay={() => void playUpcomingInQueue(abs)}
                    />
                  );
                })}
              {autoTracks.length === 0 && autoRadioLoading && (
                <p className="px-2 py-3 text-center text-xs text-yt-muted">
                  Chargement des suggestions…
                </p>
              )}
              {autoTracks.length === 0 && !autoRadioLoading && related.length === 0 && (
                <div className="px-2 py-3 text-center">
                  <p className="text-xs text-yt-muted">Aucune suggestion pour l’instant.</p>
                  <button
                    type="button"
                    className="mt-2 text-xs text-yt-red hover:underline"
                    onClick={() => topUpAutoplay()}
                  >
                    Réessayer
                  </button>
                </div>
              )}
              {autoTracks.length === 0 && related.length > 0 && (
                <div className="mt-2">
                  <p className="mb-1 px-2 text-[11px] text-yt-muted">Propositions</p>
                  {related.slice(0, 8).map((track) => (
                    <TrackRow
                      key={`prop-${track.id}`}
                      track={track}
                      queue={related}
                      hideIndex
                      alwaysActions
                      onPlay={() => {
                        addNext(track);
                        void playUpcomingInQueue(queueIndex + 1);
                      }}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      <SaveQueueSheet
        open={saveOpen}
        tracks={userTracks}
        onClose={() => setSaveOpen(false)}
      />
    </aside>
  );
}
