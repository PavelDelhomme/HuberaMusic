package ovh.delhomme.ytmusic.ui.library

import android.widget.Toast
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import ovh.delhomme.ytmusic.YtMusicApp
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.ShuffleHeadStore
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.data.resolvePinsPool
import ovh.delhomme.ytmusic.player.StreamPrefetcher
import ovh.delhomme.ytmusic.ui.util.toastMain

/**
 * Aléatoire avec anti-répétition.
 *
 * Les ids warm serveur servent de **biais soft** pour #0 (démarrage chaud).
 * [prepareShuffleLead] chauffe en parallèle / avec timeout court — jamais bloquer
 * le tap « Aléatoire » / « Tout lire ».
 */
suspend fun playLibraryShuffled(
    container: AppContainer,
    queue: List<TrackDto>,
    onPlay: (List<TrackDto>, Int) -> Unit,
    sourceKey: String = "lib:generic",
) {
    val playable = queue.filter { it.isPlayable() && it.id.length == 11 }
    if (playable.isEmpty()) {
        YtMusicApp.instance.toastMain("Aucun titre jouable", Toast.LENGTH_SHORT)
        return
    }
    val ctx = YtMusicApp.instance
    val recent = ShuffleHeadStore.loadRecentPlayed(ctx, max = 400).toHashSet()
    // Soft-biais heads serveur même pour pins / petites files (évite #0 froid).
    val warmIds = container.libraryHeadPrefetcher.cachedShuffleHeadIds()
    val shuffled = withContext(Dispatchers.Default) {
        trueShuffleQueue(playable, recent, warmIds)
    }
    val base = container.resolvedApiBase()
    val leadIds = shuffled.take(3).map { it.id }
    // Démarrer tout de suite — warm lead en best-effort (timeout court).
    onPlay(shuffled, 0)
    ShuffleHeadStore.rememberPlayed(ctx, shuffled.take(1).map { it.id })
    if (base.isNotBlank() && !StreamPrefetcher.isStreamDown()) {
        runCatching { container.downloadManager.cancelOpportunistic() }
        withContext(Dispatchers.IO) {
            withTimeoutOrNull(LEAD_WARM_TIMEOUT_MS) {
                runCatching { StreamPrefetcher.prepareShuffleLead(base, leadIds) }
            }
            runCatching {
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
    // Soft biais : dès 1 candidat warm → #0 chaud ; sinon pool libre.
    val startPool = if (warmInPool.isNotEmpty()) warmInPool else pool
    val start = startPool.random()
    val rest = pool.filter { it.id != start.id }.shuffled()
    return listOf(start) + rest
}

/**
 * Tout lire / play à l’index : démarre immédiatement, chauffe le lead en parallèle.
 */
suspend fun playQueueWithLead(
    container: AppContainer,
    queue: List<TrackDto>,
    startIndex: Int = 0,
    onPlay: (List<TrackDto>, Int) -> Unit,
) {
    val playable = queue.filter { it.isPlayable() && it.id.length == 11 }
    if (playable.isEmpty()) {
        YtMusicApp.instance.toastMain("Aucun titre jouable", Toast.LENGTH_SHORT)
        return
    }
    val idx = startIndex.coerceIn(0, playable.lastIndex)
    val base = container.resolvedApiBase()
    val lead = playable.drop(idx).take(3).map { it.id }
    onPlay(playable, idx)
    if (base.isNotBlank() && !StreamPrefetcher.isStreamDown()) {
        runCatching { container.downloadManager.cancelOpportunistic() }
        withContext(Dispatchers.IO) {
            withTimeoutOrNull(LEAD_WARM_TIMEOUT_MS) {
                runCatching { StreamPrefetcher.prepareShuffleLead(base, lead) }
            }
            StreamPrefetcher.warmFormatsLight(base, playable.drop(idx + 3).take(6).map { it.id }, limit = 6)
        }
    }
}

/**
 * Aléatoire Accès rapide : résout les pins en parallèle puis [playLibraryShuffled].
 * @return false si aucun titre jouable (caller → Toast).
 */
suspend fun playQuickAccessShuffled(
    container: AppContainer,
    pins: List<TrackDto>,
    onPlay: (List<TrackDto>, Int) -> Unit,
): Boolean {
    if (pins.isEmpty()) return false
    val uniq = withContext(Dispatchers.IO) {
        resolvePinsPool(container.api, pins, container.mixCache)
    }
    if (uniq.isEmpty()) return false
    playLibraryShuffled(
        container,
        uniq,
        onPlay,
        sourceKey = "home:pins",
    )
    return true
}

private const val LEAD_WARM_TIMEOUT_MS = 700L
