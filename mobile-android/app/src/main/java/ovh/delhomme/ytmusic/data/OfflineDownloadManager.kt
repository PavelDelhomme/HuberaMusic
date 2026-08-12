package ovh.delhomme.ytmusic.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Téléchargements hors du scope Compose (survit à la fermeture du sheet).
 * Progress partagée : sheet, chrome NP, biblio.
 */
class OfflineDownloadManager(
    private val scope: CoroutineScope,
    private val offlineStore: LocalOfflineStore,
    private val streamUrl: (trackId: String) -> String,
    private val ensureToken: suspend () -> Unit,
    private val notifyServer: suspend (trackId: String) -> Unit,
) {
    private val jobsMutex = Mutex()
    private val jobs = mutableMapOf<String, Job>()

    private val _progress = MutableStateFlow<Map<String, Float>>(emptyMap())
    val progress: StateFlow<Map<String, Float>> = _progress.asStateFlow()

    private val _errors = MutableStateFlow<Map<String, String>>(emptyMap())
    val errors: StateFlow<Map<String, String>> = _errors.asStateFlow()

    fun progressOf(trackId: String): Float? = _progress.value[trackId]

    fun isDownloading(trackId: String): Boolean = _progress.value.containsKey(trackId)

    /**
     * Lance le DL en arrière-plan (no-op si déjà local / déjà en cours).
     * @return false si déjà téléchargé ou déjà en file
     */
    fun enqueue(track: TrackDto): Boolean {
        if (offlineStore.has(track.id)) return false
        val already = jobs[track.id]?.isActive == true
        if (already) return false

        _progress.update { it + (track.id to 0.02f) }
        _errors.update { it - track.id }

        val job = scope.launch(Dispatchers.IO) {
            try {
                ensureToken()
                offlineStore
                    .download(track, streamUrl(track.id)) { p ->
                        _progress.update { cur ->
                            cur + (track.id to p.coerceIn(0.02f, 0.99f))
                        }
                    }
                    .getOrThrow()
                runCatching { notifyServer(track.id) }
            } catch (e: kotlinx.coroutines.CancellationException) {
                runCatching {
                    java.io.File(
                        ovh.delhomme.ytmusic.YtMusicApp.instance.filesDir,
                        "offline/${track.id}.part",
                    ).delete()
                }
                throw e
            } catch (e: Exception) {
                _errors.update { it + (track.id to (e.message ?: "Échec téléchargement")) }
            } finally {
                _progress.update { cur ->
                    val next = cur.toMutableMap()
                    next.remove(track.id)
                    next
                }
                jobsMutex.withLock { jobs.remove(track.id) }
            }
        }
        jobs[track.id] = job
        return true
    }

    /**
     * Pré-télécharge silencieusement les prochains titres (mix / file) pour survivre
     * à une coupure réseau. Limité pour ne pas saturer la bande.
     */
    fun enqueueAhead(tracks: List<TrackDto>, limit: Int = 2) {
        if (!NetworkMonitor.isOnline()) return
        var started = 0
        for (t in tracks) {
            if (started >= limit) break
            if (!t.id.matches(Regex("^[a-zA-Z0-9_-]{11}$"))) continue
            if (offlineStore.has(t.id)) continue
            if (jobs[t.id]?.isActive == true) continue
            // Silent : progress visible mais sans toast
            if (enqueue(t)) started++
        }
    }

    fun consumeError(trackId: String): String? {
        val msg = _errors.value[trackId] ?: return null
        _errors.update { it - trackId }
        return msg
    }
}
