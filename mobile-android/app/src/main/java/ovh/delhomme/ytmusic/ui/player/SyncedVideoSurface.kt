package ovh.delhomme.ytmusic.ui.player

import android.util.Log
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
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
 * Créée uniquement en mode Vidéo (économe) ; libérée au dispose / retour Titre.
 */
@OptIn(UnstableApi::class)
@Composable
fun SyncedVideoSurface(
    streamUrl: String,
    positionMs: Long,
    playing: Boolean,
    active: Boolean = true,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var error by remember(streamUrl) { mutableStateOf<String?>(null) }
    var ready by remember(streamUrl) { mutableStateOf(false) }
    val latestPos by rememberUpdatedState(positionMs)
    val latestPlaying by rememberUpdatedState(playing)

    val exo = remember {
        val factory = PlayerCache.dataSourceFactory(context)
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
            if (kotlin.math.abs(exo.currentPosition - target) > 250L) {
                runCatching { exo.seekTo(target) }
            }
            when {
                !latestPlaying && exo.isPlaying -> exo.pause()
                latestPlaying && !exo.isPlaying && exo.playbackState == Player.STATE_READY -> exo.play()
            }
            delay(250)
        }
    }

    Box(modifier.background(Color.Black), contentAlignment = Alignment.Center) {
        AndroidView(
            factory = { ctx ->
                PlayerView(ctx).apply {
                    useController = false
                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                    player = exo
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT,
                    )
                }
            },
            update = { it.player = exo },
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
    }
}

private const val TAG = "YTMVideo"
