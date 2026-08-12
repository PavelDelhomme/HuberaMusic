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
    private var autoplaySuggestions: Boolean =
        playerPrefs.getBoolean("autoplay_suggestions", true)

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
        }
    }

    fun connect() {
        ensureService()
        PlaybackService.Holder.onSkipAtEnd = { fillThenSkipFromEnd() }
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
                }
            }
        }, MoreExecutors.directExecutor())
    }

    fun release() {
        clearSleepTimer()
        fillJob?.cancel()
        if (PlaybackService.Holder.onSkipAtEnd != null) {
            // ne détache que si c’est encore notre callback (évite course)
            PlaybackService.Holder.onSkipAtEnd = null
        }
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
        if (title != null) queueTitle = title
        PlaybackService.Holder.queueTitle = queueTitle
        this.sourceId = sourceId
            ?: tracks.getOrNull(startIndex)?.album?.id
            ?: tracks.firstOrNull()?.album?.id
        this.sourceKind = sourceKind
            ?: if (this.sourceId != null) "album" else null
        ensureService()
        connect()
        warmAround(tracks, startIndex)
        val playable = tracks.filter { it.isPlayable() }
        this.userQueueEnd = (userQueueEnd ?: playable.size).coerceIn(0, playable.size)
        userWantsPlaying = true
        pendingAutoplay = true
        val c = controller
        if (c != null) {
            playNow(c, tracks, startIndex)
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
        }
    }

    fun toggleAutoplaySuggestions() {
        setAutoplaySuggestions(!autoplaySuggestions)
    }

    fun setAutoplaySuggestions(on: Boolean) {
        autoplaySuggestions = on
        playerPrefs.edit().putBoolean("autoplay_suggestions", on).apply()
        if (!on) {
            val queue = PlaybackService.Holder.queue
            val end = userQueueEnd.coerceIn(0, queue.size).coerceAtLeast(
                (_state.value.queueIndex + 1).coerceAtMost(queue.size),
            )
            val trimmed = queue.take(end)
            userQueueEnd = trimmed.size
            PlaybackService.Holder.queue = trimmed
            val c = player()
            if (c != null && c.mediaItemCount > end) {
                c.removeMediaItems(end, c.mediaItemCount)
                syncFrom(c)
            } else {
                _state.value = _state.value.copy(
                    queue = trimmed,
                    queueSize = trimmed.size,
                    userQueueEnd = userQueueEnd,
                    autoplaySuggestions = false,
                )
            }
            _state.value = _state.value.copy(autoplaySuggestions = false)
            return
        }
        _state.value = _state.value.copy(autoplaySuggestions = true)
    }

    /** Ajoute des suggestions après la file utilisateur (zone auto). */
    fun appendAutoTracks(tracks: List<TrackDto>, forSeedId: String? = null) {
        if (!autoplaySuggestions) return
        if (forSeedId != null && _state.value.track?.id != forSeedId) return
        val remainingUser = (userQueueEnd - _state.value.queueIndex - 1).coerceAtLeast(0)
        if (isPrecomputedMixSource(sourceKind, remainingUser)) return
        val extra = tracks.filter { it.isPlayable() }
        if (extra.isEmpty()) return
        val c = player() ?: return
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
        toAdd.forEach { c.addMediaItem(mediaItem(it)) }
        warmAround(queue, c.currentMediaItemIndex.coerceAtLeast(0))
        syncFrom(c)
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
        val p = player() ?: run {
            val exo = PlaybackService.Holder.player ?: return
            if (exo.isPlaying) {
                userWantsPlaying = false
                pendingAutoplay = false
                exo.pause()
                StreamPrefetcher.cancelIdle()
            } else {
                userWantsPlaying = true
                pendingAutoplay = true
                exo.play()
            }
            syncFrom(exo)
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
            p.play()
        }
        syncFrom(p)
    }

    fun pause() {
        userWantsPlaying = false
        pendingAutoplay = false
        connect()
        player()?.pause() ?: PlaybackService.Holder.player?.pause()
        StreamPrefetcher.cancelIdle()
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
        player()?.play() ?: PlaybackService.Holder.player?.play()
    }

    fun skipNext() {
        connect()
        val p = player() ?: PlaybackService.Holder.player ?: return
        val nextIdx = when {
            p.hasNextMediaItem() -> p.currentMediaItemIndex + 1
            repeatMode == RepeatMode.All && p.mediaItemCount > 0 -> 0
            p.mediaItemCount > 1 -> (p.currentMediaItemIndex + 1) % p.mediaItemCount
            else -> p.currentMediaItemIndex
        }
        warmAround(PlaybackService.Holder.queue, nextIdx)
        // REPEAT_MODE_ONE bloque le next ExoPlayer : on le désactive le temps du saut
        val wasOne = repeatMode == RepeatMode.One
        if (wasOne) p.repeatMode = Player.REPEAT_MODE_OFF
        when {
            p.hasNextMediaItem() -> {
                p.seekToNextMediaItem()
                p.play()
            }
            repeatMode == RepeatMode.All && p.mediaItemCount > 0 -> {
                p.seekTo(0, 0L)
                p.play()
            }
            p.mediaItemCount > 1 -> {
                p.seekTo(nextIdx, 0L)
                p.play()
            }
            else -> {
                // Un seul titre : fill « À suivre » puis skip (ne pas relancer le même)
                fillThenSkipFromEnd()
            }
        }
        if (wasOne) {
            p.repeatMode = Player.REPEAT_MODE_ONE
            repeatMode = RepeatMode.One
        }
        syncFrom(p)
    }

    /** Appelé quand il n’y a plus de suivant (UI ou notif système). */
    private fun fillThenSkipFromEnd() {
        if (pauseAtEndOfQueue || pauseAtEndOfTrack) {
            player()?.pause()
            clearSleepTimer()
            Toast.makeText(context, "Mise en veille", Toast.LENGTH_SHORT).show()
            return
        }
        if (!autoplaySuggestions) {
            Toast.makeText(context, "Fin de la file", Toast.LENGTH_SHORT).show()
            return
        }
        if (fillJob?.isActive == true) {
            Toast.makeText(context, "Suggestions en cours…", Toast.LENGTH_SHORT).show()
            return
        }
        val seed = _state.value.track?.id
            ?: PlaybackService.Holder.queue.getOrNull(
                (player() ?: PlaybackService.Holder.player)?.currentMediaItemIndex ?: 0,
            )?.id
        if (seed.isNullOrBlank()) return
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
        val p = player() ?: PlaybackService.Holder.player ?: return
        if (p.currentPosition > 3000L) {
            p.seekTo(0L)
            syncFrom(p)
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
                val prev = if (p.currentMediaItemIndex > 0) p.currentMediaItemIndex - 1 else p.mediaItemCount - 1
                p.seekTo(prev, 0L)
                p.play()
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
        val p = player() ?: PlaybackService.Holder.player ?: return
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
        player()?.seekTo(target) ?: PlaybackService.Holder.player?.seekTo(target)
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
        ensureService()
        connect()
        val c = controller ?: PlaybackService.Holder.player
        if (c != null) {
            val auto = autoplay || userWantsPlaying == true
            playNow(c, tracks, startIndex, autoplay = auto, startPositionMs = positionMs)
            if (!auto) c.pause() else c.play()
            syncFrom(c)
        } else {
            pending = tracks to startIndex
            pendingSeekMs = positionMs
            pendingAutoplay = autoplay || userWantsPlaying == true
        }
    }

    fun playAt(index: Int) {
        val p = player() ?: return
        val queue = PlaybackService.Holder.queue
        if (index !in queue.indices) return
        // Titre auto (« À suivre ») → passe dans la file utilisateur
        if (index >= userQueueEnd) {
            userQueueEnd = (index + 1).coerceAtMost(queue.size)
        }
        // Chauffe avant le seek (évite notif vide + long silence sur saut lointain)
        warmAround(queue, index)
        userWantsPlaying = true
        pendingAutoplay = true
        p.seekTo(index, 0L)
        p.prepare()
        p.play()
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
        // Coupe l’autoplay d’abord pour éviter un re-remplissage immédiat
        if (autoplaySuggestions) setAutoplaySuggestions(false)
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
            RepeatMode.Off -> RepeatMode.All
            RepeatMode.All -> RepeatMode.One
            RepeatMode.One -> RepeatMode.Off
        }
        player()?.let {
            applyRepeatShuffle(it)
            syncFrom(it)
        } ?: run {
            _state.value = _state.value.copy(repeat = repeatMode)
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
        syncFrom(p)
    }

    /**
     * Mode titre : coupe les fins « vides » sans casser le pipeline audio.
     * - Si la durée YTM (métadonnées) est nettement plus courte que le flux → skip après meta+grâce
     * - Sinon fallback paroles timed (dernière lyric + grâce)
     * Mode vidéo : ne coupe pas.
     */
    private fun maybeSkipTrailingSilence(p: Player) {
        if (SessionMediaMode.video) return
        if (!p.isPlaying) return
        if (p.playbackState != Player.STATE_READY) return
        if (StreamPrefetcher.isStreamDown()) return

        val dur = p.duration
        val pos = p.currentPosition
        if (dur <= 0L || dur == androidx.media3.common.C.TIME_UNSET || pos < 0L) return
        if (dur < 40_000L) return
        // Jamais pendant les 40 % premiers
        if (pos.toDouble() / dur < 0.40) return
        if (dur - pos < 800L) return

        val trackId = p.currentMediaItem?.mediaId ?: return
        if (silenceSkipTrackId == trackId) return
        if (silenceActiveTrackId != trackId) {
            silenceActiveTrackId = trackId
            lastLyricEndMs = -1L
            prefetchLyricsEnd(trackId)
        }

        val track = PlaybackService.Holder.queue.firstOrNull { it.id == trackId }
        val metaMs = track?.durationMsOrNull()?.takeIf { it >= 40_000L }
        // Flux souvent plus long que la durée YTM (silence / outro vidéo)
        val paddedEnd =
            metaMs != null &&
                dur >= metaMs + 3_500L &&
                pos >= metaMs + 1_200L

        val lyricsEnd =
            lastLyricEndMs > 0L &&
                lastLyricEndMs.toDouble() / dur >= 0.45 &&
                pos >= lastLyricEndMs + 2_200L &&
                dur - pos >= 1_500L

        if (!paddedEnd && !lyricsEnd) return

        silenceSkipTrackId = trackId
        AppLog.i(
            "PlayerController",
            "skip fin vide id=$trackId pos=$pos dur=$dur meta=$metaMs lyricEnd=$lastLyricEndMs padded=$paddedEnd lyrics=$lyricsEnd",
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
        val maxItems = 250
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
        if (!currentId.isNullOrBlank()) {
            // Court blocage (~450ms max) : chauffe le format API avant Exo prepare
            StreamPrefetcher.warmCurrentBlocking(base, currentId, timeoutMs = 450L)
        }
        warmAround(window, idx) // format + CacheWriter suite (async)
        // Persist 2 titres suivants sur disque (coupure réseau / mix)
        runCatching {
            val ahead = window.drop(idx + 1).take(3)
            YtMusicApp.instance.container.downloadManager.enqueueAhead(ahead, limit = 2)
        }
        ensureAudibleMediaVolume(YtMusicApp.instance)
        player.volume = 1f
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
        player.prepare()
        if (autoplay) player.play() else player.pause()
        syncFrom(player)
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
            ahead = 4,
            behind = 1,
        )
        CoverPrefetcher.warmCovers(playable, idx, ahead = 3, behind = 1)
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

    private fun persistLocalSnapshot() {
        val now = System.currentTimeMillis()
        if (now - lastPersistAt < 1_200L) return
        lastPersistAt = now
        val ui = _state.value
        val queue = ui.queue.ifEmpty { PlaybackService.Holder.queue }
        if (queue.isEmpty()) return
        onPersistLocal?.invoke(
            LocalPlaybackSnapshot(
                queue = queue,
                queueIndex = ui.queueIndex,
                positionMs = ui.positionMs,
                userQueueEnd = ui.userQueueEnd,
                queueTitle = ui.queueTitle,
                wasPlaying = ui.playing,
            ),
        )
    }

    /** Branché depuis MainActivity → SharedPreferences (survit force-stop). */
    var onPersistLocal: ((LocalPlaybackSnapshot) -> Unit)? = null

    fun flushPersist() {
        lastPersistAt = 0L
        persistLocalSnapshot()
    }

    private fun syncFrom(player: Player) {
        val queue = PlaybackService.Holder.queue
        val idx = player.currentMediaItemIndex.coerceAtLeast(0)
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
            queueTitle = queueTitle,
            userQueueEnd = userQueueEnd.coerceIn(0, queue.size),
            autoplaySuggestions = autoplaySuggestions,
            autoFillBusy = busy,
            sourceId = sourceId,
            sourceKind = sourceKind,
        )
        if (idx in queue.indices) PlaybackService.Holder.index = idx
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
)
