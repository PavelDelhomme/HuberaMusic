package ovh.delhomme.ytmusic.ui.library

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ovh.delhomme.ytmusic.YtMusicApp
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.ShuffleHeadStore
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.player.StreamPrefetcher

/**
 * Aléatoire : tête en cache (démarrage instantané) + warm #0–2, refresh fond.
 * [sourceKey] ex. "lib:liked", "album:XXX", "home:pins"
 */
suspend fun playLibraryShuffled(
    container: AppContainer,
    queue: List<TrackDto>,
    onPlay: (List<TrackDto>, Int) -> Unit,
    sourceKey: String = "lib:generic",
) {
    val playable = queue.filter { it.isPlayable() && it.id.length == 11 }
    if (playable.isEmpty()) return
    val ctx = YtMusicApp.instance
    val fp = ShuffleHeadStore.fingerprint(playable)
    val cacheKey = ShuffleHeadStore.keyFor(sourceKey, fp)
    val cachedIds = ShuffleHeadStore.loadHead(ctx, cacheKey)
    val shuffled = withContext(Dispatchers.Default) {
        if (cachedIds != null) ShuffleHeadStore.applyHead(playable, cachedIds)
        else playable.shuffled()
    }
    val base = container.resolvedApiBase()
    if (base.isNotBlank()) {
        withContext(Dispatchers.IO) {
            StreamPrefetcher.prepareShuffleLead(base, shuffled.map { it.id })
        }
    }
    onPlay(shuffled, 0)
    // Refresh tête en fond pour le prochain tap (pas bloquant)
    withContext(Dispatchers.IO) {
        runCatching {
            val next = playable.shuffled().take(12).map { it.id }
            ShuffleHeadStore.saveHead(ctx, cacheKey, next)
            if (base.isNotBlank() && !StreamPrefetcher.isStreamDown()) {
                StreamPrefetcher.warmFormatsLight(base, next.take(6), limit = 6)
                StreamPrefetcher.warmHeads3s(base, next.take(4), limit = 4)
            }
        }
    }
}

/**
 * Tout lire / play à l’index : démarre tout de suite, warm en arrière-plan.
 */
suspend fun playQueueWithLead(
    container: AppContainer,
    queue: List<TrackDto>,
    startIndex: Int = 0,
    onPlay: (List<TrackDto>, Int) -> Unit,
) {
    val playable = queue.filter { it.isPlayable() && it.id.length == 11 }
    if (playable.isEmpty()) return
    val idx = startIndex.coerceIn(0, playable.lastIndex)
    onPlay(playable, idx)
    val base = container.resolvedApiBase()
    if (base.isNotBlank()) {
        withContext(Dispatchers.IO) {
            val lead = playable.drop(idx).take(4).map { it.id }
            StreamPrefetcher.prepareShuffleLead(base, lead)
        }
    }
}
