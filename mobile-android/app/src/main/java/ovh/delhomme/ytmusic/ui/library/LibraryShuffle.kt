package ovh.delhomme.ytmusic.ui.library

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.player.StreamPrefetcher

/** Aléatoire biblio : warm formats + têtes Exo bloquantes (#0–2) puis play. */
suspend fun playLibraryShuffled(
    container: AppContainer,
    queue: List<TrackDto>,
    onPlay: (List<TrackDto>, Int) -> Unit,
) {
    val playable = queue.filter { it.isPlayable() && it.id.length == 11 }
    if (playable.isEmpty()) return
    val shuffled = withContext(Dispatchers.Default) { playable.shuffled() }
    val base = container.resolvedApiBase()
    if (base.isNotBlank()) {
        withContext(Dispatchers.IO) {
            StreamPrefetcher.prepareShuffleLead(base, shuffled.map { it.id })
        }
    }
    onPlay(shuffled, 0)
}
