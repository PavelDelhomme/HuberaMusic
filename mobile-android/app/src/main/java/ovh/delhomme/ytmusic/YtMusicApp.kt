package ovh.delhomme.ytmusic

import android.app.Application
import android.content.ComponentCallbacks2
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.disk.DiskCache
import coil.memory.MemoryCache
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.BatterySaver
import ovh.delhomme.ytmusic.data.NetworkMonitor
import ovh.delhomme.ytmusic.debug.CrashReporter
import ovh.delhomme.ytmusic.player.PlaybackIdleGuard
import ovh.delhomme.ytmusic.player.StreamPrefetcher

class YtMusicApp : Application(), ImageLoaderFactory {
    lateinit var container: AppContainer
        private set

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var imageLoader: ImageLoader? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        CrashReporter.install(this)
        container = AppContainer(this)
        NetworkMonitor.start(this)
        BatterySaver.start(this)
        PlaybackIdleGuard.start(this)
        ovh.delhomme.ytmusic.debug.TelemetryReporter.flushPending()
        // Précharge les JWT en mémoire dès le boot (évite runBlocking DataStore)
        appScope.launch {
            runCatching { container.tokenStore.warmCache() }
            runCatching { container.libraryRepo.ensureLoaded(force = false) }
        }
        // Garde hors-ligne (aimés + Mon Mix) — léger, Wi‑Fi préféré
        runCatching { container.offlineKeeper.start() }
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        if (level >= ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN) {
            // UI cachée : ne coupe le prefetch que si rien ne joue
            // (sinon coupures sur les titres suivants en arrière-plan).
            val playing = runCatching {
                ovh.delhomme.ytmusic.player.PlaybackService.Holder.isPlaybackActiveSafe()
            }.getOrDefault(false)
            if (!playing) {
                runCatching { StreamPrefetcher.cancelIdle() }
            }
            imageLoader?.memoryCache?.clear()
        }
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            imageLoader?.memoryCache?.clear()
        }
    }

    override fun newImageLoader(): ImageLoader =
        ImageLoader.Builder(this)
            .crossfade(true)
            .memoryCache {
                MemoryCache.Builder(this)
                    .maxSizePercent(0.10)
                    .build()
            }
            .diskCache {
                DiskCache.Builder()
                    .directory(cacheDir.resolve("coil-covers"))
                    .maxSizeBytes(48L * 1024L * 1024L)
                    .build()
            }
            .respectCacheHeaders(false)
            .build()
            .also { imageLoader = it }

    companion object {
        lateinit var instance: YtMusicApp
            private set
    }
}
