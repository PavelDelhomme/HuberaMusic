package ovh.delhomme.ytmusic.player

/**
 * Accès rapide : lecture et aléatoire restent sur les titres épinglés.
 * « À suivre » et les similaires restent hors de la boucle.
 * L'aléatoire est un mélange de ces épingles, rien d'autre.
 */
object QuickAccessLoopPolicy {
    fun isPinSource(sourceKind: String?): Boolean = sourceKind == "pins"

    fun blocksFollowing(sourceKind: String?, pinLoop: Boolean): Boolean =
        pinLoop || isPinSource(sourceKind)

    fun acceptsFollowing(sourceKind: String?, pinLoop: Boolean = false): Boolean =
        !blocksFollowing(sourceKind, pinLoop)

    fun acceptsSimilarIntoLoop(sourceKind: String?): Boolean = !isPinSource(sourceKind)

    fun isPinPlayable(id: String, playable: Boolean): Boolean =
        playable && id.length == 11

    /** File de lecture : épingles jouables, sans titre extérieur. */
    fun playbackIds(pins: List<Pair<String, Boolean>>): List<String> =
        pins.mapNotNull { (id, playable) ->
            id.takeIf { isPinPlayable(id, playable) }
        }.distinct()

    /** L'aléatoire est une permutation des épingles, pas un élargissement. */
    fun isPinPermutation(played: List<String>, pins: List<String>): Boolean =
        played.size == pins.size && played.toSet() == pins.toSet()
}
