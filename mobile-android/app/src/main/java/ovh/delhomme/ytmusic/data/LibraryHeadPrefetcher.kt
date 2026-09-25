package ovh.delhomme.ytmusic.data

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import ovh.delhomme.ytmusic.debug.AppLog
import ovh.delhomme.ytmusic.player.PlaybackService
import ovh.delhomme.ytmusic.player.StreamPrefetcher
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * Précharge ~5 s de tête (SimpleCache) pour la bibliothèque en fond.
 * Priorité : pins → aimés → boost viewport → songs → historique.
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
            // Têtes Aléatoire d’abord (ids en prefs) — avant le burst formats qui peut être long
            runCatching { warmServerShuffleHeads(force = true, warmClient = true) }
            runCatching { warmServerListHeads(force = true) }
            runCatching { warmFormatsBurst() }
            runCatching { warmServerRecentHeads() }
            while (true) {
                runCatching { tick(reason = "periodic") }
                runCatching { warmServerShuffleHeads(force = false) }
                runCatching { warmServerListHeads(force = false) }
                runCatching { warmServerRecentHeads() }
                delay(INTERVAL_MS)
            }
        }
    }

    /**
     * Tire le batch serveur (~100 têtes rotatives) et warm léger côté Android.
     * Refresh quand le créneau expire (~30 min, plusieurs dizaines×/jour).
     */
    private suspend fun warmServerShuffleHeads(force: Boolean, warmClient: Boolean = true) {
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
        AppLog.i(
            "LibHeads",
            "shuffle-heads n=${ids.size} slot=${r.slot} expires=${r.expiresAt} pool=${r.poolSize} warmClient=$warmClient",
        )
        if (!warmClient) return
        val base = container.resolvedApiBase()
        if (base.isBlank()) return
        // Client : 16 formats + 8 têtes 3s — le gros warm reste serveur (48)
        StreamPrefetcher.warmFormatsLight(base, ids.take(16), limit = 16)
        if (!StreamPrefetcher.isQuiet() && !PlaybackService.Holder.isPlaybackActiveSafe()) {
            StreamPrefetcher.warmHeads3s(base, ids.take(8), limit = 8)
        }
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

    /** A–Z / récents / aimés : 20 débuts sur le VPS + têtes téléphone. */
    private suspend fun warmServerListHeads(force: Boolean) {
        if (!NetworkMonitor.isOnline()) return
        if (StreamPrefetcher.isStreamDown()) return
        val now = System.currentTimeMillis()
        if (!force && now - prefs.getLong(KEY_LIST_FETCH, 0L) < 4 * 60_000L) return
        runCatching { container.ensureFreshToken() }
        val az = runCatching { container.api.listHeads(warm = 1, scope = "az") }.getOrNull()?.ids.orEmpty()
        val recent = runCatching { container.api.listHeads(warm = 1, scope = "recent") }.getOrNull()?.ids.orEmpty()
        val liked = runCatching { container.api.listHeads(warm = 1, scope = "liked") }.getOrNull()?.ids.orEmpty()
        val ids = (az + recent + liked).filter { it.length == 11 }.distinct()
        if (ids.isEmpty()) return
        prefs.edit().putLong(KEY_LIST_FETCH, now).apply()
        val base = container.resolvedApiBase()
        if (base.isBlank()) return
        StreamPrefetcher.warmFormatsLight(base, ids.take(20), limit = 20)
        StreamPrefetcher.warmHeads3s(base, ids.take(16), limit = 16)
        AppLog.i("LibHeads", "list-heads az=${az.size} recent=${recent.size} liked=${liked.size}")
    }

    /**
     * File affichée (Tout lire, album, artiste, singles) : VPS + téléphone en parallèle.
     */
    fun warmDisplayedList(ids: List<String>) {
        val clean = ids.filter { it.length == 11 }.distinct().take(20)
        if (clean.isEmpty()) return
        boostVisible(clean)
        scope.launch(Dispatchers.IO) {
            if (!NetworkMonitor.isOnline()) return@launch
            if (StreamPrefetcher.isStreamDown()) return@launch
            runCatching { container.ensureFreshToken() }
            runCatching { container.api.postListHeads(ListHeadsBody(clean)) }
            val base = container.resolvedApiBase()
            if (base.isBlank()) return@launch
            StreamPrefetcher.warmFormatsLight(base, clean, limit = 20)
            if (!PlaybackService.Holder.isPlaybackActiveSafe()) {
                StreamPrefetcher.warmHeads3s(base, clean, limit = 16)
            }
            AppLog.i("LibHeads", "visible-list n=${clean.size}")
        }
    }

    /** Ids serveur pour amorcer Aléatoire (null si créneau périmé / vide). */
    fun cachedShuffleHeadIds(): List<String> {
        val now = System.currentTimeMillis()
        val expires = prefs.getLong(KEY_SHUFFLE_EXPIRES, 0L)
        if (expires > 0L && expires < now) return emptyList()
        val raw = prefs.getString(KEY_SHUFFLE_IDS, null) ?: return emptyList()
        return raw.split(',').map { it.trim() }.filter { it.length == 11 }
    }

    /**
     * Refresh rapide des ids Aléatoire (prefs) — sans warm client (le lecteur le fait au play).
     * À appeler juste avant un shuffle froid pour un #0 dans le batch serveur.
     */
    suspend fun ensureShuffleHeads(force: Boolean = false) {
        warmServerShuffleHeads(
            force = force || cachedShuffleHeadIds().isEmpty(),
            warmClient = false,
        )
    }

    /** POST /api/stream/warm pour les 1ers titres biblio (petits comptes inclus). */
    private suspend fun warmFormatsBurst() {
        if (!NetworkMonitor.isOnline()) return
        if (PlaybackService.Holder.isPlaybackActiveSafe()) return
        val base = container.resolvedApiBase()
        if (base.isBlank()) return
        // Petit burst : assez pour fluidité, pas assez pour saturer radio/batterie
        val ids = libraryIds().take(16)
        if (ids.isEmpty()) return
        AppLog.i("LibHeads", "format burst ${ids.size}")
        StreamPrefetcher.warmTracks(base, ids)
        StreamPrefetcher.prefetchLibraryHeads(base, ids, limit = 6)
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
            val urgent = reason.contains("urgent") || reason.contains("shuffle-urgent")
            delay(if (urgent) 40L else 3_000L)
            if (urgent) {
                runCatching { warmServerShuffleHeads(force = true) }
                return@launch
            }
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

        // Aimés manquants en tête (après boost) — prioritaire pour Aléatoire / hors-ligne
        val likedWarm = likedIds().filter { !container.offlineStore.has(it) }.take(6)
        if (likedWarm.isNotEmpty()) {
            StreamPrefetcher.prefetchLibraryHeads(base, likedWarm, limit = 6)
            StreamPrefetcher.warmFormatsLight(base, likedWarm, limit = 6)
        }

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
        AppLog.i("LibHeads", "warmed ${batch.size} from=$start next=$next total=${ids.size} liked=${likedWarm.size}")
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

    private fun likedIds(): List<String> {
        val lib = container.libraryRepo.library.value
        return (lib?.liked.orEmpty()).map { it.id }.filter { it.length == 11 }.distinct()
    }

    private suspend fun libraryIds(): List<String> {
        val pins = runCatching {
            container.quickAccess.pins.first().map { it.id }
        }.getOrDefault(emptyList())
        val cached = container.libraryRepo.library.value
        val lib = cached ?: runCatching {
            container.libraryRepo.ensureLoaded(force = false)
            container.libraryRepo.library.value
        }.getOrNull()
        val azSongs = (lib?.songs.orEmpty() + lib?.liked.orEmpty())
            .filter { it.id.length == 11 }
            .sortedBy { it.title.lowercase() }
            .map { it.id }
            .distinct()
            .take(20)
        if (lib == null) {
            val remote = runCatching { container.api.library() }.getOrNull()
                ?: return (pins.filter { it.length == 11 } + azSongs).distinct()
            return buildList {
                addAll(azSongs)
                addAll(pins)
                addAll(remote.liked.orEmpty().map { it.id })
                addAll(remote.songs.orEmpty().map { it.id })
                addAll(remote.history.orEmpty().map { it.id })
            }
                .filter { it.length == 11 }
                .distinct()
        }
        return buildList {
            addAll(azSongs)
            addAll(pins)
            addAll(lib.liked.map { it.id })
            addAll(lib.songs.map { it.id })
            addAll(lib.history.map { it.id })
        }
            .filter { it.length == 11 }
            .distinct()
    }

    companion object {
        /** Têtes Aléatoire tôt ; burst formats plus tard / plus léger (batterie). */
        private const val START_DELAY_MS = 900L
        private const val INTERVAL_MS = 90_000L
        private const val BATCH = 8
        private const val KEY_CURSOR = "cursor"
        private const val KEY_LAST = "last_tick"
        private const val KEY_SHUFFLE_IDS = "shuffle_head_ids"
        private const val KEY_SHUFFLE_EXPIRES = "shuffle_head_expires"
        private const val KEY_SHUFFLE_FETCH = "shuffle_head_fetch"
        private const val KEY_RECENT_FETCH = "shuffle_recent_fetch"
        private const val KEY_LIST_FETCH = "list_head_fetch"
    }
}
