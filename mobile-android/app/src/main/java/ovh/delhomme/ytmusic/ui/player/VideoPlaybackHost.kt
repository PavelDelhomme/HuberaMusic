package ovh.delhomme.ytmusic.ui.player

import android.app.Activity
import android.content.pm.ActivityInfo
import android.os.SystemClock
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.zIndex
import kotlinx.coroutines.delay
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.BatterySaver
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.data.VideoPlaybackPrefs
import ovh.delhomme.ytmusic.data.VisualIdCache
import ovh.delhomme.ytmusic.debug.AppLog
import ovh.delhomme.ytmusic.player.PlayerController
import ovh.delhomme.ytmusic.player.PlayerUiState
import ovh.delhomme.ytmusic.player.VisualClipPrefetcher

/**
 * État vidéo Now Playing — extrait pour éviter VerifyError DEX
 * (NowPlayingScreen trop gros pour le vérifieur ART).
 */
class VideoPlaybackUi {
    var streamUrl by mutableStateOf<String?>(null)
    var error by mutableStateOf<String?>(null)
    var visualId by mutableStateOf<String?>(null)
    var resolving by mutableStateOf(false)
    var fullscreen by mutableStateOf(false)
    var fsTapArmed by mutableStateOf(true)
    var fsMediaControls by mutableStateOf(true)
    var lastClipPosMs by mutableLongStateOf(0L)
    var lastPrevTap by mutableLongStateOf(0L)

    fun enterFullscreen() {
        if (fullscreen) return
        fsTapArmed = false
        fullscreen = true
    }

    fun exitFullscreen(force: Boolean = false) {
        if (!fullscreen) return
        if (!force && !fsTapArmed) return
        fullscreen = false
        fsTapArmed = true
    }

    fun clearStream(err: String? = null) {
        streamUrl = null
        visualId = null
        resolving = false
        error = err
    }
}

