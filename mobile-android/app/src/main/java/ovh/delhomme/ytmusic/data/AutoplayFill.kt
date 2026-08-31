package ovh.delhomme.ytmusic.data

/**
 * Remplit la zone « À suivre ».
 * Préfère related?full=0 (rank + exclusion déjà joués / tops) ;
 * fallback fast (upNext) si le batch court échoue.
 */
suspend fun fetchAutoplayTracksFast(api: YtMusicApi, seedId: String): List<TrackDto> {
    if (seedId.length != 11) return emptyList()
    val fast = runCatching { api.related(seedId, fast = 1) }.getOrNull() ?: return emptyList()
    return (
        fast.tracks.orEmpty() +
            fast.related.orEmpty() +
            fast.radio.orEmpty()
        )
        .filter { it.isPlayable() && it.id != seedId }
        .distinctBy { it.id }
}

suspend fun fetchAutoplayTracksFull(api: YtMusicApi, seedId: String): List<TrackDto> {
    if (seedId.length != 11) return emptyList()
    // Batch court pour l’autoplay hors mix (pas le full 200)
    val related = runCatching { api.related(seedId, full = 0) }.getOrNull() ?: return emptyList()
    return (
        related.tracks.orEmpty() +
            related.related.orEmpty() +
            related.radio.orEmpty()
        )
        .filter { it.isPlayable() && it.id != seedId }
        .distinctBy { it.id }
}

/** Autoplay client : full court d’abord, sinon upNext rapide. */
suspend fun fetchAutoplayTracks(api: YtMusicApi, seedId: String): List<TrackDto> {
    val full = fetchAutoplayTracksFull(api, seedId)
    if (full.size >= 4) return full
    val fast = fetchAutoplayTracksFast(api, seedId)
    if (full.isEmpty()) return fast
    return (full + fast).distinctBy { it.id }
}
