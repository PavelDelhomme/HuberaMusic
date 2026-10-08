package ovh.delhomme.ytmusic.player

/**
 * Titre déjà téléchargé : rester sur `file://`. Recâbler vers `/api/stream`
 * (Wi‑Fi ou seek) renvoyait Exo sur un SimpleCache HTTP tronqué → BUFFERING
 * à 0:00, son haché (régression 357–359).
 */
object LocalPlaybackPolicy {
    fun shouldKeepLocalFileUri(schemeOrUri: String?): Boolean {
        val s = schemeOrUri?.trim()?.lowercase().orEmpty()
        if (s.isEmpty()) return false
        return s == "file" || s.startsWith("file:") || (s.startsWith("/") && !s.startsWith("//"))
    }

    /**
     * Avant un seek (y compris seek-to-start hors-ligne) : si un .m4a local
     * existe, l’URI jouée DOIT être ce fichier — jamais le proxy HTTP.
     */
    fun uriAfterSeek(currentUri: String?, localPlayUri: String?): String {
        if (localPlayUri != null && shouldKeepLocalFileUri(localPlayUri)) return localPlayUri
        return currentUri.orEmpty()
    }

    fun allowRemoteRebind(currentSchemeOrUri: String?, hasLocalFile: Boolean): Boolean {
        if (hasLocalFile) return false
        if (shouldKeepLocalFileUri(currentSchemeOrUri)) return false
        return true
    }

    /**
     * BUFFERING à pos≈0 après seek-to-start sur un fichier local n’est pas
     * un titre mort : ne pas purge / proxy / SimpleCache.
     */
    fun shouldEscalateLocalStallToRemote(
        isLocal: Boolean,
        hasLocalFile: Boolean,
        offline: Boolean,
    ): Boolean {
        if (isLocal || hasLocalFile) return false
        if (offline) return false
        return true
    }

    fun needsPrepareAfterSeek(playbackState: Int): Boolean {
        // STATE_IDLE = 1, STATE_ENDED = 4 (Media3 Player)
        return playbackState == 1 || playbackState == 4
    }
}
