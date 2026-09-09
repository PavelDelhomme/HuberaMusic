package ovh.delhomme.ytmusic.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeoutOrNull
import ovh.delhomme.ytmusic.debug.AppLog
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Téléchargements hors du scope Compose (survit à la fermeture du sheet).
 * Progress partagée : sheet, chrome NP, biblio.
 *
 * Deux priorités :
 * - **user** : clic « Télécharger » / album — survit aux seek, stall, reprise lecture
 * - **opportunistic** : ahead mix/file — annulable pour libérer la bande au rebuffer
 */
class OfflineDownloadManager(
    private val scope: CoroutineScope,
    private val offlineStore: LocalOfflineStore,
    private val streamUrl: (trackId: String) -> String,
    private val ensureToken: suspend () -> Unit,
    private val notifyServer: suspend (trackId: String) -> Unit,
    private val warmStream: (suspend (trackId: String) -> Unit)? = null,
    /** URL avec retry/offline — invalide le format DASH côté API. */
    private val streamUrlForAttempt: ((trackId: String, attempt: Int) -> String)? = null,
    /** 2 max : 1 laissait les albums coincés à 2 % derrière un warm bloqué. */
    private val maxConcurrent: Int = 2,
) {
    private enum class Priority { User, Opportunistic }

    private data class JobEntry(val job: Job, val priority: Priority)

    private val jobs = ConcurrentHashMap<String, JobEntry>()
    private val gate = Semaphore(maxConcurrent.coerceIn(1, 2))
    private val aheadRunning = AtomicBoolean(false)

    private val _progress = MutableStateFlow<Map<String, Float>>(emptyMap())
    val progress: StateFlow<Map<String, Float>> = _progress.asStateFlow()

    private val _errors = MutableStateFlow<Map<String, String>>(emptyMap())
    val errors: StateFlow<Map<String, String>> = _errors.asStateFlow()
    /** Métadonnées des titres en erreur (retry sans repasser par la biblio). */
    private val failedTracks = ConcurrentHashMap<String, TrackDto>()
    /** IDs refusés (DASH / ftyp) — ne plus ré-enqueue pendant la session. */
    private val permanentFail = ConcurrentHashMap.newKeySet<String>()

    fun progressOf(trackId: String): Float? = _progress.value[trackId]

    fun isDownloading(trackId: String): Boolean = _progress.value.containsKey(trackId)

    fun hasActiveJobs(ids: Collection<String>): Boolean {
        if (ids.isEmpty()) return false
        val active = _progress.value
        return ids.any { id -> active.containsKey(id) || jobs[id]?.job?.isActive == true }
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

    /** Lance le DL utilisateur (no-op si déjà local / déjà en cours). */
    fun enqueue(track: TrackDto): Boolean =
        enqueueInternal(track, priority = Priority.User, duringPlaybackSafe = true)

    /**
     * Pré-télécharge silencieusement les prochains titres (mix / file).
     * @param skipFirst ignore les N premiers (tête Exo sur le courant + suivants immédiats).
     * @param duringPlaybackSafe autorise le DL pendant lecture si skipFirst ≥ 3 (Wi‑Fi only).
     */
    fun enqueueAhead(
        tracks: List<TrackDto>,
        limit: Int = 2,
        skipFirst: Int = 0,
        duringPlaybackSafe: Boolean = false,
    ) {
        if (!NetworkMonitor.isOnline()) return
        if (ovh.delhomme.ytmusic.player.StreamPrefetcher.isStreamDown()) return
        if (duringPlaybackSafe) {
            if (!NetworkMonitor.isUnmeteredPreferred(ovh.delhomme.ytmusic.YtMusicApp.instance)) return
        } else if (isPlaybackActive()) {
            return
        }
        val cap = limit.coerceIn(1, 2)
        val candidates = tracks
            .drop(skipFirst.coerceAtLeast(0))
            .asSequence()
            .filter { it.id.matches(Regex("^[a-zA-Z0-9_-]{11}$")) }
            .filter { !offlineStore.has(it.id) }
            .filter { jobs[it.id]?.job?.isActive != true }
            .take(cap)
            .toList()
        if (candidates.isEmpty()) return
        if (!aheadRunning.compareAndSet(false, true)) return
        scope.launch(Dispatchers.IO) {
            try {
                val initialDelay = when {
                    duringPlaybackSafe -> 22_000L
                    isPlaybackActive() -> 18_000L
                    else -> 2_500L
                }
                delay(initialDelay)
                for ((i, t) in candidates.withIndex()) {
                    if (!NetworkMonitor.isOnline()) break
                    if (ovh.delhomme.ytmusic.player.StreamPrefetcher.isStreamDown()) break
                    if (offlineStore.has(t.id)) continue
                    enqueueInternal(
                        t,
                        priority = Priority.Opportunistic,
                        duringPlaybackSafe = duringPlaybackSafe,
                    )
                    val gap = if (duringPlaybackSafe) 14_000L else 8_000L
                    if (i < candidates.lastIndex) delay(gap)
                }
            } finally {
                aheadRunning.set(false)
            }
        }
    }

    /** DL opportuniste pendant lecture : titres à +3 et au-delà. */
    fun enqueueAheadDuringPlayback(tracks: List<TrackDto>, limit: Int = 1) {
        enqueueAhead(tracks, limit = limit, skipFirst = 3, duringPlaybackSafe = true)
    }

    private fun enqueueInternal(
        track: TrackDto,
        priority: Priority,
        duringPlaybackSafe: Boolean = false,
    ): Boolean {
        if (offlineStore.has(track.id)) return false
        if (permanentFail.contains(track.id)) return false
        val already = jobs[track.id]?.job?.isActive == true
        if (already) return false
        // Opportuniste : refuse si stream down. User : enfile et attend.
        if (
            priority == Priority.Opportunistic &&
            ovh.delhomme.ytmusic.player.StreamPrefetcher.isStreamDown()
        ) {
            return false
        }

        _progress.update { it + (track.id to 0.02f) }
        _errors.update { it - track.id }
        failedTracks.remove(track.id)

        val job = scope.launch(Dispatchers.IO) {
            try {
                while (!NetworkMonitor.refreshFromSystem()) {
                    _progress.update { it + (track.id to 0.02f) }
                    delay(2_500)
                }
                if (priority == Priority.User) {
                    // Seek / stall / 5xx : on attend, on n’abandonne pas le clic user.
                    waitUntilStreamReady(track.id, maxLoops = 80, loopMs = 2_500L)
                } else if (!duringPlaybackSafe) {
                    var waitLoops = 0
                    while (
                        isPlaybackActive() ||
                        ovh.delhomme.ytmusic.player.StreamPrefetcher.isStreamDown()
                    ) {
                        if (++waitLoops > 40) return@launch
                        _progress.update { it + (track.id to 0.02f) }
                        delay(15_000)
                        if (!NetworkMonitor.refreshFromSystem()) {
                            delay(2_500)
                        }
                    }
                } else if (ovh.delhomme.ytmusic.player.StreamPrefetcher.isStreamDown()) {
                    return@launch
                }
                runCatching {
                    ovh.delhomme.ytmusic.YtMusicApp.instance.container
                        .ensureReachableApiOrFallbackToProd()
                }
                gate.withPermit {
                    if (offlineStore.has(track.id)) return@withPermit
                    ensureToken()
                    _progress.update { it + (track.id to 0.05f) }
                    withTimeoutOrNull(2_500L) { warmStream?.invoke(track.id) }
                    _progress.update { it + (track.id to 0.12f) }
                    var attempt = 0
                    var lastFail: Throwable? = null
                    while (attempt < 4) {
                        attempt++
                        if (priority == Priority.User) {
                            waitUntilStreamReady(track.id, maxLoops = 40, loopMs = 2_000L)
                        } else if (ovh.delhomme.ytmusic.player.StreamPrefetcher.isStreamDown()) {
                            return@withPermit
                        }
                        val url = streamUrlForAttempt?.invoke(track.id, attempt - 1)
                            ?: streamUrl(track.id)
                        val result = offlineStore.download(track, url) { p ->
                            _progress.update { cur ->
                                cur + (track.id to p.coerceIn(0.08f, 0.99f))
                            }
                        }
                        if (result.isSuccess) {
                            runCatching { notifyServer(track.id) }
                            // Bundle paroles en cache local pour lecture hors-ligne
                            runCatching {
                                val app = ovh.delhomme.ytmusic.YtMusicApp.instance
                                val r = app.container.api.lyrics(track.id)
                                val prefs = app.getSharedPreferences(
                                    "plm_lyrics_cache_v5",
                                    android.content.Context.MODE_PRIVATE,
                                )
                                val timed = r.timed.orEmpty()
                                prefs.edit()
                                    .putString("t_${track.id}", r.lyrics ?: "")
                                    .putString("s_${track.id}", r.source)
                                    .putString(
                                        "l_${track.id}",
                                        timed.joinToString("\n") { "${it.startMsLong()}|${it.text}" },
                                    )
                                    .apply()
                            }
                            return@withPermit
                        }
                        lastFail = result.exceptionOrNull()
                        val msg = lastFail?.message.orEmpty()
                        val dashOrFtyp =
                            msg.contains("DASH", ignoreCase = true) ||
                                msg.contains("pas de ftyp", ignoreCase = true) ||
                                msg.contains("Conteneur", ignoreCase = true)
                        if (dashOrFtyp && attempt < 4) {
                            // Ne pas permanentFail : retry avec ?offline=1&retry=N (fichier disque / 140).
                            AppLog.w(
                                "offline",
                                "user/opportunistic DL format KO ${track.id} attempt=$attempt — progressive retry",
                            )
                            delay(1_200L * attempt)
                            continue
                        }
                        if (dashOrFtyp) {
                            permanentFail.add(track.id)
                            throw Exception(
                                "Format audio incompatible (DASH) — réessaie plus tard ou un autre titre",
                            )
                        }
                        if (priority == Priority.User && isStreamInfraFailure(lastFail ?: Exception(msg))) {
                            AppLog.w(
                                "offline",
                                "user DL infra ${track.id} attempt=$attempt — wait/retry",
                            )
                            ovh.delhomme.ytmusic.player.StreamPrefetcher.markStreamDown(25_000L)
                            cancelOpportunistic()
                            delay(3_000L * attempt)
                            continue
                        }
                        throw lastFail ?: Exception(msg)
                    }
                    throw lastFail ?: Exception("Échec téléchargement")
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
                failedTracks[track.id] = track
                _errors.update { it + (track.id to msg) }
                if (
                    msg.contains("DASH", ignoreCase = true) ||
                    msg.contains("pas de ftyp", ignoreCase = true) ||
                    msg.contains("Conteneur", ignoreCase = true)
                ) {
                    permanentFail.add(track.id)
                }
                if (priority == Priority.Opportunistic && isStreamInfraFailure(e)) {
                    onStreamInfraFailure(msg)
                } else if (priority == Priority.User && isStreamInfraFailure(e)) {
                    // Soft : coupe seulement l’ahead, garde les autres user DL.
                    ovh.delhomme.ytmusic.player.StreamPrefetcher.markStreamDown(45_000L)
                    cancelOpportunistic()
                    AppLog.w("offline", "user DL failed infra ${track.id}: ${msg.take(120)}")
                }
            } finally {
                _progress.update { cur ->
                    val next = cur.toMutableMap()
                    next.remove(track.id)
                    next
                }
                jobs.remove(track.id)
            }
        }
        jobs[track.id] = JobEntry(job, priority)
        return true
    }

    /** Attend réseau + stream OK (seek / stall / 5xx). */
    private suspend fun waitUntilStreamReady(trackId: String, maxLoops: Int, loopMs: Long) {
        var loops = 0
        while (
            ovh.delhomme.ytmusic.player.StreamPrefetcher.isStreamDown() ||
            !NetworkMonitor.refreshFromSystem()
        ) {
            if (++loops > maxLoops) return
            _progress.update { it + (trackId to 0.03f) }
            delay(loopMs)
        }
    }

    /** 502 / timeout / DNS : coupe les DL offline pour ne pas saturer l’API. */
    private fun isStreamInfraFailure(e: Throwable): Boolean {
        var cur: Throwable? = e
        while (cur != null) {
            if (cur is java.net.SocketTimeoutException) return true
            if (cur is java.net.UnknownHostException) return true
            val m = cur.message.orEmpty()
            if (m.contains("HTTP 502") || m.contains("HTTP 503") || m.contains("HTTP 504")) return true
            if (m.contains("timeout", ignoreCase = true)) return true
            if (m.contains("Unable to resolve host", ignoreCase = true)) return true
            if (m.contains("stream down", ignoreCase = true)) return true
            if (m.contains("stream infra", ignoreCase = true)) return true
            cur = cur.cause
        }
        return false
    }

    private fun onStreamInfraFailure(detail: String) {
        ovh.delhomme.ytmusic.player.StreamPrefetcher.markStreamDown(180_000L)
        val n = cancelOpportunistic()
        AppLog.w(
            "offline",
            "circuit-breaker stream down — cancelOpportunistic=$n detail=${detail.take(120)}",
        )
    }

    /** Enfile une collection (album / playlist) — priorité user. */
    fun enqueueMany(tracks: List<TrackDto>): Int {
        val app = ovh.delhomme.ytmusic.YtMusicApp.instance
        var freeBytes = app.filesDir.usableSpace
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            runCatching {
                val sm = app.getSystemService(android.app.usage.StorageStatsManager::class.java)
                val uuid = android.os.storage.StorageManager.UUID_DEFAULT
                freeBytes = sm.getFreeBytes(uuid)
            }
        }
        val needGuess = tracks.size * 4L * 1024L * 1024L // ~4 Mo / titre
        if (freeBytes in 1 until needGuess) {
            AppLog.w("offline", "espace disque faible free=$freeBytes need~$needGuess")
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                android.widget.Toast.makeText(
                    app,
                    "Espace disque faible (${freeBytes / (1024 * 1024)} Mo libres) — libère de la place",
                    android.widget.Toast.LENGTH_LONG,
                ).show()
            }
        }
        var started = 0
        for (t in tracks) {
            if (enqueue(t)) started++
        }
        return started
    }

    /** 2ᵉ tap : annule un DL en cours (purge .part). */
    fun toggleOrEnqueue(track: TrackDto): Boolean {
        if (jobs[track.id]?.job?.isActive == true) {
            cancel(track.id)
            return false
        }
        return enqueue(track)
    }

    private fun isPlaybackActive(): Boolean =
        runCatching {
            ovh.delhomme.ytmusic.player.PlaybackService.Holder.isPlaybackActiveSafe()
        }.getOrDefault(true) // en doute : ne pas DL opportuniste pendant lecture

    /** Exposé à OfflineKeeper — file non vide OU lecture/buffer = busy. */
    fun isPlaybackBusy(): Boolean =
        isPlaybackActive() ||
            runCatching {
                ovh.delhomme.ytmusic.player.PlaybackService.Holder.queue.isNotEmpty()
            }.getOrDefault(false)

    fun consumeError(trackId: String): String? {
        val msg = _errors.value[trackId] ?: return null
        _errors.update { it - trackId }
        return msg
    }

    fun failedTrack(trackId: String): TrackDto? = failedTracks[trackId]

    /**
     * Relance les DL en erreur (sauf permanentFail DASH).
     * @return nombre de jobs relancés.
     */
    fun retryFailed(limit: Int = 24): Int {
        val ids = _errors.value.keys
            .filter { it !in permanentFail && it !in _progress.value }
            .take(limit)
        var n = 0
        for (id in ids) {
            val track = failedTracks[id] ?: continue
            _errors.update { it - id }
            if (enqueue(track)) n++
        }
        return n
    }

    /** Annule un DL en cours et supprime le fichier partiel. */
    fun cancel(trackId: String): Boolean {
        val entry = jobs[trackId]
        val active = entry?.job?.isActive == true || _progress.value.containsKey(trackId)
        entry?.job?.cancel()
        jobs.remove(trackId)
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

    /**
     * Annule uniquement les DL opportunistes (ahead).
     * À utiliser au seek / stall / reprise lecture — **ne coupe pas** un clic « Télécharger ».
     */
    fun cancelOpportunistic(): Int {
        val ids = jobs.filter { it.value.priority == Priority.Opportunistic }.keys.toList()
        return cancelMany(ids)
    }

    /** Annule absolument tout (idle long / crash). Préférer [cancelOpportunistic] au quotidien. */
    fun cancelAll(): Int = cancelMany(jobs.keys.toList())
}
