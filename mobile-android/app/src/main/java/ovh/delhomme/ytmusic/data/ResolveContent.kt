package ovh.delhomme.ytmusic.data

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
