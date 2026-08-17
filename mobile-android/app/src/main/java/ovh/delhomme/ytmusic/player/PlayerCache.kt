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
    /** Plafond disque — plafonné aussi selon la RAM dispo (évite OOM sur mid-range). */
    private const val CACHE_BYTES_CAP = 160L * 1024L * 1024L // 160 Mo max
    private const val CACHE_BYTES_FLOOR = 64L * 1024L * 1024L
    private const val PREFETCH_PARALLEL = 2

    @Volatile
    private var simpleCache: SimpleCache? = null

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

    @Synchronized
    fun get(context: Context): SimpleCache {
        simpleCache?.let { return it }
        val appCtx = context.applicationContext
        val dir = File(appCtx.cacheDir, CACHE_DIR).apply { mkdirs() }
        val db = StandaloneDatabaseProvider(appCtx)
        val budget = cacheBudgetBytes(appCtx)
        return SimpleCache(dir, LeastRecentlyUsedCacheEvictor(budget), db).also {
            simpleCache = it
        }
    }

    fun dataSourceFactory(context: Context): CacheDataSource.Factory {
        val appCtx = context.applicationContext
        val token = runCatching {
            ovh.delhomme.ytmusic.YtMusicApp.instance.container.tokenStore.peekAccess()
        }.getOrNull()
        val props = mutableMapOf("X-YTM-Client" to "android")
        if (!token.isNullOrBlank()) {
            props["Authorization"] = "Bearer $token"
        }
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent("PLM-Android")
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(12_000)
            .setReadTimeoutMs(45_000)
            .setDefaultRequestProperties(props)
        val upstream = DefaultDataSource.Factory(appCtx, http)
        return CacheDataSource.Factory()
            .setCache(get(appCtx))
            .setUpstreamDataSourceFactory(upstream)
            .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
    }

    fun cancelPrefetch() {
        gen.incrementAndGet()
        prefetchInFlight.clear()
    }

    fun invalidate(context: Context, cacheKey: String) {
        if (cacheKey.isBlank()) return
        runCatching {
            get(context.applicationContext).removeResource(cacheKey)
        }
        prefetchInFlight.remove(cacheKey)
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
        if (!prefetchInFlight.add(cacheKey)) return
        val myGen = gen.get()
        val appCtx = context.applicationContext
        prefetchExecutor.execute {
            try {
                if (myGen != gen.get()) return@execute
                val cache = get(appCtx)
                val cached = cache.getCachedBytes(cacheKey, 0, bytes)
                if (cached >= (bytes * 3 / 4)) {
                    unsetBogusContentLength(cache, cacheKey, bytes)
                    return@execute
                }
                val dataSource = dataSourceFactory(appCtx).createDataSource()
                val dataSpec = DataSpec.Builder()
                    .setUri(Uri.parse(streamUrl))
                    .setLength(bytes)
                    .setKey(cacheKey)
                    .build()
                CacheWriter(dataSource, dataSpec, /* temporaryBuffer= */ null, /* listener= */ null).cache()
                unsetBogusContentLength(cache, cacheKey, bytes)
            } catch (_: Exception) {
                /* réseau / annulation — ignore */
            } finally {
                prefetchInFlight.remove(cacheKey)
            }
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
