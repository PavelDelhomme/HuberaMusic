package ovh.delhomme.ytmusic.player

/**
 * Depuis le lecteur, « Accéder à l'album » ouvre une page album distincte
 * (titres de l'album). Le lecteur plein écran se ferme et ne se rouvre pas
 * sur le relâchement du doigt (mini-lecteur dessous).
 * La page artiste reste une page artiste.
 */
object DetailOpenPolicy {
    const val PLAYER_REOPEN_SUPPRESS_MS = 900L

    fun closesPlayer(kind: String): Boolean = kind == "album" || kind == "artist"

    fun isAlbumPage(kind: String): Boolean = kind == "album"

    fun isArtistPage(kind: String): Boolean = kind == "artist"

    fun shouldIgnorePlayerReopen(nowMs: Long, suppressUntilMs: Long): Boolean =
        nowMs < suppressUntilMs
}
