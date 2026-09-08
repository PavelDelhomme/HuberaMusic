package ovh.delhomme.ytmusic.ui.library

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ovh.delhomme.ytmusic.YtMusicApp
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.ShuffleHeadStore
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.player.StreamPrefetcher

/**
 * Aléatoire avec anti-répétition.
 *
 * Important : on ne force **plus** l’ordre de la tête serveur (`applyHead`) —
 * ça figeait le même #0 pendant ~30 min (Accès rapide / Aléatoire).
 * Les ids warm servent seulement de **biais soft** : on tire #0 au hasard
 * parmi les titres déjà chauffés s’il y en a assez, sinon tirage libre.
 * [prepareShuffleLead] chauffe ensuite le vrai #0 avant Exo.
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
    val pinsOrRecent =
        sourceKey.contains("Additions", ignoreCase = true) ||
            sourceKey.startsWith("home:") ||
            sourceKey.startsWith("pins") ||
            playable.size < 24
    val warmIds =
        if (pinsOrRecent) emptyList()
        else container.libraryHeadPrefetcher.cachedShuffleHeadIds()
    val shuffled = withContext(Dispatchers.Default) {
        trueShuffleQueue(playable, recent, warmIds)
    }
    val base = container.resolvedApiBase()
    val leadIds = shuffled.take(3).map { it.id }
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
 * #0 tiré au hasard (idéalement hors récents ; soft-biais warm si possible),
 * reste mélangé — jamais d’ordre fixe serveur.
 */
internal fun trueShuffleQueue(
    playable: List<TrackDto>,
    recent: Set<String>,
    warmIds: List<String>,
): List<TrackDto> {
    if (playable.size <= 1) return playable
    val fresh = playable.filter { it.id !in recent }
    val pool = if (fresh.size >= (playable.size / 4).coerceAtLeast(8)) fresh else playable
    val warmSet = warmIds.toHashSet()
    val warmInPool = pool.filter { it.id in warmSet }
    // Soft biais : au moins 3 candidats warm → on tire parmi eux ; sinon pool libre.
    val startPool = if (warmInPool.size >= 3) warmInPool else pool
    val start = startPool.random()
    val rest = pool.filter { it.id != start.id }.shuffled()
    return listOf(start) + rest
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
