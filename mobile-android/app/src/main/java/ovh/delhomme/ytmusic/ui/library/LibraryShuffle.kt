package ovh.delhomme.ytmusic.ui.library

import android.widget.Toast
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import ovh.delhomme.ytmusic.YtMusicApp
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.ShuffleHeadStore
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.data.resolvePinsPool
import ovh.delhomme.ytmusic.player.PlayerCache
import ovh.delhomme.ytmusic.player.StreamPrefetcher
import ovh.delhomme.ytmusic.ui.util.toastMain

/**
 * Aléatoire avec anti-répétition.
 *
 * onPlay **immédiat** ; #0 priorise hors-ligne / SimpleCache / têtes serveur.
 * Warm lead en parallèle après (Exo a la bande).
 */
/** File jouable en RAM / Exo — le reste reste dans [PlaybackService.Holder.fullQueue]. */
private const val PLAY_RAM_CAP = 400

suspend fun playLibraryShuffled(
    container: AppContainer,
    queue: List<TrackDto>,
    onPlay: (List<TrackDto>, Int) -> Unit,
    sourceKey: String = "lib:generic",
) = coroutineScope {
    val playable = withContext(Dispatchers.Default) {
        queue.filter { it.isPlayable() && it.id.length == 11 }
    }
    if (playable.isEmpty()) {
        YtMusicApp.instance.toastMain("Aucun titre jouable", Toast.LENGTH_SHORT)
        return@coroutineScope
    }
    val ctx = YtMusicApp.instance
    val recent = ShuffleHeadStore.loadRecentPlayed(ctx, max = 400).toHashSet()
    var warmIds = container.libraryHeadPrefetcher.cachedShuffleHeadIds()
    // Heads en parallèle — ne bloque pas le play plus de ~200 ms
    val headsJob = if (warmIds.isEmpty()) {
        async(Dispatchers.IO) {
            withTimeoutOrNull(220L) {
                runCatching { container.libraryHeadPrefetcher.ensureShuffleHeads(force = true) }
            }
        }
    } else {
        null
    }
    // Offline : seulement candidats warm / tête de liste (pas 14k has())
    val probeIds = (warmIds + playable.asSequence().take(160).map { it.id }.toList()).distinct()
    val offlineIds = withContext(Dispatchers.IO) {
        probeIds.filter { container.offlineStore.has(it) }.toHashSet()
    }
    if (headsJob != null) {
        headsJob.await()
        warmIds = container.libraryHeadPrefetcher.cachedShuffleHeadIds()
    }
    // Parmi les warm : ceux déjà en SimpleCache / hors-ligne (démarrage <1 s)
    val hotWarm = withContext(Dispatchers.IO) {
        warmIds.filter { id ->
            id in offlineIds ||
                PlayerCache.cachedBytes(ctx, id, StreamPrefetcher.HEAD_3S) >= MIN_HOT_BYTES
        }
    }
    val biasWarm = hotWarm.ifEmpty { warmIds }
    val shuffled = withContext(Dispatchers.Default) {
        trueShuffleQueue(playable, recent, biasWarm, offlineIds)
    }
    val base = container.resolvedApiBase()
    val leadIds = shuffled.take(3).map { it.id }
    val lead0 = leadIds.firstOrNull().orEmpty()
    val lead0Hot = lead0.isNotEmpty() && (
        lead0 in offlineIds ||
            PlayerCache.cachedBytes(ctx, lead0, StreamPrefetcher.HEAD_3S) >= MIN_HOT_BYTES
        )
    // Ne pas cancelAll avant Exo si on a déjà une tête utile
    StreamPrefetcher.cancelIdle(preserveNext = true)
    StreamPrefetcher.quietPrefetch(400L)
    runCatching { container.downloadManager.cancelOpportunistic() }
    if (lead0Hot) {
        StreamPrefetcher.markHeadReady(lead0)
    }
    // Play tout de suite — zéro attente warm bloquant
    val leadWindow = if (shuffled.size > PLAY_RAM_CAP) shuffled.take(PLAY_RAM_CAP) else shuffled
    onPlay(leadWindow, 0)
    ovh.delhomme.ytmusic.player.PlaybackService.Holder.rememberFullQueue(shuffled, leadWindow.size)
    ShuffleHeadStore.rememberPlayed(ctx, shuffled.take(1).map { it.id })
    if (base.isNotBlank() && !StreamPrefetcher.isStreamDown()) {
        launch(Dispatchers.IO) {
            kotlinx.coroutines.delay(if (lead0Hot) 80L else 120L)
            StreamPrefetcher.prefetchByProximity(base, shuffled.map { it.id }, 0, ahead = 4, force = true)
            StreamPrefetcher.prefetchNextDuringPlayback(base, shuffled.map { it.id }, 0, ignoreQuiet = true)
            if (!lead0Hot) {
                runCatching { StreamPrefetcher.warmTrackFormatOnly(base, lead0) }
            }
            withTimeoutOrNull(LEAD_WARM_TIMEOUT_MS) {
                runCatching { StreamPrefetcher.prepareShuffleLead(base, leadIds.take(2)) }
            }
            runCatching {
                val nextHead = shuffled.drop(1).take(4).map { it.id }
                StreamPrefetcher.warmFormatsLight(base, nextHead, limit = 4)
                val fp = ShuffleHeadStore.fingerprint(playable.take(500))
                val cacheKey = ShuffleHeadStore.keyFor(sourceKey, fp)
                ShuffleHeadStore.saveHead(ctx, cacheKey, nextHead)
            }
            container.libraryHeadPrefetcher.requestSoon("after-shuffle")
        }
    }
}

/**
 * #0 : hors-ligne → warm/hot → pool. #1–#2 aussi tirés du warm (évite skip froid).
 * Reste : mélange partiel.
 */
