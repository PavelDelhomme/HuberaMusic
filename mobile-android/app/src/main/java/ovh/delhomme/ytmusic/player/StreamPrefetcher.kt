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
 * Annulé uniquement sur pause volontaire (pas pendant un rebuffer / skip / BG).
 *
 * En lecture (Wi‑Fi) : précharge une large fenêtre de la file par blocs
 * (têtes généreuses proches, têtes ~3–6 s plus loin) pour enchaîner sans coupure.
 */
object StreamPrefetcher {
    /** ~6–8 s audio typique YT (~160–256 kb/s) + marge conteneur. */
    const val HEAD_3S = 900L * 1024L
    /** ~12–15 s — titre suivant pendant lecture. */
    private const val HEAD_NEXT_PLAYING = 3_200L * 1024L
    /** Tête générique Wi‑Fi (~8 s). */
    private const val HEAD_WIFI = 1_400 * 1024L
    /** Titre suivant Wi‑Fi. */
    private const val HEAD_NEXT_WIFI = 2_800 * 1024L
    /** +2 / +3 Wi‑Fi. */
    private const val HEAD_NEAR_WIFI = 1_800 * 1024L
    /** Suite lointaine Wi‑Fi (~6 s). */
    private const val HEAD_FAR_WIFI = 1_100 * 1024L

    private const val HEAD_METERED = HEAD_3S
    private const val HEAD_NEXT_METERED = 1_600 * 1024L

    private const val MAX_WARM = 12
    /** Fenêtre avant sur Wi‑Fi (blocs de file / aléatoire). */
    private const val AHEAD_WIFI = 12
    private const val AHEAD_METERED = 4
    private const val DISK_CACHE_MB = 48L
    private val JSON = "application/json; charset=utf-8".toMediaType()

    @Volatile private var streamDownUntil = 0L
    private var streamFailStreak = 0
    /** Pendant le 1er play : ne pas voler la bande au titre courant. */
    @Volatile private var quietUntil = 0L
    @Volatile private var rollingAnchor = -1
    private var rollingLastAt = 0L

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
    private val diskPrefetchInFlight = ConcurrentHashMap.newKeySet<String>()
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

    /**
     * Bloque le prefetch des suivants pendant [ms] (laisse Exo démarrer le titre courant).
     * N’annule pas les requêtes en vol — évite de couper le flux en cours de lecture.
     */
    fun quietPrefetch(ms: Long) {
        quietUntil = System.currentTimeMillis() + ms.coerceAtLeast(0L)
    }

    fun isQuiet(): Boolean = System.currentTimeMillis() < quietUntil

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

