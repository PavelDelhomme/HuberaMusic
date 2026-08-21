package ovh.delhomme.ytmusic.player

import coil.imageLoader
import coil.request.ImageRequest
import ovh.delhomme.ytmusic.YtMusicApp
import ovh.delhomme.ytmusic.data.TrackDto
import java.util.concurrent.ConcurrentHashMap

/** Prefetch des pochettes (notif + UI) via Coil. */
object CoverPrefetcher {
    private val inFlight = ConcurrentHashMap.newKeySet<String>()

    fun warmCovers(
        tracks: List<TrackDto>,
        index: Int,
        ahead: Int = 2,
        behind: Int = 1,
    ) {
        if (!ovh.delhomme.ytmusic.data.BatterySaver.allowCoverPrefetch()) return
        if (tracks.isEmpty()) return
        val ctx = runCatching { YtMusicApp.instance }.getOrNull() ?: return
        val idx = index.coerceIn(0, tracks.lastIndex)
        val aheadN = if (ovh.delhomme.ytmusic.data.BatterySaver.isActive()) 0 else ahead
        val behindN = if (ovh.delhomme.ytmusic.data.BatterySaver.isActive()) 0 else behind
        val targets = buildList {
            add(tracks[idx])
            for (i in 1..aheadN) tracks.getOrNull(idx + i)?.let { add(it) }
            for (i in 1..behindN) tracks.getOrNull(idx - i)?.let { add(it) }
        }
        targets.forEachIndexed { i, t ->
            // Courant un peu plus grand ; suite en 360 pour économiser RAM
            warm(t.coverUrl(sizeHint = if (i == 0) 520 else 360))
        }
    }

    fun warm(url: String?) {
        if (!ovh.delhomme.ytmusic.data.BatterySaver.allowCoverPrefetch()) return
        if (url.isNullOrBlank()) return
        val ctx = runCatching { YtMusicApp.instance }.getOrNull() ?: return
        if (!inFlight.add(url)) return
        val size = if (url.contains("=s520") || url.contains("=w520")) 520 else 360
        val req = ImageRequest.Builder(ctx)
            .data(url)
            .size(ovh.delhomme.ytmusic.data.BatterySaver.coverSizeHint(size))
            .memoryCacheKey(url)
            .diskCacheKey(url)
            .listener(
                onSuccess = { _, _ -> inFlight.remove(url) },
                onError = { _, _ -> inFlight.remove(url) },
                onCancel = { inFlight.remove(url) },
            )
            .build()
        ctx.imageLoader.enqueue(req)
    }
}
