package ovh.delhomme.ytmusic.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import ovh.delhomme.ytmusic.debug.AppLog
import ovh.delhomme.ytmusic.player.StreamPrefetcher

/**
 * Garde hors-ligne en arrière-plan (léger) :
 * - titres « J'aime » toujours téléchargés
 * - « Mon Mix » ≈ 100 titres (historique + aimés), rafraîchi périodiquement
 * Ne concurrence pas la lecture : Wi‑Fi préféré, 1 DL à la fois, pause si stream down.
 */
class OfflineKeeper(
    private val context: Context,
    private val scope: CoroutineScope,
    private val offlineStore: LocalOfflineStore,
    private val downloadManager: OfflineDownloadManager,
    private val api: YtMusicApi,
    private val ensureToken: suspend () -> Unit,
) {
    private val prefs = context.getSharedPreferences("ytm_offline_keeper", Context.MODE_PRIVATE)
    private val tickMutex = Mutex()
    private var started = false

    /** IDs du dernier « Mon Mix » construit (pour la biblio / filtre). */
    fun monMixIds(): List<String> =
        prefs.getString(KEY_MON_MIX, null)
            ?.split(',')
            ?.map { it.trim() }
            ?.filter { it.matches(Regex("^[a-zA-Z0-9_-]{11}$")) }
            .orEmpty()

    fun start() {
        if (started) return
        started = true
        scope.launch(Dispatchers.IO) {
            delay(90_000L) // laisse démarrer l’app / lecture
            while (true) {
                runCatching { tick(reason = "periodic") }
                delay(INTERVAL_MS)
            }
        }
    }

    /** Appel manuel (retour réseau, ouverture biblio…). */
    fun requestSoon(reason: String = "manual") {
        scope.launch(Dispatchers.IO) {
            delay(4_000L)
            runCatching { tick(reason) }
        }
    }

    private suspend fun tick(reason: String) = tickMutex.withLock {
        if (!NetworkMonitor.isOnline()) return
        if (StreamPrefetcher.isStreamDown()) return
        if (!isUnmeteredPreferred()) {
            // Données mobiles : seulement aimés manquants (cap bas)
            syncLiked(limit = 8)
            return
        }
        val last = prefs.getLong(KEY_LAST_TICK, 0L)
        if (reason == "periodic" && System.currentTimeMillis() - last < INTERVAL_MS - 30_000L) {
            return
        }
        AppLog.i("OfflineKeeper", "tick reason=$reason")
        if (StreamPrefetcher.isStreamDown()) {
            AppLog.w("OfflineKeeper", "skip tick — stream down")
            return
        }
        ensureToken()
        syncLiked(limit = 8)
        delay(2_500)
        if (!NetworkMonitor.isOnline() || StreamPrefetcher.isStreamDown()) return
        syncMonMix()
        prefs.edit().putLong(KEY_LAST_TICK, System.currentTimeMillis()).apply()
    }

    private suspend fun syncLiked(limit: Int) {
        val lib = runCatching { api.library() }.getOrNull() ?: return
        val liked = (lib.liked.orEmpty() + lib.songs.orEmpty())
            .filter { it.isPlayable() && it.id.matches(Regex("^[a-zA-Z0-9_-]{11}$")) }
            .distinctBy { it.id }
        var n = 0
        for (t in liked) {
            if (n >= limit) break
            if (offlineStore.has(t.id)) continue
            if (!NetworkMonitor.isOnline() || StreamPrefetcher.isStreamDown()) break
            if (downloadManager.enqueue(t)) n++
            delay(2_200)
        }
        if (n > 0) AppLog.i("OfflineKeeper", "liked enqueued=$n")
    }

    private suspend fun syncMonMix() {
        val lib = runCatching { api.library() }.getOrNull() ?: return
        val pool = buildList {
            addAll(lib.history.orEmpty())
            addAll(lib.liked.orEmpty())
            addAll(lib.songs.orEmpty())
            addAll(lib.recentEntities.orEmpty().filter { it.isPlayable() })
        }
            .filter { it.isPlayable() && it.id.matches(Regex("^[a-zA-Z0-9_-]{11}$")) }
            .distinctBy { it.id }
            .take(MON_MIX_TARGET)

        if (pool.isEmpty()) return
        prefs.edit()
            .putString(KEY_MON_MIX, pool.joinToString(",") { it.id })
            .apply()

        var started = 0
        for (t in pool) {
            if (started >= 12) break // petit lot par tick (évite saturer)
            if (offlineStore.has(t.id)) continue
            if (!NetworkMonitor.isOnline() || StreamPrefetcher.isStreamDown()) break
            if (downloadManager.enqueue(t)) started++
            delay(2_500)
        }
        if (started > 0) AppLog.i("OfflineKeeper", "monMix enqueued=$started target=${pool.size}")
    }

    private fun isUnmeteredPreferred(): Boolean {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return false
        val net = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) ||
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
    }

    companion object {
        private const val KEY_LAST_TICK = "last_tick_ms"
        private const val KEY_MON_MIX = "mon_mix_ids"
        private const val INTERVAL_MS = 20L * 60L * 1000L // 20 min
        const val MON_MIX_TARGET = 100
        const val MON_MIX_ID = "offline-mon-mix"
        const val MON_MIX_TITLE = "Mon Mix"
    }
}
