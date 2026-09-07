package ovh.delhomme.ytmusic.ui.library

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ovh.delhomme.ytmusic.YtMusicApp
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.ShuffleHeadStore
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.player.StreamPrefetcher

/**
 * Aléatoire avec anti-répétition (évite de rejouer les ~400 derniers ids).
 * Ne réutilise plus une tête en cache qui figeait les mêmes 12 titres.
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
    val recent = ShuffleHeadStore.loadRecentPlayed(ctx, max = 400).toHashSet()
    val shuffled = withContext(Dispatchers.Default) {
        val fresh = playable.filter { it.id !in recent }
        val pool = if (fresh.size >= (playable.size / 4).coerceAtLeast(24)) fresh else playable
        pool.shuffled()
    }
    val base = container.resolvedApiBase()
    onPlay(shuffled, 0)
    ShuffleHeadStore.rememberPlayed(ctx, shuffled.take(1).map { it.id })
    withContext(Dispatchers.IO) {
        runCatching {
            if (base.isNotBlank()) {
                StreamPrefetcher.warmTrackFormatOnly(base, shuffled.first().id)
                StreamPrefetcher.warmFormatsLight(base, shuffled.drop(1).take(4).map { it.id }, limit = 4)
            }
            // Tête suivante = vrai reshuffle (pas la même tête 45 min)
            val nextHead = shuffled.drop(1).take(12).map { it.id }
            val fp = ShuffleHeadStore.fingerprint(playable)
            val cacheKey = ShuffleHeadStore.keyFor(sourceKey, fp)
            ShuffleHeadStore.saveHead(ctx, cacheKey, nextHead)
            if (base.isNotBlank() && !StreamPrefetcher.isStreamDown()) {
                StreamPrefetcher.warmFormatsLight(base, nextHead.take(6), limit = 6)
                StreamPrefetcher.warmHeads3s(base, nextHead.take(4), limit = 4)
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
