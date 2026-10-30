package ovh.delhomme.ytmusic.data

import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import ovh.delhomme.ytmusic.player.StreamPrefetcher

/**
 * Remappe les videoId morts (Extended/Radio Rekkt…) vers l’original jouable.
 * Like / biblio / accès rapide / téléchargement doivent cibler cet ID —
 * sinon l’UI « marche » sur abVA… pendant que la lecture utilise PcpOc….
 */
object TrackCanonical {
    private val SEED = mapOf(
        "abVAuW6XTCU" to "PcpOcHlHiog",
        "zzOxVZ8W5pA" to "PcpOcHlHiog",
        "te6K9qC6Sxg" to "PcpOcHlHiog",
    )
    private val cache = ConcurrentHashMap<String, String>()

    fun knownPlayId(id: String): String {
        if (id.length != 11) return id
        return cache[id] ?: SEED[id] ?: id
    }

    fun aliasIds(id: String): Set<String> {
        if (id.length != 11) return setOf(id)
        val play = knownPlayId(id)
        return linkedSetOf(id, play)
    }

    fun remember(deadId: String, playId: String) {
        if (deadId.length == 11 && playId.length == 11 && deadId != playId) {
            cache[deadId] = playId
        }
    }

    /** Applique le seed/cache local sans réseau (instantané). */
    fun applyLocal(track: TrackDto): TrackDto {
        val play = knownPlayId(track.id)
        if (play == track.id) return track
        return track.copy(id = play, canonicalId = track.canonicalId ?: track.id)
    }

    /**
     * Résout l’ID jouable (seed puis API ≤2.9 s).
     * Toujours safe pour like / pin / DL — ne bloque pas l’UI si timeout.
     */
    suspend fun resolveForActions(container: AppContainer, track: TrackDto): TrackDto {
        val local = applyLocal(track)
        if (local.id != track.id) return local
        if (track.id.length != 11) return track
        val repl = withContext(Dispatchers.IO) {
            runCatching {
                StreamPrefetcher.fetchReplacementId(
                    container.resolvedApiBase(),
                    track.id,
                    track.title,
                    track.artistLine().takeIf { it != "Artiste" },
                )
            }.getOrNull()
        }
        if (repl.isNullOrBlank() || repl == track.id) return track
        remember(track.id, repl)
        return track.copy(id = repl, canonicalId = track.canonicalId ?: track.id)
    }
}
