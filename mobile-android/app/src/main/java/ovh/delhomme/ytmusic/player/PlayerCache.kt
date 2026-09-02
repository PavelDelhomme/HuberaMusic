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
import androidx.media3.datasource.cache.Cache
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheEvictor
import androidx.media3.datasource.cache.CacheSpan
import androidx.media3.datasource.cache.CacheWriter
import androidx.media3.datasource.cache.ContentMetadata
import androidx.media3.datasource.cache.ContentMetadataMutations
import androidx.media3.datasource.cache.SimpleCache
import java.io.File
import java.util.TreeSet
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Cache disque ExoPlayer partagé (réécoute / skip / prefetch).
 * Clé = mediaId (setCustomCacheKey) → survit aux URLs googlevideo qui tournent.
 *
 * Prefetch : slot dédié « next » (+1) + pool far (+2…) ; clé pinnée non évincée.
 */
@OptIn(UnstableApi::class)
object PlayerCache {
    private const val CACHE_DIR = "exo-media"
    private const val CACHE_KEY_GEN = "s4"
    private const val PREFS = "plm_player_cache"
    private const val PREFS_GEN = "exo_cache_gen"
    private const val CACHE_BYTES_CAP = 160L * 1024L * 1024L
    private const val CACHE_BYTES_FLOOR = 64L * 1024L * 1024L
    private const val PREFETCH_FAR_PARALLEL = 1

    @Volatile
    private var simpleCache: SimpleCache? = null

    fun keyFor(trackId: String): String {
        val id = trackId.trim().substringBefore(':')
        if (id.isEmpty()) return trackId.trim()
        return "$id:$CACHE_KEY_GEN"
    }

