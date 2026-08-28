package ovh.delhomme.ytmusic.player

import android.content.Context
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheWriter
import androidx.media3.datasource.cache.ContentMetadata
import androidx.media3.datasource.cache.ContentMetadataMutations
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * Cache disque ExoPlayer partagé (réécoute / skip / prefetch).
 * Clé = mediaId (setCustomCacheKey) → survit aux URLs googlevideo qui tournent.
 * Upstream = DefaultDataSource → file:// (offline) + http(s).
 */
@OptIn(UnstableApi::class)
object PlayerCache {
    private const val CACHE_DIR = "exo-media"
    /**
     * Génération de clé cache. Bumper (s3, s4…) si un bug a figé contentLength
     * (ex. réponses API tronquées à 1 MiB → EOF ~64 s sur tous les titres déjà joués).
     */
    private const val CACHE_KEY_GEN = "s4"
    private const val PREFS = "plm_player_cache"
    private const val PREFS_GEN = "exo_cache_gen"
    /** Plafond disque — plafonné aussi selon la RAM dispo (évite OOM sur mid-range). */
    private const val CACHE_BYTES_CAP = 160L * 1024L * 1024L // 160 Mo max
    private const val CACHE_BYTES_FLOOR = 64L * 1024L * 1024L
    private const val PREFETCH_PARALLEL = 2

    @Volatile
    private var simpleCache: SimpleCache? = null

    /** Clé Exo stable par titre + génération (évite cache empoisonné). */
    fun keyFor(trackId: String): String {
        val id = trackId.trim().substringBefore(':')
        if (id.isEmpty()) return trackId.trim()
        return "$id:$CACHE_KEY_GEN"
    }

    private val prefetchExecutor = Executors.newFixedThreadPool(PREFETCH_PARALLEL) { r ->
        Thread(r, "ytm-exo-prefetch").apply { isDaemon = true }
    }
    private val prefetchInFlight = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val gen = AtomicInteger(0)

    private fun cacheBudgetBytes(context: Context): Long {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? android.app.ActivityManager
        val mem = android.app.ActivityManager.MemoryInfo()
        am?.getMemoryInfo(mem)
        val totalMb = (mem.totalMem / (1024L * 1024L)).coerceAtLeast(1L)
        // ~4 % de la RAM totale, borné
        val fromRam = (totalMb * 1024L * 1024L * 4L) / 100L
        return fromRam.coerceIn(CACHE_BYTES_FLOOR, CACHE_BYTES_CAP)
    }

