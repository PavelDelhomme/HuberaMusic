package ovh.delhomme.ytmusic.ui.player

import android.util.Log
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.FullscreenExit
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import ovh.delhomme.ytmusic.player.PlayerCache

/** Mode média session (reset au kill process, pas persisté). */
object SessionMediaMode {
    var video by mutableStateOf(false)
}

/**
 * Surface vidéo muette synchronisée sur la position audio principale.
 * L’audio vient toujours du service (piste en cours) — jamais la piste audio du clip.
 */
@OptIn(UnstableApi::class)
@Composable
fun SyncedVideoSurface(
    streamUrl: String,
    positionMs: Long,
    playing: Boolean,
    active: Boolean = true,
    fullscreen: Boolean = false,
    onToggleFullscreen: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var error by remember(streamUrl) { mutableStateOf<String?>(null) }
    var ready by remember(streamUrl) { mutableStateOf(false) }
    val latestPos by rememberUpdatedState(positionMs)
    val latestPlaying by rememberUpdatedState(playing)

    val exo = remember {
        val factory = PlayerCache.videoDataSourceFactory(context)
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(factory))
            .build()
            .apply {
                volume = 0f
                playWhenReady = false
                repeatMode = Player.REPEAT_MODE_OFF
            }
    }

    DisposableEffect(Unit) {
        onDispose {
            exo.stop()
            exo.clearMediaItems()
            exo.release()
        }
    }

    DisposableEffect(streamUrl) {
        error = null
        ready = false
        exo.volume = 0f
        val item = MediaItem.Builder()
            .setUri(streamUrl)
            .setMediaId("video:${streamUrl.hashCode()}")
            .build()
        exo.setMediaItem(item)
        exo.prepare()
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_READY) {
                    ready = true
                    runCatching { exo.seekTo(latestPos.coerceAtLeast(0L)) }
                    if (ovh.delhomme.ytmusic.BuildConfig.DEBUG) {
                        Log.i(TAG, "video ready url=${streamUrl.take(80)}")
                    }
                }
            }

            override fun onPlayerError(e: PlaybackException) {
                val msg = e.message ?: "Vidéo indisponible"
                error = msg
                if (ovh.delhomme.ytmusic.BuildConfig.DEBUG) {
                    Log.e(TAG, "video error code=${e.errorCode} $msg url=${streamUrl.take(120)}", e)
                }
            }
        }
        exo.addListener(listener)
        onDispose {
            exo.removeListener(listener)
            exo.pause()
        }
    }

    LaunchedEffect(streamUrl, active) {
        if (!active) {
            exo.pause()
            return@LaunchedEffect
        }
        while (isActive) {
            val target = latestPos.coerceAtLeast(0L)
            when (exo.playbackState) {
                Player.STATE_READY -> {
                    val drift = kotlin.math.abs(exo.currentPosition - target)
                    // Seek rare : évite les micro-coupures / crash buffer
                    if (drift > 850L) {
                        runCatching { exo.seekTo(target) }
                    }
                    when {
                        !latestPlaying && exo.isPlaying -> exo.pause()
                        latestPlaying && !exo.isPlaying -> exo.play()
                    }
                }
                Player.STATE_BUFFERING -> Unit
                else -> Unit
            }
            delay(if (latestPlaying) 120L else 280L)
        }
    }

    Box(
        modifier
            .background(Color.Black)
            .then(
                if (!fullscreen && onToggleFullscreen != null) {
                    Modifier.clickable(onClick = onToggleFullscreen)
                } else {
                    Modifier
                },
            ),
        contentAlignment = Alignment.Center,
    ) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    useController = false
                    resizeMode = if (fullscreen) {
                        AspectRatioFrameLayout.RESIZE_MODE_FIT
                    } else {
                        AspectRatioFrameLayout.RESIZE_MODE_FIT
                    }
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
        when {
            error != null -> Text(error!!, color = Color(0xFFBDBDBD))
            !ready -> CircularProgressIndicator(
                color = Color.White,
                strokeWidth = 2.dp,
                modifier = Modifier.size(28.dp),
            )
        }
        if (onToggleFullscreen != null) {
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
