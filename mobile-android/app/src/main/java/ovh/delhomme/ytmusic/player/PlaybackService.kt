package ovh.delhomme.ytmusic.player

import android.widget.Toast
import ovh.delhomme.ytmusic.ui.util.toastMain

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Bundle
import androidx.annotation.OptIn
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSourceBitmapLoader
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.CacheBitmapLoader
import androidx.media3.session.CommandButton
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import ovh.delhomme.ytmusic.BuildConfig
import ovh.delhomme.ytmusic.MainActivity
import ovh.delhomme.ytmusic.R
import ovh.delhomme.ytmusic.YtMusicApp
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.debug.AppLog
import ovh.delhomme.ytmusic.debug.CrashReporter
import java.util.concurrent.atomic.AtomicInteger

/**
 * Lecture arrière-plan + notification média persistante (style YTM) :
 * précédent / play-pause / suivant (toujours actifs), artwork, like, boucle,
 * clic → ouvre le lecteur plein écran (zone média, pas la file).
 */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
    private var player: ExoPlayer? = null
    private var sessionPlayer: Player? = null
    private var session: MediaSession? = null
    private var audioFocus: PlayerAudioFocus? = null
    private val scope = CoroutineScope(
        SupervisorJob() + Dispatchers.Main.immediate + CrashReporter.coroutineHandler("PlaybackService"),
    )

    private val cmdLike = SessionCommand(ACTION_TOGGLE_LIKE, Bundle.EMPTY)
    private val cmdCycleRepeat = SessionCommand(ACTION_CYCLE_REPEAT, Bundle.EMPTY)
    private val cmdToggleShuffle = SessionCommand(ACTION_TOGGLE_SHUFFLE, Bundle.EMPTY)
    private val cmdAddPlaylist = SessionCommand(ACTION_ADD_PLAYLIST, Bundle.EMPTY)
    private val cmdOpenLyrics = SessionCommand(ACTION_OPEN_LYRICS, Bundle.EMPTY)

    private val recoverGen = AtomicInteger(0)
    private val streamFailStreak = AtomicInteger(0)
    /** Snapshot pour détecter une fin de piste trop tôt (stream tronqué / cache). */
    @Volatile private var lastPlayingId: String = ""
    @Volatile private var lastPlayingPosMs: Long = 0L
    /** Plus haute position vue sur le titre courant — ne jamais rebobiner après une coupure. */
    @Volatile private var maxPlayingPosMs: Long = 0L
    @Volatile private var lastNearEndWarmMs: Long = 0L
    /** Précharge le titre suivant pendant la lecture (pas seulement 8–22 s avant la fin). */
    @Volatile private var lastMidTrackPrefetchMs: Long = 0L
    @Volatile private var lastStallRecoverToastMs: Long = 0L
    /** Durée Exo du titre courant — le catalogue YTM est souvent trop long (faux early_end). */
    @Volatile private var lastPlayingDurationMs: Long = 0L
    /** Fin de buffer Exo — si pos ≈ buffer et catalogue plus long, ce n’est pas un early_end. */
    @Volatile private var lastPlayingBufferedMs: Long = 0L
    @Volatile private var prevPlayingId: String = ""
    @Volatile private var prevPlayingPosMs: Long = 0L
    @Volatile private var prevPlayingDurationMs: Long = 0L
    @Volatile private var prevPlayingBufferedMs: Long = 0L
    @Volatile private var earlyEndRetries: Int = 0
    /** Titre qu’on est en train de reprendre après une fin trop tôt — ne pas reset le compteur. */
    @Volatile private var recoveringTrackId: String = ""
    @Volatile private var serviceFillInFlight: Boolean = false
    @Volatile private var lastPersistAt: Long = 0L
    /** Avance programmée (EOS / skip) — ne pas déclencher early_end recovery sur le SEEK. */
    @Volatile private var programmaticAdvance: Boolean = false
    private val stallHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private var stallRunnable: Runnable? = null
    @Volatile private var bufferingSinceElapsed: Long = 0L
    @Volatile private var bufferingTrackId: String = ""
    /** Rebinds stall sans sortir de BUFFERING — au-delà → skip (évite silence 30–45 s). */
    @Volatile private var stallRebindCount: Int = 0
    @Volatile private var stallLastPos: Long = -1L
    @Volatile private var stallPosFrozenSince: Long = 0L
    /**
     * Compteur d’épisodes sur LE MÊME titre : survit aux flashes READY après rebind
     * (sinon boucle rebind→READY→stall→rebind sans jamais escalate, Nothing/Blackview).
     */
    @Volatile private var stallSessionTrackId: String = ""
    @Volatile private var stallSessionCount: Int = 0
    @Volatile private var stallSessionAnchorPos: Long = -1L

    private fun cancelStallWatch(resetTrack: Boolean = true) {
        stallRunnable?.let { stallHandler.removeCallbacks(it) }
        stallRunnable = null
        bufferingSinceElapsed = 0L
        if (resetTrack) {
            bufferingTrackId = ""
            stallRebindCount = 0
            stallLastPos = -1L
            stallPosFrozenSince = 0L
        }
    }

    private fun clearStallSession() {
        stallSessionTrackId = ""
        stallSessionCount = 0
        stallSessionAnchorPos = -1L
    }

    private fun streakToastDue(): Boolean {
        val now = android.os.SystemClock.elapsedRealtime()
        return now - lastStallRecoverToastMs > 12_000L
    }

    private fun bufferedPositionSafe(exo: Player): Long =
        runCatching { exo.bufferedPosition }.getOrDefault(0L).coerceAtLeast(0L)

    /** Si BUFFERING sans progrès → rebind + proxy frais ; skip seulement après escalate épuisés. */
    private fun armStallWatch(player: Player) {
        if (!player.playWhenReady || player.playbackState != Player.STATE_BUFFERING) {
            // Pause user → reset total. READY bref après rebind → garder la session.
            if (!player.playWhenReady) {
                cancelStallWatch()
                clearStallSession()
                return
            }
            if (player.isPlaying) {
                val id = player.currentMediaItem?.mediaId.orEmpty()
                val pos = player.currentPosition
                val pastAnchor =
                    stallSessionTrackId == id &&
                        stallSessionAnchorPos >= 0L &&
                        pos > stallSessionAnchorPos + 15_000L
                if (pastAnchor || id != stallSessionTrackId) {
                    cancelStallWatch()
                    if (id != stallSessionTrackId) clearStallSession()
                    else if (pastAnchor) clearStallSession()
                } else {
                    // Flash READY sans progrès réel — ne pas reset le compteur d’épisodes.
                    stallRunnable?.let { stallHandler.removeCallbacks(it) }
                    stallRunnable = null
                    bufferingSinceElapsed = 0L
                }
            } else {
                stallRunnable?.let { stallHandler.removeCallbacks(it) }
                stallRunnable = null
            }
            return
        }
        val id = player.currentMediaItem?.mediaId.orEmpty()
        if (id.isBlank()) return
        if (id != bufferingTrackId) {
            bufferingTrackId = id
            bufferingSinceElapsed = android.os.SystemClock.elapsedRealtime()
            stallRebindCount = 0
            stallLastPos = player.currentPosition
            stallPosFrozenSince = android.os.SystemClock.elapsedRealtime()
            if (id != stallSessionTrackId) {
                stallSessionTrackId = id
                stallSessionCount = 0
                stallSessionAnchorPos = -1L
            }
        }
        stallRunnable?.let { stallHandler.removeCallbacks(it) }
        val r = Runnable {
            val exo = this.player ?: return@Runnable
            if (!exo.playWhenReady || exo.playbackState != Player.STATE_BUFFERING) {
                armStallWatch(exo)
                return@Runnable
            }
            val curId = exo.currentMediaItem?.mediaId.orEmpty()
            if (curId != bufferingTrackId) {
                armStallWatch(exo)
                return@Runnable
            }
            val nowElapsed = android.os.SystemClock.elapsedRealtime()
            val waited = nowElapsed - bufferingSinceElapsed
            val pos = exo.currentPosition
            if (pos != stallLastPos) {
                stallLastPos = pos
                stallPosFrozenSince = nowElapsed
            }
            val posFrozenFor = nowElapsed - stallPosFrozenSince
            val progress = exo.bufferedPosition - pos
            // Buffer « en avance » ne compte QUE si la tête de lecture avance aussi.
            // Sinon Exo reste BUFFERING avec un bufferedPosition fantôme → silence 40 s (DOVE).
            if (progress > 800L && posFrozenFor < 4_000L) {
                bufferingSinceElapsed = nowElapsed
                armStallWatch(exo)
                return@Runnable
            }
            // Patience : rebind trop tôt → wipe cache + restart audio (pire que attendre).
            if (waited < 4_500L && posFrozenFor < 4_500L) {
                armStallWatch(exo)
                return@Runnable
            }
            // Cold start (pos≈0) : laisser plus de temps au 1er octet (Blackview / titres GIMS cold).
            // Un titre absent du cache serveur demande une résolution yt-dlp (jusqu’à ~35 s) :
            // rebinder à 11 s relançait la requête sans jamais lui laisser aboutir.
            val headWarmed = StreamPrefetcher.wasHeadReadyRecently(curId, withinMs = 90_000L)
            val coldGraceMs = if (headWarmed) 20_000L else 42_000L
            if (pos <= 1_000L && bufferedPositionSafe(exo) <= 1_024L && waited < coldGraceMs) {
                armStallWatch(exo)
                return@Runnable
            }
            // 1er buffer après seek mid-track (restore) : laisser Range aboutir.
            if (
                stallRebindCount == 0 &&
                stallSessionCount <= 1 &&
                progress <= 0L &&
                waited < (if (headWarmed) 12_000L else 10_000L)
            ) {
                armStallWatch(exo)
                return@Runnable
            }
            val local = exo.currentMediaItem?.localConfiguration?.uri?.scheme == "file"
            stallRebindCount += 1
            stallSessionTrackId = curId
            stallSessionCount += 1
            if (stallSessionAnchorPos < 0L || pos > stallSessionAnchorPos) {
                stallSessionAnchorPos = pos
            }
            // Après trop d’épisodes figés au même pos → titre suivant.
            // Ne pas exiger posFrozenFor long : chaque escalate remettait le chrono →
            // episodes=10 sans jamais passer (ex. homura @64584).
            val coldStuck = pos <= 1_000L
            val samePos =
                stallSessionAnchorPos < 0L ||
                    kotlin.math.abs(pos - stallSessionAnchorPos) < 2_500L
            val stuckHard =
                samePos &&
                    (
                        (coldStuck && stallSessionCount >= 3) ||
                            (!coldStuck && stallSessionCount >= 6)
                    )
            if (stuckHard) {
                AppLog.w(
                    "PlaybackService",
                    "stall-buffer give-up → next id=$curId pos=$pos " +
                        "rebinds=$stallRebindCount episodes=$stallSessionCount frozen=${posFrozenFor}ms",
                )
                runCatching {
                    ovh.delhomme.ytmusic.debug.TelemetryReporter.report(
                        level = "error",
                        kind = "android.player.stall",
                        message = "stall give-up → next id=$curId pos=$pos " +
                            "rebinds=$stallRebindCount episodes=$stallSessionCount",
                        meta = mapOf(
                            "trackId" to curId,
                            "positionMs" to pos,
                            "rebinds" to stallRebindCount,
                            "episodes" to stallSessionCount,
                            "action" to "skip_next",
                        ),
                        force = true,
                    )
                }
                cancelStallWatch()
                clearStallSession()
                streamFailStreak.set(0)
                val nextIdx = exo.currentMediaItemIndex + 1
                val end = Holder.userQueueEnd
                android.os.Handler(mainLooper).post {
                    toastMain("Flux bloqué — titre suivant", Toast.LENGTH_SHORT)
                }
                if (!Holder.autoplaySuggestions && end > 0 && nextIdx >= end) {
                    exo.playWhenReady = false
                    runCatching { exo.pause() }
                    return@Runnable
                }
                if (nextIdx < exo.mediaItemCount) {
                    runCatching { advanceToQueueIndex(exo, nextIdx) }
                } else {
                    val uiFill = Holder.onSkipAtEnd
                    if (uiFill != null) uiFill.invoke() else fillAutoplayFromService(advanceAfterFill = true)
                }
                return@Runnable
            }
            // Escalade = URL fraîche + proxy, JAMAIS seek(0) (utilisateur entendait reprise au début).
            val escalate =
                stallRebindCount >= 2 ||
                    stallSessionCount >= 2 ||
                    (waited >= 10_000L && posFrozenFor >= 6_000L)
            if (escalate) {
                // wipeCache après plusieurs escalate (cache / atom MP4 corrompu, code 3003).
                // Cold start : wipe dès le 2ᵉ escalate (tête poison / 502).
                val wipe =
                    stallSessionCount >= 4 ||
                        stallRebindCount >= 5 ||
                        (pos <= 1_000L && stallSessionCount >= 2)
                AppLog.w(
                    "PlaybackService",
                    "stall-buffer escalate-recover ${waited}ms frozen=${posFrozenFor}ms " +
                        "rebinds=$stallRebindCount episodes=$stallSessionCount wipe=$wipe " +
                        "id=$curId pos=$pos",
                )
                runCatching {
                    ovh.delhomme.ytmusic.debug.TelemetryReporter.report(
                        level = "warn",
                        kind = "android.player.stall",
                        message = "stall escalate-recover id=$curId pos=$pos " +
                            "rebinds=$stallRebindCount episodes=$stallSessionCount " +
                            "waited=${waited}ms",
                        meta = mapOf(
                            "trackId" to curId,
                            "positionMs" to pos,
                            "rebinds" to stallRebindCount,
                            "episodes" to stallSessionCount,
                            "waitedMs" to waited,
                            "local" to local,
                            "wipeCache" to wipe,
                        ),
                        force = streakToastDue(),
                    )
                }
                cancelStallWatch(resetTrack = false)
                bufferingTrackId = curId
                bufferingSinceElapsed = android.os.SystemClock.elapsedRealtime()
                stallLastPos = pos
                stallPosFrozenSince = android.os.SystemClock.elapsedRealtime()
                // Libère bande : coupe prefetch / DL pendant recovery.
                StreamPrefetcher.quietPrefetch(8_000L)
                StreamPrefetcher.cancelIdle(preserveNext = false)
                runCatching { YtMusicApp.instance.container.downloadManager.cancelAll() }
                scope.launch {
                    runCatching {
                        YtMusicApp.instance.container.invalidateStreamUrlCache(curId)
                        withTimeout(10_000L) {
                            val r = stallRebindCount.coerceAtLeast(1)
                            YtMusicApp.instance.container.api.streamResolveUrl(
                                curId,
                                retry = r,
                                streamRetry = r.toString(),
                            )
                        }
                    }
                    if (exo.currentMediaItem?.mediaId != curId) return@launch
                    // Toujours reprendre à la position figée — jamais 0.
                    rebindCurrentStream(
                        reason = "stall-escalate",
                        forcePlay = true,
                        seekPos = pos.coerceAtLeast(0L),
                        retryN = stallRebindCount.coerceAtLeast(1),
                        wipeCache = wipe,
                    )
                    android.os.Handler(mainLooper).post {
                        if (streakToastDue()) {
                            lastStallRecoverToastMs = android.os.SystemClock.elapsedRealtime()
                            toastMain("Reprise du flux…", Toast.LENGTH_SHORT)
                        }
                        armStallWatch(exo)
                    }
                }
                return@Runnable
            }
            AppLog.w(
                "PlaybackService",
                "stall-buffer ${waited}ms frozen=${posFrozenFor}ms progress=$progress " +
                    "local=$local rebind=$stallRebindCount episode=$stallSessionCount id=$curId",
            )
            cancelStallWatch(resetTrack = false)
            bufferingTrackId = curId
            bufferingSinceElapsed = android.os.SystemClock.elapsedRealtime()
            stallLastPos = pos
            stallPosFrozenSince = android.os.SystemClock.elapsedRealtime()
            StreamPrefetcher.quietPrefetch(6_000L)
            if (local) {
                val container = runCatching { YtMusicApp.instance.container }.getOrNull()
                scope.launch {
                    runCatching { container?.offlineStore?.remove(curId) }
                    runCatching { container?.invalidateStreamUrlCache(curId) }
                    runCatching { PlayerCache.invalidate(this@PlaybackService, curId) }
                    if (exo.currentMediaItem?.mediaId != curId) return@launch
                    val track = Holder.queue.firstOrNull { it.id == curId } ?: return@launch
                    val remote = container?.remoteStreamUrl(curId) ?: return@launch
                    val rebuilt = mediaItemFor(track, { _ -> remote }, Holder.queueTitle)
                    runCatching {
                        val seekPos = exo.currentPosition.coerceAtLeast(0L)
                        exo.replaceMediaItem(exo.currentMediaItemIndex, rebuilt)
                        exo.seekTo(exo.currentMediaItemIndex, seekPos)
                        exo.prepare()
                        exo.playWhenReady = true
                        exo.play()
                    }
                    android.os.Handler(mainLooper).post { armStallWatch(exo) }
                }
                android.os.Handler(mainLooper).post {
                    toastMain("Fichier local KO — reprise en streaming…", Toast.LENGTH_SHORT)
                }
            } else {
                // Soft rebind : URL fraîche, position conservée, cache Exo gardé.
                rebindCurrentStream(
                    reason = "stall-buffer",
                    forcePlay = true,
                    seekPos = pos.coerceAtLeast(0L),
                    wipeCache = false,
                )
                armStallWatch(exo)
            }
        }
        stallRunnable = r
        stallHandler.postDelayed(r, 1_200L)
    }

    private fun refreshPlaybackActiveFlag(player: Player) {
        // Busy dès qu’une file tourne (play / buffer / pause mid-song) — coupe OfflineKeeper.
        Holder.playbackActive = player.mediaItemCount > 0 && (
            player.isPlaying ||
                player.playWhenReady ||
                player.playbackState == Player.STATE_BUFFERING ||
                player.playbackState == Player.STATE_READY
            )
    }

    private val playerListener = object : Player.Listener {
        override fun onAudioSessionIdChanged(audioSessionId: Int) {
            if (audioSessionId != C.AUDIO_SESSION_ID_UNSET) {
                AudioEqualizer.attach(audioSessionId)
            }
        }

        override fun onEvents(player: Player, events: Player.Events) {
            if (
                events.contains(Player.EVENT_IS_PLAYING_CHANGED) ||
                events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) ||
                events.contains(Player.EVENT_PLAY_WHEN_READY_CHANGED)
            ) {
                refreshPlaybackActiveFlag(player)
            }
            if (player.playbackState == Player.STATE_READY || player.isPlaying) {
                val id = player.currentMediaItem?.mediaId.orEmpty()
                if (id.isNotBlank()) {
                    if (id != lastPlayingId) {
                        prevPlayingId = lastPlayingId
                        prevPlayingPosMs = maxOf(lastPlayingPosMs, maxPlayingPosMs)
                        prevPlayingDurationMs = lastPlayingDurationMs
                        prevPlayingBufferedMs = lastPlayingBufferedMs
                        lastPlayingId = id
                        lastPlayingDurationMs = 0L
                        lastPlayingBufferedMs = 0L
                        // Revenir au titre repris n’est PAS un nouveau titre — garder les retries.
                        val recovered = recoveringTrackId.isNotBlank() &&
                            (id == recoveringTrackId || prevPlayingId == recoveringTrackId)
                        if (earlyEndRetries > 0 && id != prevPlayingId && !recovered) {
                            earlyEndRetries = 0
                            recoveringTrackId = ""
                            maxPlayingPosMs = 0L
                        } else if (!recovered) {
                            maxPlayingPosMs = 0L
                        }
                    } else {
                        lastPlayingPosMs = player.currentPosition.coerceAtLeast(0L)
                        if (lastPlayingPosMs > maxPlayingPosMs) maxPlayingPosMs = lastPlayingPosMs
                        lastPlayingBufferedMs = player.bufferedPosition.coerceAtLeast(0L)
                        val d = player.duration
                        if (d > 0L && d != C.TIME_UNSET) {
                            lastPlayingDurationMs = d
                        }
                    }
                }
            }
            if (
                events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) &&
                player.playbackState == Player.STATE_ENDED
            ) {
                val id = player.currentMediaItem?.mediaId.orEmpty()
                if (id.isNotBlank() && id == lastPlayingId) {
                    val pos = player.currentPosition.coerceAtLeast(0L)
                    lastPlayingPosMs = maxOf(pos, lastPlayingPosMs, maxPlayingPosMs)
                    maxPlayingPosMs = lastPlayingPosMs
                    if (player.duration > 0L && player.duration != C.TIME_UNSET) {
                        lastPlayingDurationMs = player.duration
                    }
                }
            }
            if (
                events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) &&
                player.playbackState == Player.STATE_READY
            ) {
                AppLog.i(
                    "PlaybackService",
                    "STATE_READY id=${player.currentMediaItem?.mediaId} " +
                        "pos=${player.currentPosition} buf=${player.bufferedPosition} " +
                        "playing=${player.isPlaying}",
                )
            }
            persistPlaybackSnapshot(durable = false)
            // Précharge « À suivre » même sans Activity / Now Playing (BG, lecteur fermé)
            if (
                events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION) ||
                (events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) &&
                    player.playbackState == Player.STATE_READY)
            ) {
                ensureServiceAutoplayAhead(player)
            }
            if (
                events.contains(Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED) ||
                events.contains(Player.EVENT_REPEAT_MODE_CHANGED) ||
                events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION) ||
                events.contains(Player.EVENT_MEDIA_METADATA_CHANGED)
            ) {
                refreshMediaButtons()
                ensureCurrentItemMetadata()
            } else if (
                events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) ||
                events.contains(Player.EVENT_IS_PLAYING_CHANGED)
            ) {
                // Boutons play/pause seulement — pas de rebuild metadata / notif à chaque tick buffer.
                refreshMediaButtons()
            }
            if (events.contains(Player.EVENT_IS_PLAYING_CHANGED)) {
                PlaybackIdleGuard.onPlayingChanged(player.isPlaying)
            }
            // Titre courant encore en file:// alors qu’on est en ligne → bascule proxy
            if (
                events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION) ||
                (events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) &&
                    player.playbackState == Player.STATE_READY)
            ) {
                demoteCurrentLocalIfOnline(player)
            }
            if (
                events.contains(Player.EVENT_IS_PLAYING_CHANGED) ||
                events.contains(Player.EVENT_PLAY_WHEN_READY_CHANGED)
            ) {
                if (player.playWhenReady && player.playbackState != Player.STATE_IDLE) {
                    if (audioFocus?.requestIfNeeded() != true) {
                        runCatching { player.pause() }
                    }
                    // Reprise lecture : libère la bande (Mon Mix / ahead offline).
                    runCatching {
                        YtMusicApp.instance.container.downloadManager.cancelAll()
                    }
                } else if (player.playbackState == Player.STATE_IDLE) {
                    audioFocus?.abandon(force = true)
                } else if (!player.playWhenReady) {
                    // Pause user : abandon OK. Pause après appel : abandon() no-op (attente GAIN).
                    audioFocus?.abandon()
                }
                // Notif FGS même en pause si file non vide
                invalidateMediaNotification()
            }
            if (events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION)) {
                val idx = player.currentMediaItemIndex
                // Pochettes NP tout de suite (évite flash placeholder après son fluide)
                CoverPrefetcher.warmCovers(Holder.queue, idx, ahead = 2, behind = 0)
                warmUpcoming(idx)
                enqueueOfflineAhead(idx)
                scope.launch {
                    delay(40)
                    refreshMediaButtons()
                    ensureCurrentItemMetadata()
                    delay(280)
                    refreshMediaButtons()
                }
            }
            if (
                events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) ||
                events.contains(Player.EVENT_PLAY_WHEN_READY_CHANGED)
            ) {
                armStallWatch(player)
            }
            if (
                events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) &&
                player.playbackState == Player.STATE_READY &&
                player.playWhenReady
            ) {
                streamFailStreak.set(0)
                StreamPrefetcher.markStreamOk()
                cancelStallWatch()
                // Remplace le placeholder FGS par la vraie notif média (titre + boutons).
                ensureCurrentItemMetadata()
                invalidateMediaNotification()
            }
            // 35–45 s avant la fin : fenêtre exclusive +1 (pas de far-heads / offline).
            if (player.isPlaying && player.playbackState == Player.STATE_READY) {
                val d = player.duration
                val posNow = player.currentPosition
                if (d > 0L && d != C.TIME_UNSET) {
                    val rem = d - posNow
                    if (rem in 8_000L..45_000L) {
                        val now = android.os.SystemClock.elapsedRealtime()
                        if (now - lastNearEndWarmMs > 3_500L) {
                            lastNearEndWarmMs = now
                            warmExclusiveNext(player.currentMediaItemIndex)
                        }
                    }
                }
                // Pendant toute la lecture : maintient le titre suivant (ignore quiet).
                val nowMid = android.os.SystemClock.elapsedRealtime()
                if (nowMid - lastMidTrackPrefetchMs > 5_000L) {
                    lastMidTrackPrefetchMs = nowMid
                    val q = Holder.queue
                    if (q.isNotEmpty()) {
                        StreamPrefetcher.prefetchNextDuringPlayback(
                            resolvedApiBase(),
                            q.map { it.id },
                            player.currentMediaItemIndex,
                            ignoreQuiet = true,
                        )
                    }
                }
            }
            // Fin propre du dernier item (sans erreur googlevideo) → suivant ou fill « À suivre »
            if (
                events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) &&
                player.playbackState == Player.STATE_ENDED
            ) {
                handleNaturalEnd(player)
            }
            if (
                events.contains(Player.EVENT_PLAY_WHEN_READY_CHANGED) &&
                !player.playWhenReady
            ) {
                // Pause user : coupe far-prefetch, garde la tête +1 pinnée.
                StreamPrefetcher.cancelIdle(preserveNext = true)
            }
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            val exo = player ?: return
            val curIdx = exo.currentMediaItemIndex
            val skipRecovery =
                programmaticAdvance ||
                    reason == Player.MEDIA_ITEM_TRANSITION_REASON_SEEK
            if (programmaticAdvance) programmaticAdvance = false
            val snapPrevId = when (reason) {
                Player.MEDIA_ITEM_TRANSITION_REASON_AUTO ->
                    prevPlayingId.ifBlank { lastPlayingId }
                Player.MEDIA_ITEM_TRANSITION_REASON_SEEK ->
                    lastPlayingId.ifBlank { prevPlayingId }
                else -> lastPlayingId
            }
            val snapPrevPos = maxOf(prevPlayingPosMs, maxPlayingPosMs, lastPlayingPosMs)
            val snapPrevDur = prevPlayingDurationMs.takeIf { it > 0L } ?: lastPlayingDurationMs
            val snapPrevBuf = prevPlayingBufferedMs.takeIf { it > 0L } ?: lastPlayingBufferedMs
            promoteUpcomingToLocal(exo, exo.currentMediaItemIndex + 1)
            // Nouveau +1 : pin cache + prefetch immédiat
            val nextId = Holder.queue.getOrNull(curIdx + 1)?.id
            if (nextId != null && nextId.length == 11) {
                PlayerCache.pinTrack(nextId)
                StreamPrefetcher.prefetchNextDuringPlayback(
                    resolvedApiBase(),
                    Holder.queue.map { it.id },
                    curIdx,
                    ignoreQuiet = true,
                )
            }
            if (skipRecovery) {
                recoveringTrackId = ""
                earlyEndRetries = 0
                Holder.index = curIdx.coerceAtLeast(0)
            } else if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) {
                val naturalExoEnd =
                    snapPrevDur >= 45_000L &&
                        snapPrevPos.toDouble() / snapPrevDur.toDouble() >= 0.88
                val naturalBufEnd =
                    snapPrevBuf >= 45_000L &&
                        (
                            snapPrevPos >= snapPrevBuf - 5_000L ||
                                snapPrevPos.toDouble() / snapPrevBuf.toDouble() >= 0.92
                            )
                val prevIdx = if (snapPrevId.isNotBlank()) {
                    Holder.queue.indexOfFirst { it.id == snapPrevId }
                } else {
                    -1
                }
                val curIdx = exo.currentMediaItemIndex
                val forwardAdvance = prevIdx >= 0 && curIdx > prevIdx
                if (naturalExoEnd || naturalBufEnd || mediaItemActuallyEnded(snapPrevPos, snapPrevDur)) {
                    recoveringTrackId = ""
                    earlyEndRetries = 0
                    if (forwardAdvance) Holder.index = curIdx
                } else if (forwardAdvance && prevIdx >= 0) {
                    // Recovery uniquement si saut AVANT ~72 % de la durée Exo réelle
                    val exoRatio = if (snapPrevDur >= 45_000L) {
                        snapPrevPos.toDouble() / snapPrevDur.toDouble()
                    } else {
                        1.0
                    }
                    if (exoRatio < 0.72) {
                        maybeRecoverEarlyEnd(exo, snapPrevId, snapPrevPos, snapPrevDur, snapPrevBuf)
                    }
                    Holder.index = curIdx
                }
                // Stop en fin de file user si lecture auto OFF (suggestions restent dans la file)
                val idx = exo.currentMediaItemIndex
                val end = Holder.userQueueEnd
                if (!Holder.autoplaySuggestions && end > 0 && idx >= end) {
                    val back = (end - 1).coerceAtLeast(0)
                    exo.pause()
                    val dur = exo.duration
                    if (dur > 0) exo.seekTo(back, dur) else exo.seekTo(back, 0L)
                    exo.pause()
                    android.os.Handler(mainLooper).post {
                        this@PlaybackService.toastMain("Fin de la file — active « À suivre » pour continuer", Toast.LENGTH_SHORT)
                    }
                }
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            val exo = player ?: return
            val item = exo.currentMediaItem ?: return
            val id = item.mediaId
            if (id.isBlank()) return

            val localFile = item.localConfiguration?.uri?.scheme == "file"
            val networkish = !localFile && isNetworkOrServerError(error)
            val dur = when {
                exo.duration > 0L && exo.duration != C.TIME_UNSET -> exo.duration
                lastPlayingDurationMs > 0L -> lastPlayingDurationMs
                else -> 0L
            }
            val pos = bestKnownPos(exo)
            // Fin de titre souvent signalée comme IO/403/connexion coupée par googlevideo —
            // ce n’est PAS une panne réseau : avancer proprement, sans toast « connexion perdue ».
            // Fin de CE fichier (pos ≈ durée Exo) = enchaîner.
            // Ne jamais se baser sur le catalogue YTM (souvent plus court) → skip prématuré.
            val nearExoEnd =
                dur >= 45_000L &&
                    pos >= 0L &&
                    (
                        pos.toDouble() / dur.toDouble() >= 0.96 ||
                            (dur - pos) in 0L..2_500L
                    )
            val nearEnd = !localFile && nearExoEnd
            if (nearEnd) {
                streamFailStreak.set(0)
                StreamPrefetcher.markStreamOk()
                AppLog.i(
                    "PlaybackService",
                    "EOS via error (pas une panne réseau) id=$id pos=$pos dur=$dur code=${error.errorCode}",
                )
                val curIdx = exo.currentMediaItemIndex.coerceAtLeast(0)
                val end = Holder.userQueueEnd
                val nextIdx = curIdx + 1
                if (!Holder.autoplaySuggestions && end > 0 && nextIdx >= end) {
                    exo.playWhenReady = false
                    runCatching { exo.pause() }
                    android.os.Handler(mainLooper).post {
                        this@PlaybackService.toastMain("Fin de la file — active « À suivre » pour continuer", Toast.LENGTH_SHORT)
                    }
                    return
                }
                if (nextIdx < exo.mediaItemCount) {
                    runCatching { advanceToQueueIndex(exo, nextIdx) }
                    return
                }
                // Fin de file Exo → fill UI ou service (BG)
                val uiFill = Holder.onSkipAtEnd
                if (uiFill != null) uiFill.invoke() else fillAutoplayFromService(advanceAfterFill = true)
                return
            }

            val httpStatus = httpStatusOf(error)
            val streak = streamFailStreak.incrementAndGet()
            AppLog.w(
                "PlaybackService",
                "onPlayerError code=${error.errorCode} http=$httpStatus network=$networkish local=$localFile streak=$streak id=$id pos=$pos dur=$dur",
                error,
            )
            if (httpStatus != null && httpStatus >= 500) {
                // Ne coupe le prefetch / offline qu’après plusieurs 5xx — un seul 502
                // (getAudioFormat deadline) ne doit pas bloquer 2 min toute la file.
                if (streak >= 3) {
                    StreamPrefetcher.markStreamDown(90_000L)
                    StreamPrefetcher.cancelIdle()
                    runCatching {
                        ovh.delhomme.ytmusic.YtMusicApp.instance.container.downloadManager.cancelAll()
                    }
                } else {
                    // Laisse le titre courant retenter : coupe seulement le bruit (LibHeads / prefetch suite).
                    StreamPrefetcher.cancelIdle()
                    StreamPrefetcher.quietPrefetch(4_000L)
                }
            }
            runCatching {
                ovh.delhomme.ytmusic.debug.TelemetryReporter.reportPlayerError(
                    code = error.errorCode,
                    trackId = id,
                    networkish = networkish,
                    local = localFile,
                    streak = streak,
                    detail = error.stackTraceToString().take(4_000),
                    httpStatus = httpStatus,
                )
            }

            // Fichier local corrompu / manquant : purge + retenter le stream (même titre).
            if (localFile) {
                val container = runCatching { ovh.delhomme.ytmusic.YtMusicApp.instance.container }.getOrNull()
                AppLog.w("PlaybackService", "fichier local invalide → purge id=$id")
                val online = ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()
                if (online && container != null) {
                    streamFailStreak.set(0)
                    val attempt = recoverGen.incrementAndGet()
                    scope.launch {
                        runCatching { container.offlineStore.remove(id) }
                        runCatching { PlayerCache.invalidate(this@PlaybackService, id) }
                        if (attempt != recoverGen.get()) return@launch
                        if (exo.currentMediaItem?.mediaId != id) return@launch
                        val track = Holder.queue.firstOrNull { it.id == id } ?: return@launch
                        val rebuilt = mediaItemFor(
                            track,
                            { tid -> container.remoteStreamUrl(tid) },
                            Holder.queueTitle,
                        )
                        runCatching {
                            val pos = exo.currentPosition.coerceAtLeast(0L)
                            exo.replaceMediaItem(exo.currentMediaItemIndex, rebuilt)
                            exo.seekTo(exo.currentMediaItemIndex, pos)
                            exo.prepare()
                            exo.playWhenReady = true
                            exo.play()
                        }
                    }
                    android.os.Handler(mainLooper).post {
                        this@PlaybackService.toastMain("Fichier local KO — reprise en streaming…", Toast.LENGTH_SHORT)
                    }
                    return
                }

                streamFailStreak.set(0)
                scope.launch {
                    runCatching { container?.offlineStore?.remove(id) }
                }
                val curIdx = exo.currentMediaItemIndex.coerceAtLeast(0)
                val nextOfflineIdx = (curIdx + 1 until Holder.queue.size).firstOrNull { i ->
                    container?.offlineStore?.has(Holder.queue[i].id) == true
                }
                if (nextOfflineIdx != null) {
                    rematerializeOfflineFrom(exo, nextOfflineIdx, container)
                    android.os.Handler(mainLooper).post {
                        this@PlaybackService.toastMain("Fichier local KO — suite hors ligne", Toast.LENGTH_SHORT)
                    }
                    return
                }
                android.os.Handler(mainLooper).post {
                    this@PlaybackService.toastMain("Lecture locale impossible", Toast.LENGTH_SHORT)
                }
                return
            }

            // Réseau / serveur : rester sur LE MÊME titre autant que possible
            // (ne plus skip auto mid-song vers le prochain DL — ça « changeait de musique »).
            if (networkish) {
                val offline = !ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()
                val container = runCatching { ovh.delhomme.ytmusic.YtMusicApp.instance.container }.getOrNull()
                val localUri = container?.offlineStore?.playUri(id)
                if (localUri != null) {
                    streamFailStreak.set(0)
                    val attempt = recoverGen.incrementAndGet()
                    scope.launch {
                        if (attempt != recoverGen.get()) return@launch
                        if (exo.currentMediaItem?.mediaId != id) return@launch
                        val track = Holder.queue.firstOrNull { it.id == id }
                        val rebuilt = if (track != null) {
                            // Fallback hors-ligne : forcer le fichier local (pas streamUrl→local
                            // si le fichier vient d’être jugé KO ailleurs).
                            mediaItemFor(track, { _ -> localUri.toString() }, Holder.queueTitle)
                        } else {
                            item.buildUpon().setUri(localUri).build()
                        }
                        runCatching {
                            val pos = exo.currentPosition.coerceAtLeast(0L)
                            exo.replaceMediaItem(exo.currentMediaItemIndex, rebuilt)
                            exo.seekTo(exo.currentMediaItemIndex, pos)
                            exo.prepare()
                            exo.playWhenReady = true
                            exo.play()
                        }
                    }
                    return
                }
                // Vraiment hors-ligne sans fichier local pour ce titre → suite offline
                if (offline) {
                    val curIdx = exo.currentMediaItemIndex.coerceAtLeast(0)
                    val nextOfflineIdx = (curIdx + 1 until Holder.queue.size).firstOrNull { i ->
                        container?.offlineStore?.has(Holder.queue[i].id) == true
                    }
                    if (nextOfflineIdx != null) {
                        streamFailStreak.set(0)
                        rematerializeOfflineFrom(exo, nextOfflineIdx, container)
                        android.os.Handler(mainLooper).post {
                            this@PlaybackService.toastMain("Hors ligne — suite sur titres téléchargés", Toast.LENGTH_SHORT)
                        }
                        return
                    }
                    StreamPrefetcher.markStreamDown()
                    StreamPrefetcher.cancelIdle()
                    recoverGen.incrementAndGet()
                    exo.playWhenReady = false
                    runCatching { exo.pause() }
                    streamFailStreak.set(0)
                    ovh.delhomme.ytmusic.data.NetworkMonitor.markPausedForNetwork()
                    android.os.Handler(mainLooper).post {
                        this@PlaybackService.toastMain("Hors ligne — télécharge des titres (⋮) pour continuer", Toast.LENGTH_SHORT)
                    }
                    return
                }
                // Réseau / 5xx : retry proxy frais ; après trop d’échecs → titre suivant
                // (évite silence interminable type Melrose Place / 502 en boucle).
                val errBlobEarly = runCatching { error.stackTraceToString() }.getOrDefault("")
                val httpBody = httpResponseBodyOf(error)
                val unavailable =
                    Regex(
                        "unavailable|not available|private video|copyright|Impossible de streamer",
                        RegexOption.IGNORE_CASE,
                    ).containsMatchIn(errBlobEarly + "\n" + httpBody) ||
                        (httpStatus != null && httpStatus == 404)
                // DNS / connexion data qui saute (code 2001) : le titre n’a rien à se reprocher,
                // c’est le réseau. On retente indéfiniment avec backoff au lieu de passer au
                // suivant — un creux de 4G ne doit jamais faire changer de musique.
                val transientNetwork =
                    error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED ||
                        error.errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT ||
                        Regex(
                            "UnknownHost|Unable to resolve host|ECONNRESET|SocketTimeout",
                            RegexOption.IGNORE_CASE,
                        ).containsMatchIn(errBlobEarly)
                val giveUpStreak = when {
                    unavailable -> 2
                    transientNetwork -> Int.MAX_VALUE
                    else -> 8
                }
                if (streak >= giveUpStreak) {
                    AppLog.w(
                        "PlaybackService",
                        "onPlayerError give-up streak=$streak → next id=$id pos=$pos http=$httpStatus unavailable=$unavailable",
                    )
                    streamFailStreak.set(0)
                    cancelStallWatch()
                    clearStallSession()
                    val nextIdx = exo.currentMediaItemIndex + 1
                    val end = Holder.userQueueEnd
                    android.os.Handler(mainLooper).post {
                        toastMain(
                            if (unavailable) "Titre indisponible — suivant" else "Flux KO — titre suivant",
                            Toast.LENGTH_SHORT,
                        )
                    }
                    if (!Holder.autoplaySuggestions && end > 0 && nextIdx >= end) {
                        exo.playWhenReady = false
                        runCatching { exo.pause() }
                        return
                    }
                    if (nextIdx < exo.mediaItemCount) {
                        runCatching { advanceToQueueIndex(exo, nextIdx) }
                    } else {
                        val uiFill = Holder.onSkipAtEnd
                        if (uiFill != null) uiFill.invoke() else fillAutoplayFromService(advanceAfterFill = true)
                    }
                    return
                }
                val attempt = recoverGen.incrementAndGet()
                val resumePos = exo.currentPosition.coerceAtLeast(0L)
                val errBlob = errBlobEarly
                val isEof = errBlob.contains("EOFException", ignoreCase = true)
                val truncatedMid =
                    !localFile &&
                        (
                            isEof ||
                                (
                                    resumePos in 45_000L..130_000L &&
                                        (dur <= 0L || dur >= 90_000L) &&
                                        (
                                            httpStatus == null ||
                                                httpStatus >= 500 ||
                                                error.errorCode == PlaybackException.ERROR_CODE_IO_UNSPECIFIED
                                        )
                                )
                        )
                val seekPos = when {
                    truncatedMid && streak >= 3 -> 0L
                    truncatedMid -> (resumePos - 20_000L).coerceAtLeast(0L)
                    else -> resumePos
                }
                scope.launch {
                    runCatching { PlayerCache.invalidate(this@PlaybackService, id) }
                    runCatching { container?.invalidateStreamUrlCache(id) }
                    if (truncatedMid || resumePos > 45_000L) {
                        StreamPrefetcher.requestServerDiskCache(Holder.resolvedApiBase(), id)
                    }
                    StreamPrefetcher.cancelIdle()
                    StreamPrefetcher.quietPrefetch(3_000L)
                    val resolveOk = runCatching {
                        withTimeout(12_000L) {
                            val r = streak.coerceAtLeast(1)
                            container?.api?.streamResolveUrl(
                                id,
                                retry = r,
                                streamRetry = r.toString(),
                            )
                        }
                    }.isSuccess
                    val retryDelay = when {
                        // DNS / data coupée : backoff plus large, on attend que le réseau revienne.
                        transientNetwork -> (1_500L * streak).coerceAtMost(10_000L)
                        truncatedMid -> (2_000L * streak).coerceAtMost(8_000L)
                        httpStatus != null && httpStatus >= 500 ->
                            (800L * streak).coerceAtMost(6_000L)
                        else -> (300L * streak).coerceAtMost(4_000L)
                    }
                    delay(retryDelay)
                    if (attempt != recoverGen.get()) return@launch
                    if (exo.currentMediaItem?.mediaId != id) return@launch
                    val track = Holder.queue.firstOrNull { it.id == id }
                    val rebuilt = runCatching {
                        val nextItem = if (track != null && container != null) {
                            mediaItemFor(
                                track,
                                { tid -> container.remoteStreamUrl(tid, retry = streak.coerceAtLeast(1)) },
                                Holder.queueTitle,
                            )
                        } else {
                            item
                        }
                        val idx = exo.currentMediaItemIndex.coerceAtLeast(0)
                        exo.replaceMediaItem(idx, nextItem)
                        exo.seekTo(idx, seekPos)
                        exo.prepare()
                        exo.playWhenReady = true
                        exo.play()
                        true
                    }.getOrDefault(false)
                    android.os.Handler(mainLooper).post {
                        armStallWatch(exo)
                        if (rebuilt && resolveOk && streakToastDue()) {
                            lastStallRecoverToastMs = android.os.SystemClock.elapsedRealtime()
                            toastMain("Reprise du flux…", Toast.LENGTH_SHORT)
                        }
                    }
                }
                return
            }

            // Conteneur MP4 malformé (atom length) : wipe + retry, puis skip.
            val parseMalformed =
                error.errorCode == PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED ||
                    error.errorCode == PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED ||
                    (error.cause?.message?.contains("atom with length", ignoreCase = true) == true)
            if (parseMalformed && streak >= 3) {
                AppLog.w("PlaybackService", "parse malformed give-up → next id=$id streak=$streak")
                streamFailStreak.set(0)
                cancelStallWatch()
                clearStallSession()
                val nextIdx = exo.currentMediaItemIndex + 1
                android.os.Handler(mainLooper).post {
                    toastMain("Fichier illisible — titre suivant", Toast.LENGTH_SHORT)
                }
                if (nextIdx < exo.mediaItemCount) {
                    runCatching { advanceToQueueIndex(exo, nextIdx) }
                } else {
                    val uiFill = Holder.onSkipAtEnd
                    if (uiFill != null) uiFill.invoke() else fillAutoplayFromService(advanceAfterFill = true)
                }
                return
            }

            // Autres erreurs : retry sur le même titre ; skip après trop d’échecs.
            if (streak >= 6) {
                AppLog.w("PlaybackService", "player-error give-up streak=$streak → next id=$id code=${error.errorCode}")
                streamFailStreak.set(0)
                cancelStallWatch()
                clearStallSession()
                val nextIdx = exo.currentMediaItemIndex + 1
                android.os.Handler(mainLooper).post {
                    toastMain("Erreur lecture — titre suivant", Toast.LENGTH_SHORT)
                }
                if (nextIdx < exo.mediaItemCount) {
                    runCatching { advanceToQueueIndex(exo, nextIdx) }
                } else {
                    val uiFill = Holder.onSkipAtEnd
                    if (uiFill != null) uiFill.invoke() else fillAutoplayFromService(advanceAfterFill = true)
                }
                return
            }
            val attempt = recoverGen.incrementAndGet()
            scope.launch {
                runCatching { PlayerCache.invalidate(this@PlaybackService, id) }
                runCatching {
                    YtMusicApp.instance.container.invalidateStreamUrlCache(id)
                }
                delay((400L * streak).coerceAtMost(4_000L))
                if (attempt != recoverGen.get()) return@launch
                if (exo.currentMediaItem?.mediaId != id) return@launch
                rebindCurrentStream(
                    reason = "player-error-${error.errorCode}",
                    forcePlay = true,
                    retryN = streak.coerceAtLeast(1),
                    wipeCache = parseMalformed || streak >= 2,
                )
                android.os.Handler(mainLooper).post { armStallWatch(exo) }
            }
            return
        }

        private fun httpStatusOf(error: PlaybackException): Int? {
            var c: Throwable? = error
            var depth = 0
            while (c != null && depth++ < 8) {
                if (c is androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException) {
                    return c.responseCode
                }
                val m = Regex("Response code:\\s*(\\d{3})").find(c.message ?: "")
                if (m != null) return m.groupValues[1].toIntOrNull()
                c = c.cause
            }
            return null
        }

        /** Corps JSON d’erreur API (`Impossible de streamer` / video unavailable). */
        private fun httpResponseBodyOf(error: PlaybackException): String {
            var c: Throwable? = error
            var depth = 0
            while (c != null && depth++ < 8) {
                if (c is androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException) {
                    val bytes = c.responseBody ?: return ""
                    return runCatching { bytes.toString(Charsets.UTF_8) }.getOrDefault("").take(800)
                }
                c = c.cause
            }
            return ""
        }

        private fun isNetworkOrServerError(error: PlaybackException): Boolean {
            when (error.errorCode) {
                PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
                PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
                PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS,
                PlaybackException.ERROR_CODE_TIMEOUT,
                // EOF mid-stream (souvent ~64 s / 1 MiB) = chaîne stream, pas un bug decode local
                PlaybackException.ERROR_CODE_IO_UNSPECIFIED,
                PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE,
                -> return true
            }
            var c: Throwable? = error.cause
            var depth = 0
            while (c != null && depth++ < 6) {
                if (c is java.io.EOFException) return true
                val name = c.javaClass.name
                if (
                    c is java.net.UnknownHostException ||
                    c is java.net.ConnectException ||
                    c is java.net.SocketTimeoutException ||
                    c is java.io.InterruptedIOException ||
                    name.contains("UnknownHost") ||
                    name.contains("ConnectException") ||
                    name.contains("SocketTimeout") ||
                    name.contains("EOFException")
                ) {
                    return true
                }
                val msg = (c.message ?: "").lowercase()
                if (
                    "failed to connect" in msg ||
                    "unable to resolve" in msg ||
                    "connection refused" in msg ||
                    "network is unreachable" in msg ||
                    "502" in msg ||
                    "503" in msg ||
                    "504" in msg ||
                    "unexpected end of stream" in msg ||
                    "end of stream" in msg
                ) {
                    return true
                }
                c = c.cause
            }
            return false
        }
    }

    override fun onCreate() {
        super.onCreate()

        // maxBuffer très large = le titre entier est aspiré en une seule connexion dès le
        // départ. Une coupure data / échec DNS en milieu de morceau ne provoque alors plus
        // ni silence ni Range mid-fichier (que le serveur ne sait pas toujours servir).
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                /* minBufferMs */ 15_000,
                /* maxBufferMs */ 600_000,
                /* bufferForPlaybackMs */ 350,
                /* bufferForPlaybackAfterRebufferMs */ 1_200,
            )
            .setPrioritizeTimeOverSizeThresholds(true)
            .setTargetBufferBytes(24 * 1024 * 1024)
            .build()

        val mediaSourceFactory = DefaultMediaSourceFactory(this)
            .setDataSourceFactory(PlayerCache.dataSourceFactory(this))

        val exo = ExoPlayer.Builder(this)
            .setMediaSourceFactory(mediaSourceFactory)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                    .build(),
                // false : Exo ne vole pas le focus (Netflix / YouTube) sur seek / prepare / ouverture.
                // Le focus est demandé manuellement seulement quand playWhenReady=true (PlayerAudioFocus).
                /* handleAudioFocus= */ false,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .setLoadControl(loadControl)
            .build()
        // Précharge ~12 s du MediaItem suivant (même CacheDataSource → SimpleCache).
        runCatching {
            exo.setPreloadConfiguration(
                androidx.media3.exoplayer.ExoPlayer.PreloadConfiguration(/* durationUs */ 12_000_000L),
            )
        }
        exo.addListener(playerListener)
        player = exo
        audioFocus = PlayerAudioFocus(this) { player }
        val forwarding = YtmForwardingPlayer(exo)
        sessionPlayer = forwarding

        val openPlayer = sessionActivityPendingIntent()

        session = MediaSession.Builder(this, forwarding)
            .setCallback(SessionCallback())
            .setSessionActivity(openPlayer)
            .setBitmapLoader(CacheBitmapLoader(DataSourceBitmapLoader(this)))
            .setMediaButtonPreferences(buildMediaButtons(forwarding))
            .build()

        val notificationProvider = DefaultMediaNotificationProvider.Builder(this)
            .setChannelName(R.string.playback_channel_name)
            .build()
        // Petite icône monochrome obligatoire (ic_brand_fg SVG → crash Samsung)
        notificationProvider.setSmallIcon(R.drawable.ic_stat_play)
        setMediaNotificationProvider(notificationProvider)

        // Media3 peut appeler startForegroundService avant que la notif soit prête
        // (Blackview API 28 → crash RemoteServiceException sous ~5 s). Annonce FGS tout de suite.
        promoteToForegroundPlaceholder()

        Holder.player = exo
        Holder.service = this
        refreshPlaybackActiveFlag(exo)
        if (exo.audioSessionId != C.AUDIO_SESSION_ID_UNSET) {
            AudioEqualizer.attach(exo.audioSessionId)
        }

        // Dès qu’un DL hors-ligne se termine → bascule les suivants en file:// (anti-coupure)
        scope.launch {
            val store = runCatching { YtMusicApp.instance.container.offlineStore }.getOrNull() ?: return@launch
            store.revision.collect {
                val p = player ?: return@collect
                val idx = p.currentMediaItemIndex
                promoteUpcomingToLocal(p, idx + 1)
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Ne JAMAIS réécraser la notif Media3 (titre/pochette/boutons) avec le placeholder
        // « PLM / Lecture… » — chaque startForegroundService / rebind le faisait.
        ensureForegroundNotification()
        return super.onStartCommand(intent, flags, startId)
    }

    /**
     * FGS : placeholder uniquement si aucune piste / métadonnées ; sinon force la notif Media3.
     */
    private fun ensureForegroundNotification() {
        val exo = player
        val hasMedia = exo != null && exo.mediaItemCount > 0
        val title = exo?.currentMediaItem?.mediaMetadata?.title?.toString()?.trim().orEmpty()
        val hasRealTitle = title.isNotBlank() && title != "…" && !title.equals("PLM", ignoreCase = true)
        if (hasMedia && (hasRealTitle || session != null)) {
            // Remet / rafraîchit la vraie notif transport (évite rester sur le placeholder).
            runCatching { ensureCurrentItemMetadata() }
            invalidateMediaNotification()
            return
        }
        promoteToForegroundPlaceholder()
    }

    /**
     * Notif FGS immédiate (même id que DefaultMediaNotificationProvider) pour respecter
     * le délai Android après `startForegroundService`. Remplacée ensuite par la notif Media3.
     * Ne pas rappeler une fois qu’une piste réelle est en file.
     */
    private fun promoteToForegroundPlaceholder() {
        val exo = player
        if (exo != null && exo.mediaItemCount > 0) {
            invalidateMediaNotification()
            return
        }
        runCatching {
            val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= 26) {
                val chId = DefaultMediaNotificationProvider.DEFAULT_CHANNEL_ID
                // Samsung : IMPORTANCE_LOW → notif plate « PLM / Lecture… » sans contrôles média.
                val existing = nm.getNotificationChannel(chId)
                if (existing == null || existing.importance < NotificationManager.IMPORTANCE_DEFAULT) {
                    runCatching { nm.deleteNotificationChannel(chId) }
                    val ch = NotificationChannel(
                        chId,
                        getString(R.string.playback_channel_name),
                        NotificationManager.IMPORTANCE_DEFAULT,
                    ).apply {
                        setShowBadge(false)
                        setSound(null, null)
                        enableVibration(false)
                        description = "Lecteur multimédia PLM"
                    }
                    nm.createNotificationChannel(ch)
                }
            }
            val notification: Notification = NotificationCompat.Builder(
                this,
                DefaultMediaNotificationProvider.DEFAULT_CHANNEL_ID,
            )
                .setContentTitle("PLM")
                .setContentText("Lecture…")
                .setSmallIcon(R.drawable.ic_stat_play)
                .setContentIntent(sessionActivityPendingIntent())
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .build()
            ServiceCompat.startForeground(
                this,
                DefaultMediaNotificationProvider.DEFAULT_NOTIFICATION_ID,
                notification,
                if (Build.VERSION.SDK_INT >= 29) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                } else {
                    0
                },
            )
        }.onFailure { err ->
            AppLog.w("PlaybackService", "promoteToForegroundPlaceholder KO", err)
        }
    }

    private fun sessionActivityPendingIntent(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra(MainActivity.EXTRA_OPEN_PLAYER, true)
            action = Intent.ACTION_VIEW
        }
        return PendingIntent.getActivity(
            this,
            /* requestCode */ 42,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onTaskRemoved(rootIntent: Intent?) {
        persistPlaybackSnapshot(durable = true)
        val p = player
        // Garder service + notif tant qu’une file existe (même en pause)
        if (p == null || p.mediaItemCount == 0) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        persistPlaybackSnapshot(durable = true)
        scope.cancel()
        audioFocus?.abandon(force = true)
        audioFocus = null
        player?.removeListener(playerListener)
        session?.release()
        session = null
        player?.release()
        player = null
        Holder.player = null
        Holder.service = null
        Holder.playbackActive = false
        Holder.onServiceStopped?.invoke()
        super.onDestroy()
    }

    private fun refreshMediaButtons() {
        val p = sessionPlayer ?: player ?: return
        session?.setMediaButtonPreferences(buildMediaButtons(p))
    }

    /**
     * Force le redraw de la notif média (compacte OEM souvent vide après seek lointain
     * tant qu’on n’expand/collapse pas manuellement).
     * Debounce : les salves onEvents + ensureMetadata saturaient le Main (Skipped 1000+ frames).
     */
    private var lastNotifInvalidateMs = 0L
    private val notifInvalidateHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val notifInvalidateRunnable = Runnable {
        val s = session ?: return@Runnable
        val startFg = (player?.mediaItemCount ?: 0) > 0
        runCatching { onUpdateNotification(s, startFg) }
        lastNotifInvalidateMs = android.os.SystemClock.elapsedRealtime()
    }

    private fun invalidateMediaNotification() {
        if (session == null) return
        val now = android.os.SystemClock.elapsedRealtime()
        val elapsed = now - lastNotifInvalidateMs
        notifInvalidateHandler.removeCallbacks(notifInvalidateRunnable)
        if (elapsed >= 280L) {
            notifInvalidateRunnable.run()
        } else {
            notifInvalidateHandler.postDelayed(notifInvalidateRunnable, 280L - elapsed)
        }
    }

    /**
     * Si le MediaItem courant a des métadonnées vides (saut lointain / placeholder),
     * les reconstruit depuis [Holder.queue] pour que la notif système affiche titre + boutons.
     */
    fun ensureCurrentItemMetadata() {
        val exo = player ?: return
        val idx = exo.currentMediaItemIndex
        if (idx < 0 || idx >= exo.mediaItemCount) return
        val item = exo.getMediaItemAt(idx)
        val title = item.mediaMetadata.title?.toString()?.trim().orEmpty()
        val track = Holder.queue.getOrNull(idx)?.takeIf { it.id == item.mediaId }
            ?: Holder.queue.firstOrNull { it.id == item.mediaId }
        if (track == null) {
            refreshMediaButtons()
            invalidateMediaNotification()
            return
        }
        val needsRebuild = title.isEmpty() ||
            title == "…" ||
            item.mediaMetadata.artworkUri == null ||
            (track.title.isNotBlank() && !title.equals(track.title, ignoreCase = false) && title.length < 2)
        if (needsRebuild) {
            val rebuilt = mediaItemFor(
                track,
                { id ->
                    runCatching { ovh.delhomme.ytmusic.YtMusicApp.instance.container.streamUrl(id) }
                        .getOrElse { "${Holder.resolvedApiBase()}/api/stream/$id" }
                },
                Holder.queueTitle,
            )
            runCatching {
                val pos = exo.currentPosition.coerceAtLeast(0L)
                exo.replaceMediaItem(idx, rebuilt)
                // replaceMediaItem peut reset la position sur certains builds
                if (exo.currentMediaItemIndex == idx && exo.currentPosition < 50L && pos > 50L) {
                    exo.seekTo(idx, pos)
                }
            }
        }
        refreshMediaButtons()
        invalidateMediaNotification()
    }

    fun notifyQueueJump() {
        refreshMediaButtons()
        ensureCurrentItemMetadata()
        invalidateMediaNotification()
        scope.launch {
            delay(80)
            refreshMediaButtons()
            ensureCurrentItemMetadata()
            invalidateMediaNotification()
            delay(350)
            refreshMediaButtons()
            invalidateMediaNotification()
            // Bitmap artwork souvent prêt après ~1s sur saut froid
            delay(700)
            refreshMediaButtons()
            invalidateMediaNotification()
        }
    }

    private fun buildMediaButtons(p: Player): List<CommandButton> {
        val mediaId = p.currentMediaItem?.mediaId
        val liked = mediaId != null && mediaId in Holder.likedIds
        val shuffleOn = p.shuffleModeEnabled
        val repeatIcon = when (p.repeatMode) {
            Player.REPEAT_MODE_ONE -> CommandButton.ICON_REPEAT_ONE
            Player.REPEAT_MODE_ALL -> CommandButton.ICON_REPEAT_ALL
            else -> CommandButton.ICON_REPEAT_OFF
        }
        val repeatName = when (p.repeatMode) {
            Player.REPEAT_MODE_ONE -> "Boucler le titre"
            Player.REPEAT_MODE_ALL -> "Boucler la file"
            else -> "Boucle désactivée"
        }

        // Compact notif = prev / play / next. Secondaires = J’aime + Playlist + Paroles
        // (Samsung Media panel affiche surtout BACK/FORWARD_SECONDARY ; overflow = le reste).
        return listOf(
            CommandButton.Builder(if (liked) CommandButton.ICON_HEART_FILLED else CommandButton.ICON_HEART_UNFILLED)
                .setDisplayName(if (liked) "Retirer des J'aime" else "J'aime")
                .setSessionCommand(cmdLike)
                .setSlots(CommandButton.SLOT_BACK_SECONDARY, CommandButton.SLOT_OVERFLOW)
                .build(),
            CommandButton.Builder(CommandButton.ICON_PLAYLIST_ADD)
                .setDisplayName("Ajouter à une playlist")
                .setSessionCommand(cmdAddPlaylist)
                .setSlots(CommandButton.SLOT_FORWARD_SECONDARY, CommandButton.SLOT_OVERFLOW)
                .build(),
            CommandButton.Builder(CommandButton.ICON_SUBTITLES)
                .setDisplayName("Paroles")
                .setSessionCommand(cmdOpenLyrics)
                .setSlots(CommandButton.SLOT_OVERFLOW)
                .build(),
            CommandButton.Builder(repeatIcon)
                .setDisplayName(repeatName)
                .setSessionCommand(cmdCycleRepeat)
                .setSlots(CommandButton.SLOT_OVERFLOW)
                .build(),
            CommandButton.Builder(if (shuffleOn) CommandButton.ICON_SHUFFLE_ON else CommandButton.ICON_SHUFFLE_OFF)
                .setDisplayName(if (shuffleOn) "Aléatoire activé" else "Aléatoire")
                .setSessionCommand(cmdToggleShuffle)
                .setSlots(CommandButton.SLOT_OVERFLOW)
                .build(),
        )
    }

    private inner class SessionCallback : MediaSession.Callback {
        override fun onConnect(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
        ): MediaSession.ConnectionResult {
            val sessionCommands = MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon()
                .add(cmdLike)
                .add(cmdCycleRepeat)
                .add(cmdToggleShuffle)
                .add(cmdAddPlaylist)
                .add(cmdOpenLyrics)
                .build()
            // Force next/prev toujours dispo (sinon Samsung grise « suivant » sans item suivant)
            val playerCommands = MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
                .add(Player.COMMAND_SEEK_TO_NEXT)
                .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                .add(Player.COMMAND_SEEK_TO_PREVIOUS)
                .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                .build()
            return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                .setAvailableSessionCommands(sessionCommands)
                .setAvailablePlayerCommands(playerCommands)
                .setMediaButtonPreferences(buildMediaButtons(session.player))
                .build()
        }

        override fun onCustomCommand(
            session: MediaSession,
            controller: MediaSession.ControllerInfo,
            customCommand: SessionCommand,
            args: Bundle,
        ): ListenableFuture<SessionResult> {
            val p = session.player
            when (customCommand.customAction) {
                ACTION_TOGGLE_SHUFFLE -> {
                    Holder.onToggleShuffle?.invoke()
                        ?: run { p.shuffleModeEnabled = !p.shuffleModeEnabled }
                    refreshMediaButtons()
                }
                ACTION_CYCLE_REPEAT -> {
                    Holder.onCycleRepeat?.invoke()
                        ?: run {
                            p.repeatMode = when (p.repeatMode) {
                                Player.REPEAT_MODE_ONE -> Player.REPEAT_MODE_ALL
                                Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_OFF
                                else -> Player.REPEAT_MODE_ONE
                            }
                        }
                    refreshMediaButtons()
                }
                ACTION_TOGGLE_LIKE -> {
                    toggleLikeFromNotification(p)
                }
                ACTION_ADD_PLAYLIST -> {
                    openAppFromMediaAction(MainActivity.EXTRA_OPEN_ADD_PLAYLIST)
                }
                ACTION_OPEN_LYRICS -> {
                    openAppFromMediaAction(MainActivity.EXTRA_OPEN_LYRICS)
                }
            }
            return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
        }
    }

    /** Ouvre PLM sur l’écran demandé (playlist / paroles) depuis la notif Samsung / Media3. */
    private fun openAppFromMediaAction(extra: String) {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP or
                Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra(MainActivity.EXTRA_OPEN_PLAYER, true)
            putExtra(extra, true)
            action = Intent.ACTION_VIEW
        }
        runCatching { startActivity(intent) }
            .onFailure { AppLog.w("PlaybackService", "openAppFromMediaAction $extra", it) }
    }

    private fun toggleLikeFromNotification(p: Player) {
        val mediaId = p.currentMediaItem?.mediaId ?: return
        val track = Holder.queue.firstOrNull { it.id == mediaId } ?: return
        val app = applicationContext as? YtMusicApp ?: return
        scope.launch {
            runCatching {
                app.container.ensureFreshToken()
                val r = app.container.api.like(track)
                Holder.likedIds = if (r.liked) {
                    Holder.likedIds + mediaId
                } else {
                    Holder.likedIds - mediaId
                }
                Holder.onLikedIdsChanged?.invoke(Holder.likedIds)
                refreshMediaButtons()
            }
        }
    }

    private fun bestKnownPos(exo: Player): Long {
        return maxOf(
            exo.currentPosition.coerceAtLeast(0L),
            lastPlayingPosMs,
            maxPlayingPosMs,
        )
    }

    private fun advanceToQueueIndex(exo: Player, nextIdx: Int, warmFrom: Int = nextIdx) {
        programmaticAdvance = true
        recoverGen.incrementAndGet()
        try {
            val nextId = Holder.queue.getOrNull(nextIdx)?.id
            if (!nextId.isNullOrBlank()) {
                StreamPrefetcher.warmTrackFormatOnly(resolvedApiBase(), nextId)
            }
            val exoPlayer = exo as? ExoPlayer ?: player
            if (exoPlayer != null) promoteUpcomingToLocal(exoPlayer, nextIdx)
            exo.seekTo(nextIdx, 0L)
            exo.prepare()
            exo.playWhenReady = true
            exo.play()
            Holder.index = nextIdx
            earlyEndRetries = 0
            recoveringTrackId = ""
        } finally {
            programmaticAdvance = false
        }
        warmUpcoming(warmFrom)
        val exoPlayer = exo as? ExoPlayer ?: player
        if (exoPlayer != null) enqueueOfflineAhead(warmFrom)
    }

    /**
     * — suivant en file → seek + play
     * — fin de file user + auto OFF → stop + toast
     * — sinon → [Holder.onSkipAtEnd] (fill suggestions puis avance)
     *
     * Important : STATE_ENDED = ce fichier audio est **fini**. Un catalogue YouTube plus
     * long n’est pas une erreur. Reprendre 4 s avant = boucle sur la coda (Nothing).
     */
    private fun handleNaturalEnd(exo: Player) {
        val curIdx = exo.currentMediaItemIndex.coerceAtLeast(0)
        val curId = exo.currentMediaItem?.mediaId ?: lastPlayingId
        val pos = bestKnownPos(exo)
        val exoDur = when {
            exo.duration > 0L && exo.duration != C.TIME_UNSET -> exo.duration
            lastPlayingDurationMs > 0L -> lastPlayingDurationMs
            else -> 0L
        }
        val catalog = Holder.queue.firstOrNull { it.id == curId }?.durationMsOrNull()
        if (curId.isNotBlank() && shouldRetryEndedAsTruncated(curId, pos, exoDur, catalog)) {
            AppLog.w(
                "PlaybackService",
                "STATE_ENDED peut-être tronqué — 1 retry URL fraîche id=$curId pos=$pos exoDur=$exoDur catalog=$catalog",
            )
            maybeRecoverEarlyEnd(exo, curId, pos, exoDur, lastPlayingBufferedMs, fromStateEnded = true)
            return
        }
        recoveringTrackId = ""
        earlyEndRetries = 0
        val end = Holder.userQueueEnd
        val nextIdx = curIdx + 1
        AppLog.i(
            "PlaybackService",
            "STATE_ENDED idx=$curIdx next=$nextIdx count=${exo.mediaItemCount} auto=${Holder.autoplaySuggestions} userEnd=$end",
        )
        if (!Holder.autoplaySuggestions && end > 0 && nextIdx >= end) {
            exo.playWhenReady = false
            runCatching { exo.pause() }
            android.os.Handler(mainLooper).post {
                this.toastMain("Fin de la file — active « À suivre » pour continuer", Toast.LENGTH_SHORT)
            }
            return
        }
        if (nextIdx < exo.mediaItemCount) {
            runCatching { advanceToQueueIndex(exo, nextIdx) }
            return
        }
        // Plus de média préparé → fill UI si dispo, sinon service (= BG / lecteur fermé)
        val uiFill = Holder.onSkipAtEnd
        if (uiFill != null) {
            uiFill.invoke()
        } else {
            fillAutoplayFromService(advanceAfterFill = true)
        }
    }

    /** Précharge « À suivre » dans Exo — indépendant du toggle auto-avance. */
    private fun ensureServiceAutoplayAhead(exo: Player) {
        if (serviceFillInFlight) return
        val idx = exo.currentMediaItemIndex.coerceAtLeast(0)
        val remaining = (exo.mediaItemCount - idx - 1).coerceAtLeast(0)
        if (remaining >= 6) return
        fillAutoplayFromService(advanceAfterFill = false)
    }

    /**
     * Fill related côté service : marche app en arrière-plan et lecteur plein écran fermé.
     */
    fun requestAutoplayFill(advanceAfterFill: Boolean) {
        fillAutoplayFromService(advanceAfterFill)
    }

    private fun fillAutoplayFromService(advanceAfterFill: Boolean) {
        if (serviceFillInFlight) return
        val exo = player ?: return
        val seed = exo.currentMediaItem?.mediaId
            ?: Holder.queue.getOrNull(Holder.index)?.id
            ?: return
        if (seed.length != 11) return
        serviceFillInFlight = true
        scope.launch {
            try {
                val container = runCatching { YtMusicApp.instance.container }.getOrNull() ?: return@launch
                runCatching { container.ensureFreshToken() }
                val tracks = ovh.delhomme.ytmusic.data.fetchAutoplayTracks(container.api, seed)
                if (tracks.isEmpty()) {
                    AppLog.w("PlaybackService", "autoplay fill vide seed=$seed")
                    return@launch
                }
                val existing = Holder.queue.map { it.id }.toHashSet()
                val toAdd = tracks.filter { it.isPlayable() && it.id !in existing }.take(12)
                if (toAdd.isEmpty()) return@launch
                val base = { id: String -> container.remoteStreamUrl(id) }
                withContext(Dispatchers.Main.immediate) {
                    val p = player ?: return@withContext
                    val startCount = p.mediaItemCount
                    Holder.queue = Holder.queue + toAdd
                    toAdd.forEach { t ->
                        p.addMediaItem(mediaItemFor(t, base, Holder.queueTitle))
                    }
                    AppLog.i(
                        "PlaybackService",
                        "autoplay fill +${toAdd.size} (service) seed=$seed count=$startCount→${p.mediaItemCount}",
                    )
                    if (advanceAfterFill && p.playbackState == Player.STATE_ENDED) {
                        val next = p.currentMediaItemIndex + 1
                        if (next < p.mediaItemCount) {
                            runCatching { advanceToQueueIndex(p, next) }
                        }
                    } else {
                        warmUpcoming(p.currentMediaItemIndex)
                    }
                }
            } finally {
                serviceFillInFlight = false
            }
        }
    }

    /**
     * Saut AUTO au milieu : Exo a encore de l’audio sur CE fichier (pos << exoDur).
     * Ne pas se fier au catalogue YouTube (souvent plus long que le flux) — ça
     * rebouclait la fin du morceau au lieu d’enchaîner.
     */
    private fun streamLooksTruncated(
        pos: Long,
        exoDur: Long,
        catalog: Long?,
        bufferedMs: Long = 0L,
    ): Boolean {
        if (pos < 8_000L) return false
        if (bufferedMs >= 45_000L) {
            if (pos >= bufferedMs - 5_000L || pos.toDouble() / bufferedMs.toDouble() >= 0.92) {
                return false
            }
        }
        if (exoDur >= 45_000L) {
            if (pos.toDouble() / exoDur.toDouble() >= 0.88) return false
            // Vrai milieu de piste seulement (< 72 % Exo) — pas une coda / fin catalogue
            return pos.toDouble() / exoDur.toDouble() < 0.72 && (exoDur - pos) > 8_000L
        }
        val cat = catalog?.takeIf { it >= 45_000L } ?: return false
        // Durée Exo inconnue : seulement un vrai milieu (< 55 % catalogue), pas la coda.
        return pos.toDouble() / cat.toDouble() < 0.55
    }

    /** STATE_ENDED + fichier réellement épuisé → enchaîner, même si le catalogue est plus long. */
    private fun mediaItemActuallyEnded(pos: Long, exoDur: Long): Boolean {
        if (exoDur >= 1_000L && (pos >= exoDur - 2_500L || pos.toDouble() / exoDur.toDouble() >= 0.96)) {
            return true
        }
        if (exoDur <= 0L && pos >= 8_000L) return true
        return false
    }

    /**
     * Retry uniquement si le flux s’arrête *avant* la fin Exo (troncature).
     * Si Exo a vraiment terminé le fichier → jamais retry (évite boucle coda E27).
     */
    private fun shouldRetryEndedAsTruncated(
        trackId: String,
        pos: Long,
        exoDur: Long,
        catalog: Long?,
    ): Boolean {
        if (earlyEndRetries >= 1) return false
        if (recoveringTrackId == trackId && earlyEndRetries > 0) return false
        val cat = catalog?.takeIf { it >= 45_000L } ?: return false
        if (mediaItemActuallyEnded(pos, exoDur)) {
            // Flux réellement terminé → enchaîner. Ne jamais rejouer la coda
            // juste parce que le catalogue YTM est plus long (boucle E27).
            return false
        }
        if (exoDur >= 45_000L && pos.toDouble() / exoDur.toDouble() >= 0.85) return false
        return pos >= 8_000L && pos.toDouble() / cat.toDouble() < 0.75
    }

    /**
     * Si Exo passe au suivant alors que le titre précédent n’a pas atteint ~85 %
     * de sa durée **Exo** → stream tronqué / cache empoisonné : on revient et on retente.
     */
    private fun maybeRecoverEarlyEnd(
        exo: Player,
        snapPrevId: String,
        snapPrevPos: Long,
        snapPrevDur: Long,
        snapPrevBuf: Long = 0L,
        fromStateEnded: Boolean = false,
    ) {
        val prevId = snapPrevId.trim()
        val pos = snapPrevPos.coerceAtLeast(0L)
        if (prevId.isBlank() || earlyEndRetries >= 2) return
        // Race seek (pos≈0 du nouveau titre). Un vrai mid-track à 8–15 s doit être repris.
        if (pos < 8_000L) {
            AppLog.d(
                "PlaybackService",
                "early_end ignoré (trop tôt / race) id=$prevId pos=${pos}ms",
            )
            return
        }
        val track = Holder.queue.firstOrNull { it.id == prevId } ?: return
        val exoDur = snapPrevDur.takeIf { it >= 45_000L }
        val catalog = track.durationMsOrNull()?.takeIf { it >= 45_000L }
        val bufEnd = snapPrevBuf.takeIf { it >= 45_000L }
        if (fromStateEnded) {
            if (mediaItemActuallyEnded(pos, snapPrevDur) || earlyEndRetries >= 1) return
        } else if (!streamLooksTruncated(pos, exoDur ?: 0L, catalog, bufEnd ?: 0L)) {
            // Fin naturelle selon le conteneur réel
            if (exoDur != null && pos.toDouble() / exoDur.toDouble() >= 0.90) {
                AppLog.d(
                    "PlaybackService",
                    "early_end ignoré (EOS Exo) id=$prevId pos=$pos exoDur=$exoDur catalog=$catalog",
                )
                recoveringTrackId = ""
                earlyEndRetries = 0
                return
            }
            if (
                exoDur == null &&
                bufEnd != null &&
                pos.toDouble() / bufEnd.toDouble() >= 0.92
            ) {
                AppLog.d(
                    "PlaybackService",
                    "early_end ignoré (EOS buffer) id=$prevId pos=$pos buf=$bufEnd catalog=$catalog",
                )
                recoveringTrackId = ""
                earlyEndRetries = 0
                return
            }
            val expectedEarly = catalog ?: exoDur ?: return
            if (pos.toDouble() / expectedEarly.toDouble() >= 0.88) return
        }
        val expected = catalog ?: exoDur ?: return
        val ratio = pos.toDouble() / expected.toDouble()
        val prevIdx = Holder.queue.indexOfFirst { it.id == prevId }
        if (prevIdx < 0) return
        val curIdx = exo.currentMediaItemIndex
        // Encore sur le même titre : ne pas « récupérer » près de la fin (catalogue > flux)
        if (!fromStateEnded && exo.currentMediaItem?.mediaId == prevId) {
            val dur = snapPrevDur.takeIf { it >= 45_000L } ?: return
            if (pos.toDouble() / dur.toDouble() >= 0.72) return
        }
        // Ne jamais rebobiner vers un titre déjà passé (race async / prevPlayingId périmé)
        if (prevIdx < curIdx) {
            AppLog.d(
                "PlaybackService",
                "early_end ignoré (titre déjà passé) id=$prevId prevIdx=$prevIdx curIdx=$curIdx",
            )
            return
        }
        if (fromStateEnded && prevIdx != curIdx) {
            AppLog.d(
                "PlaybackService",
                "early_end ignoré (EOS idx mismatch) id=$prevId prevIdx=$prevIdx curIdx=$curIdx",
            )
            return
        }
        recoveringTrackId = prevId
        earlyEndRetries += 1
        val ratioLabel = String.format(java.util.Locale.US, "%.2f", ratio)
        AppLog.w(
            "PlaybackService",
            "fin trop tôt id=$prevId pos=${pos}ms expected=${expected}ms ratio=$ratioLabel → retry #$earlyEndRetries ended=$fromStateEnded",
        )
        val diag = buildString {
            appendLine("android.player.early_end")
            appendLine("trackId=$prevId posMs=$pos expectedMs=$expected ratio=$ratioLabel retry=$earlyEndRetries")
            appendLine("queueSize=${Holder.queue.size} index=${Holder.index} userEnd=${Holder.userQueueEnd}")
            appendLine()
            appendLine("--- breadcrumbs ---")
            AppLog.breadcrumbSnapshot().takeLast(30).forEach { appendLine(it) }
            appendLine()
            appendLine("--- recent logs ---")
            append(AppLog.recentLogText(20_000))
        }
        runCatching {
            // warn : récupération auto, pas une crash — évite spam email ; logs + stack pour debug
            ovh.delhomme.ytmusic.debug.TelemetryReporter.report(
                level = if (earlyEndRetries >= 2) "error" else "warn",
                kind = "android.player.early_end",
                message = "early end $prevId pos=$pos expected=$expected ratio=$ratioLabel",
                stack = diag,
                meta = mapOf(
                    "trackId" to prevId,
                    "positionMs" to pos,
                    "expectedMs" to expected,
                    "ratio" to ratio,
                    "retry" to earlyEndRetries,
                    "breadcrumbs" to AppLog.breadcrumbSnapshot().takeLast(40),
                    "recentLogs" to AppLog.recentLogText(24_000),
                ),
                force = earlyEndRetries >= 2,
            )
        }
        val container = runCatching { YtMusicApp.instance.container }.getOrNull()
        val attempt = recoverGen.incrementAndGet()
        scope.launch {
            if (attempt != recoverGen.get()) return@launch
            if (exo.currentMediaItemIndex > prevIdx) return@launch
            if (fromStateEnded && exo.currentMediaItem?.mediaId != prevId) return@launch
            runCatching { PlayerCache.invalidate(this@PlaybackService, prevId) }
            if (container?.offlineStore?.has(prevId) == true) {
                runCatching { container.offlineStore.remove(prevId) }
            }
            // Bust format côté API (URL/CDN morte) puis URI avec cache-buster Exo
            runCatching {
                withTimeout(8_000L) {
                    container?.api?.streamResolveUrl(prevId)
                }
            }
            val bust = System.currentTimeMillis()
            val rebuilt = mediaItemFor(
                track,
                { tid ->
                    val base = container?.remoteStreamUrl(tid)
                        ?: (Holder.resolvedApiBase() + "/api/stream/$tid")
                    val sep = if (base.contains('?')) '&' else '?'
                    "$base${sep}r=$bust"
                },
                Holder.queueTitle,
            )
            // Reprendre à la coupure — jamais pos-4s (ça reboucle la coda).
            val resumeAt = pos.coerceAtLeast(0L)
            runCatching {
                if (attempt != recoverGen.get()) return@runCatching
                if (exo.currentMediaItemIndex > prevIdx) return@runCatching
                exo.replaceMediaItem(prevIdx, rebuilt)
                exo.seekTo(prevIdx, resumeAt)
                exo.prepare()
                exo.playWhenReady = true
                exo.play()
                Holder.index = prevIdx
                lastPlayingId = prevId
                lastPlayingPosMs = resumeAt
            }
        }
    }

    private fun warmUpcoming(fromIndex: Int) {
        if (StreamPrefetcher.isStreamDown()) return
        val queue = Holder.queue
        if (queue.isEmpty()) return
        val base = resolvedApiBase()
        StreamPrefetcher.warmAround(
            base,
            queue.map { it.id },
            fromIndex,
            ahead = 12,
            behind = 0,
        )
        CoverPrefetcher.warmCovers(queue, fromIndex, ahead = 6, behind = 0)
        enqueueOfflineAhead(fromIndex)
    }

    /** Near-end : uniquement +1 (coupe far-prefetch + offline pour libérer bande + cache). */
    private fun warmExclusiveNext(fromIndex: Int) {
        if (StreamPrefetcher.isStreamDown()) return
        val queue = Holder.queue
        if (queue.isEmpty()) return
        val ids = queue.map { it.id }
        val nextId = ids.getOrNull(fromIndex + 1)
        StreamPrefetcher.cancelIdle(preserveNext = true)
        runCatching {
            YtMusicApp.instance.container.downloadManager.cancelAll()
        }
        if (nextId != null && nextId.length == 11) {
            PlayerCache.pinTrack(nextId)
        }
        StreamPrefetcher.prefetchNextDuringPlayback(
            resolvedApiBase(),
            ids,
            fromIndex,
            ignoreQuiet = true,
        )
        CoverPrefetcher.warmCovers(queue, fromIndex, ahead = 1, behind = 0)
    }

    /** Télécharge silencieusement +1 titre offline (Wi‑Fi, hors BatterySaver / near-end). */
    private fun enqueueOfflineAhead(fromIndex: Int) {
        // Pendant une vraie lecture : laisse la bande au titre courant + prefetch +1 (pas de DL offline).
        val exo = player
        if (exo != null && (exo.isPlaying || exo.playWhenReady)) return
        if (StreamPrefetcher.isQuiet()) return
        if (ovh.delhomme.ytmusic.data.BatterySaver.isActive()) return
        if (exo != null) {
            val d = exo.duration
            val pos = exo.currentPosition
            if (d > 0L && d != C.TIME_UNSET && d - pos < 45_000L) return
        }
        val queue = Holder.queue
        if (queue.isEmpty()) return
        val ahead = queue.drop((fromIndex + 1).coerceAtLeast(0))
        if (ahead.isEmpty()) return
        runCatching {
            ovh.delhomme.ytmusic.YtMusicApp.instance.container.downloadManager
                .enqueueAheadDuringPlayback(ahead, limit = 1)
        }
        val p = player ?: return
        promoteUpcomingToLocal(p, fromIndex + 1)
    }

    /**
     * Remplace les MediaItem HTTP des titres suivants par `file://` dès qu’un DL est prêt
     * **uniquement hors-ligne**. En ligne : rebascule file:// → proxy (les .m4a locaux
     * provoquaient des KO mid-song + mails « local=true »).
     */
    private fun promoteUpcomingToLocal(exo: ExoPlayer, fromIndex: Int) {
        val container = runCatching { YtMusicApp.instance.container }.getOrNull() ?: return
        val online = runCatching {
            ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()
        }.getOrDefault(true)
        val queue = Holder.queue
        val start = fromIndex.coerceAtLeast(0)
        val end = (start + 4).coerceAtMost(minOf(queue.size, exo.mediaItemCount))
        for (i in start until end) {
            val track = queue.getOrNull(i) ?: continue
            val cur = exo.getMediaItemAt(i)
            val scheme = cur.localConfiguration?.uri?.scheme
            if (online) {
                // Remonter au proxy si un file:// trainait depuis une session hors-ligne
                if (scheme != "file") continue
                runCatching {
                    exo.replaceMediaItem(
                        i,
                        mediaItemFor(track, { tid -> container.remoteStreamUrl(tid) }, Holder.queueTitle),
                    )
                }
                continue
            }
            if (!container.offlineStore.has(track.id)) continue
            if (scheme == "file") continue
            runCatching {
                exo.replaceMediaItem(
                    i,
                    mediaItemFor(track, { tid -> container.streamUrl(tid) }, Holder.queueTitle),
                )
            }
        }
    }

    /** Si le titre courant est encore file:// en Wi‑Fi → proxy immédiat (évite KO local). */
    private fun demoteCurrentLocalIfOnline(exo: Player) {
        val scheme = exo.currentMediaItem?.localConfiguration?.uri?.scheme ?: return
        if (scheme != "file") return
        val online = runCatching {
            ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()
        }.getOrDefault(true)
        if (!online) return
        val container = runCatching { YtMusicApp.instance.container }.getOrNull() ?: return
        val id = exo.currentMediaItem?.mediaId ?: return
        val track = Holder.queue.firstOrNull { it.id == id } ?: return
        val pos = exo.currentPosition.coerceAtLeast(0L)
        val wantPlay = exo.playWhenReady || exo.isPlaying
        AppLog.i("PlaybackService", "demote local→proxy id=$id pos=$pos")
        runCatching {
            val idx = exo.currentMediaItemIndex.coerceAtLeast(0)
            exo.replaceMediaItem(
                idx,
                mediaItemFor(track, { tid -> container.remoteStreamUrl(tid) }, Holder.queueTitle),
            )
            exo.seekTo(idx, pos)
            exo.prepare()
            if (wantPlay) {
                exo.playWhenReady = true
                exo.play()
            }
        }
    }

    /**
     * Reconstruit l’URI du titre courant (proxy frais) et reprend à la position.
     * À appeler après Wi‑Fi ↔ 4G, coupure données, ou retour en ligne.
     * @param wipeCache false sur stall (garde les octets déjà en cache Exo).
     */
    fun rebindCurrentStream(
        reason: String,
        forcePlay: Boolean = true,
        seekPos: Long? = null,
        retryN: Int = 0,
        wipeCache: Boolean = true,
    ) {
        val exo = player ?: return
        if (exo.mediaItemCount <= 0) return
        val id = exo.currentMediaItem?.mediaId ?: return
        if (id.isBlank()) return
        val scheme = exo.currentMediaItem?.localConfiguration?.uri?.scheme
        if (scheme == "file") {
            if (forcePlay && !exo.isPlaying) {
                runCatching {
                    exo.prepare()
                    exo.playWhenReady = true
                    exo.play()
                }
            }
            return
        }
        val container = runCatching { YtMusicApp.instance.container }.getOrNull() ?: return
        val track = Holder.queue.firstOrNull { it.id == id } ?: return
        val pos = (seekPos ?: bestKnownPos(exo)).coerceAtLeast(0L)
        // Coupure pile à la fin : enchaîner, ne pas rebobiner (ex. 215s → 146s).
        val durGuess = when {
            exo.duration > 0L && exo.duration != C.TIME_UNSET -> exo.duration
            lastPlayingDurationMs > 0L -> lastPlayingDurationMs
            else -> 0L
        }
        if (durGuess >= 45_000L && (pos.toDouble() / durGuess >= 0.90 || durGuess - pos <= 4_000L)) {
            AppLog.i("PlaybackService", "rebind skipped (EOS) reason=$reason id=$id pos=$pos dur=$durGuess")
            handleNaturalEnd(exo)
            return
        }
        val wantPlay = forcePlay || exo.playWhenReady || exo.isPlaying
        recoverGen.incrementAndGet()
        streamFailStreak.set(0)
        StreamPrefetcher.markStreamOk()
        val bust = System.currentTimeMillis()
        val retry = retryN.coerceAtLeast(recoverGen.get()).coerceAtLeast(1)
        val rebuilt = mediaItemFor(
            track,
            { tid ->
                val base = container.remoteStreamUrl(tid, retry = retry)
                val sep = if (base.contains('?')) '&' else '?'
                "$base${sep}r=$bust"
            },
            Holder.queueTitle,
        )
        AppLog.i(
            "PlaybackService",
            "rebindCurrentStream reason=$reason id=$id pos=$pos play=$wantPlay wipe=$wipeCache",
        )
        if (wipeCache) {
            runCatching { PlayerCache.invalidate(this, id) }
        }
        runCatching {
            val idx = exo.currentMediaItemIndex.coerceAtLeast(0)
            exo.replaceMediaItem(idx, rebuilt)
            exo.seekTo(idx, pos)
            exo.prepare()
            if (wantPlay) {
                exo.playWhenReady = true
                exo.play()
            }
        }
    }

    /** Handover : ne casse pas une lecture qui avance déjà, ni une pause utilisateur. */
    fun rebindIfStalled(reason: String) {
        val exo = player ?: return
        if (exo.mediaItemCount <= 0) return
        if (!exo.playWhenReady && !exo.isPlaying) return
        val stalled =
            exo.playbackState == Player.STATE_BUFFERING ||
                exo.playbackState == Player.STATE_IDLE ||
                (exo.playWhenReady && !exo.isPlaying)
        if (!stalled) return
        rebindCurrentStream(reason, forcePlay = true)
    }

    private fun persistPlaybackSnapshot(durable: Boolean) {
        val exo = player ?: return
        val queue = Holder.queue
        if (queue.isEmpty()) return
        val now = System.currentTimeMillis()
        val must = durable
        val interval = if (exo.isPlaying || exo.playWhenReady) 3_500L else 8_000L
        if (!must && now - lastPersistAt < interval) return
        lastPersistAt = now
        val idx = exo.currentMediaItemIndex.coerceAtLeast(0).coerceAtMost(queue.lastIndex)
        runCatching {
            YtMusicApp.instance.container.localPlayback.save(
                ovh.delhomme.ytmusic.data.LocalPlaybackStore.Snapshot(
                    queue = queue,
                    queueIndex = idx,
                    positionMs = exo.currentPosition.coerceAtLeast(0L),
                    userQueueEnd = Holder.userQueueEnd.coerceIn(0, queue.size),
                    queueTitle = Holder.queueTitle,
                    wasPlaying = exo.isPlaying || exo.playWhenReady,
                ),
                durable = true,
            )
        }
    }

    /**
     * Reconstruit la file à partir de [startIdx] en priorisant les fichiers locaux,
     * puis saute à cet index et reprend la lecture.
     */
    private fun rematerializeOfflineFrom(
        exo: ExoPlayer,
        startIdx: Int,
        container: ovh.delhomme.ytmusic.data.AppContainer?,
    ) {
        if (container == null) return
        val queue = Holder.queue
        if (queue.isEmpty() || startIdx !in queue.indices) return
        val items = queue.map { t ->
            mediaItemFor(t, { id -> container.streamUrl(id) }, Holder.queueTitle)
        }
        runCatching {
            exo.setMediaItems(items, startIdx, 0L)
            exo.prepare()
            exo.playWhenReady = true
            exo.play()
            Holder.index = startIdx
        }
    }

    private fun resolvedApiBase(): String = Holder.resolvedApiBase()

    object Holder {
        @Volatile var player: ExoPlayer? = null
        @Volatile var service: PlaybackService? = null
        @Volatile var queue: List<TrackDto> = emptyList()
        @Volatile var index: Int = 0
        @Volatile var queueTitle: String = "File d'attente"
        @Volatile var likedIds: Set<String> = emptySet()
        @Volatile var onLikedIdsChanged: ((Set<String>) -> Unit)? = null
        /** Skip à la fin de file (1 titre) → fill autoplay côté UI. */
        @Volatile var onSkipAtEnd: (() -> Unit)? = null
        /** Shuffle « suite only » / cycle repeat — délégué au PlayerController UI. */
        @Volatile var onToggleShuffle: (() -> Unit)? = null
        @Volatile var onCycleRepeat: (() -> Unit)? = null
        /** Frontière file utilisateur / suggestions. */
        @Volatile var userQueueEnd: Int = 0
        /** Auto-avance dans « À suivre » (sinon stop en fin de file user). */
        @Volatile var autoplaySuggestions: Boolean = true
        /** Service détruit (idle guard / OS) → invalider MediaController UI. */
        @Volatile var onServiceStopped: (() -> Unit)? = null
        /** Mis à jour sur le thread principal — lecture depuis IO sans toucher ExoPlayer. */
        @Volatile var playbackActive: Boolean = false

        fun isPlaybackActiveSafe(): Boolean = playbackActive

        fun fillAtEnd(advance: Boolean = true) {
            service?.requestAutoplayFill(advance)
        }

        fun resolvedApiBase(): String {
            val override = service
                ?.getSharedPreferences("ytm_api", android.content.Context.MODE_PRIVATE)
                ?.getString("base_url", null)
                ?.trim()
                ?.trimEnd('/')
            return if (!override.isNullOrBlank()) override else BuildConfig.API_BASE_URL.trimEnd('/')
        }

        fun syncLikedIds(ids: Set<String>) {
            likedIds = ids
            service?.refreshMediaButtons()
        }
    }

    companion object {
        const val ACTION_TOGGLE_LIKE = "ytm.action.TOGGLE_LIKE"
        const val ACTION_CYCLE_REPEAT = "ytm.action.CYCLE_REPEAT"
        const val ACTION_TOGGLE_SHUFFLE = "ytm.action.TOGGLE_SHUFFLE"
        const val ACTION_ADD_PLAYLIST = "ytm.action.ADD_PLAYLIST"
        const val ACTION_OPEN_LYRICS = "ytm.action.OPEN_LYRICS"
    }
}