    private val nextPrefetchExecutor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "ytm-exo-prefetch-next").apply { isDaemon = true }
    }
    private val farPrefetchExecutor = Executors.newFixedThreadPool(PREFETCH_FAR_PARALLEL) { r ->
        Thread(r, "ytm-exo-prefetch-far").apply { isDaemon = true }
    }
    private val prefetchInFlight = ConcurrentHashMap.newKeySet<String>()
    private val targetBytes = ConcurrentHashMap<String, AtomicLong>()
    private val gen = AtomicInteger(0)
    private val pinnedKey = AtomicReference<String?>(null)

    private fun cacheBudgetBytes(context: Context): Long {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? android.app.ActivityManager
        val mem = android.app.ActivityManager.MemoryInfo()
        am?.getMemoryInfo(mem)
        val totalMb = (mem.totalMem / (1024L * 1024L)).coerceAtLeast(1L)
        val fromRam = (totalMb * 1024L * 1024L * 4L) / 100L
        return fromRam.coerceIn(CACHE_BYTES_FLOOR, CACHE_BYTES_CAP)
    }

    private fun migrateCacheGen(context: Context) {
        val appCtx = context.applicationContext
        val prefs = appCtx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getString(PREFS_GEN, "") == CACHE_KEY_GEN) return
        runCatching { simpleCache?.release() }
        simpleCache = null
        runCatching { File(appCtx.cacheDir, CACHE_DIR).deleteRecursively() }
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
        return SimpleCache(dir, PinAwareLruEvictor(budget), db).also {
            simpleCache = it
        }
    }

    fun pinTrack(trackId: String) {
        if (trackId.isBlank()) return
        pinnedKey.set(keyFor(trackId))
    }

    fun unpinTrack(trackId: String? = null) {
        if (trackId == null) {
            pinnedKey.set(null)
            return
        }
        pinnedKey.compareAndSet(keyFor(trackId), null)
    }

    fun pinnedCacheKey(): String? = pinnedKey.get()

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

    fun videoDataSourceFactory(context: Context): DefaultDataSource.Factory {
        val appCtx = context.applicationContext
        return DefaultDataSource.Factory(appCtx, httpFactory(appCtx))
    }

    fun cancelPrefetch(preservePinned: Boolean = false) {
        if (preservePinned) {
            val pin = pinnedKey.get()
            prefetchInFlight.removeIf { it != pin }
            targetBytes.keys.removeIf { it != pin }
        } else {
            gen.incrementAndGet()
            prefetchInFlight.clear()
            targetBytes.clear()
        }
    }

    fun invalidate(context: Context, cacheKey: String) {
        if (cacheKey.isBlank()) return
        val key = keyFor(cacheKey)
        runCatching { get(context.applicationContext).removeResource(key) }
        val bare = cacheKey.trim().substringBefore(':')
        if (bare.isNotBlank() && bare != key) {
            runCatching { get(context.applicationContext).removeResource(bare) }
        }
        prefetchInFlight.remove(key)
        prefetchInFlight.remove(bare)
        targetBytes.remove(key)
    }

    fun cachedBytes(context: Context, trackId: String, span: Long = 4L * 1024L * 1024L): Long {
        if (trackId.isBlank()) return 0L
        val key = keyFor(trackId)
        return runCatching { get(context.applicationContext).getCachedBytes(key, 0, span) }.getOrDefault(0L)
    }

    fun prefetchHead(
        context: Context,
        streamUrl: String,
        cacheKey: String,
        bytes: Long,
        priorityNext: Boolean = false,
    ) {
        if (streamUrl.isBlank() || cacheKey.isBlank() || bytes <= 0L) return
        val key = keyFor(cacheKey)
        if (priorityNext) pinTrack(cacheKey)
        val target = targetBytes.getOrPut(key) { AtomicLong(0L) }
        val prev = target.get()
        if (bytes > prev) target.set(bytes)
        val want = target.get()
        if (!prefetchInFlight.add(key)) return
        val myGen = gen.get()
        val appCtx = context.applicationContext
        val exec = if (priorityNext) nextPrefetchExecutor else farPrefetchExecutor
        exec.execute {
            try {
                if (!priorityNext && myGen != gen.get()) return@execute
                val cache = get(appCtx)
                val need = target.get().coerceAtLeast(want)
                val cached = cache.getCachedBytes(key, 0, need)
                if (cached >= (need * 3 / 4)) {
                    touchSpan(cache, key)
                    unsetBogusContentLength(cache, key, need)
                    return@execute
                }
                val dataSource = dataSourceFactory(appCtx).createDataSource()
                val dataSpec = DataSpec.Builder()
                    .setUri(Uri.parse(streamUrl))
                    .setLength(need)
                    .setKey(key)
                    .build()
                CacheWriter(dataSource, dataSpec, null, null).cache()
                val extended = target.get()
                if (extended > need) {
                    val more = dataSourceFactory(appCtx).createDataSource()
                    val moreSpec = DataSpec.Builder()
                        .setUri(Uri.parse(streamUrl))
                        .setLength(extended)
                        .setKey(key)
                        .build()
                    CacheWriter(more, moreSpec, null, null).cache()
                }
                unsetBogusContentLength(cache, key, target.get())
                touchSpan(cache, key)
            } catch (_: Exception) {
                /* ignore */
            } finally {
                prefetchInFlight.remove(key)
            }
        }
    }

    private fun touchSpan(cache: SimpleCache, cacheKey: String) {
        runCatching {
            cache.getCachedBytes(cacheKey, 0, 4_096L)
            cache.applyContentMetadataMutations(cacheKey, ContentMetadataMutations())
        }
    }

    fun prefetchHeadBlocking(
        context: Context,
        streamUrl: String,
        cacheKey: String,
        bytes: Long,
        timeoutMs: Long = 2_500L,
    ) {
        if (streamUrl.isBlank() || cacheKey.isBlank() || bytes <= 0L) return
        val key = keyFor(cacheKey)
        pinTrack(cacheKey)
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
                touchSpan(cache, key)
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
            touchSpan(cache, key)
        } catch (_: Exception) {
            /* ignore */
        } finally {
            prefetchInFlight.remove(key)
        }
    }

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

    /**
     * LRU classique qui saute la clé pinnée (+1) pour ne pas perdre la tête
     * du titre suivant avant la transition.
     */
    private class PinAwareLruEvictor(private val maxBytes: Long) : CacheEvictor {
        private var currentSize = 0L
        private val leastRecentlyUsed = TreeSet(
            Comparator<CacheSpan> { a, b ->
                val cmp = a.lastTouchTimestamp.compareTo(b.lastTouchTimestamp)
                if (cmp != 0) cmp else a.compareTo(b)
            },
        )

        override fun onCacheInitialized() {}

        override fun requiresCacheSpanTouches(): Boolean = true

        override fun onStartFile(cache: Cache, key: String, position: Long, length: Long) {
            if (length != C.LENGTH_UNSET.toLong()) {
                evictCache(cache, length)
            }
        }

        override fun onSpanAdded(cache: Cache, span: CacheSpan) {
            leastRecentlyUsed.add(span)
            currentSize += span.length
            evictCache(cache, 0)
        }

        override fun onSpanRemoved(cache: Cache, span: CacheSpan) {
            leastRecentlyUsed.remove(span)
            currentSize -= span.length
        }

        override fun onSpanTouched(cache: Cache, oldSpan: CacheSpan, newSpan: CacheSpan) {
            leastRecentlyUsed.remove(oldSpan)
            leastRecentlyUsed.add(newSpan)
        }

        private fun evictCache(cache: Cache, requiredSpace: Long) {
            val pin = pinnedKey.get()
            while (currentSize + requiredSpace > maxBytes && leastRecentlyUsed.isNotEmpty()) {
                val candidate = leastRecentlyUsed.firstOrNull { span ->
                    pin == null || span.key != pin
                } ?: break
                cache.removeSpan(candidate)
            }
        }
    }
}