@Composable
fun rememberVideoPlaybackUi(
    player: PlayerController,
    ui: PlayerUiState,
    container: AppContainer,
    sheetVisible: Boolean,
): VideoPlaybackUi {
    val context = LocalContext.current
    val video = remember { VideoPlaybackUi() }
    video.fsMediaControls = VideoPlaybackPrefs.fullscreenControls(context)

    // Warm silencieux visualId
    LaunchedEffect(ui.track?.id, ui.queueIndex, ui.queue.size) {
        val track = ui.track ?: return@LaunchedEffect
        if (BatterySaver.isActive()) {
            if (VisualIdCache.get(context, track.id) != null) return@LaunchedEffect
            runCatching {
                container.ensureFreshToken()
                val vis = container.api.trackVisual(
                    track.id,
                    title = track.title,
                    artist = track.artistLine().takeIf { it != "Artiste" },
                    durationSeconds = track.durationSeconds,
                    waitMs = 0,
                    refresh = null,
                )
                val vid = vis.visualId?.takeIf { it.isNotBlank() && it != track.id }
                if (vid != null) VisualIdCache.put(context, track.id, vid)
            }
            return@LaunchedEffect
        }
        val ahead = if (BatterySaver.isSoft()) 1 else 2
        val ids = buildList {
            add(track)
            for (i in 1..ahead) {
                ui.queue.getOrNull(ui.queueIndex + i)?.let { add(it) }
            }
        }.distinctBy { it.id }
        for (t in ids) {
            if (VisualIdCache.get(context, t.id) != null) continue
            if (container.offlineStore.hasVideo(t.id)) continue
            runCatching {
                container.ensureFreshToken()
                val vis = container.api.trackVisual(
                    t.id,
                    title = t.title,
                    artist = t.artistLine().takeIf { it != "Artiste" },
                    durationSeconds = t.durationSeconds,
                    waitMs = 0,
                    refresh = null,
                )
                val vid = vis.visualId?.takeIf { it.isNotBlank() && it != t.id }
                if (vid != null) VisualIdCache.put(context, t.id, vid)
            }
        }
    }

    // Resolve mode Vidéo
    LaunchedEffect(ui.track?.id, SessionMediaMode.video, sheetVisible) {
        val track = ui.track
        if (!sheetVisible || track == null || !SessionMediaMode.video) {
            if (!SessionMediaMode.video) {
                video.resolving = false
            } else {
                video.clearStream()
            }
            return@LaunchedEffect
        }
        video.error = null
        val localUri = container.offlineStore.videoPlayUri(track.id)?.toString()
        val cached = VisualIdCache.get(context, track.id)?.takeIf { it.isNotBlank() && it != track.id }
        if (localUri != null) {
            video.visualId = cached ?: track.id
            video.streamUrl = localUri
            video.resolving = false
            VisualIdCache.getClipDurationMs(context, track.id)?.let { player.applyKnownDurationMs(it) }
            runCatching {
                container.ensureFreshToken()
                val vis = container.api.trackVisual(
                    track.id,
                    title = track.title,
                    artist = track.artistLine().takeIf { it != "Artiste" },
                    durationSeconds = track.durationSeconds,
                    waitMs = 800,
                    refresh = null,
                )
                val vid = vis.visualId?.takeIf { it.isNotBlank() && it != track.id }
                if (vid != null) {
                    VisualIdCache.put(context, track.id, vid)
                    video.visualId = vid
                }
            }
            return@LaunchedEffect
        }
        if (cached != null) {
            video.visualId = cached
            video.streamUrl = container.videoStreamUrl(cached)
            video.resolving = false
            VisualIdCache.getClipDurationMs(context, track.id)?.let { player.applyKnownDurationMs(it) }
            runCatching {
                container.ensureFreshToken()
                val vis = container.api.trackVisual(
                    track.id,
                    title = track.title,
                    artist = track.artistLine().takeIf { it != "Artiste" },
                    durationSeconds = track.durationSeconds,
                    waitMs = 2_500,
                    refresh = null,
                )
                if (!SessionMediaMode.video || ui.track?.id != track.id) return@runCatching
                val vid = vis.visualId?.takeIf { it.isNotBlank() && it != track.id }
                if (vid != null && vid != cached) {
                    VisualIdCache.put(context, track.id, vid)
                    video.visualId = vid
                    video.streamUrl = container.offlineStore.videoPlayUri(track.id)?.toString()
                        ?: container.videoStreamUrl(vid)
                }
            }
            return@LaunchedEffect
        }
        video.streamUrl = null
        video.visualId = null
        video.resolving = true
        runCatching {
            container.ensureFreshToken()
            val quick = container.api.trackVisual(
                track.id,
                title = track.title,
                artist = track.artistLine().takeIf { it != "Artiste" },
                durationSeconds = track.durationSeconds,
                waitMs = 600,
                refresh = null,
            )
            if (!SessionMediaMode.video || ui.track?.id != track.id) return@runCatching
            var vid = quick.visualId?.takeIf { it.isNotBlank() && it != track.id }
            if (vid != null) {
                VisualIdCache.put(context, track.id, vid)
                video.visualId = vid
                video.streamUrl = container.videoStreamUrl(vid)
                video.resolving = false
                video.error = null
                runCatching { container.api.streamResolveUrl(vid, "video") }
            }
            val slow = container.api.trackVisual(
                track.id,
                title = track.title,
                artist = track.artistLine().takeIf { it != "Artiste" },
                durationSeconds = track.durationSeconds,
                waitMs = 4_500,
                refresh = null,
            )
            if (!SessionMediaMode.video || ui.track?.id != track.id) return@runCatching
            val better = slow.visualId?.takeIf { it.isNotBlank() && it != track.id }
            if (better != null) {
                VisualIdCache.put(context, track.id, better)
                if (better != vid) {
                    video.visualId = better
                    video.streamUrl = container.offlineStore.videoPlayUri(track.id)?.toString()
                        ?: container.videoStreamUrl(better)
                    runCatching { container.api.streamResolveUrl(better, "video") }
                }
                video.resolving = false
                video.error = null
            } else if (vid == null) {
                video.clearStream("Pas de clip vidéo pour ce titre")
            } else {
                video.resolving = false
            }
        }.onFailure {
            if (!SessionMediaMode.video || ui.track?.id != track.id) return@onFailure
            video.resolving = false
            if (video.streamUrl == null) {
                video.error = "Clip introuvable — pochette affichée"
            }
            AppLog.w("YTMVideo", "visual resolve failed: ${it.message}")
        }
    }

    LaunchedEffect(ui.track?.id, ui.queueIndex, SessionMediaMode.video, ui.queue.size) {
        if (!SessionMediaMode.video) {
            VisualClipPrefetcher.cancel()
            return@LaunchedEffect
        }
        if (ui.queue.isEmpty()) return@LaunchedEffect
        VisualClipPrefetcher.maintain(
            context = context,
            queue = ui.queue,
            index = ui.queueIndex.coerceIn(0, ui.queue.lastIndex),
        )
    }

    LaunchedEffect(ui.track?.id) {
        video.lastClipPosMs = 0L
    }

    LaunchedEffect(SessionMediaMode.video) {
        player.setVideoClipMode(SessionMediaMode.video)
        if (!SessionMediaMode.video) {
            video.exitFullscreen(force = true)
            VisualClipPrefetcher.cancel()
            if (video.lastClipPosMs > 0L) {
                player.seek(video.lastClipPosMs)
                video.lastClipPosMs = 0L
            }
        }
    }

    BackHandler(enabled = video.fullscreen) { video.exitFullscreen(force = true) }

    val activity = context as? Activity
    LaunchedEffect(video.fullscreen) {
        val act = activity ?: return@LaunchedEffect
        if (video.fullscreen) {
            player.setVideoClipMode(true)
            act.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            video.fsTapArmed = false
            delay(520)
            video.fsTapArmed = true
        } else if (SessionMediaMode.video) {
            player.setVideoClipMode(true)
            act.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        } else {
            act.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
    }
    DisposableEffect(Unit) {
        onDispose {
            activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
    }

    LaunchedEffect(sheetVisible, video.fullscreen) {
        if (sheetVisible || video.fullscreen) {
            video.fsMediaControls = VideoPlaybackPrefs.fullscreenControls(context)
        }
    }

    return video
}

@Composable
fun VideoFullscreenOverlay(
    video: VideoPlaybackUi,
    track: TrackDto,
    ui: PlayerUiState,
    player: PlayerController,
    container: AppContainer,
) {
    val context = LocalContext.current
    val url = video.streamUrl
    if (!video.fullscreen || url == null || !SessionMediaMode.video) return
    Box(
        Modifier
            .fillMaxSize()
            .zIndex(80f)
            .background(Color.Black)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = {},
            ),
    ) {
        SyncedVideoSurface(
            streamUrl = url,
            positionMs = ui.positionMs,
            playing = player.wantsPlaying(),
            active = true,
            fullscreen = true,
            useClipAudio = true,
            trackDurationMs = ui.durationMs,
            showMediaControls = video.fsMediaControls,
            trackTitle = track.title,
            trackArtist = track.artistLine(),
            onPlayPause = { player.toggle() },
            onSkipPrevious = {
                val now = SystemClock.elapsedRealtime()
                val double = now - video.lastPrevTap < 380L
                video.lastPrevTap = now
                player.skipPrevOrRestart(forcePrevious = double)
            },
            onSkipNext = { player.skipNext() },
            onSeekRatio = { player.seekRatio(it) },
            onClipPositionMs = { pos ->
                video.lastClipPosMs = pos
                val cap = ui.durationMs.takeIf { it > 1_000L }
                val safe = if (cap != null) pos.coerceAtMost(cap - 400L) else pos
                if (kotlin.math.abs(ui.positionMs - safe) > 1_200L) {
                    player.seek(safe.coerceAtLeast(0L))
                }
            },
            onClipDurationMs = { clipDur ->
                VisualIdCache.putClipDurationMs(context, track.id, clipDur)
                player.applyKnownDurationMs(clipDur)
            },
            onPlaybackError = { errMsg ->
                runCatching { VisualIdCache.remove(context, track.id) }
                video.exitFullscreen(force = true)
                video.clearStream(
                    when {
                        errMsg.contains("trop lent", ignoreCase = true) ->
                            "Clip trop lent — pochette affichée"
                        else -> "Clip indisponible — pochette affichée"
                    },
                )
            },
            onToggleFullscreen = { video.exitFullscreen(force = true) },
            modifier = Modifier.fillMaxSize(),
        )
    }
}
