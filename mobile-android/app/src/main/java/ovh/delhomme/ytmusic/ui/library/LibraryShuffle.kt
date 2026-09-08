package ovh.delhomme.ytmusic.ui.library

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ovh.delhomme.ytmusic.YtMusicApp
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.ShuffleHeadStore
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.player.StreamPrefetcher

/**
 * Aléatoire avec anti-répétition + tête serveur (~100 ids rotatifs ~30 min).
 * Pour « Enregistré récemment », on ne force pas la tête biblio globale
 * (mismatch warm) : shuffle local + [prepareShuffleLead] **avant** le play.
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
    val additionsScope = sourceKey.contains("Additions", ignoreCase = true)
    val serverHead =
        if (additionsScope) emptyList()
        else container.libraryHeadPrefetcher.cachedShuffleHeadIds()
    val shuffled = withContext(Dispatchers.Default) {
        val fresh = playable.filter { it.id !in recent }
        val pool = if (fresh.size >= (playable.size / 4).coerceAtLeast(24)) fresh else playable
        if (serverHead.isNotEmpty()) {
            ShuffleHeadStore.applyHead(pool, serverHead)
        } else {
            pool.shuffled()
        }
    }
    val base = container.resolvedApiBase()
    val leadIds = shuffled.take(3).map { it.id }
    // Coupe DL opportuniste + préchauffe #0–#2 **avant** Exo (sinon 50–60 s à froid).
    if (base.isNotBlank() && !StreamPrefetcher.isStreamDown()) {
        runCatching { container.downloadManager.cancelOpportunistic() }
        withContext(Dispatchers.IO) {
            runCatching { StreamPrefetcher.prepareShuffleLead(base, leadIds) }
        }
    }
    onPlay(shuffled, 0)
    ShuffleHeadStore.rememberPlayed(ctx, shuffled.take(1).map { it.id })
    withContext(Dispatchers.IO) {
        runCatching {
            if (base.isNotBlank() && !StreamPrefetcher.isStreamDown()) {
                val nextHead = shuffled.drop(3).take(12).map { it.id }
                StreamPrefetcher.warmFormatsLight(base, nextHead, limit = 12)
                StreamPrefetcher.warmHeads3s(base, shuffled.drop(1).take(8).map { it.id }, limit = 8)
                val fp = ShuffleHeadStore.fingerprint(playable)
                val cacheKey = ShuffleHeadStore.keyFor(sourceKey, fp)
                ShuffleHeadStore.saveHead(ctx, cacheKey, shuffled.drop(1).take(12).map { it.id })
            }
            container.libraryHeadPrefetcher.requestSoon("after-shuffle")
        }
    }
}

/**
 * Tout lire / play à l’index : chauffe le lead puis démarre.
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
    val base = container.resolvedApiBase()
    val lead = playable.drop(idx).take(3).map { it.id }
    if (base.isNotBlank() && !StreamPrefetcher.isStreamDown()) {
        runCatching { container.downloadManager.cancelOpportunistic() }
        withContext(Dispatchers.IO) {
            runCatching { StreamPrefetcher.prepareShuffleLead(base, lead) }
        }
    }
    onPlay(playable, idx)
    if (base.isNotBlank()) {
        withContext(Dispatchers.IO) {
            StreamPrefetcher.warmFormatsLight(base, playable.drop(idx + 3).take(6).map { it.id }, limit = 6)
        }
    }
}
