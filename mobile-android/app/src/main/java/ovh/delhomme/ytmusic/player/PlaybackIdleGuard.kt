package ovh.delhomme.ytmusic.player

import android.content.Intent
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.media3.common.Player
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.YtMusicApp
import ovh.delhomme.ytmusic.debug.AppLog

/**
 * Coupe le service de lecture après une longue inactivité en arrière-plan
 * (aucune lecture en cours) pour limiter réseau / CPU / batterie.
 */
object PlaybackIdleGuard {
    /** 20 min — compromis entre 15 et 30 min demandés. */
    private const val IDLE_SHUTDOWN_MS = 20 * 60_000L
    private const val CHECK_INTERVAL_MS = 60_000L

    @Volatile private var appInForeground = false
    @Volatile private var lastPlaybackActivityMs = System.currentTimeMillis()

    private var scope: CoroutineScope? = null

    fun start(app: YtMusicApp) {
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                appInForeground = true
                touch()
            }

            override fun onStop(owner: LifecycleOwner) {
                appInForeground = false
                markIdleStart()
            }
        })
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        scope?.launch {
            while (isActive) {
                delay(CHECK_INTERVAL_MS)
                maybeShutdownIdlePlayback(app)
            }
        }
    }

    /** Lecture active ou interaction utilisateur récente. */
    fun touch() {
        lastPlaybackActivityMs = System.currentTimeMillis()
    }

    /** Démarre le délai d'inactivité (pause, fin de file, etc.). */
    fun markIdleStart() {
        lastPlaybackActivityMs = System.currentTimeMillis()
    }

    fun onPlayingChanged(isPlaying: Boolean) {
        if (isPlaying) touch() else markIdleStart()
    }

    private fun maybeShutdownIdlePlayback(app: YtMusicApp) {
        if (appInForeground) return
        val p = PlaybackService.Holder.player
        if (p == null || p.mediaItemCount == 0) return
        if (p.isPlaying || (p.playWhenReady && p.playbackState == Player.STATE_BUFFERING)) {
            touch()
            return
        }
        val idleMs = System.currentTimeMillis() - lastPlaybackActivityMs
        if (idleMs < IDLE_SHUTDOWN_MS) return

        AppLog.i(
            "PlaybackIdleGuard",
            "Arrêt service après ${idleMs / 60_000} min sans lecture (BG)",
        )
        StreamPrefetcher.cancelIdle()
        runCatching { app.container.downloadManager.cancelAll() }
        runCatching {
            p.stop()
            p.clearMediaItems()
        }
        PlaybackService.Holder.queue = emptyList()
        PlaybackService.Holder.index = 0
        runCatching {
            app.stopService(Intent(app, PlaybackService::class.java))
        }
    }
}
