package ovh.delhomme.ytmusic.data

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import ovh.delhomme.ytmusic.debug.AppLog
import ovh.delhomme.ytmusic.player.PlaybackService
import ovh.delhomme.ytmusic.player.StreamPrefetcher
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * Précharge ~5 s de tête (SimpleCache) pour la bibliothèque en fond.
 * Priorité : titres boostés (viewport) → aimés → songs → historique.
 * Ne concurrence pas le titre en cours (quiet / stream down / lecture).
 */
class LibraryHeadPrefetcher(
    private val context: Context,
    private val scope: CoroutineScope,
    private val container: AppContainer,
) {
    private val prefs = context.getSharedPreferences("ytm_lib_heads", Context.MODE_PRIVATE)
    private val tickMutex = Mutex()
    private val boost = ConcurrentLinkedQueue<String>()
    private var started = false

    fun start() {
        if (started) return
        started = true
        scope.launch(Dispatchers.IO) {
            delay(START_DELAY_MS)
            while (true) {
                runCatching { tick(reason = "periodic") }
                delay(INTERVAL_MS)
            }
        }
    }

    /** Viewport biblio / pins — priorité haute pour les prochains ticks. */
    fun boostVisible(ids: List<String>) {
        ids.asReversed().forEach { id ->
            if (id.length == 11) {
                boost.remove(id)
                boost.offer(id)
            }
        }
        while (boost.size > 48) boost.poll()
        scope.launch(Dispatchers.IO) {
            delay(1_200L)
            runCatching { tick(reason = "visible") }
        }
    }

    fun requestSoon(reason: String = "manual") {
        scope.launch(Dispatchers.IO) {
            delay(3_000L)
            runCatching { tick(reason) }
        }
    }

    private suspend fun tick(reason: String) = tickMutex.withLock {
        if (!NetworkMonitor.isOnline()) return
        if (StreamPrefetcher.isStreamDown()) return
        if (StreamPrefetcher.isQuiet()) return
        if (!BatterySaver.allowBackgroundDownloads()) return
        if (!NetworkMonitor.isUnmeteredPreferred(context) && reason == "periodic") {
            // Données mobiles : seulement boost viewport, petit lot
            drainBoost(limit = 3)
            return
        }
        if (PlaybackService.Holder.isPlaybackActiveSafe() && reason == "periodic") {
            // Lecture active : uniquement boost (faible), pas le crawl complet
            drainBoost(limit = 2)
            return
        }
        val last = prefs.getLong(KEY_LAST, 0L)
        if (reason == "periodic" && System.currentTimeMillis() - last < INTERVAL_MS - 20_000L) {
            return
        }
        AppLog.i("LibHeads", "tick reason=$reason")
        runCatching { container.ensureFreshToken() }
        val base = container.resolvedApiBase()
        if (base.isBlank()) return

        drainBoost(limit = 8)

        val cursor = prefs.getInt(KEY_CURSOR, 0)
        val ids = libraryIds()
        if (ids.isEmpty()) return
        val start = cursor.coerceIn(0, ids.lastIndex)
        val batch = (ids.drop(start) + ids.take(start)).filter { !container.offlineStore.has(it) }.take(BATCH)
        if (batch.isEmpty()) {
            prefs.edit().putInt(KEY_CURSOR, 0).putLong(KEY_LAST, System.currentTimeMillis()).apply()
            return
        }
        StreamPrefetcher.prefetchLibraryHeads(base, batch, limit = BATCH)
        val next = (start + batch.size) % ids.size.coerceAtLeast(1)
        prefs.edit()
            .putInt(KEY_CURSOR, next)
            .putLong(KEY_LAST, System.currentTimeMillis())
            .apply()
        AppLog.i("LibHeads", "warmed ${batch.size} from=$start next=$next total=${ids.size}")
    }

    private fun drainBoost(limit: Int) {
        val base = container.resolvedApiBase()
        if (base.isBlank()) return
        val ids = buildList {
            repeat(limit) {
                val id = boost.poll() ?: return@buildList
                if (!container.offlineStore.has(id)) add(id)
            }
        }
        if (ids.isNotEmpty()) {
            StreamPrefetcher.prefetchLibraryHeads(base, ids, limit = limit)
        }
    }

    private suspend fun libraryIds(): List<String> {
        val cached = container.libraryRepo.library.value
        val lib = cached ?: runCatching {
            container.libraryRepo.ensureLoaded(force = false)
            container.libraryRepo.library.value
        }.getOrNull()
        if (lib == null) {
            val remote = runCatching { container.api.library() }.getOrNull() ?: return emptyList()
            return buildList {
                addAll(remote.liked.orEmpty().map { it.id })
                addAll(remote.songs.orEmpty().map { it.id })
                addAll(remote.history.orEmpty().map { it.id })
            }
                .filter { it.length == 11 }
                .distinct()
        }
        return buildList {
            addAll(lib.liked.map { it.id })
            addAll(lib.songs.map { it.id })
            addAll(lib.history.map { it.id })
        }
            .filter { it.length == 11 }
            .distinct()
    }

    companion object {
        private const val START_DELAY_MS = 45_000L
        private const val INTERVAL_MS = 2 * 60_000L
        private const val BATCH = 6
        private const val KEY_CURSOR = "cursor"
        private const val KEY_LAST = "last_tick"
    }
}
