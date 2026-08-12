package ovh.delhomme.ytmusic.player

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import ovh.delhomme.ytmusic.YtMusicApp
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Prefetch streams :
 * 1) POST /api/stream/warm (batch) → chauffe le déchiffrement API
 * 2) CacheWriter → SimpleCache Exo (mêmes octets que la lecture)
 * 3) Éviction des titres déjà écoutés pour laisser la place à la suite
 * Annulé uniquement sur pause volontaire (pas pendant un rebuffer / skip).
 */
object StreamPrefetcher {
    /** ~10 s audio typique YT (~160–256 kb/s) + marge conteneur. */
    const val HEAD_3S = 1_400L * 1024L
    /** Tête générique Wi‑Fi (~1.5 Mo ≈ ~45–60 s audio). */
    private const val HEAD_WIFI = 1_800 * 1024L
    /** Titre suivant Wi‑Fi. */
    private const val HEAD_NEXT_WIFI = 4_500 * 1024L
    /** +2 / +3 Wi‑Fi. */
    private const val HEAD_NEAR_WIFI = 2_200 * 1024L
    /** Suite lointaine Wi‑Fi — au minimum ~10 s. */
    private const val HEAD_FAR_WIFI = 1_400 * 1024L

    private const val HEAD_METERED = HEAD_3S
    private const val HEAD_NEXT_METERED = 1_600 * 1024L

    private const val MAX_WARM = 12
    private const val AHEAD_WIFI = 6
    private const val AHEAD_METERED = 3
    private const val DISK_CACHE_MB = 24L
    private val JSON = "application/json; charset=utf-8".toMediaType()

    @Volatile private var streamDownUntil = 0L
    private var streamFailStreak = 0

    fun isStreamDown(): Boolean = System.currentTimeMillis() < streamDownUntil

    fun markStreamOk() {
        streamFailStreak = 0
        streamDownUntil = 0L
    }

    fun markStreamDown(pauseMs: Long = 45_000L) {
        streamDownUntil = System.currentTimeMillis() + pauseMs
        cancelIdle()
    }

    private fun noteNetworkFailure() {
        streamFailStreak += 1
        if (streamFailStreak >= 2) markStreamDown()
    }

    private val client: OkHttpClient by lazy {
        val dir = File(YtMusicApp.instance.cacheDir, "stream-prefetch").apply { mkdirs() }
        OkHttpClient.Builder()
            .cache(okhttp3.Cache(dir, DISK_CACHE_MB * 1024L * 1024L))
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(45, TimeUnit.SECONDS)
            .followRedirects(true)
            .build()
    }

