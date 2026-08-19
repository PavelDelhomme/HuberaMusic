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
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.atomic.AtomicBoolean

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
    private val warmStream: (suspend (trackId: String) -> Unit)? = null,
    /** 2 max : 1 laissait les albums (Pandemonium) coincés à 2 % derrière un warm bloqué. */
    private val maxConcurrent: Int = 2,
) {
    private val jobsMutex = Mutex()
    private val jobs = mutableMapOf<String, Job>()
    private val gate = Semaphore(maxConcurrent.coerceIn(1, 2))
    private val aheadRunning = AtomicBoolean(false)

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
                // Hors-ligne : rester en file jusqu’au retour réseau (ne pas échouer tout de suite).
                // Recalcule le vrai réseau : après Wi‑Fi → 4G le flag peut rester faux.
                while (!NetworkMonitor.refreshFromSystem()) {
                    _progress.update { it + (track.id to 0.02f) }
                    kotlinx.coroutines.delay(2_500)
                }
                runCatching {
                    ovh.delhomme.ytmusic.YtMusicApp.instance.container
                        .ensureReachableApiOrFallbackToProd()
                }
                gate.withPermit {
                    // Re-check après attente du sémaphore
                    if (offlineStore.has(track.id)) return@withPermit
                    ensureToken()
                    _progress.update { it + (track.id to 0.05f) }
                    if (!isPlaybackActive()) {
                        withTimeoutOrNull(800L) { warmStream?.invoke(track.id) }
                    }
                    _progress.update { it + (track.id to 0.12f) }
                    offlineStore
                        .download(track, streamUrl(track.id)) { p ->
                            _progress.update { cur ->
                                cur + (track.id to p.coerceIn(0.08f, 0.99f))
                            }
                        }
                        .getOrThrow()
                    // Marque serveur sans re-télécharger (ack)
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
                val msg = e.message ?: "Échec téléchargement"
                _errors.update { it + (track.id to msg) }
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
     * à une coupure réseau. Séquentiel + limité : ne pas concurrencer la lecture
     * (sinon googlevideo reset → trou / skip).
     */
    fun enqueueAhead(tracks: List<TrackDto>, limit: Int = 2) {
        if (!NetworkMonitor.isOnline()) return
        if (ovh.delhomme.ytmusic.player.StreamPrefetcher.isStreamDown()) return
        val cap = limit.coerceIn(1, 2)
        val candidates = tracks
            .asSequence()
            .filter { it.id.matches(Regex("^[a-zA-Z0-9_-]{11}$")) }
            .filter { !offlineStore.has(it.id) }
            .filter { jobs[it.id]?.isActive != true }
            .take(cap)
            .toList()
        if (candidates.isEmpty()) return
        // Un seul « ahead pipeline » à la fois — priorité au prochain titre
        if (!aheadRunning.compareAndSet(false, true)) return
        scope.launch(Dispatchers.IO) {
            try {
                val delayMs = if (isPlaybackActive()) 18_000L else 2_500L
                kotlinx.coroutines.delay(delayMs)
                for ((i, t) in candidates.withIndex()) {
                    if (!NetworkMonitor.isOnline()) break
                    if (ovh.delhomme.ytmusic.player.StreamPrefetcher.isStreamDown()) break
                    if (offlineStore.has(t.id)) continue
                    enqueue(t)
                    if (i < candidates.lastIndex) kotlinx.coroutines.delay(8_000)
                }
            } finally {
                aheadRunning.set(false)
            }
        }
    }

    private fun isPlaybackActive(): Boolean =
        ovh.delhomme.ytmusic.player.PlaybackService.Holder.isPlaybackActiveSafe()

    fun consumeError(trackId: String): String? {
        val msg = _errors.value[trackId] ?: return null
        _errors.update { it - trackId }
        return msg
    }

    /** Annule un DL en cours et supprime le fichier partiel. */
    fun cancel(trackId: String): Boolean {
        val job = jobs[trackId]
        val active = job?.isActive == true || _progress.value.containsKey(trackId)
        job?.cancel()
        _progress.update { it - trackId }
        _errors.update { it - trackId }
        runCatching {
            java.io.File(
                ovh.delhomme.ytmusic.YtMusicApp.instance.filesDir,
                "offline/$trackId.part",
            ).delete()
        }
        return active
    }

    fun cancelMany(ids: Collection<String>): Int {
        var n = 0
        for (id in ids) if (cancel(id)) n++
        return n
    }

    /** Annule tous les téléchargements actifs (ex. arrêt idle en arrière-plan). */
    fun cancelAll(): Int = cancelMany(jobs.keys.toList())
}