    /**
     * Pré-télécharge le .m4a côté API (cache disque serveur) pour les seeks mid-range.
     * Fire-and-forget — POST /api/download/:id (peut prendre 30–90 s sur le relais maison).
     */
    fun requestServerDiskCache(baseApi: String, trackId: String) {
        if (trackId.length != 11 || isStreamDown() || isLocalOffline(trackId)) return
        val key = "disk:$trackId"
        synchronized(recent) {
            val last = recent[key]
            if (last != null && System.currentTimeMillis() - last < 180_000L) return
        }
        if (!diskPrefetchInFlight.add(trackId)) return
        val builder = Request.Builder()
            .url("${baseApi.trimEnd('/')}/api/download/$trackId")
            .header("X-YTM-Client", "android")
            .tag("ytm-disk-prefetch")
            .post(ByteArray(0).toRequestBody(null))
        authHeader()?.let { builder.header("Authorization", it) }
        val diskClient = client.newBuilder()
            .readTimeout(130, TimeUnit.SECONDS)
            .callTimeout(130, TimeUnit.SECONDS)
            .build()
        diskClient.newCall(builder.build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                diskPrefetchInFlight.remove(trackId)
            }

            override fun onResponse(call: Call, response: Response) {
                response.close()
                diskPrefetchInFlight.remove(trackId)
                if (response.isSuccessful) {
                    markStreamOk()
                    synchronized(recent) {
                        recent[key] = System.currentTimeMillis()
                    }
                } else if (response.code in 500..599) {
                    noteNetworkFailure()
                }
            }
        })
    }

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

    /**
     * Chauffe synchrone du titre courant avant Exo.
     * [wait]=true → API résout le format avant de répondre (démarrage quasi instantané).
     */
    fun warmCurrentBlocking(
        baseApi: String,
        trackId: String,
        timeoutMs: Long = 450L,
        wait: Boolean = false,
    ) {
        if (trackId.length != 11 || isStreamDown() || isLocalOffline(trackId)) return
        val key = "warm:$trackId"
        if (!wait) {
            synchronized(recent) {
                val last = recent[key]
                if (last != null && System.currentTimeMillis() - last < 60_000L) return
            }
        }
        val payload = JSONObject().put("ids", JSONArray(listOf(trackId)))
        if (wait) payload.put("wait", true)
        val body = payload.toString().toRequestBody(JSON)
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

    /** Warm formats uniquement (léger) — pas de têtes Exo. Idéal biblio / aléatoire. */
    fun warmFormatsLight(baseApi: String, trackIds: List<String>, limit: Int = 48) {
        if (isStreamDown() || !ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()) return
        val ids = trackIds.distinct().filter { it.length == 11 && !isLocalOffline(it) }.take(limit.coerceIn(1, 64))
        if (ids.isEmpty()) return
        ids.chunked(MAX_WARM).forEach { block -> warmBatch(baseApi, block) }
    }

    /** Après un prefetchHeadBlocking réussi (Aléatoire biblio). */
    fun markHeadReady(trackId: String) {
        synchronized(recent) {
            recent["head:$trackId"] = System.currentTimeMillis()
        }
    }

    fun wasHeadReadyRecently(trackId: String, withinMs: Long = 20_000L): Boolean {
        synchronized(recent) {
            val t = recent["head:$trackId"] ?: return false
            return System.currentTimeMillis() - t < withinMs
        }
    }

    /**
     * Prépare Aléatoire : format wait + tête Exo bloquante pour #0, puis #1–2 en parallèle.
     */
    suspend fun prepareShuffleLead(baseApi: String, trackIds: List<String>) {
        if (trackIds.isEmpty() || isStreamDown()) return
        if (!ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()) return
        val base = baseApi.trimEnd('/')
        val lead = trackIds.distinct().filter { it.length == 11 && !isLocalOffline(it) }.take(3)
        if (lead.isEmpty()) return
        quietPrefetch(520L)
        val app = YtMusicApp.instance
        // #0 — priorité absolue (son immédiat)
        val first = lead[0]
        warmCurrentBlocking(base, first, timeoutMs = 1_500L, wait = true)
        prefetchStartHeadBlocking(app, base, first, HEAD_NEXT_WIFI)
        markHeadReady(first)
        // #1–2 — formats + têtes courtes (skip rapide)
        lead.drop(1).forEach { id ->
            warmTrackFormatOnly(base, id)
            prefetchStartHeadBlocking(app, base, id, HEAD_3S)
            markHeadReady(id)
        }
        warmFormatsLight(base, trackIds.drop(3).take(6), limit = 6)
    }

    private fun prefetchStartHeadBlocking(
        context: android.content.Context,
        baseApi: String,
        trackId: String,
        bytes: Long,
    ) {
        if (trackId.length != 11 || isLocalOffline(trackId)) return
        val url = "${baseApi.trimEnd('/')}/api/stream/$trackId"
        PlayerCache.prefetchHeadBlocking(context, url, trackId, bytes, timeoutMs = 2_200L)
    }

    /** Fire-and-forget (scroll biblio). */
    fun prefetchStartHead(baseApi: String, trackId: String, bytes: Long = HEAD_NEXT_WIFI) {
        if (trackId.length != 11 || isStreamDown() || isLocalOffline(trackId)) return
        if (!ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()) return
        warmBatch(baseApi, listOf(trackId))
        val url = "${baseApi.trimEnd('/')}/api/stream/$trackId"
        PlayerCache.prefetchHead(YtMusicApp.instance, url, trackId, bytes)
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

    /** Chauffe le format API sans prefetch Exo (Exo charge le titre courant). */
    fun warmTrackFormatOnly(baseApi: String, trackId: String) {
        if (trackId.length != 11 || isStreamDown() || isLocalOffline(trackId)) return
        warmBatch(baseApi, listOf(trackId))
    }

    fun warmTrack(baseApi: String, trackId: String) {
        if (trackId.length != 11 || isStreamDown() || isLocalOffline(trackId)) return
        warmBatch(baseApi, listOf(trackId))
        if (!isPlaybackActive()) {
            exoPrefetch(baseApi, trackId, distance = 0)
        }
    }

    /** Fenêtre glissante : maintient idx+1…idx+[window] à jour pendant la lecture. */
    fun maintainRollingPrefetch(
        baseApi: String,
        queueIds: List<String>,
        fromIndex: Int,
        window: Int = 4,
    ) {
        if (isStreamDown() || !ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()) return
        if (queueIds.isEmpty()) return
        val idx = fromIndex.coerceIn(0, queueIds.lastIndex)
        val now = System.currentTimeMillis()
        if (idx == rollingAnchor && now - rollingLastAt < 12_000L) return
        rollingAnchor = idx
        rollingLastAt = now
        val win = ovh.delhomme.ytmusic.data.BatterySaver.streamPrefetchAhead(window.coerceIn(4, 16))
        val end = (idx + win).coerceAtMost(queueIds.lastIndex)
        if (end <= idx) return
        val slice = (idx + 1..end).mapNotNull { queueIds.getOrNull(it) }.filter {
            it.length == 11 && !isLocalOffline(it)
        }
        if (slice.isEmpty()) return
        // Chauffe API par blocs de MAX_WARM
        slice.chunked(MAX_WARM).forEach { block -> warmBatch(baseApi, block) }
        slice.forEachIndexed { i, id ->
            val dist = i + 1
            val url = "${baseApi.trimEnd('/')}/api/stream/$id"
            val playing = isPlaybackActive()
            val unmetered = isUnmetered()
            val saver = ovh.delhomme.ytmusic.data.BatterySaver.isActive()
            val bytes = when {
                saver -> HEAD_3S
                !unmetered -> if (dist == 1) HEAD_NEXT_METERED else HEAD_3S
                playing && dist == 1 -> HEAD_NEXT_PLAYING
                playing && dist == 2 -> HEAD_NEAR_WIFI
                playing && dist <= 4 -> HEAD_WIFI
                playing && dist <= 8 -> HEAD_FAR_WIFI
                !playing && dist == 1 -> HEAD_NEXT_WIFI
                !playing && dist <= 4 -> HEAD_NEAR_WIFI
                else -> HEAD_3S
            }
            PlayerCache.prefetchHead(YtMusicApp.instance, url, id, bytes)
        }
    }

    /** ~3 s de tête pour les [count] titres après [fromIndex] (changement de piste). */
    fun prefetchUpcomingHeads(
        baseApi: String,
        queueIds: List<String>,
        fromIndex: Int,
        count: Int = 3,
    ) {
        prefetchUpcomingHeadsTiered(baseApi, queueIds, fromIndex, count)
    }

    /**
     * Têtes tiered : titre suivant plus gros, suite en ~3 s — OK pendant la lecture
     * (pas de DL offline complet, pas de saturation proxy).
     */
    fun prefetchUpcomingHeadsTiered(
        baseApi: String,
        queueIds: List<String>,
        fromIndex: Int,
        count: Int = 5,
        ignoreQuiet: Boolean = false,
    ) {
        if (isStreamDown() || !ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()) return
        if (!ignoreQuiet && isQuiet()) return
        val idx = fromIndex.coerceIn(0, queueIds.lastIndex.coerceAtLeast(0))
        val playing = isPlaybackActive()
        val unmetered = isUnmetered()
        val saver = ovh.delhomme.ytmusic.data.BatterySaver.isActive()
        val take = ovh.delhomme.ytmusic.data.BatterySaver.streamPrefetchAhead(count.coerceIn(1, 16))
        val upcoming = queueIds.drop(idx + 1).take(take).filter { it.length == 11 && !isLocalOffline(it) }
        upcoming.chunked(MAX_WARM).forEach { block -> warmBatch(baseApi, block) }
        upcoming.forEachIndexed { i, id ->
            val url = "${baseApi.trimEnd('/')}/api/stream/$id"
            val bytes = when {
                saver -> HEAD_3S
                !unmetered -> if (i == 0) HEAD_NEXT_METERED else HEAD_3S
                !playing && i == 0 -> HEAD_NEXT_WIFI
                !playing && i <= 3 -> HEAD_NEAR_WIFI
                playing && i == 0 -> HEAD_NEXT_PLAYING
                playing && i == 1 -> HEAD_NEAR_WIFI
                playing && i <= 4 -> HEAD_WIFI
                playing && i <= 8 -> HEAD_FAR_WIFI
                else -> HEAD_3S
            }
            PlayerCache.prefetchHead(YtMusicApp.instance, url, id, bytes)
        }
    }

    /** Clic loin dans la file / scroll : chauffe le titre cible ± [radius]. */
    fun prefetchAroundIndex(
        baseApi: String,
        queueIds: List<String>,
        centerIndex: Int,
        radius: Int = 2,
    ) {
        if (isStreamDown() || queueIds.isEmpty()) return
        if (!ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()) return
        val c = centerIndex.coerceIn(0, queueIds.lastIndex)
        val r = radius.coerceIn(0, 4)
        val playing = isPlaybackActive()
        val targets = ((c - r)..(c + r)).filter { it in queueIds.indices }
        val ids = targets.mapNotNull { queueIds.getOrNull(it) }.filter { it.length == 11 && !isLocalOffline(it) }
        if (ids.isEmpty()) return
        warmBatch(baseApi, ids.distinct().take(MAX_WARM))
        for (i in targets) {
            val id = queueIds.getOrNull(i) ?: continue
            if (id.length != 11 || isLocalOffline(id)) continue
            val url = "${baseApi.trimEnd('/')}/api/stream/$id"
            val dist = kotlin.math.abs(i - c)
            val bytes = when (dist) {
                0 -> HEAD_NEXT_PLAYING
                1 -> HEAD_NEAR_WIFI
                2 -> HEAD_3S + 768 * 1024L
                else -> HEAD_3S
            }
            PlayerCache.prefetchHead(YtMusicApp.instance, url, id, bytes)
        }
    }

    /** Liste arbitraire (similaires, biblio visible) — chauffe les têtes sans attendre quiet. */
    fun prefetchTrackIds(baseApi: String, trackIds: List<String>, limit: Int = 16) {
        if (isStreamDown() || !ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()) return
        val ids = trackIds.distinct().filter { it.length == 11 && !isLocalOffline(it) }.take(limit)
        if (ids.isEmpty()) return
        warmBatch(baseApi, ids.take(MAX_WARM))
        ids.forEachIndexed { i, id ->
            val url = "${baseApi.trimEnd('/')}/api/stream/$id"
            val bytes = when (i) {
                0 -> HEAD_NEXT_PLAYING
                1, 2 -> HEAD_NEAR_WIFI
                else -> HEAD_3S
            }
            PlayerCache.prefetchHead(YtMusicApp.instance, url, id, bytes)
        }
    }

    private fun isPlaybackActive(): Boolean =
        PlaybackService.Holder.isPlaybackActiveSafe()

    private fun exoPrefetch(baseApi: String, trackId: String, distance: Int) {
        if (isStreamDown() || isLocalOffline(trackId)) return
        val unmetered = isUnmetered()
        val playing = isPlaybackActive()
        val bytes = when {
            playing && distance >= 1 -> HEAD_3S
            !unmetered && distance == 0 -> HEAD_NEXT_METERED
            !unmetered && distance <= 2 -> HEAD_METERED
            !unmetered -> HEAD_3S
            playing && distance == 0 -> HEAD_3S
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
    fun warmHeads3s(baseApi: String, trackIds: List<String>, limit: Int = 12) {
        if (isQuiet()) return
        if (isStreamDown() || !ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()) return
        val capped = ovh.delhomme.ytmusic.data.BatterySaver.streamPrefetchAhead(limit.coerceIn(1, 16))
        val ids = trackIds.distinct().filter { it.length == 11 && !isLocalOffline(it) }.take(capped)
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
        val idx = index.coerceIn(0, queueIds.lastIndex)
        // 1er play : uniquement le format du titre courant (Exo charge le flux).
        if (isQuiet()) {
            val current = queueIds.getOrNull(idx) ?: return
            if (current.length == 11) warmBatch(baseApi, listOf(current))
            return
        }
        val unmetered = isUnmetered()
        val aheadN = if (unmetered) ahead.coerceAtMost(AHEAD_WIFI) else ahead.coerceAtMost(AHEAD_METERED)
        val behindN = if (unmetered) behind else 0

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
        (listOf(current) + nextIds + behindIds).chunked(MAX_WARM).forEach { block ->
            warmBatch(baseApi, block)
        }
        if (isPlaybackActive()) {
            prefetchUpcomingHeadsTiered(baseApi, queueIds, idx, count = aheadN)
        } else {
            nextIds.forEachIndexed { i, id ->
                exoPrefetch(baseApi, id, distance = i + 1)
            }
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