    private val inFlight = ConcurrentHashMap.newKeySet<String>()
    private val recent = object : LinkedHashMap<String, Long>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>?): Boolean =
            size > 64
    }

    /** Coupe les téléchargements prefetch HTTP (pause volontaire uniquement). */
    fun cancelIdle() {
        client.dispatcher.cancelAll()
        inFlight.clear()
        PlayerCache.cancelPrefetch()
    }

    private fun isUnmetered(): Boolean {
        val cm = YtMusicApp.instance.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return false
        val net = cm.activeNetwork ?: return false
        val caps = cm.getNetworkCapabilities(net) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) ||
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ||
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
    }

    private fun authHeader(): String? =
        YtMusicApp.instance.container.tokenStore.peekAccess()?.let { "Bearer $it" }

    private fun isLocalOffline(trackId: String): Boolean =
        runCatching { YtMusicApp.instance.container.offlineStore.has(trackId) }.getOrDefault(false)

    fun warm(resolveUrl: String) {
        if (resolveUrl.isBlank() || isStreamDown()) return
        synchronized(recent) {
            val last = recent[resolveUrl]
            if (last != null && System.currentTimeMillis() - last < 120_000L) return
        }
        if (!inFlight.add(resolveUrl)) return
        val builder = Request.Builder()
            .url(resolveUrl)
            .header("X-YTM-Client", "android")
            .tag("ytm-prefetch")
            .get()
        authHeader()?.let { builder.header("Authorization", it) }
        client.newCall(builder.build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                inFlight.remove(resolveUrl)
                noteNetworkFailure()
            }

            override fun onResponse(call: Call, response: Response) {
                response.close()
                inFlight.remove(resolveUrl)
                if (response.isSuccessful) {
                    markStreamOk()
                    synchronized(recent) {
                        recent[resolveUrl] = System.currentTimeMillis()
                    }
                } else if (response.code in 500..599) {
                    noteNetworkFailure()
                }
            }
        })
    }

    fun warmCurrentBlocking(baseApi: String, trackId: String, timeoutMs: Long = 450L) {
        if (trackId.length != 11 || isStreamDown() || isLocalOffline(trackId)) return
        val key = "warm:$trackId"
        synchronized(recent) {
            val last = recent[key]
            if (last != null && System.currentTimeMillis() - last < 60_000L) return
        }
        val body = JSONObject().put("ids", JSONArray(listOf(trackId))).toString().toRequestBody(JSON)
        val builder = Request.Builder()
            .url("${baseApi.trimEnd('/')}/api/stream/warm")
            .header("X-YTM-Client", "android")
            .header("Content-Type", "application/json")
            .tag("ytm-prefetch")
            .post(body)
        authHeader()?.let { builder.header("Authorization", it) }
        try {
            val timed = client.newBuilder()
                .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .connectTimeout(timeoutMs.coerceAtMost(400), TimeUnit.MILLISECONDS)
                .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                .build()
            timed.newCall(builder.build()).execute().use { response ->
                if (response.isSuccessful) {
                    markStreamOk()
                    synchronized(recent) {
                        recent[key] = System.currentTimeMillis()
                    }
                } else if (response.code in 500..599) {
                    noteNetworkFailure()
                }
            }
        } catch (_: Exception) {
            /* timeout — Exo démarre quand même */
        }
    }

    private fun warmBatch(baseApi: String, trackIds: List<String>) {
        if (isStreamDown()) return
        val ids = trackIds.distinct().filter { it.length == 11 && !isLocalOffline(it) }.take(MAX_WARM)
        if (ids.isEmpty()) return
        val key = "warm:${ids.sorted().joinToString(",")}"
        synchronized(recent) {
            val last = recent[key]
            if (last != null && System.currentTimeMillis() - last < 45_000L) return
        }
        if (!inFlight.add(key)) return
        val body = JSONObject().put("ids", JSONArray(ids)).toString().toRequestBody(JSON)
        val builder = Request.Builder()
            .url("${baseApi.trimEnd('/')}/api/stream/warm")
            .header("X-YTM-Client", "android")
            .header("Content-Type", "application/json")
            .tag("ytm-prefetch")
            .post(body)
        authHeader()?.let { builder.header("Authorization", it) }
        client.newCall(builder.build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                inFlight.remove(key)
                noteNetworkFailure()
            }

            override fun onResponse(call: Call, response: Response) {
                response.close()
                inFlight.remove(key)
                if (!response.isSuccessful) {
                    if (response.code in 500..599) {
                        noteNetworkFailure()
                    } else if (!isStreamDown()) {
                        ids.take(3).forEach { id ->
                            warm("${baseApi.trimEnd('/')}/api/stream/$id/url")
                        }
                    }
                    return
                }
                markStreamOk()
                synchronized(recent) {
                    recent[key] = System.currentTimeMillis()
                }
            }
        })
    }

    fun warmTrack(baseApi: String, trackId: String) {
        if (trackId.length != 11 || isStreamDown() || isLocalOffline(trackId)) return
        warmBatch(baseApi, listOf(trackId))
        exoPrefetch(baseApi, trackId, distance = 0)
    }

    private fun exoPrefetch(baseApi: String, trackId: String, distance: Int) {
        if (isStreamDown() || isLocalOffline(trackId)) return
        val unmetered = isUnmetered()
        val bytes = when {
            !unmetered && distance == 0 -> HEAD_NEXT_METERED
            !unmetered && distance <= 2 -> HEAD_METERED
            !unmetered -> HEAD_3S
            distance == 0 -> HEAD_NEXT_WIFI
            distance <= 2 -> HEAD_NEAR_WIFI
            distance <= 5 -> HEAD_WIFI
            else -> maxOf(HEAD_FAR_WIFI, HEAD_3S)
        }
        val url = "${baseApi.trimEnd('/')}/api/stream/$trackId"
        PlayerCache.prefetchHead(YtMusicApp.instance, url, trackId, bytes)
    }

    /**
     * Précharge ~3 s de tête pour une liste (file / biblio visible).
     * Limité pour ne pas saturer le réseau.
     */
    fun warmHeads3s(baseApi: String, trackIds: List<String>, limit: Int = 24) {
        if (isStreamDown() || !ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()) return
        val ids = trackIds.distinct().filter { it.length == 11 && !isLocalOffline(it) }.take(limit)
        if (ids.isEmpty()) return
        warmBatch(baseApi, ids.take(MAX_WARM))
        ids.forEach { id ->
            val url = "${baseApi.trimEnd('/')}/api/stream/$id"
            PlayerCache.prefetchHead(YtMusicApp.instance, url, id, HEAD_3S)
        }
    }

    fun warmMany(resolveUrls: List<String>) {
        if (isStreamDown()) return
        resolveUrls.distinct().take(MAX_WARM).forEach { warm(it) }
    }

    fun warmTracks(baseApi: String, trackIds: List<String>) {
        if (isStreamDown()) return
        val ids = trackIds.distinct().filter { it.length == 11 }.take(MAX_WARM)
        if (ids.isEmpty()) return
        warmBatch(baseApi, ids)
        ids.drop(1).forEachIndexed { i, id ->
            exoPrefetch(baseApi, id, distance = i)
        }
    }

    /**
     * Précharge une grosse partie des titres suivants + évince ceux déjà passés.
     */
    fun warmAround(
        baseApi: String,
        queueIds: List<String>,
        index: Int,
        ahead: Int = AHEAD_WIFI,
        behind: Int = 1,
    ) {
        if (queueIds.isEmpty() || isStreamDown()) return
        if (!ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()) {
            cancelIdle()
            return
        }
        val unmetered = isUnmetered()
        val aheadN = if (unmetered) ahead.coerceAtLeast(AHEAD_WIFI) else AHEAD_METERED
        val behindN = if (unmetered) behind else 0
        val idx = index.coerceIn(0, queueIds.lastIndex)

        // Libère le cache Exo des titres déjà écoutés (garde [behindN] derrière)
        evictPlayed(queueIds, idx, keepBehind = behindN.coerceAtLeast(0))

        val nextIds = buildList {
            for (i in 1..aheadN) {
                val t = queueIds.getOrNull(idx + i) ?: break
                if (t.length == 11) add(t)
            }
        }
        val behindIds = buildList {
            for (i in 1..behindN) {
                val t = queueIds.getOrNull(idx - i) ?: break
                if (t.length == 11) add(t)
            }
        }
        val current = queueIds[idx]
        warmBatch(baseApi, listOf(current) + nextIds + behindIds)
        nextIds.forEachIndexed { i, id ->
            exoPrefetch(baseApi, id, distance = i)
        }
    }

    /** Supprime du SimpleCache les titres avant l’index (sauf keepBehind). */
    fun evictPlayed(queueIds: List<String>, index: Int, keepBehind: Int = 1) {
        if (queueIds.isEmpty() || index <= keepBehind) return
        val ctx = YtMusicApp.instance
        val cut = (index - keepBehind).coerceAtLeast(0)
        for (i in 0 until cut) {
            val id = queueIds.getOrNull(i) ?: continue
            if (id.length != 11) continue
            // Ne touche pas aux fichiers offline locaux
            if (isLocalOffline(id)) continue
            PlayerCache.invalidate(ctx, id)
        }
    }
}
