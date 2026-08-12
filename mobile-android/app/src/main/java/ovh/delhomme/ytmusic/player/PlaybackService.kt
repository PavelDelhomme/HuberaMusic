package ovh.delhomme.ytmusic.player

import android.app.PendingIntent
import android.content.Intent
import android.os.Bundle
import androidx.annotation.OptIn
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
    private val scope = CoroutineScope(
        SupervisorJob() + Dispatchers.Main.immediate + CrashReporter.coroutineHandler("PlaybackService"),
    )

    private val cmdLike = SessionCommand(ACTION_TOGGLE_LIKE, Bundle.EMPTY)
    private val cmdCycleRepeat = SessionCommand(ACTION_CYCLE_REPEAT, Bundle.EMPTY)
    private val cmdToggleShuffle = SessionCommand(ACTION_TOGGLE_SHUFFLE, Bundle.EMPTY)

    private val recoverGen = AtomicInteger(0)
    private val streamFailStreak = AtomicInteger(0)
    /** Snapshot pour détecter une fin de piste trop tôt (stream tronqué / cache). */
    @Volatile private var lastPlayingId: String = ""
    @Volatile private var lastPlayingPosMs: Long = 0L
    @Volatile private var prevPlayingId: String = ""
    @Volatile private var prevPlayingPosMs: Long = 0L
    @Volatile private var earlyEndRetries: Int = 0

    private val playerListener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) {
            if (player.playbackState == Player.STATE_READY || player.isPlaying) {
                val id = player.currentMediaItem?.mediaId.orEmpty()
                if (id.isNotBlank()) {
                    if (id != lastPlayingId) {
                        prevPlayingId = lastPlayingId
                        prevPlayingPosMs = lastPlayingPosMs
                        lastPlayingId = id
                        if (earlyEndRetries > 0 && id != prevPlayingId) {
                            // Nouveau titre « normal » après reprise
                            earlyEndRetries = 0
                        }
                    } else {
                        lastPlayingPosMs = player.currentPosition.coerceAtLeast(0L)
                    }
                }
            }
            if (
                events.contains(Player.EVENT_SHUFFLE_MODE_ENABLED_CHANGED) ||
                events.contains(Player.EVENT_REPEAT_MODE_CHANGED) ||
                events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION) ||
                events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) ||
                events.contains(Player.EVENT_IS_PLAYING_CHANGED) ||
                events.contains(Player.EVENT_MEDIA_METADATA_CHANGED)
            ) {
                refreshMediaButtons()
                ensureCurrentItemMetadata()
            }
            if (events.contains(Player.EVENT_MEDIA_ITEM_TRANSITION)) {
                warmUpcoming(player.currentMediaItemIndex)
                enqueueOfflineAhead(player.currentMediaItemIndex)
                scope.launch {
                    delay(120)
                    refreshMediaButtons()
                    ensureCurrentItemMetadata()
                    delay(400)
                    refreshMediaButtons()
                }
            }
            if (
                events.contains(Player.EVENT_PLAYBACK_STATE_CHANGED) &&
                player.playbackState == Player.STATE_READY &&
                player.playWhenReady
            ) {
                streamFailStreak.set(0)
                StreamPrefetcher.markStreamOk()
            }
            if (
                events.contains(Player.EVENT_PLAY_WHEN_READY_CHANGED) &&
                !player.playWhenReady
            ) {
                StreamPrefetcher.cancelIdle()
            }
        }

        override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
            if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) {
                val exo = player ?: return
                maybeRecoverEarlyEnd(exo)
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
                        android.widget.Toast.makeText(
                            this@PlaybackService,
                            "Fin de la file — active « À suivre » pour continuer",
                            android.widget.Toast.LENGTH_SHORT,
                        ).show()
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
            val streak = streamFailStreak.incrementAndGet()
            AppLog.w(
                "PlaybackService",
                "onPlayerError code=${error.errorCode} network=$networkish local=$localFile streak=$streak id=$id",
                error,
            )
            runCatching {
                ovh.delhomme.ytmusic.debug.TelemetryReporter.reportPlayerError(
                    code = error.errorCode,
                    trackId = id,
                    networkish = networkish,
                    local = localFile,
                    streak = streak,
                    detail = error.stackTraceToString().take(4_000),
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
                        android.widget.Toast.makeText(
                            this@PlaybackService,
                            "Fichier local KO — reprise en streaming…",
                            android.widget.Toast.LENGTH_SHORT,
                        ).show()
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
                        android.widget.Toast.makeText(
                            this@PlaybackService,
                            "Fichier local KO — suite hors ligne",
                            android.widget.Toast.LENGTH_SHORT,
                        ).show()
                    }
                    return
                }
                android.os.Handler(mainLooper).post {
                    android.widget.Toast.makeText(
                        this@PlaybackService,
                        "Lecture locale impossible",
                        android.widget.Toast.LENGTH_SHORT,
                    ).show()
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
                            mediaItemFor(track, { tid -> container.streamUrl(tid) }, Holder.queueTitle)
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
                            android.widget.Toast.makeText(
                                this@PlaybackService,
                                "Hors ligne — suite sur titres téléchargés",
                                android.widget.Toast.LENGTH_SHORT,
                            ).show()
                        }
                        return
                    }
                    StreamPrefetcher.markStreamDown()
                    StreamPrefetcher.cancelIdle()
                    recoverGen.incrementAndGet()
                    exo.playWhenReady = false
                    runCatching { exo.stop() }
                    streamFailStreak.set(0)
                    ovh.delhomme.ytmusic.data.NetworkMonitor.markPausedForNetwork()
                    android.os.Handler(mainLooper).post {
                        android.widget.Toast.makeText(
                            this@PlaybackService,
                            "Hors ligne — télécharge des titres (⋮) pour continuer",
                            android.widget.Toast.LENGTH_SHORT,
                        ).show()
                    }
                    return
                }
                // Encore « online » : glitch / handover — retenter le MÊME titre (pas de skip)
                if (streak <= 4) {
                    val attempt = recoverGen.incrementAndGet()
                    scope.launch {
                        runCatching { PlayerCache.invalidate(this@PlaybackService, id) }
                        delay(400L * streak)
                        if (attempt != recoverGen.get()) return@launch
                        if (exo.currentMediaItem?.mediaId != id) return@launch
                        runCatching {
                            val pos = exo.currentPosition.coerceAtLeast(0L)
                            val track = Holder.queue.firstOrNull { it.id == id }
                            val nextItem = if (track != null && container != null) {
                                mediaItemFor(track, { tid -> container.streamUrl(tid) }, Holder.queueTitle)
                            } else {
                                item
                            }
                            exo.setMediaItem(nextItem, pos)
                            exo.prepare()
                            exo.playWhenReady = true
                        }
                    }
                    if (streak == 1 || streak == 3) {
                        android.os.Handler(mainLooper).post {
                            android.widget.Toast.makeText(
                                this@PlaybackService,
                                "Réseau instable — reprise…",
                                android.widget.Toast.LENGTH_SHORT,
                            ).show()
                        }
                    }
                    return
                }
                // Échecs réseau répétés alors que le device se dit en ligne → pause (pas de skip)
                StreamPrefetcher.markStreamDown()
                StreamPrefetcher.cancelIdle()
                recoverGen.incrementAndGet()
                exo.playWhenReady = false
                runCatching { exo.stop() }
                streamFailStreak.set(0)
                ovh.delhomme.ytmusic.data.NetworkMonitor.markPausedForNetwork()
                android.os.Handler(mainLooper).post {
                    val localApi = BuildConfig.API_BASE_URL.contains("127.0.0.1") ||
                        BuildConfig.API_BASE_URL.contains("192.168.") ||
                        BuildConfig.API_BASE_URL.contains("10.") ||
                        BuildConfig.API_BASE_URL.startsWith("http://")
                    android.widget.Toast.makeText(
                        this@PlaybackService,
                        when {
                            localApi -> "API locale injoignable (port 8787 ?) — ou change de réseau"
                            else -> "Connexion perdue — vérifie le réseau (Wi‑Fi / données)"
                        },
                        android.widget.Toast.LENGTH_LONG,
                    ).show()
                }
                return
            }

            if (streak >= 2) {
                StreamPrefetcher.markStreamDown()
                StreamPrefetcher.cancelIdle()
                recoverGen.incrementAndGet()
                exo.playWhenReady = false
                runCatching { exo.stop() }
                streamFailStreak.set(0)
                android.os.Handler(mainLooper).post {
                    val localApi = BuildConfig.API_BASE_URL.contains("127.0.0.1") ||
                        BuildConfig.API_BASE_URL.contains("192.168.") ||
                        BuildConfig.API_BASE_URL.contains("10.") ||
                        BuildConfig.API_BASE_URL.startsWith("http://")
                    android.widget.Toast.makeText(
                        this@PlaybackService,
                        if (localApi) {
                            "Lecture impossible — API locale (8787) ou flux YouTube"
                        } else {
                            "Lecture impossible — réessaie ou vérifie le réseau"
                        },
                        android.widget.Toast.LENGTH_LONG,
                    ).show()
                }
                return
            }

            // 1 seul reprepare (CDN / proxy expiré) — ne compte pas comme « recovered » sync
            val attempt = recoverGen.incrementAndGet()
            scope.launch {
                runCatching { PlayerCache.invalidate(this@PlaybackService, id) }
                delay(200)
                if (attempt != recoverGen.get()) return@launch
                if (exo.currentMediaItem?.mediaId != id) return@launch
                runCatching {
                    val pos = exo.currentPosition.coerceAtLeast(0L)
                    exo.setMediaItem(item, pos)
                    exo.prepare()
                    exo.playWhenReady = true
                }
                // Si ça échoue encore → 2ᵉ onPlayerError → stop (streak >= 2)
            }
        }

        private fun isNetworkOrServerError(error: PlaybackException): Boolean {
            when (error.errorCode) {
                PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
                PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
                PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS,
                PlaybackException.ERROR_CODE_TIMEOUT,
                -> return true
            }
            var c: Throwable? = error.cause
            var depth = 0
            while (c != null && depth++ < 6) {
                val name = c.javaClass.name
                if (
                    c is java.net.UnknownHostException ||
                    c is java.net.ConnectException ||
                    c is java.net.SocketTimeoutException ||
                    c is java.io.InterruptedIOException ||
                    name.contains("UnknownHost") ||
                    name.contains("ConnectException") ||
                    name.contains("SocketTimeout")
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
                    "504" in msg
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

        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                /* minBufferMs */ 15_000,
                /* maxBufferMs */ 70_000,
                /* bufferForPlaybackMs */ 750,
                /* bufferForPlaybackAfterRebufferMs */ 2_000,
            )
            .setPrioritizeTimeOverSizeThresholds(true)
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
                /* handleAudioFocus= */ true,
            )
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .setLoadControl(loadControl)
            .build()
        exo.addListener(playerListener)
        player = exo
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

        Holder.player = exo
        Holder.service = this
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
        val p = player
        // Garder service + notif tant qu’une file existe (même en pause)
        if (p == null || p.mediaItemCount == 0) {
            stopSelf()
        }
    }

    override fun onDestroy() {
        scope.cancel()
        player?.removeListener(playerListener)
        session?.release()
        session = null
        player?.release()
        player = null
        Holder.player = null
        Holder.service = null
        super.onDestroy()
    }

    private fun refreshMediaButtons() {
        val p = sessionPlayer ?: player ?: return
        session?.setMediaButtonPreferences(buildMediaButtons(p))
    }

    /**
     * Force le redraw de la notif média (compacte OEM souvent vide après seek lointain
     * tant qu’on n’expand/collapse pas manuellement).
     */
    private fun invalidateMediaNotification() {
        val s = session ?: return
        val startFg = player?.playWhenReady == true || player?.isPlaying == true
        runCatching { onUpdateNotification(s, startFg) }
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

        // Compact notif = prev / play / next (player). Like + boucle en secondaires / overflow.
        return listOf(
            CommandButton.Builder(if (liked) CommandButton.ICON_HEART_FILLED else CommandButton.ICON_HEART_UNFILLED)
                .setDisplayName(if (liked) "Retirer des J'aime" else "J'aime")
                .setSessionCommand(cmdLike)
                .setSlots(CommandButton.SLOT_BACK_SECONDARY, CommandButton.SLOT_OVERFLOW)
                .build(),
            CommandButton.Builder(repeatIcon)
                .setDisplayName(repeatName)
                .setSessionCommand(cmdCycleRepeat)
                .setSlots(CommandButton.SLOT_FORWARD_SECONDARY, CommandButton.SLOT_OVERFLOW)
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
                    p.shuffleModeEnabled = !p.shuffleModeEnabled
                    refreshMediaButtons()
                }
                ACTION_CYCLE_REPEAT -> {
                    p.repeatMode = when (p.repeatMode) {
                        Player.REPEAT_MODE_OFF -> Player.REPEAT_MODE_ALL
                        Player.REPEAT_MODE_ALL -> Player.REPEAT_MODE_ONE
                        else -> Player.REPEAT_MODE_OFF
                    }
                    refreshMediaButtons()
                }
                ACTION_TOGGLE_LIKE -> {
                    toggleLikeFromNotification(p)
                }
            }
            return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
        }
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

    /**
     * Si Exo passe au suivant alors que le titre précédent n’a pas atteint ~85 %
     * de sa durée connue → stream tronqué / cache empoisonné : on revient et on retente.
     */
    private fun maybeRecoverEarlyEnd(exo: Player) {
        val prevId = prevPlayingId.ifBlank { lastPlayingId }
        val pos = if (prevPlayingId.isNotBlank()) prevPlayingPosMs else lastPlayingPosMs
        if (prevId.isBlank() || earlyEndRetries >= 2) return
        val track = Holder.queue.firstOrNull { it.id == prevId } ?: return
        val expected = track.durationMsOrNull()?.takeIf { it >= 45_000L } ?: return
        if (pos >= (expected * 0.85).toLong()) return
        val prevIdx = Holder.queue.indexOfFirst { it.id == prevId }
        if (prevIdx < 0) return
        earlyEndRetries += 1
        AppLog.w(
            "PlaybackService",
            "fin trop tôt id=$prevId pos=${pos}ms expected=${expected}ms → retry #$earlyEndRetries",
        )
        runCatching {
            ovh.delhomme.ytmusic.debug.TelemetryReporter.report(
                level = "error",
                kind = "android.player.early_end",
                message = "early end $prevId pos=$pos expected=$expected",
                meta = mapOf(
                    "trackId" to prevId,
                    "positionMs" to pos,
                    "expectedMs" to expected,
                    "retry" to earlyEndRetries,
                ),
            )
        }
        val container = runCatching { YtMusicApp.instance.container }.getOrNull()
        scope.launch {
            runCatching { PlayerCache.invalidate(this@PlaybackService, prevId) }
            if (container?.offlineStore?.has(prevId) == true) {
                runCatching { container.offlineStore.remove(prevId) }
            }
            val rebuilt = mediaItemFor(
                track,
                { tid -> container?.remoteStreamUrl(tid) ?: Holder.resolvedApiBase() + "/api/stream/$tid" },
                Holder.queueTitle,
            )
            runCatching {
                exo.replaceMediaItem(prevIdx, rebuilt)
                exo.seekTo(prevIdx, pos.coerceAtLeast(0L))
                exo.prepare()
                exo.playWhenReady = true
                exo.play()
                Holder.index = prevIdx
                lastPlayingId = prevId
                lastPlayingPosMs = pos
            }
        }
        android.os.Handler(mainLooper).post {
            android.widget.Toast.makeText(
                this,
                "Reprise du titre (fin anticipée évitée)",
                android.widget.Toast.LENGTH_SHORT,
            ).show()
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
            ahead = 5,
            behind = 1,
        )
        // Toute la fenêtre visible de la file : au moins ~3 s de tête
        StreamPrefetcher.warmHeads3s(
            base,
            queue.drop(fromIndex.coerceAtLeast(0)).take(12).map { it.id },
            limit = 12,
        )
        CoverPrefetcher.warmCovers(queue, fromIndex, ahead = 3, behind = 1)
        enqueueOfflineAhead(fromIndex)
    }

    /** Télécharge silencieusement les 2 titres suivants → survivre hors-ligne / mix. */
    private fun enqueueOfflineAhead(fromIndex: Int) {
        val queue = Holder.queue
        if (queue.isEmpty()) return
        val ahead = queue.drop((fromIndex + 1).coerceAtLeast(0)).take(3)
        if (ahead.isEmpty()) return
        runCatching {
            ovh.delhomme.ytmusic.YtMusicApp.instance.container.downloadManager.enqueueAhead(ahead, limit = 2)
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
        /** Frontière file utilisateur / suggestions. */
        @Volatile var userQueueEnd: Int = 0
        /** Auto-avance dans « À suivre » (sinon stop en fin de file user). */
        @Volatile var autoplaySuggestions: Boolean = true

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
        val nextIdx = when {
            exo.hasNextMediaItem() -> cur + 1
            exo.repeatMode == Player.REPEAT_MODE_ALL && exo.mediaItemCount > 0 -> 0
            exo.mediaItemCount > 1 -> (cur + 1) % exo.mediaItemCount
            else -> cur
        }
        // Chauffe le titre cible + le suivant avant / pendant le seek (notif + UI)
        warmAroundIndex(nextIdx)
        when {
            exo.hasNextMediaItem() -> {
                exo.seekToNextMediaItem()
                exo.play()
            }
            exo.repeatMode == Player.REPEAT_MODE_ALL && exo.mediaItemCount > 0 -> {
                exo.seekTo(/* mediaItemIndex */ 0, /* positionMs */ 0L)
                exo.play()
            }
            exo.mediaItemCount > 1 -> {
                exo.seekTo(nextIdx, 0L)
                exo.play()
            }
            else -> {
                // Ne pas relancer le même titre — déléguer au fill autoplay
                PlaybackService.Holder.onSkipAtEnd?.invoke()
            }
        }
        if (wasOne) exo.repeatMode = Player.REPEAT_MODE_ONE
    }

    private fun warmAroundIndex(index: Int) {
        val queue = PlaybackService.Holder.queue
        if (queue.isEmpty()) return
        val api = PlaybackService.Holder.resolvedApiBase()
        StreamPrefetcher.warmAround(api, queue.map { it.id }, index, ahead = 4, behind = 0)
        CoverPrefetcher.warmCovers(queue, index, ahead = 3, behind = 0)
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
    val idx = startIndex.coerceIn(0, playable.lastIndex)
    PlaybackService.Holder.queue = playable
    PlaybackService.Holder.index = idx
    // warmAround déjà fait par PlayerController.play / warmUpcoming — pas de 2ᵉ CacheWriter ici
    CoverPrefetcher.warmCovers(playable, idx, ahead = 3, behind = 1)
    val items = playable.map { t ->
        mediaItemFor(t, baseStreamUrl, PlaybackService.Holder.queueTitle)
    }
    setMediaItems(items, idx, 0L)
    volume = 1f
    prepare()
    playWhenReady = true
}

/** Si le volume média Android est à 0, le remonte un peu (sinon « pas de son » jusqu’aux touches volume). */
fun ensureAudibleMediaVolume(context: android.content.Context) {
    val am = context.getSystemService(android.content.Context.AUDIO_SERVICE) as? android.media.AudioManager
        ?: return
    val stream = android.media.AudioManager.STREAM_MUSIC
    val cur = am.getStreamVolume(stream)
    if (cur > 0) return
    val max = am.getStreamMaxVolume(stream).coerceAtLeast(1)
    val target = (max * 0.35f).toInt().coerceIn(1, max)
    runCatching {
        am.setStreamVolume(stream, target, android.media.AudioManager.FLAG_SHOW_UI)
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
        .setCustomCacheKey(t.id)
        .setMediaMetadata(meta.build())
        .build()
}