    /** Une fois par gen : purge le SimpleCache (LENGTH figé / spans tronqués). */
    private fun migrateCacheGen(context: Context) {
        val appCtx = context.applicationContext
        val prefs = appCtx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getString(PREFS_GEN, "") == CACHE_KEY_GEN) return
        runCatching {
            simpleCache?.release()
        }
        simpleCache = null
        runCatching {
            File(appCtx.cacheDir, CACHE_DIR).deleteRecursively()
        }
        prefs.edit().putString(PREFS_GEN, CACHE_KEY_GEN).apply()
    }

    @Synchronized
    fun get(context: Context): SimpleCache {
        val appCtx = context.applicationContext
        migrateCacheGen(appCtx)
        simpleCache?.let { return it }
        val dir = File(appCtx.cacheDir, CACHE_DIR).apply { mkdirs() }
        val db = StandaloneDatabaseProvider(appCtx)
        val budget = cacheBudgetBytes(appCtx)
        return SimpleCache(dir, LeastRecentlyUsedCacheEvictor(budget), db).also {
            simpleCache = it
        }
    }

    private fun httpFactory(context: Context): DefaultHttpDataSource.Factory {
        val token = runCatching {
            ovh.delhomme.ytmusic.YtMusicApp.instance.container.tokenStore.peekAccess()
        }.getOrNull()
        val props = mutableMapOf("X-YTM-Client" to "android")
        if (!token.isNullOrBlank()) {
            props["Authorization"] = "Bearer $token"
        }
        return DefaultHttpDataSource.Factory()
            .setUserAgent("PLM-Android")
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(12_000)
            .setReadTimeoutMs(120_000)
            .setDefaultRequestProperties(props)
    }

    fun dataSourceFactory(context: Context): CacheDataSource.Factory {
        val appCtx = context.applicationContext
        val upstream = DefaultDataSource.Factory(appCtx, httpFactory(appCtx))
        return CacheDataSource.Factory()
            .setCache(get(appCtx))
            .setUpstreamDataSourceFactory(upstream)
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
    }

    /** Vidéo progressive : pas de SimpleCache audio (évite LENGTH figé / collision clés). */
    fun videoDataSourceFactory(context: Context): DefaultDataSource.Factory {
        val appCtx = context.applicationContext
        return DefaultDataSource.Factory(appCtx, httpFactory(appCtx))
    }

    fun cancelPrefetch() {
        gen.incrementAndGet()
        prefetchInFlight.clear()
    }

    fun invalidate(context: Context, cacheKey: String) {
        if (cacheKey.isBlank()) return
        val key = keyFor(cacheKey)
        runCatching {
            get(context.applicationContext).removeResource(key)
        }
        // Ancienne clé sans gen (cache pré-s2) — au cas où.
        val bare = cacheKey.trim().substringBefore(':')
        if (bare.isNotBlank() && bare != key) {
            runCatching { get(context.applicationContext).removeResource(bare) }
        }
        prefetchInFlight.remove(key)
        prefetchInFlight.remove(bare)
    }

    /**
     * Précharge les premiers octets (~tête audio) dans le SimpleCache Exo.
     *
     * Important : si le serveur omet Content-Range, SimpleCache peut figer
     * contentLength = taille du prefetch → Exo croit que le titre est fini
     * (coupe avant la fin). On force alors LENGTH_UNSET.
     */
    fun prefetchHead(context: Context, streamUrl: String, cacheKey: String, bytes: Long) {
        if (streamUrl.isBlank() || cacheKey.isBlank() || bytes <= 0L) return
        val key = keyFor(cacheKey)
        if (!prefetchInFlight.add(key)) return
        val myGen = gen.get()
        val appCtx = context.applicationContext
        prefetchExecutor.execute {
            try {
                if (myGen != gen.get()) return@execute
                val cache = get(appCtx)
                val cached = cache.getCachedBytes(key, 0, bytes)
                if (cached >= (bytes * 3 / 4)) {
                    unsetBogusContentLength(cache, key, bytes)
                    return@execute
                }
                val dataSource = dataSourceFactory(appCtx).createDataSource()
                val dataSpec = DataSpec.Builder()
                    .setUri(Uri.parse(streamUrl))
                    .setLength(bytes)
                    .setKey(key)
                    .build()
                CacheWriter(dataSource, dataSpec, null, null).cache()
                unsetBogusContentLength(cache, key, bytes)
            } catch (_: Exception) {
                /* réseau / annulation — ignore */
            } finally {
                prefetchInFlight.remove(key)
            }
        }
    }

    /** Bloquant — Aléatoire #0 (son dès le 1er play). */
    fun prefetchHeadBlocking(
        context: Context,
        streamUrl: String,
        cacheKey: String,
        bytes: Long,
        timeoutMs: Long = 2_500L,
    ) {
        if (streamUrl.isBlank() || cacheKey.isBlank() || bytes <= 0L) return
        val key = keyFor(cacheKey)
        val myGen = gen.get()
        val appCtx = context.applicationContext
        if (!prefetchInFlight.add(key)) {
            val deadline = System.currentTimeMillis() + timeoutMs.coerceAtMost(1_500L)
            while (System.currentTimeMillis() < deadline) {
                if (myGen != gen.get()) return
                val cached = runCatching { get(appCtx).getCachedBytes(key, 0, bytes) }.getOrDefault(0L)
                if (cached >= bytes / 4) return
                Thread.sleep(40)
            }
            return
        }
        try {
            if (myGen != gen.get()) return
            val cache = get(appCtx)
            val cached = cache.getCachedBytes(key, 0, bytes)
            if (cached >= (bytes * 3 / 4)) {
                unsetBogusContentLength(cache, key, bytes)
                return
            }
            val dataSource = dataSourceFactory(appCtx).createDataSource()
            val dataSpec = DataSpec.Builder()
                .setUri(Uri.parse(streamUrl))
                .setLength(bytes)
                .setKey(key)
                .build()
            CacheWriter(dataSource, dataSpec, null, null).cache()
            unsetBogusContentLength(cache, key, bytes)
        } catch (_: Exception) {
            /* timeout — Exo tentera quand même */
        } finally {
            prefetchInFlight.remove(key)
        }
    }

    /** Après un prefetch partiel, ne jamais figer contentLength (Exo croirait le titre fini). */
    private fun unsetBogusContentLength(cache: SimpleCache, cacheKey: String, requestedBytes: Long) {
        runCatching {
            val meta = cache.getContentMetadata(cacheKey)
            val len = ContentMetadata.getContentLength(meta)
            if (len != C.LENGTH_UNSET.toLong() && len > 0) {
                val mutations = ContentMetadataMutations()
                ContentMetadataMutations.setContentLength(mutations, C.LENGTH_UNSET.toLong())
                cache.applyContentMetadataMutations(cacheKey, mutations)
            }
        }
    }
}
