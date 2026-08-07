package ovh.delhomme.ytmusic.data

/**
 * Construit une file « radio ».
 * @param progressive si true : related?fast=1 d’abord (~8–15 titres) — l’appelant peut
 *   ensuite top-up avec [buildRadioQueueContinuation].
 */
suspend fun buildRadioQueue(
    api: YtMusicApi,
    kind: String,
    id: String,
    seed: TrackDto? = null,
    stayClose: Boolean = false,
    mixCache: MixCacheStore? = null,
    progressive: Boolean = true,
): List<TrackDto> {
    val cacheKey = when (kind) {
        "album" -> mixCache?.keyRadio("album", id)
        "artist" -> mixCache?.keyRadio("artist", id)
        else -> mixCache?.keyRadio("track", id)
    }
    mixCache?.let { cache ->
        cacheKey?.let { key ->
            cache.get(key)?.takeIf { it.isNotEmpty() }?.let { cached ->
                val seedPlayable = seed?.takeIf { it.isPlayable() }
                val head = seedPlayable ?: cached.firstOrNull() ?: return@let
                return listOf(head) + cached.filter { it.id != head.id }.take(MixCacheStore.MIX_TARGET)
            }
        }
    }

    val seedPlayable = seed?.takeIf { it.isPlayable() }
    val pool = mutableListOf<TrackDto>()
    var start: TrackDto? = seedPlayable

    when (kind) {
        "album" -> {
            val radioRes = runCatching { api.albumRadio(id) }.getOrNull()
            val radio = radioRes?.tracks.orEmpty()
            val album = runCatching { api.album(id) }.getOrNull()
            val albumTracks = album?.tracks.orEmpty().filter { it.isPlayable() }
            start = start ?: albumTracks.firstOrNull()
            pool += radio.filter { it.isPlayable() && it.id != start?.id }
            pool += albumTracks.filter { it.id != start?.id }.take(6)
            if (mixCache != null && cacheKey != null && pool.isNotEmpty()) {
                mixCache.put(cacheKey, pool, radioRes?.generatedAt ?: System.currentTimeMillis())
            }
        }
        "artist" -> {
            val radioRes = runCatching { api.artistRadio(id) }.getOrNull()
            val radio = radioRes?.tracks.orEmpty()
            val artist = runCatching { api.artist(id) }.getOrNull()
            val songs = (artist?.songs.orEmpty() + artist?.tracks.orEmpty())
                .distinctBy { it.id }
                .filter { it.isPlayable() }
            start = start ?: songs.firstOrNull() ?: radio.firstOrNull { it.isPlayable() }
            pool += songs.filter { it.id != start?.id }.take(8)
            pool += radio.filter { it.isPlayable() && it.id != start?.id }
            if (mixCache != null && cacheKey != null && pool.isNotEmpty()) {
                mixCache.put(cacheKey, pool, radioRes?.generatedAt ?: System.currentTimeMillis())
            }
        }
        else -> {
            val trackId = id
            // Progressif : fast d’abord (évite timeout 45s / file à 1 titre)
            val related = if (progressive) {
                runCatching { api.related(trackId, fast = 1) }.getOrNull()
                    ?: runCatching { api.related(trackId, full = 0) }.getOrNull()
            } else {
                runCatching { api.related(trackId, full = 1) }.getOrNull()
                    ?: runCatching { api.related(trackId, full = 0) }.getOrNull()
            }
            var candidates = (
                (related?.tracks.orEmpty()) +
                    (related?.related.orEmpty()) +
                    (related?.radio.orEmpty())
                )
                .filter { it.isPlayable() && it.id != trackId }

            if (stayClose && seedPlayable?.artists?.firstOrNull() != null) {
                val key = (
                    seedPlayable.artists!!.first().id
                        ?: seedPlayable.artists!!.first().name
                    ).lowercase()
                val close = candidates.filter { t ->
                    t.artists.orEmpty().any { a ->
                        (a.id ?: a.name).lowercase() == key
                    }
                }
                val far = candidates.filter { t ->
                    t.artists.orEmpty().none { a ->
                        (a.id ?: a.name).lowercase() == key
                    }
                }
                candidates = close.take(20) + far
            }
            pool += candidates
            start = start ?: TrackDto(
                id = trackId,
                title = seed?.title ?: "Radio",
                artists = seed?.artists,
                thumbnails = seed?.thumbnails,
                type = "song",
            ).takeIf { it.isPlayable() }
            // Ne cache que les mixes « complets » (pas le fast)
            if (!progressive && mixCache != null && cacheKey != null && pool.isNotEmpty()) {
                mixCache.put(cacheKey, pool, related?.generatedAt ?: System.currentTimeMillis())
            }
        }
    }

    val seen = linkedSetOf<String>()
    val uniq = mutableListOf<TrackDto>()
    for (t in pool) {
        if (t.id in seen || !t.isPlayable()) continue
        seen += t.id
        uniq += t
        if (uniq.size >= MixCacheStore.MIX_TARGET) break
    }

    val head = start?.takeIf { it.isPlayable() } ?: uniq.firstOrNull() ?: return emptyList()
    val restCap = if (progressive && kind == "track") 24 else MixCacheStore.MIX_TARGET
    return listOf(head) + uniq.filter { it.id != head.id }.take(restCap)
}

/** Top-up après un démarrage progressif (full=0 puis éventuellement cache). */
suspend fun buildRadioQueueContinuation(
    api: YtMusicApi,
    trackId: String,
    alreadyIds: Set<String>,
    mixCache: MixCacheStore? = null,
): List<TrackDto> {
    val mid = runCatching { api.related(trackId, full = 0) }.getOrNull()
    var pool = (
        (mid?.tracks.orEmpty()) + (mid?.related.orEmpty()) + (mid?.radio.orEmpty())
        )
        .filter { it.isPlayable() && it.id !in alreadyIds && it.id != trackId }
        .distinctBy { it.id }
    if (pool.size < 20) {
        val full = runCatching { api.related(trackId, full = 1) }.getOrNull()
        val extra = (
            (full?.tracks.orEmpty()) + (full?.related.orEmpty()) + (full?.radio.orEmpty())
            )
            .filter { it.isPlayable() && it.id !in alreadyIds && it.id != trackId }
        pool = (pool + extra).distinctBy { it.id }
        if (mixCache != null && pool.isNotEmpty()) {
            mixCache.put(
                mixCache.keyRadio("track", trackId),
                pool,
                full?.generatedAt ?: System.currentTimeMillis(),
            )
        }
    }
    return pool.take(MixCacheStore.MIX_TARGET)
}
