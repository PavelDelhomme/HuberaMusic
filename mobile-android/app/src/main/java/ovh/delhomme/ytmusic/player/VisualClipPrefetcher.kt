package ovh.delhomme.ytmusic.player

import android.content.Context
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.cache.CacheWriter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import ovh.delhomme.ytmusic.YtMusicApp
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.data.VisualIdCache
import java.util.concurrent.atomic.AtomicInteger

/**
 * Prefetch clips (mode Vidéo uniquement), calqué sur le prefetch audio :
 * - resolve visualId pour le titre courant + N suivants
 * - précharge une grosse tête de chaque clip dans le cache Exo
 *
 * Inactif hors mode Vidéo → zéro impact musique seule.
 * Respecte [BatterySaver] (fenêtre / taille tête / parallélisme).
 */
@OptIn(UnstableApi::class)
object VisualClipPrefetcher {
    private const val TAG = "YTMVideoPrefetch"
    /** ~8–12 s vidéo 360p — démarrage instantané au skip. */
    private const val HEAD_BYTES = 3_500L * 1024L
    /** Courant + suivants (comme StreamPrefetcher window). */
    private const val AHEAD = 5
    private const val PARALLEL = 2

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val gen = AtomicInteger(0)
    private var job: Job? = null

    fun cancel() {
        gen.incrementAndGet()
        job?.cancel()
        job = null
    }

    fun maintain(
        context: Context,
        queue: List<TrackDto>,
        index: Int,
    ) {
        val myGen = gen.incrementAndGet()
        job?.cancel()
        job = scope.launch {
            // Court délai : laisser le clip courant prendre le réseau d’abord
            delay(if (ovh.delhomme.ytmusic.data.BatterySaver.isActive()) 700L else 350L)
            if (myGen != gen.get()) return@launch
            val appCtx = context.applicationContext
            val container = runCatching { YtMusicApp.instance.container }.getOrNull() ?: return@launch
            val ahead = ovh.delhomme.ytmusic.data.BatterySaver.videoPrefetchAhead(AHEAD)
            val headBytes = ovh.delhomme.ytmusic.data.BatterySaver.videoPrefetchHeadBytes(HEAD_BYTES)
            val parallel = ovh.delhomme.ytmusic.data.BatterySaver.videoPrefetchParallel(PARALLEL)
            val start = index.coerceAtLeast(0)
            val end = (index + ahead).coerceAtMost(queue.lastIndex)
            if (start > end) return@launch
            val slots = (start..end).mapNotNull { i -> queue.getOrNull(i)?.let { i to it } }
            val sem = Semaphore(parallel)
            coroutineScope {
                slots.map { (i, track) ->
                    async {
                        sem.withPermit {
                            if (myGen != gen.get()) return@async
                            runCatching {
                                // Fichier offline déjà là → pas de prefetch réseau
                                if (container.offlineStore.hasVideo(track.id)) return@runCatching
                                var vid = VisualIdCache.get(appCtx, track.id)
                                    ?.takeIf { it.isNotBlank() && it != track.id }
                                if (vid == null) {
                                    container.ensureFreshToken()
                                    val vis = container.api.trackVisual(
                                        track.id,
                                        title = track.title,
                                        artist = track.artistLine().takeIf { it != "Artiste" },
                                        durationSeconds = track.durationSeconds,
                                        waitMs = if (i == index) 2_500 else 4_500,
                                        refresh = null,
                                    )
                                    vid = vis.visualId?.takeIf { it.isNotBlank() && it != track.id }
                                    if (vid != null) {
                                        VisualIdCache.put(appCtx, track.id, vid)
                                        Log.i(TAG, "resolved +${i - index} ${track.title.take(28)} → $vid")
                                    }
                                }
                                val visualId = vid ?: return@runCatching
                                runCatching { container.api.streamResolveUrl(visualId, "video") }
                                prefetchHead(appCtx, container.videoStreamUrl(visualId), visualId, headBytes, myGen)
                            }.onFailure {
                                Log.w(TAG, "prefetch ${track.id}: ${it.message}")
                            }
                        }
                    }
                }.awaitAll()
            }
        }
    }

    private fun prefetchHead(
        context: Context,
        url: String,
        visualId: String,
        headBytes: Long,
        myGen: Int,
    ) {
        if (myGen != gen.get()) return
        val cacheKey = "v:$visualId"
        val cache = PlayerCache.get(context)
        val cached = cache.getCachedBytes(cacheKey, 0, headBytes)
        if (cached >= headBytes * 0.55) return
        val factory = PlayerCache.videoCacheDataSourceFactory(context)
        val dataSource = factory.createDataSource()
        val spec = DataSpec.Builder()
            .setUri(url)
            .setPosition(0)
            .setLength(headBytes)
            .setKey(cacheKey)
            .build()
        runCatching {
            CacheWriter(dataSource, spec, /* temporaryBuffer= */ null, /* progressListener= */ null)
                .cache()
            Log.i(TAG, "cached head $visualId ~${headBytes / 1024} KiB")
        }.onFailure {
            Log.w(TAG, "cache head $visualId: ${it.message}")
        }
    }
}
