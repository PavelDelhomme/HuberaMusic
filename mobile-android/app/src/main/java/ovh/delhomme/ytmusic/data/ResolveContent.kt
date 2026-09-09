package ovh.delhomme.ytmusic.data

import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import java.util.concurrent.ConcurrentHashMap

/** Résout playlist / album / artiste / mix → liste de titres jouables. */
suspend fun resolvePlayableTracks(api: YtMusicApi, item: TrackDto): List<TrackDto> {
    if (item.isPlayable()) return listOf(item)
    return when {
        item.isPlaylist() || item.id.startsWith("local:") -> {
            val rawId = item.id.removePrefix("local:")
            if (item.id.startsWith("local:")) {
                val lib = runCatching { api.library() }.getOrNull()
                lib?.playlists?.firstOrNull { it.id == rawId }?.tracks.orEmpty()
                    .filter { it.isPlayable() }
            } else {
                runCatching { api.playlist(rawId).tracks }.getOrDefault(emptyList())
                    .filter { it.isPlayable() }
            }
        }
        item.isAlbum() -> {
            runCatching { api.album(item.id).tracks }.getOrDefault(emptyList())
                .filter { it.isPlayable() }
        }
        item.isArtist() -> {
            val radio = runCatching { api.artistRadio(item.id).tracks }.getOrDefault(emptyList())
            if (radio.isNotEmpty()) return radio.filter { it.isPlayable() }
            val detail = runCatching { api.artist(item.id) }.getOrNull()
            (detail?.songs.orEmpty() + detail?.tracks.orEmpty())
                .distinctBy { it.id }
                .filter { it.isPlayable() }
        }
        item.isMix() -> {
            runCatching { api.recoRadio(item.id).tracks }.getOrDefault(emptyList())
                .filter { it.isPlayable() }
        }
        else -> emptyList()
    }
}

private data class PinPoolCacheEntry(val atMs: Long, val tracks: List<TrackDto>)

private val pinPoolCache = ConcurrentHashMap<String, PinPoolCacheEntry>()
private const val PIN_POOL_TTL_MS = 8L * 60L * 1000L

/**
 * Pool Accès rapide : résolution **parallèle** des pins (playlists/mix/artistes),
 * avec hit MixCache + cache mémoire TTL pour un 2ᵉ tap Aléatoire quasi instantané.
 */
suspend fun resolvePinsPool(
    api: YtMusicApi,
    pins: List<TrackDto>,
    mixCache: MixCacheStore? = null,
): List<TrackDto> = coroutineScope {
    if (pins.isEmpty()) return@coroutineScope emptyList()
    val now = System.currentTimeMillis()
    pins.map { pin ->
        async {
            if (pin.isPlayable()) return@async listOf(pin)
            val cacheKey = "pin:${pin.id}:${pin.type.orEmpty()}"
            pinPoolCache[cacheKey]?.takeIf { now - it.atMs < PIN_POOL_TTL_MS }?.tracks
                ?.takeIf { it.isNotEmpty() }
                ?.let { return@async it }

            if (pin.isMix() && mixCache != null) {
                val cached =
                    mixCache.get(mixCache.keyCategory(pin.id))
                        ?: mixCache.get(mixCache.keyRadio("mix", pin.id))
                if (!cached.isNullOrEmpty()) {
                    pinPoolCache[cacheKey] = PinPoolCacheEntry(now, cached)
                    return@async cached
                }
            }

            val resolved = runCatching { resolvePlayableTracks(api, pin) }.getOrDefault(emptyList())
            if (resolved.isNotEmpty()) {
                pinPoolCache[cacheKey] = PinPoolCacheEntry(now, resolved)
            }
            resolved
        }
    }.awaitAll().flatten().distinctBy { it.id }
}

/** Invalide le cache mémoire (unpin / reorder / sync). */
fun invalidatePinsPoolCache() {
    pinPoolCache.clear()
}
