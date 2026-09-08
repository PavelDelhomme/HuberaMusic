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
            // Premier passage agressif : chauffe formats API (évite 50–60 s à froid)
            runCatching { warmFormatsBurst() }
            runCatching { warmServerShuffleHeads(force = true) }
            runCatching { warmServerRecentHeads() }
            while (true) {
                runCatching { tick(reason = "periodic") }
                runCatching { warmServerShuffleHeads(force = false) }
                runCatching { warmServerRecentHeads() }
                delay(INTERVAL_MS)
            }
        }
    }

    /**
     * Tire le batch serveur (~100 têtes rotatives) et warm léger côté Android.
     * Refresh quand le créneau expire (~30 min, plusieurs dizaines×/jour).
     */
    private suspend fun warmServerShuffleHeads(force: Boolean) {
        if (!NetworkMonitor.isOnline()) return
        if (StreamPrefetcher.isStreamDown()) return
        val now = System.currentTimeMillis()
        val expires = prefs.getLong(KEY_SHUFFLE_EXPIRES, 0L)
        if (!force && expires > now + 60_000L) return
        if (!force && now - prefs.getLong(KEY_SHUFFLE_FETCH, 0L) < 5 * 60_000L) return
        runCatching { container.ensureFreshToken() }
        val r = runCatching { container.api.shuffleHeads(warm = 1, scope = "all") }.getOrNull() ?: return
        val ids = r.ids.filter { it.length == 11 }.distinct()
        if (ids.isEmpty()) return
        prefs.edit()
            .putString(KEY_SHUFFLE_IDS, ids.joinToString(","))
            .putLong(KEY_SHUFFLE_EXPIRES, r.expiresAt ?: (now + 30 * 60_000L))
            .putLong(KEY_SHUFFLE_FETCH, now)
            .apply()
        val base = container.resolvedApiBase()
        if (base.isBlank()) return
        // Client : 16 formats + 8 têtes 3s — le gros warm reste serveur (48)
        StreamPrefetcher.warmFormatsLight(base, ids.take(16), limit = 16)
        if (!StreamPrefetcher.isQuiet() && !PlaybackService.Holder.isPlaybackActiveSafe()) {
            StreamPrefetcher.warmHeads3s(base, ids.take(8), limit = 8)
        }
        AppLog.i(
            "LibHeads",
            "shuffle-heads n=${ids.size} slot=${r.slot} expires=${r.expiresAt} pool=${r.poolSize}",
        )
    }

    /** Warm ciblé « Enregistré récemment » (scope=recent) — ne remplace pas la tête Aléatoire globale. */
    private suspend fun warmServerRecentHeads() {
        if (!NetworkMonitor.isOnline()) return
        if (StreamPrefetcher.isStreamDown()) return
        val now = System.currentTimeMillis()
        if (now - prefs.getLong(KEY_RECENT_FETCH, 0L) < 8 * 60_000L) return
        runCatching { container.ensureFreshToken() }
        val r = runCatching { container.api.shuffleHeads(warm = 1, scope = "recent") }.getOrNull() ?: return
        val ids = r.ids.filter { it.length == 11 }.distinct()
        if (ids.isEmpty()) return
        prefs.edit().putLong(KEY_RECENT_FETCH, now).apply()
        val base = container.resolvedApiBase()
        if (base.isBlank()) return
        StreamPrefetcher.warmFormatsLight(base, ids.take(20), limit = 20)
        if (!StreamPrefetcher.isQuiet() && !PlaybackService.Holder.isPlaybackActiveSafe()) {
            StreamPrefetcher.warmHeads3s(base, ids.take(10), limit = 10)
        }
        AppLog.i("LibHeads", "shuffle-heads recent n=${ids.size} pool=${r.poolSize}")
    }

    /** Ids serveur pour amorcer Aléatoire (null si créneau périmé / vide). */
    fun cachedShuffleHeadIds(): List<String> {
        val now = System.currentTimeMillis()
        val expires = prefs.getLong(KEY_SHUFFLE_EXPIRES, 0L)
        if (expires > 0L && expires < now) return emptyList()
        val raw = prefs.getString(KEY_SHUFFLE_IDS, null) ?: return emptyList()
        return raw.split(',').map { it.trim() }.filter { it.length == 11 }
    }

    /** POST /api/stream/warm pour les 1ers titres biblio (petits comptes inclus). */
    private suspend fun warmFormatsBurst() {
        if (!NetworkMonitor.isOnline()) return
        val base = container.resolvedApiBase()
        if (base.isBlank()) return
        val ids = libraryIds().take(36)
        if (ids.isEmpty()) return
        AppLog.i("LibHeads", "format burst ${ids.size}")
        StreamPrefetcher.warmTracks(base, ids)
        StreamPrefetcher.prefetchLibraryHeads(base, ids, limit = 12)
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
            runCatching { warmServerShuffleHeads(force = reason.contains("shuffle")) }
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
                addAll(remote.songs.orEmpty().map { it.id })
                addAll(remote.liked.orEmpty().map { it.id })
                addAll(remote.history.orEmpty().map { it.id })
            }
                .filter { it.length == 11 }
                .distinct()
        }
        return buildList {
            // Songs biblio d’abord (ajouts récents / Enregistré récemment), puis likes, puis history
            addAll(lib.songs.map { it.id })
            addAll(lib.liked.map { it.id })
            addAll(lib.history.map { it.id })
        }
            .filter { it.length == 11 }
            .distinct()
    }

    companion object {
        /** Démarre vite après login — biblio froide = 50–60 s au 1er titre (compte Hélène). */
        private const val START_DELAY_MS = 1_800L
        private const val INTERVAL_MS = 60_000L
        private const val BATCH = 12
        private const val KEY_CURSOR = "cursor"
        private const val KEY_LAST = "last_tick"
        private const val KEY_SHUFFLE_IDS = "shuffle_head_ids"
        private const val KEY_SHUFFLE_EXPIRES = "shuffle_head_expires"
        private const val KEY_SHUFFLE_FETCH = "shuffle_head_fetch"
        private const val KEY_RECENT_FETCH = "shuffle_recent_fetch"
    }
}
