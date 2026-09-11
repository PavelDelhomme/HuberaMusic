package ovh.delhomme.ytmusic.ui.player

import android.util.Log
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.FullscreenExit
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import ovh.delhomme.ytmusic.player.PlayerCache
import kotlin.math.abs

/** Mode média session (reset au kill process, pas persisté). */
object SessionMediaMode {
    var video by mutableStateOf(false)
}

/**
 * Surface vidéo.
 *
 * Mode clip (`useClipAudio`) :
 * - le **son** vient du clip
 * - le titre audio est en pause / muet
 * - double-tap gauche −5 s / droite +5 s
 * - tap simple → plein écran (ou toggle chrome si [showMediaControls])
 */
@OptIn(UnstableApi::class)
@Composable
fun SyncedVideoSurface(
    streamUrl: String,
    positionMs: Long,
    playing: Boolean,
    active: Boolean = true,
    fullscreen: Boolean = false,
    useClipAudio: Boolean = true,
    onClipPositionMs: ((Long) -> Unit)? = null,
    /** Durée réelle du clip Exo (ms) — à associer au titre comme durationSeconds. */
    onClipDurationMs: ((Long) -> Unit)? = null,
    onPlaybackError: ((String) -> Unit)? = null,
    onToggleFullscreen: (() -> Unit)? = null,
    /** Durée du titre audio (ms) — pour ne pas pousser la timeline musique au-delà. */
    trackDurationMs: Long = 0L,
    /** Overlay lecteur multimédia (plein écran). */
    showMediaControls: Boolean = false,
    trackTitle: String? = null,
    trackArtist: String? = null,
    onPlayPause: (() -> Unit)? = null,
    onSkipPrevious: (() -> Unit)? = null,
    onSkipNext: (() -> Unit)? = null,
    onSeekRatio: ((Float) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var error by remember(streamUrl) { mutableStateOf<String?>(null) }
    var ready by remember(streamUrl) { mutableStateOf(false) }
    var seekHint by remember { mutableStateOf<String?>(null) }
    var announcedClipDur by remember(streamUrl) { mutableStateOf(false) }
    var chromeVisible by remember(fullscreen, showMediaControls) {
        mutableStateOf(fullscreen && showMediaControls)
    }
    var scrubRatio by remember { mutableFloatStateOf(-1f) }
    val latestPos by rememberUpdatedState(positionMs)
    val latestPlaying by rememberUpdatedState(playing)
    val latestUseClip by rememberUpdatedState(useClipAudio)
    val latestOnClipPos by rememberUpdatedState(onClipPositionMs)
    val latestOnClipDur by rememberUpdatedState(onClipDurationMs)
    val latestOnError by rememberUpdatedState(onPlaybackError)
    val latestTrackDur by rememberUpdatedState(trackDurationMs)
    val latestToggleFs by rememberUpdatedState(onToggleFullscreen)
    val latestSeekRatio by rememberUpdatedState(onSeekRatio)

    val exo = remember {
        val saver = ovh.delhomme.ytmusic.data.BatterySaver.isActive() ||
            ovh.delhomme.ytmusic.data.BatterySaver.isSoft()
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                if (saver) 5_000 else 8_000,
                if (saver) 24_000 else 40_000,
                if (saver) 1_200 else 1_500,
                if (saver) 2_000 else 3_000,
            )
            .build()
        val local = streamUrl.startsWith("file:") || streamUrl.startsWith("/")
        val builder = ExoPlayer.Builder(context).setLoadControl(loadControl)
        if (!local) {
            val factory = PlayerCache.videoCacheDataSourceFactory(context)
            builder.setMediaSourceFactory(DefaultMediaSourceFactory(factory))
        }
        builder
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .build(),
                /* handleAudioFocus= */ false,
            )
            .build()
            .apply {
                volume = if (useClipAudio) 1f else 0f
                playWhenReady = false
                repeatMode = Player.REPEAT_MODE_OFF
            }
    }

    DisposableEffect(Unit) {
        onDispose {
            exo.volume = 0f
            exo.stop()
            exo.clearMediaItems()
            exo.release()
        }
    }

    DisposableEffect(streamUrl) {
        error = null
        ready = false
        exo.volume = if (latestUseClip) 1f else 0f
        val cacheKey = when {
            streamUrl.startsWith("file:") || streamUrl.startsWith("/") ->
                "v:local:" + streamUrl.substringAfterLast('/').substringBefore('.')
            else ->
                "v:" + streamUrl.substringAfter("/api/stream/")
                    .substringBefore('?')
                    .substringBefore('&')
                    .ifBlank { streamUrl.hashCode().toString() }
        }
        val item = MediaItem.Builder()
            .setUri(streamUrl)
            .setMediaId(cacheKey)
            .setCustomCacheKey(cacheKey)
            .build()
        exo.setMediaItem(item)
        exo.prepare()
        val listener = object : Player.Listener {
            private var announcedReady = false
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_READY) {
                    ready = true
                    error = null
                    if (!announcedReady) {
                        announcedReady = true
                        runCatching { seekClipSafe(exo, latestPos) }
                        if (latestPlaying) {
                            exo.volume = if (latestUseClip) 1f else 0f
                            exo.play()
                        }
                        Log.i(TAG, "video ready clipAudio=$latestUseClip url=${streamUrl.take(80)}")
                    }
                }
            }

            override fun onPlayerError(e: PlaybackException) {
                val msg = e.message ?: "Vidéo indisponible"
                error = msg
                ready = false
                latestOnError?.invoke(msg)
                Log.e(TAG, "video error code=${e.errorCode} $msg url=${streamUrl.take(120)}", e)
            }
        }
        exo.addListener(listener)
        onDispose {
            exo.removeListener(listener)
            exo.pause()
            exo.volume = 0f
        }
    }

    LaunchedEffect(streamUrl, active) {
        if (!active || streamUrl.isBlank()) return@LaunchedEffect
        delay(14_000L)
        if (!ready && error == null) {
            val msg = "Clip trop lent — pochette affichée"
            error = msg
            latestOnError?.invoke(msg)
            Log.w(TAG, "video timeout 14s url=${streamUrl.take(100)}")
        }
    }

    LaunchedEffect(useClipAudio, active) {
        exo.volume = when {
            !active -> 0f
            useClipAudio -> 1f
            else -> 0f
        }
    }

    LaunchedEffect(seekHint) {
        if (seekHint == null) return@LaunchedEffect
        delay(650)
        seekHint = null
    }

    LaunchedEffect(chromeVisible, fullscreen, showMediaControls) {
        if (!fullscreen || !showMediaControls || !chromeVisible) return@LaunchedEffect
        delay(3_800L)
        chromeVisible = false
    }

    LaunchedEffect(streamUrl, active, useClipAudio) {
        if (!active) {
            exo.pause()
            exo.volume = 0f
            return@LaunchedEffect
        }
        var lastReported = -1L
        var lastTargetSeen = latestPos
        var lastClipSeekAt = 0L
        while (isActive) {
            val target = latestPos.coerceAtLeast(0L)
            when (exo.playbackState) {
                Player.STATE_READY, Player.STATE_BUFFERING -> {
                    val clipPos = exo.currentPosition.coerceAtLeast(0L)
                    val clipDur = exo.duration.takeIf { it > 0L && it != C.TIME_UNSET }
                    if (clipDur != null && !announcedClipDur) {
                        announcedClipDur = true
                        latestOnClipDur?.invoke(clipDur)
                    }
                    if (latestUseClip) {
                        val targetJump = abs(target - lastTargetSeen)
                        if (targetJump > 2_800L && abs(target - clipPos) > 2_000L) {
                            val now = android.os.SystemClock.elapsedRealtime()
                            if (now - lastClipSeekAt > 600L) {
                                runCatching { seekClipSafe(exo, target) }
                                lastClipSeekAt = now
                            }
                        }
                        lastTargetSeen = target
                        if (abs(clipPos - lastReported) > 350L) {
                            lastReported = clipPos
                            val trackDur = latestTrackDur
                            val reportPos =
                                if (trackDur > 1_000L) clipPos.coerceAtMost(trackDur - 400L)
                                else clipPos
                            latestOnClipPos?.invoke(reportPos)
                        }
                        if (clipDur != null && clipPos >= clipDur - 350L && latestPlaying) {
                            latestOnClipPos?.invoke(clipPos)
                        }
                    } else {
                        if (abs(clipPos - target) > 1_800L) {
                            val now = android.os.SystemClock.elapsedRealtime()
                            if (now - lastClipSeekAt > 700L) {
                                runCatching { seekClipSafe(exo, target) }
                                lastClipSeekAt = now
                            }
                        }
                        lastTargetSeen = target
                    }
                    exo.volume = if (latestUseClip) 1f else 0f
                    when {
                        !latestPlaying && exo.isPlaying -> exo.pause()
                        latestPlaying && !exo.isPlaying && exo.playbackState == Player.STATE_READY ->
                            exo.play()
                    }
                }
                else -> Unit
            }
            delay(ovh.delhomme.ytmusic.data.BatterySaver.videoSyncPollMs(latestPlaying))
        }
    }

    fun seekBy(deltaMs: Long) {
        val cur = exo.currentPosition.coerceAtLeast(0L)
        val next = (cur + deltaMs).coerceAtLeast(0L)
        seekClipSafe(exo, next)
        val trackDur = latestTrackDur
        val report =
            if (trackDur > 1_000L) next.coerceAtMost(trackDur - 400L) else next
        latestOnClipPos?.invoke(report)
        seekHint = if (deltaMs < 0) "−5 s" else "+5 s"
        if (fullscreen && showMediaControls) chromeVisible = true
    }

    val durationForBar = trackDurationMs.takeIf { it > 1_000L }
        ?: exo.duration.takeIf { it > 0L && it != C.TIME_UNSET }
        ?: 1L
    val shownProgress = when {
        scrubRatio >= 0f -> scrubRatio
        else -> (positionMs.toFloat() / durationForBar.toFloat()).coerceIn(0f, 1f)
    }

    Box(
        modifier
            .background(Color.Black),
        contentAlignment = Alignment.Center,
    ) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    useController = false
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                    setShutterBackgroundColor(android.graphics.Color.BLACK)
                    isClickable = false
                    isFocusable = false
                    player = exo
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                }
            },
            update = { view ->
                view.player = exo
                view.resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
            },
            modifier = Modifier.fillMaxSize(),
        )
        Box(
            Modifier
                .fillMaxSize()
                .pointerInput(streamUrl, fullscreen, showMediaControls) {
                    detectTapGestures(
                        onDoubleTap = { offset ->
                            val mid = size.width / 2f
                            if (offset.x < mid) seekBy(-5_000L) else seekBy(5_000L)
                        },
                        onTap = {
                            when {
                                fullscreen && showMediaControls -> chromeVisible = !chromeVisible
                                else -> latestToggleFs?.invoke()
                            }
                        },
                    )
                },
        )
        AnimatedVisibility(
            visible = seekHint != null,
            enter = fadeIn(),
            exit = fadeOut(),
            modifier = Modifier.align(Alignment.Center),
        ) {
            Text(
                seekHint.orEmpty(),
                color = Color.White,
                fontSize = 28.sp,
                fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .background(Color.Black.copy(alpha = 0.45f))
                    .padding(horizontal = 20.dp, vertical = 10.dp),
            )
        }
        when {
            error != null -> Text(error!!, color = Color(0xFFBDBDBD))
            !ready -> CircularProgressIndicator(
                color = Color.White,
                strokeWidth = 2.dp,
                modifier = Modifier.size(28.dp),
            )
        }

        if (fullscreen && showMediaControls) {
            AnimatedVisibility(
                visible = chromeVisible,
                enter = fadeIn(),
                exit = fadeOut(),
                modifier = Modifier.fillMaxSize(),
            ) {
                Box(Modifier.fillMaxSize()) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .align(Alignment.TopCenter)
                            .background(
                                Brush.verticalGradient(
                                    listOf(Color.Black.copy(alpha = 0.72f), Color.Transparent),
                                ),
                            )
                            .statusBarsPadding()
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                    ) {
                        Column {
                            if (!trackTitle.isNullOrBlank()) {
                                Text(
                                    trackTitle,
                                    color = Color.White,
                                    fontSize = 16.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            if (!trackArtist.isNullOrBlank()) {
                                Text(
                                    trackArtist,
                                    color = Color.White.copy(alpha = 0.75f),
                                    fontSize = 13.sp,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    }
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .align(Alignment.BottomCenter)
                            .background(
                                Brush.verticalGradient(
                                    listOf(Color.Transparent, Color.Black.copy(alpha = 0.78f)),
                                ),
                            )
                            .navigationBarsPadding()
                            .padding(horizontal = 12.dp, vertical = 8.dp),
                    ) {
                        Column(Modifier.fillMaxWidth()) {
                            Row(
                                Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    formatVideoMs(
                                        if (scrubRatio >= 0f) {
                                            (scrubRatio * durationForBar).toLong()
                                        } else {
                                            positionMs
                                        },
                                    ),
                                    color = Color.White,
                                    fontSize = 12.sp,
                                    modifier = Modifier.padding(end = 8.dp),
                                )
                                Slider(
                                    value = shownProgress,
                                    onValueChange = {
                                        scrubRatio = it
                                        chromeVisible = true
                                    },
                                    onValueChangeFinished = {
                                        val r = scrubRatio.coerceIn(0f, 1f)
                                        scrubRatio = -1f
                                        latestSeekRatio?.invoke(r)
                                        val target = (r * durationForBar).toLong()
                                        seekClipSafe(exo, target)
                                        latestOnClipPos?.invoke(target)
                                    },
                                    modifier = Modifier.weight(1f),
                                    colors = SliderDefaults.colors(
                                        thumbColor = Color.White,
                                        activeTrackColor = Color.White,
                                        inactiveTrackColor = Color.White.copy(alpha = 0.28f),
                                    ),
                                )
                                Text(
                                    formatVideoMs(durationForBar),
                                    color = Color.White,
                                    fontSize = 12.sp,
                                    modifier = Modifier.padding(start = 8.dp),
                                )
                            }
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .padding(bottom = 4.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Spacer(Modifier.size(48.dp))
                                Row(
                                    horizontalArrangement = Arrangement.spacedBy(20.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    IconButton(
                                        onClick = {
                                            chromeVisible = true
                                            onSkipPrevious?.invoke()
                                        },
                                        modifier = Modifier
                                            .size(52.dp)
                                            .background(Color.White.copy(alpha = 0.12f), CircleShape),
                                    ) {
                                        Icon(
                                            Icons.Default.SkipPrevious,
                                            contentDescription = "Précédent",
                                            tint = Color.White,
                                            modifier = Modifier.size(32.dp),
                                        )
                                    }
                                    IconButton(
                                        onClick = {
                                            chromeVisible = true
                                            onPlayPause?.invoke()
                                        },
                                        modifier = Modifier
                                            .size(64.dp)
                                            .background(Color.White.copy(alpha = 0.18f), CircleShape),
                                    ) {
                                        Icon(
                                            if (playing) Icons.Default.Pause else Icons.Default.PlayArrow,
                                            contentDescription = if (playing) "Pause" else "Lecture",
                                            tint = Color.White,
                                            modifier = Modifier.size(36.dp),
                                        )
                                    }
                                    IconButton(
                                        onClick = {
                                            chromeVisible = true
                                            onSkipNext?.invoke()
                                        },
                                        modifier = Modifier
                                            .size(52.dp)
                                            .background(Color.White.copy(alpha = 0.12f), CircleShape),
                                    ) {
                                        Icon(
                                            Icons.Default.SkipNext,
                                            contentDescription = "Suivant",
                                            tint = Color.White,
                                            modifier = Modifier.size(32.dp),
                                        )
                                    }
                                }
                                IconButton(
                                    onClick = { latestToggleFs?.invoke() },
                                    modifier = Modifier.size(48.dp),
                                ) {
                                    Icon(
                                        Icons.Default.FullscreenExit,
                                        contentDescription = "Quitter plein écran",
                                        tint = Color.White,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        } else if (onToggleFullscreen != null) {
            IconButton(
                onClick = onToggleFullscreen,
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(8.dp),
            ) {
                Icon(
                    if (fullscreen) Icons.Default.FullscreenExit else Icons.Default.Fullscreen,
                    contentDescription = if (fullscreen) "Quitter plein écran" else "Plein écran",
                    tint = Color.White,
                )
            }
        }
    }
}

private const val TAG = "YTMVideo"

private fun seekClipSafe(exo: ExoPlayer, positionMs: Long) {
    val pos = positionMs.coerceAtLeast(0L)
    val dur = exo.duration
    if (dur > 0L) {
        exo.seekTo(pos.coerceAtMost((dur - 400L).coerceAtLeast(0L)))
    } else {
        exo.seekTo(pos)
    }
}

private fun formatVideoMs(ms: Long): String {
    val total = (ms / 1000L).coerceAtLeast(0L)
    val m = total / 60L
    val s = total % 60L
    return "%d:%02d".format(m, s)
}
