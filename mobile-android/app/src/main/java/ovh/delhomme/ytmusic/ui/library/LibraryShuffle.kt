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
    // Son d’abord — warm ne bloque plus le 1er play (latence Aléatoire).
    onPlay(shuffled, 0)
    withContext(Dispatchers.IO) {
        runCatching {
            if (base.isNotBlank()) {
                StreamPrefetcher.warmTrackFormatOnly(base, shuffled.first().id)
                StreamPrefetcher.warmFormatsLight(base, shuffled.drop(1).take(4).map { it.id }, limit = 4)
            }
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
            lead.firstOrNull()?.takeIf { it.length == 11 }?.let {
                StreamPrefetcher.warmTrackFormatOnly(base, it)
            }
            StreamPrefetcher.warmFormatsLight(base, lead.drop(1), limit = 3)
        }
    }
}
