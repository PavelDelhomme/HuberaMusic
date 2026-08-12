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
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.sync.withPermit

/**
 * Téléchargements hors du scope Compose (survit à la fermeture du sheet).
 * Progress partagée : sheet, chrome NP, biblio.
 * Concurrence limitée pour éviter les DL bloqués à 2 % (saturation réseau / API).
 */
class OfflineDownloadManager(
    private val scope: CoroutineScope,
    private val offlineStore: LocalOfflineStore,
    private val streamUrl: (trackId: String) -> String,
    private val ensureToken: suspend () -> Unit,
    private val notifyServer: suspend (trackId: String) -> Unit,
    private val maxConcurrent: Int = 3,
) {
    private val jobsMutex = Mutex()
    private val jobs = mutableMapOf<String, Job>()
    private val gate = Semaphore(maxConcurrent.coerceIn(1, 4))

    private val _progress = MutableStateFlow<Map<String, Float>>(emptyMap())
    val progress: StateFlow<Map<String, Float>> = _progress.asStateFlow()

    private val _errors = MutableStateFlow<Map<String, String>>(emptyMap())
    val errors: StateFlow<Map<String, String>> = _errors.asStateFlow()

    fun progressOf(trackId: String): Float? = _progress.value[trackId]

    fun isDownloading(trackId: String): Boolean = _progress.value.containsKey(trackId)

    fun hasActiveJobs(ids: Collection<String>): Boolean {
        if (ids.isEmpty()) return false
        val active = _progress.value
        return ids.any { id -> active.containsKey(id) || jobs[id]?.isActive == true }
    }

    /**
     * Progression agrégée 0..1 pour un album / playlist :
     * titres locaux = 1, en cours = progress map, sinon 0.
     */
    fun aggregateProgress(ids: List<String>): Float {
        if (ids.isEmpty()) return 0f
        val map = _progress.value
        var sum = 0f
        for (id in ids) {
            sum += when {
                offlineStore.has(id) -> 1f
                map.containsKey(id) -> map.getValue(id).coerceIn(0.02f, 0.99f)
                else -> 0f
            }
        }
        return (sum / ids.size).coerceIn(0f, 1f)
    }

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
                gate.withPermit {
                    // Re-check après attente du sémaphore
                    if (offlineStore.has(track.id)) return@withPermit
                    ensureToken()
                    offlineStore
                        .download(track, streamUrl(track.id)) { p ->
                            _progress.update { cur ->
                                cur + (track.id to p.coerceIn(0.02f, 0.99f))
                            }
                        }
                        .getOrThrow()
                    runCatching { notifyServer(track.id) }
                }
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

    /** Enfile une collection (album / playlist) — concurrence gérée par le sémaphore. */
    fun enqueueMany(tracks: List<TrackDto>): Int {
        var started = 0
        for (t in tracks) {
            if (enqueue(t)) started++
        }
        return started
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
            if (enqueue(t)) started++
        }
    }

    fun consumeError(trackId: String): String? {
        val msg = _errors.value[trackId] ?: return null
        _errors.update { it - trackId }
        return msg
    }
}
