package ovh.delhomme.ytmusic.player

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.YtMusicApp

/**
 * Scope qui survit à la composition (NowPlaying / LaunchedEffect).
 * Préfère le scope application ; le PlaybackService a le sien pour Exo.
 */
object PlaybackScopes {
    private val fallback = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    fun launchPlayback(block: suspend CoroutineScope.() -> Unit): Job {
        val app = runCatching { YtMusicApp.instance.container.appScope() }.getOrNull()
        return (app ?: fallback).launch { block() }
    }
}
