package ovh.delhomme.ytmusic.data

/**
 * Mix / radio hors-ligne à partir des titres déjà téléchargés sur l’appareil.
 * Pas d’appel API — shuffle des fichiers locaux (optionnellement seed en tête).
 */
fun buildOfflineMix(
    offlineStore: LocalOfflineStore,
    seed: TrackDto? = null,
    limit: Int = 80,
): List<TrackDto> {
    val local = offlineStore.listTracks().filter { it.isPlayable() }
    if (local.isEmpty()) return emptyList()
    val seedId = seed?.id?.takeIf { it.matches(Regex("^[a-zA-Z0-9_-]{11}$")) }
    val pool = if (seedId != null) {
        local.filter { it.id != seedId }.shuffled()
    } else {
        local.shuffled()
    }
    val head = if (seedId != null) {
        listOfNotNull(seed?.takeIf { offlineStore.has(it.id) } ?: local.firstOrNull { it.id == seedId })
    } else {
        emptyList()
    }
    return (head + pool).distinctBy { it.id }.take(limit.coerceAtLeast(1))
}
