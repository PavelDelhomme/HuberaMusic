package ovh.delhomme.ytmusic.player

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import ovh.delhomme.ytmusic.data.MixCacheStore
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.data.isPrecomputedMixSource
import ovh.delhomme.ytmusic.YtMusicApp
import ovh.delhomme.ytmusic.debug.CrashReporter
import ovh.delhomme.ytmusic.debug.AppLog
import ovh.delhomme.ytmusic.ui.player.SessionMediaMode
import android.widget.Toast

enum class RepeatMode { Off, All, One }

/** Volume ExoPlayer — ne pas saturer le canal média du téléphone. */
internal const val PLAYBACK_VOLUME = 0.82f

data class PlayerUiState(
    val track: TrackDto? = null,
    val playing: Boolean = false,
    val positionMs: Long = 0L,
    val durationMs: Long = 0L,
    val bufferedMs: Long = 0L,
    val queueSize: Int = 0,
    val queueIndex: Int = 0,
    val queue: List<TrackDto> = emptyList(),
    val sleepLabel: String? = null,
    val shuffle: Boolean = false,
    val repeat: RepeatMode = RepeatMode.Off,
    /** Vitesse ExoPlayer (1f = normal). */
    val playbackSpeed: Float = 1f,
    /** Libellé source : « File d'attente », nom de playlist, mix… */
    val queueTitle: String = "File d'attente",
    /** Fin exclusive de la file lancée par l’utilisateur ; au-delà = suggestions auto. */
    val userQueueEnd: Int = 0,
    /** Lecture automatique (suggestions après la file). */
    val autoplaySuggestions: Boolean = true,
    /** Remplissage « À suivre » en cours (skip à 1 titre). */
    val autoFillBusy: Boolean = false,
    /** Id de la collection lancée (album / playlist / mix). */
    val sourceId: String? = null,
    val sourceKind: String? = null,
)