internal fun trueShuffleQueue(
    playable: List<TrackDto>,
    recent: Set<String>,
    warmIds: List<String>,
    offlineIds: Set<String> = emptySet(),
): List<TrackDto> {
    if (playable.size <= 1) return playable
    val fresh = playable.filter { it.id !in recent }
    val pool = if (fresh.size >= (playable.size / 4).coerceAtLeast(8)) fresh else playable
    val byId = pool.associateBy { it.id }
    val warmSet = warmIds.toHashSet()
    val offlineInPool = pool.filter { it.id in offlineIds }
    val warmOffline = offlineInPool.filter { it.id in warmSet }
    val warmInPool = pool.filter { it.id in warmSet }
    val startPool = when {
        warmOffline.isNotEmpty() -> warmOffline
        offlineInPool.isNotEmpty() -> offlineInPool
        warmInPool.isNotEmpty() -> warmInPool
        else -> pool
    }
    val start = startPool.random()
    val used = linkedSetOf(start.id)
    val head = mutableListOf(start)
    // #1 puis #2 : rester dans le lot serveur warm (sinon BUFFERING au skip)
    for (wid in warmIds) {
        if (head.size >= 3) break
        if (wid in used) continue
        val t = byId[wid] ?: continue
        head += t
        used += wid
    }
    val restPool = pool.filter { it.id !in used }
    if (restPool.isEmpty()) return head
    val copy = restPool.toMutableList()
    val mixN = minOf(240, copy.size)
    for (i in 0 until mixN) {
        val j = i + kotlin.random.Random.nextInt(copy.size - i)
        val tmp = copy[i]
        copy[i] = copy[j]
        copy[j] = tmp
    }
    return head + copy
}

/**
 * Tout lire / play à l’index : démarre immédiatement, chauffe le lead en parallèle.
 */
suspend fun playQueueWithLead(
    container: AppContainer,
    queue: List<TrackDto>,
    startIndex: Int = 0,
    onPlay: (List<TrackDto>, Int) -> Unit,
) = coroutineScope {
    val playable = withContext(Dispatchers.Default) {
        queue.filter { it.isPlayable() && it.id.length == 11 }
    }
    if (playable.isEmpty()) {
        YtMusicApp.instance.toastMain("Aucun titre jouable", Toast.LENGTH_SHORT)
        return@coroutineScope
    }
    val idx = startIndex.coerceIn(0, playable.lastIndex)
    val from = idx
    val to = (from + PLAY_RAM_CAP).coerceAtMost(playable.size)
    val window = if (playable.size > PLAY_RAM_CAP) playable.subList(from, to) else playable
    val localIdx = if (playable.size > PLAY_RAM_CAP) 0 else idx
    val base = container.resolvedApiBase()
    val lead = window.drop(localIdx).take(20).map { it.id }
    val lead0 = lead.firstOrNull().orEmpty()
    val ctx = YtMusicApp.instance
    val hot = lead0.isNotEmpty() && (
        container.offlineStore.has(lead0) ||
            PlayerCache.cachedBytes(ctx, lead0, StreamPrefetcher.HEAD_3S) >= MIN_HOT_BYTES
        )
    if (hot) StreamPrefetcher.markHeadReady(lead0)
    StreamPrefetcher.cancelIdle(preserveNext = true)
    StreamPrefetcher.quietPrefetch(400L)
    onPlay(window, localIdx)
    ovh.delhomme.ytmusic.player.PlaybackService.Holder.rememberFullQueue(playable, from + window.size)
    container.libraryHeadPrefetcher.warmDisplayedList(lead.take(3))
    if (base.isNotBlank() && !StreamPrefetcher.isStreamDown()) {
        launch(Dispatchers.IO) {
            runCatching { container.downloadManager.cancelOpportunistic() }
            kotlinx.coroutines.delay(if (hot) 80L else 120L)
            StreamPrefetcher.prefetchByProximity(base, window.map { it.id }, localIdx, ahead = 4, force = true)
            StreamPrefetcher.prefetchNextDuringPlayback(base, window.map { it.id }, localIdx, ignoreQuiet = true)
            withTimeoutOrNull(LEAD_WARM_TIMEOUT_MS) {
                runCatching { StreamPrefetcher.prepareShuffleLead(base, lead.take(2)) }
            }
            StreamPrefetcher.warmFormatsLight(base, lead.drop(1).take(4), limit = 4)
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
    val uniq = if (pins.isEmpty()) {
        emptyList()
    } else {
        withContext(Dispatchers.IO) {
            resolvePinsPool(container.api, pins, container.mixCache)
        }
    }
    val pool = if (uniq.isNotEmpty()) {
        uniq
    } else {
        var lib = container.libraryRepo.library.value
        if (lib == null || (lib.songs.isEmpty() && lib.liked.isEmpty())) {
            runCatching { container.libraryRepo.refresh(force = false) }
            lib = container.libraryRepo.library.value
                ?: runCatching { container.api.library() }.getOrNull()
        }
        (lib?.songs.orEmpty() + lib?.liked.orEmpty() + lib?.history.orEmpty())
            .filter { it.isPlayable() && it.id.length == 11 }
            .distinctBy { it.id }
    }
    if (pool.isEmpty()) return false
    playLibraryShuffled(
        container,
        pool,
        onPlay,
        sourceKey = if (uniq.isNotEmpty()) "home:pins" else "home:library",
    )
    return true
}

/** ~180 Ko ≈ 1 s audio — assez pour marquer « chaud » et laisser Exo démarrer. */
private const val MIN_HOT_BYTES = 180L * 1024L
private const val LEAD_WARM_TIMEOUT_MS = 1_600L
