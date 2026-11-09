package ovh.delhomme.ytmusic.data

/**
 * Clip visuel pour un titre.
 *
 * Un YouTube « Laisse Nous Raver » / reel Instagram a le **même** ID que le titre :
 * on le joue en clip. L’ancien filtre `visualId != trackId` tombait alors sur
 * « Pas de clip » alors que la vidéo EST le morceau.
 *
 * Les chaînes Topic (audio-only) restent gérées à la lecture : si Exo échoue,
 * on affiche la pochette.
 */
object VisualIds {
    fun pick(trackId: String, visualId: String?, source: String? = null): String? {
        val t = trackId.trim()
        val v = visualId?.trim()?.takeIf { it.length == 11 }
        if (v != null && v != t) return v
        if (t.length == 11) return v ?: t
        return v
    }
}