/**
 * Expose toujours next/prev à la notification système, avec wrap de file
 * (comme [PlayerController.skipNext] / skipPrev).
 */
@OptIn(UnstableApi::class)
private class YtmForwardingPlayer(
    private val exo: ExoPlayer,
) : ForwardingPlayer(exo) {
    override fun getAvailableCommands(): Player.Commands =
        super.getAvailableCommands().buildUpon()
            .add(COMMAND_SEEK_TO_NEXT)
            .add(COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
            .add(COMMAND_SEEK_TO_PREVIOUS)
            .add(COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
            .build()

    override fun isCommandAvailable(command: @Player.Command Int): Boolean =
        when (command) {
            COMMAND_SEEK_TO_NEXT,
            COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
            COMMAND_SEEK_TO_PREVIOUS,
            COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
            -> true
            else -> super.isCommandAvailable(command)
        }

    override fun seekToNext() = seekToNextMediaItem()

    override fun seekToNextMediaItem() {
        val wasOne = exo.repeatMode == Player.REPEAT_MODE_ONE
        if (wasOne) exo.repeatMode = Player.REPEAT_MODE_OFF
        val cur = exo.currentMediaItemIndex
        val offline = !ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()
        val store = runCatching { ovh.delhomme.ytmusic.YtMusicApp.instance.container.offlineStore }.getOrNull()
        val nextIdx = when {
            offline && store != null -> {
                val q = PlaybackService.Holder.queue
                (cur + 1 until q.size).firstOrNull { store.has(q[it].id) }
                    ?: if (exo.repeatMode == Player.REPEAT_MODE_ALL) {
                        q.indices.firstOrNull { store.has(q[it].id) }
                    } else {
                        null
                    }
                    ?: cur
            }
            exo.hasNextMediaItem() -> cur + 1
            exo.repeatMode == Player.REPEAT_MODE_ALL && exo.mediaItemCount > 0 -> 0
            exo.mediaItemCount > 1 -> (cur + 1) % exo.mediaItemCount
            else -> cur
        }
        // Chauffe le titre cible + le suivant avant / pendant le seek (notif + UI)
        warmAroundIndex(nextIdx)
        when {
            offline && store != null && nextIdx != cur &&
                store.has(PlaybackService.Holder.queue.getOrNull(nextIdx)?.id.orEmpty()) -> {
                exo.seekTo(nextIdx, 0L)
                exo.prepare()
                exo.play()
            }
            exo.hasNextMediaItem() && !(offline && store != null) -> {
                exo.seekToNextMediaItem()
                if (exo.playbackState == Player.STATE_IDLE) exo.prepare()
                exo.playWhenReady = true
                exo.play()
            }
            exo.repeatMode == Player.REPEAT_MODE_ALL && exo.mediaItemCount > 0 -> {
                exo.seekTo(/* mediaItemIndex */ 0, /* positionMs */ 0L)
                if (exo.playbackState == Player.STATE_IDLE) exo.prepare()
                exo.playWhenReady = true
                exo.play()
            }
            exo.mediaItemCount > 1 && !(offline && store != null) -> {
                exo.seekTo(nextIdx, 0L)
                if (exo.playbackState == Player.STATE_IDLE) exo.prepare()
                exo.playWhenReady = true
                exo.play()
            }
            offline && store != null -> {
                // Pas d’autre titre local — rester
                val ctx = ovh.delhomme.ytmusic.YtMusicApp.instance
                android.os.Handler(ctx.mainLooper).post {
                    ctx.toastMain("Hors ligne — pas d’autre titre téléchargé", Toast.LENGTH_SHORT)
                }
            }
            else -> {
                // Ne pas relancer le même titre — fill UI ou service (BG)
                val ui = PlaybackService.Holder.onSkipAtEnd
                if (ui != null) ui.invoke() else PlaybackService.Holder.fillAtEnd(advance = true)
            }
        }
        if (wasOne) exo.repeatMode = Player.REPEAT_MODE_ONE
    }

    private fun warmAroundIndex(index: Int) {
        val queue = PlaybackService.Holder.queue
        if (queue.isEmpty()) return
        val api = PlaybackService.Holder.resolvedApiBase()
        StreamPrefetcher.warmAround(api, queue.map { it.id }, index, ahead = 12, behind = 0)
        CoverPrefetcher.warmCovers(queue, index, ahead = 6, behind = 0)
    }

    override fun seekToPrevious() = seekToPreviousMediaItem()

    override fun seekToPreviousMediaItem() {
        when {
            exo.currentPosition > 3_000L -> exo.seekTo(0L)
            exo.hasPreviousMediaItem() -> exo.seekToPreviousMediaItem()
            exo.mediaItemCount > 1 -> exo.seekTo(exo.mediaItemCount - 1, 0L)
            else -> exo.seekTo(0L)
        }
    }
}

fun ExoPlayer.playTracks(baseStreamUrl: (String) -> String, tracks: List<TrackDto>, startIndex: Int) {
    val playable = tracks.filter { it.isPlayable() }
    if (playable.isEmpty()) return
    val maxItems = 80
    val (window, idx) = if (playable.size > maxItems) {
        val half = maxItems / 2
        val raw = startIndex.coerceIn(0, playable.lastIndex)
        val from = (raw - half).coerceAtLeast(0)
        val to = (from + maxItems).coerceAtMost(playable.size)
        val slice = playable.subList(from, to)
        slice to (raw - from).coerceIn(0, slice.lastIndex)
    } else {
        playable to startIndex.coerceIn(0, playable.lastIndex)
    }
    PlaybackService.Holder.queue = window
    PlaybackService.Holder.index = idx
    StreamPrefetcher.quietPrefetch(120L)
    val current = window.getOrNull(idx)
    if (current != null && current.id.length == 11) {
        StreamPrefetcher.warmTrackFormatOnly(PlaybackService.Holder.resolvedApiBase(), current.id)
    }
    CoverPrefetcher.warmCovers(window, idx, ahead = 3, behind = 1)
    // Courant + 3 suivants d’abord → prepare/play immédiat, reste de la fenêtre ensuite.
    val leadTo = (idx + 4).coerceAtMost(window.size)
    val lead = window.subList(idx, leadTo)
    setMediaItems(lead.map { mediaItemFor(it, baseStreamUrl, PlaybackService.Holder.queueTitle) }, 0, 0L)
    volume = PLAYBACK_VOLUME
    prepare()
    playWhenReady = true
    if (idx > 0) {
        addMediaItems(
            0,
            window.subList(0, idx).map { mediaItemFor(it, baseStreamUrl, PlaybackService.Holder.queueTitle) },
        )
    }
    if (leadTo < window.size) {
        addMediaItems(
            window.subList(leadTo, window.size).map {
                mediaItemFor(it, baseStreamUrl, PlaybackService.Holder.queueTitle)
            },
        )
    }
}

fun mediaItemFor(
    t: TrackDto,
    baseStreamUrl: (String) -> String,
    queueTitle: String = PlaybackService.Holder.queueTitle,
): MediaItem {
    val cover = t.coverUrl(sizeHint = 600)
    val album = t.album?.name?.takeIf { it.isNotBlank() } ?: queueTitle
    val meta = MediaMetadata.Builder()
        .setTitle(t.title)
        .setArtist(t.artistLine())
        .setAlbumTitle(album)
        .setSubtitle(t.artistLine())
        .setArtworkUri(cover?.let { android.net.Uri.parse(it) })
        .setMediaType(MediaMetadata.MEDIA_TYPE_MUSIC)
        .setIsPlayable(true)
    // Ne pas figer durationMs depuis YTM : un écart vs le flux réel fausse la barre
    // et masque les fins anticipées. Exo lit la durée dans le conteneur.
    return MediaItem.Builder()
        .setMediaId(t.id)
        .setUri(baseStreamUrl(t.id))
        .setCustomCacheKey(PlayerCache.keyFor(t.id))
        .setMediaMetadata(meta.build())
        .build()
}
