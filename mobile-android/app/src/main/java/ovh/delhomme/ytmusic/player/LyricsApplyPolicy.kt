package ovh.delhomme.ytmusic.player

/** Politique karaoké : une réponse vide ne doit pas casser un cache déjà sync. */
object LyricsApplyPolicy {
    fun shouldReplaceCachedLyrics(incoming: String?): Boolean {
        val t = incoming?.trim().orEmpty()
        return t.length >= 8
    }

    const val COLD_GRACE_MS = 55_000L
}