/** Pont UI ↔ Media3 PlaybackService (lecture arrière-plan). */
class PlayerController(
    private val context: Context,
    private val streamUrl: (String) -> String,
    private val warmUrl: (String) -> String = { id ->
        streamUrl(id).substringBefore('?').replace("/api/stream/$id", "/api/stream/$id/url")
    },
) {
    private var controllerFuture: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private var pending: Pair<List<TrackDto>, Int>? = null
    private var pendingSeekMs: Long = 0L
    private var pendingAutoplay: Boolean = true
    /** Intent utilisateur play/pause — empêche un flush pending de re-pauser après un 1er play. */
    @Volatile private var userWantsPlaying: Boolean? = null

    private val _state = MutableStateFlow(PlayerUiState())
    val state: StateFlow<PlayerUiState> = _state.asStateFlow()

    private val sleepHandler = Handler(Looper.getMainLooper())
    private var sleepRunnable: Runnable? = null
    private var pauseAtEndOfTrack = false
    private var pauseAtEndOfQueue = false
    private var sleepLabel: String? = null
    private var queueTitle: String = "File d'attente"
    private var shuffleEnabled: Boolean = false
    /** Ordre naturel de la suite pendant le shuffle (restore OFF + ajouts autoplay). */
    private var shuffleNatural: MutableList<TrackDto>? = null
    private var repeatMode: RepeatMode = RepeatMode.Off
    private var silenceActiveTrackId: String? = null
    private var silenceSkipTrackId: String? = null
    /** Fin de dernière lyric (ms) pour le titre courant. */
    private var lastLyricEndMs: Long = -1L
    private var lyricsFetchTrackId: String? = null
    private var userQueueEnd: Int = 0
    private var sourceId: String? = null
    private var sourceKind: String? = null
    private val playerPrefs = context.getSharedPreferences("ytm_player", Context.MODE_PRIVATE)
    private var autoplaySuggestions: Boolean = loadAutoplaySuggestionsPref()

    init {
        PlaybackService.Holder.autoplaySuggestions = autoplaySuggestions
        _state.value = _state.value.copy(autoplaySuggestions = autoplaySuggestions)
    }

    private val scope = CoroutineScope(
        SupervisorJob() + Dispatchers.Main.immediate + CrashReporter.coroutineHandler("PlayerController"),
    )
    private var fillJob: Job? = null

    /**
     * Fournisseur de titres « À suivre » (related?fast=1).
     * Branché depuis MainActivity via [AppContainer.api].
     */
    var autoFillFetcher: (suspend (seedId: String) -> List<TrackDto>)? = null

    private val listener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
            syncFrom(player)
            if (events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION) ||
                (events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) &&
                    player.playbackState == Player.STATE_READY)
            ) {
                ensureAutoplayAhead()
            }
        }
    }

    fun connect() {
        PlaybackService.Holder.onSkipAtEnd = { fillThenSkipFromEnd(fromUserSkip = true) }
        PlaybackService.Holder.onToggleShuffle = { toggleShuffle() }
        PlaybackService.Holder.onCycleRepeat = { cycleRepeat() }
        if (controller != null || controllerFuture != null) return
        // Ne démarre PAS le service à l’ouverture UI (évite session média PLM à côté de Netflix).
        val alreadyRunning =
            PlaybackService.Holder.service != null || PlaybackService.Holder.player != null
        if (!alreadyRunning) return
        bindMediaController()
    }

    private fun ensureServiceAndConnect() {
        ensureService()
        if (controller != null || controllerFuture != null) return
        bindMediaController()
    }

    private fun bindMediaController() {
        if (controller != null || controllerFuture != null) return
        val token = SessionToken(context, ComponentName(context, PlaybackService::class.java))
        val future = MediaController.Builder(context, token).buildAsync()
        controllerFuture = future
        future.addListener({
            runCatching {
                val c = future.get()
                controller = c
                c.addListener(listener)
                applyRepeatShuffle(c)
                syncFrom(c)
                pending?.let { (tracks, idx) ->
                    val seek = pendingSeekMs
                    val auto = pendingAutoplay || userWantsPlaying == true
                    pending = null
                    pendingSeekMs = 0L
                    pendingAutoplay = true
                    // Déjà démarré via Holder.player → sync seulement (évite double prepare)
                    val exo = PlaybackService.Holder.player
                    val alreadyPrepared =
                        exo != null &&
                            exo.mediaItemCount > 0 &&
                            tracks.getOrNull(idx)?.id?.let { id ->
                                exo.currentMediaItem?.mediaId == id ||
                                    (0 until exo.mediaItemCount).any { i ->
                                        exo.getMediaItemAt(i).mediaId == id
                                    }
                            } == true
                    if (alreadyPrepared) {
                        if (seek > 0L) runCatching { c.seekTo(seek) }
                        if (!auto) c.pause() else c.play()
                        syncFrom(c)
                    } else {
                        playNow(c, tracks, idx, autoplay = auto, startPositionMs = seek)
                        if (!auto) c.pause() else c.play()
                        syncFrom(c)
                    }
                    ensureAutoplayAhead()
                }
            }
        }, MoreExecutors.directExecutor())
    }

    fun release() {
        clearSleepTimer()
        fillJob?.cancel()
        if (PlaybackService.Holder.onSkipAtEnd != null) {
            PlaybackService.Holder.onSkipAtEnd = null
        }
        PlaybackService.Holder.onToggleShuffle = null
        PlaybackService.Holder.onCycleRepeat = null
        controller?.removeListener(listener)
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controller = null
        controllerFuture = null
    }

    fun play(
        tracks: List<TrackDto>,
        startIndex: Int = 0,
        title: String? = null,
        /** Fin exclusive file utilisateur ; null = toute la file lancée est « user ». */
        userQueueEnd: Int? = null,
        sourceId: String? = null,
        sourceKind: String? = null,
    ) {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        val mode = am?.mode ?: AudioManager.MODE_NORMAL
        if (mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION) {
            Toast.makeText(
                context,
                "Lecture impossible pendant un appel — termine l'appel puis réessaie",
                Toast.LENGTH_LONG,
            ).show()
            AppLog.w("player", "play bloqué MODE_IN_CALL/COMM mode=$mode")
            return
        }
        if (title != null) {
            queueTitle = title.ifBlank { "File d'attente" }
        } else {
            queueTitle = "File d'attente"
        }
        PlaybackService.Holder.queueTitle = queueTitle
        this.sourceId = sourceId
        this.sourceKind = sourceKind
        ensureServiceAndConnect()
        val playable = tracks.filter { it.isPlayable() }
        this.userQueueEnd = (userQueueEnd ?: playable.size).coerceIn(0, playable.size)
        userWantsPlaying = true
        pendingAutoplay = true
        if (playable.isNotEmpty()) {
            val idx = startIndex.coerceIn(0, playable.lastIndex)
            val base = streamUrl("_").substringBefore("/api/stream/")
            val firstId = playable[idx].id
            StreamPrefetcher.quietPrefetch(420L)
            val headReady = !firstId.isNullOrBlank() && StreamPrefetcher.wasHeadReadyRecently(firstId)
            if (!headReady) {
                StreamPrefetcher.warmTrackFormatOnly(base, firstId)
                scope.launch(Dispatchers.IO) {
                    StreamPrefetcher.warmCurrentBlocking(base, firstId, timeoutMs = 900L, wait = true)
                }
                playable.drop(idx + 1).take(2).forEach { t ->
                    StreamPrefetcher.warmTrackFormatOnly(base, t.id)
                }
            }
            val startId = firstId
            scope.launch {
                delay(if (headReady) 120L else 480L)
                if (player()?.currentMediaItem?.mediaId != startId) return@launch
                warmAround(playable, idx)
                StreamPrefetcher.prefetchUpcomingHeadsTiered(
                    base,
                    playable.map { it.id },
                    idx,
                    count = 4,
                    ignoreQuiet = false,
                )
            }
        }
        val c = controller
        if (c != null) {
            playNow(c, tracks, startIndex)
            ensureAutoplayAhead()
        } else {
            pending = tracks to startIndex
            pendingSeekMs = 0L
            pendingAutoplay = true
            PlaybackService.Holder.queue = playable
            PlaybackService.Holder.player?.let { exo ->
                exo.playTracks(streamUrl, tracks, startIndex)
                applyRepeatShuffle(exo)
                syncFrom(exo)
            }
            scope.launch {
                delay(700)
                ensureAutoplayAhead()
            }
        }
    }

    fun toggleAutoplaySuggestions() {
        setAutoplaySuggestions(!autoplaySuggestions)
    }

    fun setAutoplaySuggestions(on: Boolean) {
        applyAutoplaySuggestions(on, syncRemote = true)
    }

    /** Applique la préf locale (hydratation serveur sans re-POST). */
    fun hydrateAutoplaySuggestions(on: Boolean) {
        applyAutoplaySuggestions(on, syncRemote = false)
    }

    private fun applyAutoplaySuggestions(on: Boolean, syncRemote: Boolean) {
        autoplaySuggestions = on
        val editor = playerPrefs.edit().putBoolean("autoplay_suggestions", on)
        if (syncRemote) editor.putBoolean("autoplay_suggestions_explicit", true)
        editor.apply()
        PlaybackService.Holder.autoplaySuggestions = on
        // Ne pas trimmer la zone « À suivre » — elle reste visible ; on coupe seulement l’auto-avance
        _state.value = _state.value.copy(autoplaySuggestions = on)
        if (syncRemote) {
            scope.launch {
                runCatching {
                    YtMusicApp.instance.container.api.savePrefs(
                        ovh.delhomme.ytmusic.data.SavePrefsBody(autoplaySuggestions = on),
                    )
                }
            }
        }
    }

    /** Ajoute des suggestions après la file utilisateur (zone auto) — toujours, pour affichage. */
    fun appendAutoTracks(tracks: List<TrackDto>, forSeedId: String? = null) {
        if (forSeedId != null && _state.value.track?.id != forSeedId) return
        val remainingUser = (userQueueEnd - _state.value.queueIndex - 1).coerceAtLeast(0)
        if (isPrecomputedMixSource(sourceKind, remainingUser)) return
        val extra = tracks.filter { it.isPlayable() }
        if (extra.isEmpty()) return
        val c = player() ?: PlaybackService.Holder.player ?: return
        val queue = PlaybackService.Holder.queue.toMutableList()
        val existing = queue.map { it.id }.toHashSet()
        // Titres déjà passés dans la file (avant l’index) → pas de remise en « À suivre »
        val curIdx = c.currentMediaItemIndex.coerceAtLeast(0)
        for (i in 0 until curIdx.coerceAtMost(queue.size)) {
            existing.add(queue[i].id)
        }
        val toAdd = extra.filter { it.id !in existing }.take(80)
        if (toAdd.isEmpty()) return
        if (userQueueEnd <= 0) userQueueEnd = (_state.value.queueIndex + 1).coerceAtMost(queue.size)
        queue.addAll(toAdd)
        if (shuffleEnabled) {
            val natural = shuffleNatural ?: queue.drop(curIdx + 1).dropLast(toAdd.size).toMutableList()
            natural.addAll(toAdd)
            shuffleNatural = natural
        }
        PlaybackService.Holder.queue = queue
        PlaybackService.Holder.userQueueEnd = userQueueEnd
        toAdd.forEach { c.addMediaItem(mediaItem(it)) }
        warmAround(queue, c.currentMediaItemIndex.coerceAtLeast(0))
        syncFrom(c)
    }

    /**
     * Précharge « À suivre » dans Exo (toujours) — le toggle ne contrôle que l’auto-avance
     * après la fin de la file utilisateur.
     */
    fun ensureAutoplayAhead() {
        if (fillJob?.isActive == true) return
        val remainingUser = (userQueueEnd - _state.value.queueIndex - 1).coerceAtLeast(0)
        if (isPrecomputedMixSource(sourceKind, remainingUser)) return
        val remaining = (PlaybackService.Holder.queue.size - _state.value.queueIndex - 1)
            .coerceAtLeast(0)
        if (remaining >= 6) return
        val seed = _state.value.track?.id
            ?: PlaybackService.Holder.queue.getOrNull(_state.value.queueIndex)?.id
            ?: return
        val fetcher = autoFillFetcher ?: return
        fillJob = scope.launch {
            try {
                _state.value = _state.value.copy(autoFillBusy = true)
                val tracks = runCatching { fetcher(seed) }.getOrDefault(emptyList())
                if (tracks.isNotEmpty() && _state.value.track?.id == seed) {
                    appendAutoTracks(tracks, forSeedId = seed)
                }
            } finally {
                _state.value = _state.value.copy(autoFillBusy = false)
            }
        }
    }

    /** Coupe la zone auto (après userQueueEnd) — nouveau seed / change de monde. */
    fun clearAutoTracks() {
        val queue = PlaybackService.Holder.queue
        val end = userQueueEnd.coerceIn(0, queue.size).coerceAtLeast(
            (_state.value.queueIndex + 1).coerceAtMost(queue.size),
        )
        if (queue.size <= end) return
        val trimmed = queue.take(end)
        userQueueEnd = trimmed.size
        PlaybackService.Holder.queue = trimmed
        val c = player() ?: PlaybackService.Holder.player
        if (c != null && c.mediaItemCount > end) {
            // Retire seulement la queue — pas de setMediaItems/prepare (évite rebuffer du titre courant)
            c.removeMediaItems(end, c.mediaItemCount)
            syncFrom(c)
        } else {
            _state.value = _state.value.copy(
                queue = trimmed,
                queueSize = trimmed.size,
                userQueueEnd = userQueueEnd,
            )
        }
    }

    fun setQueueTitle(title: String) {
        queueTitle = title.ifBlank { "File d'attente" }
        _state.value = _state.value.copy(queueTitle = queueTitle)
    }

    fun toggle() {
        connect()
        val p = player() ?: PlaybackService.Holder.player
        if (p == null) {
            _state.value = _state.value.copy(playing = true)
            startPlaybackFromUiState()
            return
        }
        if (p.isPlaying) {
            userWantsPlaying = false
            pendingAutoplay = false
            p.pause()
            StreamPrefetcher.cancelIdle()
        } else {
            userWantsPlaying = true
            pendingAutoplay = true
            resumeOrPlay(p)
        }
        syncFrom(p)
    }

    /**
     * Après restore silencieuse (autoplay=false), l’UI a la file mais pas de MediaSession/Exo.
     * Un simple [connect] refuse de démarrer le service → play/pause no-op.
     * On hydrate pending + Holder puis [ensureServiceAndConnect] ; le bind flushe avec autoplay.
     */
    private fun startPlaybackFromUiState(): Boolean {
        val fromPending = pending
        val tracks = fromPending?.first?.takeIf { it.isNotEmpty() } ?: _state.value.queue
        if (tracks.isEmpty()) return false
        val idx = (fromPending?.second ?: _state.value.queueIndex).coerceIn(0, tracks.lastIndex)
        val seek =
            if (fromPending != null) pendingSeekMs
            else _state.value.positionMs
        userWantsPlaying = true
        pendingAutoplay = true
        pending = tracks to idx
        pendingSeekMs = seek.coerceAtLeast(0L)
        PlaybackService.Holder.queue = tracks
        PlaybackService.Holder.index = idx
        PlaybackService.Holder.queueTitle = queueTitle
        ensureServiceAndConnect()
        // Service déjà chaud (race rare) : flush immédiat sans attendre le MediaController
        val exo = player() ?: PlaybackService.Holder.player
        if (exo != null && pending != null) {
            val (t, i) = pending!!
            val seekMs = pendingSeekMs
            pending = null
            pendingSeekMs = 0L
            playNow(exo, t, i, autoplay = true, startPositionMs = seekMs)
            syncFrom(exo)
        }
        return true
    }

    /**
     * Après restore (autoplay=false) ou échec stream, Exo peut être IDLE / ENDED
     * avec des URI mortes : un simple play() ne recharge rien.
     * On re-prépare le titre courant (URL proxy fraîche) puis on lance.
     */
    private fun resumeOrPlay(p: Player) {
        val state = p.playbackState
        val needRebuild =
            p.mediaItemCount == 0 ||
                state == Player.STATE_IDLE ||
                state == Player.STATE_ENDED
        val id = p.currentMediaItem?.mediaId
        val queue = PlaybackService.Holder.queue
        val idx = p.currentMediaItemIndex.coerceAtLeast(0)
        if (needRebuild || (id.isNullOrBlank() && queue.isNotEmpty())) {
            val tracks = queue.ifEmpty { _state.value.queue }
            if (tracks.isEmpty()) {
                p.play()
                return
            }
            val start = idx.coerceIn(0, tracks.lastIndex)
            val pos = p.currentPosition.coerceAtLeast(_state.value.positionMs).coerceAtLeast(0L)
            playNow(p, tracks, start, autoplay = true, startPositionMs = pos)
            return
        }
        // URI stream encore là mais pas de buffer (souvent après kill / toast « Reprise du flux »)
        if (p.bufferedPosition <= p.currentPosition + 500L && !id.isNullOrBlank()) {
            val track = queue.firstOrNull { it.id == id } ?: _state.value.queue.firstOrNull { it.id == id }
            if (track != null) {
                val pos = p.currentPosition.coerceAtLeast(0L)
                runCatching {
                    val item = mediaItemFor(track, streamUrl, queueTitle)
                    p.replaceMediaItem(p.currentMediaItemIndex, item)
                    p.seekTo(p.currentMediaItemIndex, pos)
                    p.prepare()
                    p.play()
                }
                return
            }
        }
        runCatching { p.prepare() }
        p.play()
    }

    fun pause() {
        userWantsPlaying = false
        pendingAutoplay = false
        connect()
        player()?.pause() ?: PlaybackService.Holder.player?.pause()
        StreamPrefetcher.cancelIdle()
        flushPersist()
    }

    /**
     * Arrête la lecture et vide complètement la file (mini-lecteur disparaît).
     * Déclenché typiquement par un swipe bas sur la barre réduite.
     */
    fun stopAndClear() {
        userWantsPlaying = false
        pendingAutoplay = false
        pending = null
        pendingSeekMs = 0L
        fillJob?.cancel()
        clearSleepTimer()
        StreamPrefetcher.cancelIdle()
        runCatching { connect() }
        val p = player() ?: PlaybackService.Holder.player
        runCatching {
            p?.pause()
            p?.clearMediaItems()
        }
        PlaybackService.Holder.queue = emptyList()
        PlaybackService.Holder.index = 0
        PlaybackService.Holder.queueTitle = "File d'attente"
        userQueueEnd = 0
        queueTitle = "File d'attente"
        sourceId = null
        sourceKind = null
        _state.value = PlayerUiState(
            track = null,
            playing = false,
            positionMs = 0,
            durationMs = 0,
            bufferedMs = 0,
            queueSize = 0,
            queueIndex = 0,
            queue = emptyList(),
            sleepLabel = null,
            shuffle = shuffleEnabled,
            repeat = repeatMode,
            playbackSpeed = playbackSpeed,
            queueTitle = queueTitle,
            userQueueEnd = 0,
            autoplaySuggestions = autoplaySuggestions,
            autoFillBusy = false,
            sourceId = null,
            sourceKind = null,
        )
        runCatching { onClearLocal?.invoke() }
    }

    /** Branché depuis MainActivity → efface le snapshot local. */
    var onClearLocal: (() -> Unit)? = null

    fun playResume() {
        userWantsPlaying = true
        pendingAutoplay = true
        connect()
        val p = player() ?: PlaybackService.Holder.player
        if (p == null) {
            startPlaybackFromUiState()
            return
        }
        resumeOrPlay(p)
        syncFrom(p)
    }

    fun skipNext() {
        connect()
        val p = player() ?: PlaybackService.Holder.player
        if (p == null) {
            if (!startPlaybackFromUiState()) return
            // Bind async : on avance d’un cran dans pending pour le flush
            val q = pending?.first ?: _state.value.queue
            if (q.size > 1) {
                val cur = (pending?.second ?: _state.value.queueIndex).coerceIn(0, q.lastIndex)
                val next = (cur + 1) % q.size
                pending = q to next
                pendingSeekMs = 0L
                PlaybackService.Holder.index = next
            }
            return
        }
        val saved = PlaybackService.Holder.queue.ifEmpty { _state.value.queue }
        val idleOrEmpty =
            p.mediaItemCount == 0 ||
                p.playbackState == Player.STATE_IDLE
        if (idleOrEmpty && saved.size > 1) {
            val cur = PlaybackService.Holder.index.coerceIn(0, saved.lastIndex)
            val next = if (saved.size > 1) (cur + 1) % saved.size else cur
            userWantsPlaying = true
            pendingAutoplay = true
            playNow(p, saved, next, autoplay = true)
            return
        }
        val nextIdx = when {
            p.hasNextMediaItem() -> p.currentMediaItemIndex + 1
            repeatMode == RepeatMode.All && p.mediaItemCount > 0 -> 0
            p.mediaItemCount > 1 -> (p.currentMediaItemIndex + 1) % p.mediaItemCount
            else -> p.currentMediaItemIndex
        }
        warmAround(PlaybackService.Holder.queue, nextIdx)
        val nid = PlaybackService.Holder.queue.getOrNull(nextIdx)?.id
        if (!nid.isNullOrBlank()) {
            val base = streamUrl("_").substringBefore("/api/stream/")
            StreamPrefetcher.warmTrackFormatOnly(base, nid)
            // Skip utilisateur : ignorer quietPrefetch pour chauffer le suivant tout de suite
            StreamPrefetcher.prefetchUpcomingHeadsTiered(
                base,
                PlaybackService.Holder.queue.map { it.id },
                p.currentMediaItemIndex,
                count = 4,
                ignoreQuiet = true,
            )
        }
        // REPEAT_MODE_ONE bloque le next ExoPlayer : on le désactive le temps du saut
        val wasOne = repeatMode == RepeatMode.One
        if (wasOne) p.repeatMode = Player.REPEAT_MODE_OFF
        when {
            p.hasNextMediaItem() -> {
                p.seekToNextMediaItem()
                if (p.playbackState == Player.STATE_IDLE) p.prepare()
                p.playWhenReady = true
                p.play()
            }
            repeatMode == RepeatMode.All && p.mediaItemCount > 0 -> {
                p.seekTo(0, 0L)
                if (p.playbackState == Player.STATE_IDLE) p.prepare()
                p.playWhenReady = true
                p.play()
            }
            p.mediaItemCount > 1 -> {
                p.seekTo(nextIdx, 0L)
                if (p.playbackState == Player.STATE_IDLE) p.prepare()
                p.playWhenReady = true
                p.play()
            }
            else -> {
                val savedQ = PlaybackService.Holder.queue.ifEmpty { _state.value.queue }
                val cur = p.currentMediaItemIndex.coerceAtLeast(0)
                if (savedQ.size > cur + 1) {
                    userWantsPlaying = true
                    playNow(p, savedQ, cur + 1, autoplay = true)
                } else {
                    fillThenSkipFromEnd(fromUserSkip = true)
                }
            }
        }
        if (wasOne) {
            p.repeatMode = Player.REPEAT_MODE_ONE
            repeatMode = RepeatMode.One
        }
        syncFrom(p)
    }

    /** Appelé quand il n’y a plus de suivant (UI ou notif système). */
    private fun fillThenSkipFromEnd(fromUserSkip: Boolean = false) {
        if (pauseAtEndOfQueue || pauseAtEndOfTrack) {
            player()?.pause()
            clearSleepTimer()
            Toast.makeText(context, "Mise en veille", Toast.LENGTH_SHORT).show()
            return
        }
        // Fin naturelle + auto OFF → stop (suggestions restent visibles)
        if (!fromUserSkip && !autoplaySuggestions) {
            Toast.makeText(context, "Fin de la file", Toast.LENGTH_SHORT).show()
            return
        }
        if (fillJob?.isActive == true) {
            Toast.makeText(context, "Suggestions en cours…", Toast.LENGTH_SHORT).show()
            return
        }
        val savedQ = PlaybackService.Holder.queue.ifEmpty { _state.value.queue }
        val pNow = player() ?: PlaybackService.Holder.player
        val curIdx = (pNow?.currentMediaItemIndex ?: PlaybackService.Holder.index).coerceAtLeast(0)
        if (savedQ.size > curIdx + 1) {
            val p = pNow
            if (p != null) {
                if (p.playbackState == Player.STATE_ENDED ||
                    p.playbackState == Player.STATE_IDLE ||
                    p.currentMediaItemIndex < curIdx + 1
                ) {
                    playNow(p, savedQ, curIdx + 1, autoplay = true)
                    return
                }
                if (p.hasNextMediaItem()) {
                    p.seekToNextMediaItem()
                    p.prepare()
                    p.play()
                    syncFrom(p)
                    return
                }
            }
        }
        if (savedQ.size > curIdx + 1 && (pNow == null || pNow.mediaItemCount <= curIdx + 1)) {
            if (pNow != null) {
                playNow(pNow, savedQ, curIdx + 1, autoplay = true)
                return
            }
        }
        val seed = _state.value.track?.id
            ?: savedQ.getOrNull(curIdx)?.id
        if (seed.isNullOrBlank()) {
            if (savedQ.size > curIdx + 1 && pNow != null) {
                playNow(pNow, savedQ, curIdx + 1, autoplay = true)
            }
            return
        }
        val fetcher = autoFillFetcher
        if (fetcher == null) {
            Toast.makeText(context, "Suggestions indisponibles", Toast.LENGTH_SHORT).show()
            return
        }
        _state.value = _state.value.copy(autoFillBusy = true)
        Toast.makeText(context, "Chargement des suggestions…", Toast.LENGTH_SHORT).show()
        fillJob = scope.launch {
            try {
                val tracks = runCatching { fetcher(seed) }.getOrDefault(emptyList())
                if (tracks.isNotEmpty()) appendAutoTracks(tracks)
                val p = player() ?: PlaybackService.Holder.player
                if (p != null && p.hasNextMediaItem()) {
                    p.seekToNextMediaItem()
                    p.play()
                    syncFrom(p)
                } else {
                    Toast.makeText(
                        context,
                        if (tracks.isEmpty()) "Aucune suggestion" else "File mise à jour",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            } finally {
                _state.value = _state.value.copy(autoFillBusy = false)
            }
        }
    }

    /**
     * Précédent YTM :
     * - si position > 3 s → retour début du titre
     * - sinon → titre précédent dans la file
     */
    fun skipPrev() {
        connect()
        val p = player() ?: PlaybackService.Holder.player
        if (p == null) {
            if (!startPlaybackFromUiState()) return
            val q = pending?.first ?: _state.value.queue
            if (q.size > 1) {
                val cur = (pending?.second ?: _state.value.queueIndex).coerceIn(0, q.lastIndex)
                val posMs = pendingSeekMs.coerceAtLeast(_state.value.positionMs)
                if (posMs <= 3000L) {
                    val prev = if (cur > 0) cur - 1 else q.lastIndex
                    pending = q to prev
                    pendingSeekMs = 0L
                    PlaybackService.Holder.index = prev
                }
            }
            return
        }
        val saved = PlaybackService.Holder.queue.ifEmpty { _state.value.queue }
        val idleOrEmpty =
            p.mediaItemCount == 0 ||
                p.playbackState == Player.STATE_IDLE
        val curIdx = if (idleOrEmpty) {
            PlaybackService.Holder.index.coerceIn(0, saved.lastIndex.coerceAtLeast(0))
        } else {
            p.currentMediaItemIndex.coerceAtLeast(0)
        }
        val posMs = if (idleOrEmpty) {
            _state.value.positionMs.coerceAtLeast(0L)
        } else {
            p.currentPosition.coerceAtLeast(0L)
        }
        if (!idleOrEmpty && posMs > 3000L) {
            p.seekTo(0L)
            syncFrom(p)
            return
        }
        if (idleOrEmpty && saved.size > 1) {
            val prev = if (curIdx > 0) curIdx - 1 else saved.lastIndex
            userWantsPlaying = true
            pendingAutoplay = true
            playNow(p, saved, prev, autoplay = true)
            return
        }
        val wasOne = repeatMode == RepeatMode.One
        if (wasOne) p.repeatMode = Player.REPEAT_MODE_OFF
        when {
            p.hasPreviousMediaItem() -> {
                p.seekToPreviousMediaItem()
                p.play()
            }
            p.mediaItemCount > 1 -> {
                val prev = if (curIdx > 0) curIdx - 1 else p.mediaItemCount - 1
                p.seekTo(prev, 0L)
                p.play()
            }
            saved.size > 1 -> {
                val prev = if (curIdx > 0) curIdx - 1 else saved.lastIndex
                userWantsPlaying = true
                playNow(p, saved, prev, autoplay = true)
            }
            else -> p.seekTo(0L)
        }
        if (wasOne) {
            p.repeatMode = Player.REPEAT_MODE_ONE
            repeatMode = RepeatMode.One
        }
        syncFrom(p)
    }

    fun skipPrevOrRestart(forcePrevious: Boolean) {
        connect()
        val p = player() ?: PlaybackService.Holder.player
        if (p == null) {
            if (forcePrevious) {
                if (!startPlaybackFromUiState()) return
                val q = pending?.first ?: _state.value.queue
                if (q.size > 1) {
                    val cur = (pending?.second ?: _state.value.queueIndex).coerceIn(0, q.lastIndex)
                    val prev = if (cur > 0) cur - 1 else q.lastIndex
                    pending = q to prev
                    pendingSeekMs = 0L
                    PlaybackService.Holder.index = prev
                }
            } else {
                skipPrev()
            }
            return
        }
        if (forcePrevious) {
            val wasOne = repeatMode == RepeatMode.One
            if (wasOne) p.repeatMode = Player.REPEAT_MODE_OFF
            if (p.hasPreviousMediaItem()) {
                p.seekToPreviousMediaItem()
                p.play()
            } else if (p.mediaItemCount > 1) {
                val prev = if (p.currentMediaItemIndex > 0) p.currentMediaItemIndex - 1 else p.mediaItemCount - 1
                p.seekTo(prev, 0L)
                p.play()
            }
            if (wasOne) {
                p.repeatMode = Player.REPEAT_MODE_ONE
                repeatMode = RepeatMode.One
            }
            syncFrom(p)
        } else {
            skipPrev()
        }
    }

    fun seek(ms: Long) {
        val target = ms.coerceAtLeast(0L)
        val trackId = _state.value.track?.id
            ?: player()?.currentMediaItem?.mediaId
            ?: PlaybackService.Holder.queue.getOrNull(_state.value.queueIndex)?.id
        if (target > 45_000L && !trackId.isNullOrBlank()) {
            runCatching {
                StreamPrefetcher.requestServerDiskCache(
                    PlaybackService.Holder.resolvedApiBase(),
                    trackId,
                )
            }
        }
        val p = player() ?: PlaybackService.Holder.player
        if (p != null) {
            // Seek in-place — ne pas prepare/rebind (sinon retour au début sur mid-range)
            p.seekTo(target)
            if (!p.playWhenReady && userWantsPlaying == true) {
                p.playWhenReady = true
            }
        }
        // Met à jour la timeline UI même en pause (sync multi-appareils)
        _state.value = _state.value.copy(positionMs = target)
    }

    /** Avance / recule dans le titre courant (appui long next/prev). */
    fun seekBy(deltaMs: Long) {
        val p = player() ?: PlaybackService.Holder.player
        val cur = p?.currentPosition?.takeIf { it >= 0L } ?: _state.value.positionMs
        val dur = when {
            p != null && p.duration > 0L -> p.duration
            _state.value.durationMs > 0L -> _state.value.durationMs
            else -> Long.MAX_VALUE / 4
        }
        seek((cur + deltaMs).coerceIn(0L, dur))
    }

    /** Position UI seule (miroir remote sans forcément seek Exo si non préparé). */
    fun mirrorPosition(ms: Long, durationMs: Long = _state.value.durationMs) {
        _state.value = _state.value.copy(
            positionMs = ms.coerceAtLeast(0L),
            durationMs = durationMs.coerceAtLeast(_state.value.durationMs),
        )
        val p = player() ?: PlaybackService.Holder.player
        if (p != null && p.mediaItemCount > 0) {
            val cur = p.currentPosition
            if (kotlin.math.abs(cur - ms) > 1500L) {
                p.seekTo(ms.coerceAtLeast(0L))
            }
        }
    }

    /** Restaure une file sync (autres appareils) + timecode, sans forcer le play. */
    fun restoreQueue(
        tracks: List<TrackDto>,
        startIndex: Int,
        positionMs: Long,
        autoplay: Boolean,
        title: String? = "File d'attente",
        userQueueEnd: Int? = null,
    ) {
        if (tracks.isEmpty()) return
        if (title != null) queueTitle = title
        this.userQueueEnd = (userQueueEnd ?: tracks.size).coerceIn(0, tracks.size)
        // Ne pas écraser un intent play utilisateur en cours
        if (userWantsPlaying != true) {
            userWantsPlaying = autoplay
            pendingAutoplay = autoplay
        }
        val wantPlay = autoplay || userWantsPlaying == true
        if (!wantPlay) {
            // Restauration silencieuse (sync multi-appareils) : pas de MediaSession.
            // On garde quand même Holder.queue pour qu’un play utilisateur puisse démarrer Exo.
            val idx = startIndex.coerceIn(0, tracks.lastIndex)
            val curTrack = tracks.getOrNull(idx)
            val metaDur = curTrack?.durationMsOrNull()?.coerceAtLeast(0L) ?: 0L
            pending = tracks to idx
            pendingSeekMs = positionMs
            pendingAutoplay = false
            PlaybackService.Holder.queue = tracks
            PlaybackService.Holder.index = idx
            PlaybackService.Holder.queueTitle = queueTitle
            _state.value = _state.value.copy(
                queue = tracks,
                queueIndex = idx,
                positionMs = positionMs.coerceAtLeast(0L),
                track = curTrack,
                playing = false,
                durationMs = metaDur,
                queueTitle = queueTitle,
                userQueueEnd = this.userQueueEnd,
                queueSize = tracks.size,
            )
            curTrack?.id?.takeIf { it.length == 11 }?.let { id ->
                val base = streamUrl("_").substringBefore("/api/stream/")
                scope.launch(Dispatchers.IO) {
                    StreamPrefetcher.warmTrackFormatOnly(base, id)
                }
            }
            return
        }
        ensureServiceAndConnect()
        val c = controller ?: PlaybackService.Holder.player
        if (c != null) {
            val auto = true
            playNow(c, tracks, startIndex, autoplay = auto, startPositionMs = positionMs)
            c.play()
            syncFrom(c)
        } else {
            pending = tracks to startIndex
            pendingSeekMs = positionMs
            pendingAutoplay = true
        }
    }

    fun playAt(index: Int) {
        ensureServiceAndConnect()
        val p = player() ?: PlaybackService.Holder.player ?: return
        val queue = PlaybackService.Holder.queue.ifEmpty { _state.value.queue }
        if (index !in queue.indices) return
        val idleOrEmpty =
            p.mediaItemCount == 0 ||
                p.playbackState == Player.STATE_IDLE ||
                p.playbackState == Player.STATE_ENDED
        if (idleOrEmpty || index !in 0 until p.mediaItemCount) {
            userWantsPlaying = true
            pendingAutoplay = true
            playNow(p, queue, index, autoplay = true)
            return
        }
        if (index >= userQueueEnd) {
            userQueueEnd = (index + 1).coerceAtMost(queue.size)
        }
        userWantsPlaying = true
        pendingAutoplay = true
        val track = queue[index]
        val base = streamUrl("_").substringBefore("/api/stream/")
        // Prefetch en arrière-plan — ne bloque pas le saut
        if (track.id.length == 11) {
            scope.launch {
                StreamPrefetcher.quietPrefetch(200L)
                StreamPrefetcher.warmTrackFormatOnly(base, track.id)
                StreamPrefetcher.prefetchAroundIndex(base, queue.map { it.id }, index, radius = 2)
            }
        }
        // seekTo suffit si l’item est déjà dans Exo — éviter replace+prepare (lag UI)
        p.seekTo(index, 0L)
        if (p.playbackState == Player.STATE_IDLE) p.prepare()
        p.playWhenReady = true
        p.play()
        warmAround(queue, index)
        PlaybackService.Holder.service?.notifyQueueJump()
        syncFrom(p)
    }

    fun removeFromQueue(index: Int) {
        val p = player() ?: return
        val queue = PlaybackService.Holder.queue.toMutableList()
        val cur = p.currentMediaItemIndex.coerceAtLeast(0)
        if (index !in queue.indices || index == cur) return
        queue.removeAt(index)
        if (index < userQueueEnd) userQueueEnd = (userQueueEnd - 1).coerceAtLeast(0)
        PlaybackService.Holder.queue = queue
        p.removeMediaItem(index)
        syncFrom(p)
    }

    /** Retire les titres avant le titre en cours (section « déjà joués »). */
    fun clearPlayedFromQueue() {
        val p = player() ?: return
        val cur = p.currentMediaItemIndex.coerceAtLeast(0)
        if (cur <= 0) return
        val queue = PlaybackService.Holder.queue.toMutableList()
        if (cur >= queue.size) return
        repeat(cur) {
            if (queue.isNotEmpty()) queue.removeAt(0)
            if (p.mediaItemCount > 0) p.removeMediaItem(0)
        }
        userQueueEnd = (userQueueEnd - cur).coerceAtLeast(0).coerceAtMost(queue.size)
        PlaybackService.Holder.queue = queue
        syncFrom(p)
    }

    /**
     * Vide la file : ne garde que le titre en cours (plus de suivants / autoplay).
     * Utile depuis le bandeau file rétracté sur mobile.
     */
    fun clearUpcomingFromQueue() {
        val p = player() ?: return
        val cur = p.currentMediaItemIndex.coerceAtLeast(0)
        val queue = PlaybackService.Holder.queue
        if (queue.isEmpty() || cur !in queue.indices) return
        if (queue.size <= 1) return
        val current = queue[cur]
        while (p.mediaItemCount > cur + 1) {
            p.removeMediaItem(p.mediaItemCount - 1)
        }
        while (p.mediaItemCount > 1 && p.currentMediaItemIndex > 0) {
            p.removeMediaItem(0)
        }
        PlaybackService.Holder.queue = listOf(current)
        userQueueEnd = 1
        syncFrom(p)
        queueTitle = "File d'attente"
        _state.value = _state.value.copy(queueTitle = "File d'attente")
    }

    fun moveInQueue(from: Int, to: Int) {
        val p = player() ?: return
        val queue = PlaybackService.Holder.queue.toMutableList()
        if (from !in queue.indices || to !in queue.indices || from == to) return
        val item = queue.removeAt(from)
        queue.add(to, item)
        if (from < userQueueEnd) userQueueEnd -= 1
        if (to < userQueueEnd) userQueueEnd += 1
        userQueueEnd = userQueueEnd.coerceIn(0, queue.size)
        PlaybackService.Holder.queue = queue
        p.moveMediaItem(from, to)
        syncFrom(p)
    }

    fun toggleShuffle() {
        val turningOn = !shuffleEnabled
        shuffleEnabled = turningOn
        val c = player()
        if (c != null && turningOn) {
            val idx = c.currentMediaItemIndex.coerceAtLeast(0)
            val queue = PlaybackService.Holder.queue.toMutableList()
            if (idx < queue.lastIndex) {
                val head = queue.take(idx + 1)
                val rest = queue.drop(idx + 1)
                shuffleNatural = rest.toMutableList()
                val shuffled = rest.shuffled()
                val newQ = head + shuffled
                PlaybackService.Holder.queue = newQ
                while (c.mediaItemCount > idx + 1) c.removeMediaItem(idx + 1)
                shuffled.forEach { c.addMediaItem(mediaItem(it)) }
            } else {
                shuffleNatural = mutableListOf()
            }
            // Ordre géré manuellement — pas le shuffle ExoPlayer
            c.shuffleModeEnabled = false
            syncFrom(c)
            _state.value = _state.value.copy(shuffle = true)
        } else if (c != null && !turningOn) {
            val idx = c.currentMediaItemIndex.coerceAtLeast(0)
            val queue = PlaybackService.Holder.queue.toMutableList()
            val head = queue.take(idx + 1)
            val rest = queue.drop(idx + 1)
            val natural = shuffleNatural
            val restored = if (natural != null) {
                val byId = rest.associateBy { it.id }
                val restIds = rest.map { it.id }.toMutableSet()
                val out = mutableListOf<TrackDto>()
                for (t in natural) {
                    if (t.id in restIds) {
                        byId[t.id]?.let { out.add(it) }
                        restIds.remove(t.id)
                    }
                }
                for (t in rest) if (t.id in restIds) out.add(t)
                out
            } else {
                rest
            }
            shuffleNatural = null
            val newQ = head + restored
            PlaybackService.Holder.queue = newQ
            while (c.mediaItemCount > idx + 1) c.removeMediaItem(idx + 1)
            restored.forEach { c.addMediaItem(mediaItem(it)) }
            c.shuffleModeEnabled = false
            syncFrom(c)
            _state.value = _state.value.copy(shuffle = false)
        } else {
            shuffleNatural = null
            c?.let {
                it.shuffleModeEnabled = false
                syncFrom(it)
            }
            _state.value = _state.value.copy(shuffle = false)
        }
    }

    fun cycleRepeat() {
        repeatMode = when (repeatMode) {
            RepeatMode.One -> RepeatMode.All
            RepeatMode.All -> RepeatMode.Off
            RepeatMode.Off -> RepeatMode.One
        }
        player()?.let {
            applyRepeatShuffle(it)
            syncFrom(it)
        } ?: run {
            _state.value = _state.value.copy(repeat = repeatMode)
        }
    }

    private var playbackSpeed: Float = 1f

    companion object {
        /** Vitesses proposées dans le menu lecteur (×0.75 … ×1.50 + extrêmes). */
        val PLAYBACK_SPEEDS = floatArrayOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f)
    }

    /** Cycle rapide : 1 → 0.75 → 1.25 → 1.5 → 1 */
    fun cyclePlaybackSpeed() {
        val steps = floatArrayOf(1f, 0.75f, 1.25f, 1.5f)
        val idx = steps.indexOfFirst { kotlin.math.abs(it - playbackSpeed) < 0.01f }
        setPlaybackSpeed(steps[(idx + 1).coerceAtLeast(0) % steps.size])
    }

    fun setPlaybackSpeed(speed: Float) {
        playbackSpeed = speed.coerceIn(0.5f, 2f)
        player()?.let { p ->
            runCatching { p.setPlaybackSpeed(playbackSpeed) }
            syncFrom(p)
        } ?: run {
            _state.value = _state.value.copy(playbackSpeed = playbackSpeed)
        }
    }

    private var lastRollingMaintainAt = 0L

    fun tickPrefetch() {
        val p = player() ?: return
        if (!p.isPlaying && p.playbackState != Player.STATE_READY) return
        val now = System.currentTimeMillis()
        if (now - lastRollingMaintainAt < 12_000L) return
        lastRollingMaintainAt = now
        val queue = PlaybackService.Holder.queue
        if (queue.isEmpty()) return
        val idx = p.currentMediaItemIndex.coerceIn(0, queue.lastIndex)
        val base = streamUrl("_").substringBefore("/api/stream/")
        val ids = queue.map { it.id }
        StreamPrefetcher.maintainRollingPrefetch(base, ids, idx, window = 4)
        if (
            !StreamPrefetcher.isStreamDown() &&
            !ovh.delhomme.ytmusic.data.BatterySaver.isActive()
        ) {
            runCatching {
                YtMusicApp.instance.container.downloadManager.enqueueAheadDuringPlayback(
                    queue.drop(idx + 1),
                    limit = 1,
                )
            }
        }
    }

    fun tick() {
        val p = player() ?: return
        if (pauseAtEndOfTrack) {
            val dur = p.duration
            val pos = p.currentPosition
            if (dur > 0 && pos >= dur - 900) {
                p.pause()
                clearSleepTimer()
            }
        } else if (pauseAtEndOfQueue) {
            val dur = p.duration
            val pos = p.currentPosition
            val last = p.currentMediaItemIndex >= p.mediaItemCount - 1
            if (last && dur > 0 && pos >= dur - 900) {
                p.pause()
                clearSleepTimer()
            }
        }
        maybeSkipTrailingSilence(p)
        tickPrefetch()
        syncFrom(p)
    }

    /**
     * Mode titre : coupe uniquement une vraie fin vide près de la fin du flux.
     * Ne coupe PAS sur durée méta seule (souvent trop courte vs stream) ni
     * sur lyrics-end s’il reste beaucoup d’audio.
     */
    private fun maybeSkipTrailingSilence(p: Player) {
        if (SessionMediaMode.video) return
        if (!p.isPlaying) return
        if (p.playbackState != Player.STATE_READY) return
        if (StreamPrefetcher.isStreamDown()) return

        val dur = p.duration
        val pos = p.currentPosition
        if (dur <= 0L || dur == androidx.media3.common.C.TIME_UNSET || pos < 0L) return
        if (dur < 45_000L) return
        // Jamais pendant les 92 % premiers — évite couper l’outro (ex. Papaoutai)
        if (pos.toDouble() / dur < 0.92) return
        val remaining = dur - pos
        // Il doit rester très peu d’audio audible
        if (remaining > 2_500L || remaining < 400L) return

        val trackId = p.currentMediaItem?.mediaId ?: return
        if (silenceSkipTrackId == trackId) return

        val track = PlaybackService.Holder.queue.firstOrNull { it.id == trackId }
        val metaMs = track?.durationMsOrNull()?.takeIf { it >= 45_000L }
        // Meta YTM souvent trop courte : ne couper que si le flux dépasse clairement + padding réel
        val paddedEnd =
            metaMs != null &&
                dur >= metaMs + 12_000L &&
                pos >= metaMs + 6_000L &&
                remaining <= 2_000L &&
                pos.toDouble() / dur >= 0.96

        if (!paddedEnd) return

        silenceSkipTrackId = trackId
        AppLog.i(
            "PlayerController",
            "skip fin vide id=$trackId pos=$pos dur=$dur meta=$metaMs padded=$paddedEnd",
        )
        skipNext()
    }

    private fun prefetchLyricsEnd(trackId: String) {
        if (lyricsFetchTrackId == trackId) return
        lyricsFetchTrackId = trackId
        scope.launch(Dispatchers.IO) {
            val endMs = runCatching {
                val r = YtMusicApp.instance.container.api.lyrics(trackId)
                val timed = r.timed.orEmpty()
                if (timed.isNotEmpty()) timed.maxOf { it.startMsLong() } else -1L
            }.getOrDefault(-1L)
            if (silenceActiveTrackId == trackId) {
                lastLyricEndMs = endMs
            }
        }
    }

    fun clearSleepTimer() {
        sleepRunnable?.let { sleepHandler.removeCallbacks(it) }
        sleepRunnable = null
        pauseAtEndOfTrack = false
        pauseAtEndOfQueue = false
        sleepLabel = null
        player()?.let { syncFrom(it) } ?: run {
            _state.value = _state.value.copy(sleepLabel = null)
        }
    }

    /**
     * @param delayMs null = fin de chanson ; -2 = fin de file ; sinon délai en ms.
     */
    fun setSleepTimer(delayMs: Long?, label: String) {
        clearSleepTimer()
        sleepLabel = label
        when {
            delayMs == null -> {
                pauseAtEndOfTrack = true
                player()?.let { syncFrom(it) } ?: run {
                    _state.value = _state.value.copy(sleepLabel = label)
                }
            }
            delayMs == -2L -> {
                pauseAtEndOfQueue = true
                player()?.let { syncFrom(it) } ?: run {
                    _state.value = _state.value.copy(sleepLabel = label)
                }
            }
            else -> {
                val r = Runnable {
                    player()?.pause()
                    clearSleepTimer()
                }
                sleepRunnable = r
                sleepHandler.postDelayed(r, delayMs)
                player()?.let { syncFrom(it) } ?: run {
                    _state.value = _state.value.copy(sleepLabel = label)
                }
            }
        }
    }

    fun playNext(track: TrackDto) {
        if (!track.isPlayable()) return
        val c = player() ?: run {
            play(listOf(track), 0)
            return
        }
        val queue = PlaybackService.Holder.queue.toMutableList()
        val idx = c.currentMediaItemIndex.coerceAtLeast(0)
        val insertAt = (idx + 1).coerceAtMost(queue.size)
        queue.add(insertAt, track)
        PlaybackService.Holder.queue = queue
        if (insertAt < userQueueEnd) userQueueEnd += 1
        else userQueueEnd = insertAt + 1
        c.addMediaItem(insertAt, mediaItem(track))
        StreamPrefetcher.warmTrack(streamUrl("_").substringBefore("/api/stream/"), track.id)
        syncFrom(c)
    }

    /** Insère plusieurs titres juste après le courant (ordre conservé). */
    fun playNextMany(tracks: List<TrackDto>) {
        tracks.filter { it.isPlayable() }.asReversed().forEach { playNext(it) }
    }

    fun addToQueue(track: TrackDto) {
        if (!track.isPlayable()) return
        val c = player() ?: run {
            play(listOf(track), 0)
            return
        }
        val queue = PlaybackService.Holder.queue.toMutableList()
        val end = userQueueEnd.coerceIn(0, queue.size).coerceAtLeast(
            (c.currentMediaItemIndex + 1).coerceAtMost(queue.size),
        )
        queue.add(end, track)
        userQueueEnd = end + 1
        PlaybackService.Holder.queue = queue
        c.addMediaItem(end, mediaItem(track))
        StreamPrefetcher.warmTrack(streamUrl("_").substringBefore("/api/stream/"), track.id)
        syncFrom(c)
    }

    fun addManyToQueue(tracks: List<TrackDto>) {
        tracks.filter { it.isPlayable() }.forEach { addToQueue(it) }
    }

    /**
     * Ajoute (ou remplace) la suite après le titre courant sans le relancer.
     * Cap par défaut pour ne pas saturer (mix / radio).
     */
    fun enqueueAfterCurrent(
        tracks: List<TrackDto>,
        replaceRest: Boolean = true,
        cap: Int = MixCacheStore.MIX_TARGET,
        title: String? = null,
        sourceId: String? = null,
        sourceKind: String? = null,
    ) {
        val extras = tracks.filter { it.isPlayable() }.distinctBy { it.id }.take(cap)
        if (extras.isEmpty()) return
        val c = player()
        if (c == null || PlaybackService.Holder.queue.isEmpty()) {
            play(extras, 0, title = title, sourceId = sourceId, sourceKind = sourceKind)
            return
        }
        if (title != null) setQueueTitle(title)
        if (sourceId != null) this.sourceId = sourceId
        if (sourceKind != null) this.sourceKind = sourceKind
        val idx = c.currentMediaItemIndex.coerceAtLeast(0)
        val queue = PlaybackService.Holder.queue.toMutableList()
        val currentId = queue.getOrNull(idx)?.id
        val filtered = extras.filter { it.id != currentId }
        val head = queue.take(idx + 1)
        val kept = if (replaceRest) {
            emptyList()
        } else {
            queue.drop(idx + 1).filter { t -> filtered.none { it.id == t.id } }
        }
        val newQ = (head + filtered + kept).take(idx + 1 + MixCacheStore.MIX_TARGET)
        while (c.mediaItemCount > idx + 1) {
            c.removeMediaItem(idx + 1)
        }
        filtered.take((newQ.size - head.size).coerceAtLeast(0)).forEach { c.addMediaItem(mediaItem(it)) }
        PlaybackService.Holder.queue = newQ
        // Mix soft : la portion insérée compte comme file user ; le « kept » reste auto
        userQueueEnd = if (replaceRest) {
            newQ.size
        } else {
            (idx + 1 + filtered.size).coerceAtMost(newQ.size)
        }
        warmAround(newQ, idx)
        syncFrom(c)
    }

    /**
     * Radio / Mix : hard-start — remplace toute la file, part du seed, abandonne les déjà joués.
     */
    fun playRadioOrEnqueue(
        mix: List<TrackDto>,
        title: String,
        sourceKind: String = "mix",
        sourceId: String? = null,
    ) {
        val playable = mix.filter { it.isPlayable() }.distinctBy { it.id }.take(MixCacheStore.MIX_TARGET)
        if (playable.isEmpty()) return
        val seed = playable.first()
        val displayTitle =
            if (sourceKind == "radio" || title.equals("Mix", ignoreCase = true)) {
                "Mix à partir de « ${seed.title} »"
            } else {
                title
            }
        shuffleEnabled = false
        shuffleNatural = null
        play(
            playable,
            0,
            title = displayTitle,
            userQueueEnd = playable.size,
            sourceId = sourceId ?: if (sourceKind == "radio") seed.id else null,
            sourceKind = sourceKind,
        )
        setAutoplaySuggestions(playable.size < 12)
    }

    /** Ajoute des titres après la file sans remplacer le courant (top-up radio progressif). */
    fun appendRadioContinuation(tracks: List<TrackDto>, forSeedId: String? = null) {
        if (tracks.isEmpty()) return
        appendAutoTracks(tracks, forSeedId = forSeedId)
    }

    private fun mediaItem(t: TrackDto): MediaItem =
        mediaItemFor(t, streamUrl, queueTitle)

    private fun playNow(
        player: Player,
        tracks: List<TrackDto>,
        startIndex: Int,
        autoplay: Boolean = true,
        startPositionMs: Long = 0L,
    ) {
        val playable = tracks.filter { it.isPlayable() }
        if (playable.isEmpty()) return
        // Fenêtre autour de l’index : évite OOM / TransactionTooLarge sur grosses bibliothèques
        val maxItems = 80
        val centered = if (playable.size > maxItems) {
            val half = maxItems / 2
            val raw = startIndex.coerceIn(0, playable.lastIndex)
            val from = (raw - half).coerceAtLeast(0)
            val to = (from + maxItems).coerceAtMost(playable.size)
            val slice = playable.subList(from, to)
            val localIdx = (raw - from).coerceIn(0, slice.lastIndex)
            slice to localIdx
        } else {
            playable to startIndex.coerceIn(0, playable.lastIndex)
        }
        val window = centered.first
        val idx = centered.second
        PlaybackService.Holder.queue = window
        PlaybackService.Holder.index = idx
        PlaybackService.Holder.queueTitle = queueTitle
        if (userQueueEnd <= 0 || userQueueEnd > window.size) {
            userQueueEnd = window.size
        }
        val base = streamUrl("_").substringBefore("/api/stream/")
        val currentId = window.getOrNull(idx)?.id
        // Exo démarre tout de suite. Quiet court puis têtes des suivants.
        StreamPrefetcher.quietPrefetch(320L)
        if (!currentId.isNullOrBlank()) {
            StreamPrefetcher.warmTrackFormatOnly(base, currentId)
        }
        if (autoplay) {
            val ahead = window.drop(idx + 1).take(4)
            val startId = currentId
            scope.launch {
                delay(350)
                if (player()?.currentMediaItem?.mediaId != startId) return@launch
                warmAround(window, idx)
                StreamPrefetcher.maintainRollingPrefetch(base, window.map { it.id }, idx, window = 4)
                if (!ovh.delhomme.ytmusic.data.BatterySaver.isActive()) {
                    runCatching {
                        YtMusicApp.instance.container.downloadManager.enqueueAheadDuringPlayback(
                            window.drop(idx + 1),
                            limit = 1,
                        )
                    }
                }
            }
        }
        // Ne jamais toucher au volume STREAM_MUSIC système : garder celui déjà réglé.
        player.volume = PLAYBACK_VOLUME
        val playingSame =
            autoplay &&
                player.isPlaying &&
                player.currentMediaItem?.mediaId == currentId &&
                !currentId.isNullOrBlank()
        val pos = if (playingSame) player.currentPosition.coerceAtLeast(0L) else startPositionMs.coerceAtLeast(0L)
        player.setMediaItems(
            window.map { mediaItem(it) },
            idx,
            pos,
        )
        applyRepeatShuffle(player)
        // Toujours prepare : le bouton play après restore/sync doit répondre sans rebuild complet.
        player.prepare()
        if (autoplay) {
            player.play()
        } else {
            player.pause()
        }
        AppLog.i("player", "playNow id=$currentId idx=$idx n=${window.size} pos=$pos auto=$autoplay")
        syncFrom(player)
        ensureAutoplayAhead()
    }

    fun prefetchQueueFocus(centerIndex: Int, radius: Int = 3) {
        val queue = PlaybackService.Holder.queue
        if (queue.isEmpty()) return
        val base = streamUrl("_").substringBefore("/api/stream/")
        StreamPrefetcher.prefetchAroundIndex(base, queue.map { it.id }, centerIndex, radius)
        StreamPrefetcher.prefetchUpcomingHeadsTiered(
            base,
            queue.map { it.id },
            centerIndex,
            count = 12,
            ignoreQuiet = true,
        )
    }

    private fun warmAround(tracks: List<TrackDto>, startIndex: Int) {
        val playable = tracks.filter { it.isPlayable() }
        if (playable.isEmpty()) return
        val idx = startIndex.coerceIn(0, playable.lastIndex)
        val base = streamUrl("_").substringBefore("/api/stream/")
        StreamPrefetcher.warmAround(
            base,
            playable.map { it.id },
            idx,
            ahead = 12,
            behind = 1,
        )
        CoverPrefetcher.warmCovers(playable, idx, ahead = 6, behind = 1)
    }

    private fun applyRepeatShuffle(player: Player) {
        player.shuffleModeEnabled = shuffleEnabled
        player.repeatMode = when (repeatMode) {
            RepeatMode.Off -> Player.REPEAT_MODE_OFF
            RepeatMode.All -> Player.REPEAT_MODE_ALL
            RepeatMode.One -> Player.REPEAT_MODE_ONE
        }
    }

    private fun player(): Player? = controller ?: PlaybackService.Holder.player

    /** ON par défaut ; réactive si OFF sans choix explicite (ex. ancien clearUpcoming). */
    private fun loadAutoplaySuggestionsPref(): Boolean {
        val explicit = playerPrefs.getBoolean("autoplay_suggestions_explicit", false)
        val stored = playerPrefs.getBoolean("autoplay_suggestions", true)
        if (!explicit && !stored) {
            playerPrefs.edit().putBoolean("autoplay_suggestions", true).apply()
            return true
        }
        return stored
    }

    /**
     * Démarre le service en arrière-plan (pas FGS).
     *
     * Important : `startForegroundService()` impose un `startForeground()` sous ~5s.
     * Media3 ne le fait qu’une fois la lecture démarrée → ANR/crash à l’ouverture
     * de l’app si on force le FGS trop tôt. Le passage foreground est géré par
     * MediaSessionService via la notification média quand `play()` démarre.
     */
    private fun ensureService() {
        runCatching {
            context.startService(Intent(context, PlaybackService::class.java))
        }
    }

    private var lastPersistAt = 0L

    private fun persistLocalSnapshot(durable: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!durable && now - lastPersistAt < 1_200L) return
        lastPersistAt = now
        val ui = _state.value
        val queue = ui.queue.ifEmpty { PlaybackService.Holder.queue }
        if (queue.isEmpty()) return
        val p = player() ?: PlaybackService.Holder.player
        val pos = p?.currentPosition?.coerceAtLeast(0L) ?: ui.positionMs
        val playing = p?.let { it.isPlaying || it.playWhenReady } ?: ui.playing
        onPersistLocal?.invoke(
            LocalPlaybackSnapshot(
                queue = queue,
                queueIndex = ui.queueIndex,
                positionMs = pos,
                userQueueEnd = ui.userQueueEnd,
                queueTitle = ui.queueTitle,
                wasPlaying = playing,
                durable = durable,
            ),
        )
    }

    private var lastCoverPrefetchId: String? = null

    /** Branché depuis MainActivity → SharedPreferences (survit force-stop). */
    var onPersistLocal: ((LocalPlaybackSnapshot) -> Unit)? = null

    fun flushPersist() {
        lastPersistAt = 0L
        persistLocalSnapshot(durable = true)
    }

    private fun syncFrom(player: Player) {
        var queue = PlaybackService.Holder.queue
        val idx = player.currentMediaItemIndex.coerceAtLeast(0)
        val exoDur = player.duration.takeIf { it > 0L && it != androidx.media3.common.C.TIME_UNSET }
        if (exoDur != null && idx in queue.indices) {
            val cur = queue[idx]
            if (cur.durationMsOrNull() == null) {
                val patched = queue.toMutableList()
                patched[idx] = cur.withKnownDurationMs(exoDur)
                queue = patched
                PlaybackService.Holder.queue = patched
            }
        }
        val track = queue.getOrNull(idx)
            ?: queue.getOrNull(PlaybackService.Holder.index)
        shuffleEnabled = player.shuffleModeEnabled
        repeatMode = when (player.repeatMode) {
            Player.REPEAT_MODE_ONE -> RepeatMode.One
            Player.REPEAT_MODE_ALL -> RepeatMode.All
            else -> RepeatMode.Off
        }
        val busy = _state.value.autoFillBusy
        _state.value = PlayerUiState(
            track = track,
            playing = player.isPlaying,
            positionMs = player.currentPosition.coerceAtLeast(0),
            durationMs = player.duration.coerceAtLeast(0),
            bufferedMs = player.bufferedPosition.coerceAtLeast(0),
            queueSize = queue.size,
            queueIndex = idx.coerceIn(0, (queue.size - 1).coerceAtLeast(0)),
            queue = queue,
            sleepLabel = sleepLabel,
            shuffle = shuffleEnabled,
            repeat = repeatMode,
            playbackSpeed = playbackSpeed,
            queueTitle = queueTitle,
            userQueueEnd = userQueueEnd.coerceIn(0, queue.size),
            autoplaySuggestions = autoplaySuggestions,
            autoFillBusy = busy,
            sourceId = sourceId,
            sourceKind = sourceKind,
        )
        if (idx in queue.indices) PlaybackService.Holder.index = idx
        PlaybackService.Holder.userQueueEnd = userQueueEnd.coerceIn(0, queue.size)
        PlaybackService.Holder.autoplaySuggestions = autoplaySuggestions
        track?.id?.takeIf { it != lastCoverPrefetchId }?.let { id ->
            lastCoverPrefetchId = id
            CoverPrefetcher.warmCovers(queue, idx.coerceIn(0, (queue.size - 1).coerceAtLeast(0)), ahead = 2, behind = 0)
        }
        persistLocalSnapshot()
    }
}

data class LocalPlaybackSnapshot(
    val queue: List<TrackDto>,
    val queueIndex: Int,
    val positionMs: Long,
    val userQueueEnd: Int,
    val queueTitle: String,
    val wasPlaying: Boolean,
    val durable: Boolean = false,
)
