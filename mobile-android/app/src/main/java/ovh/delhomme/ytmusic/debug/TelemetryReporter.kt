package ovh.delhomme.ytmusic.debug

import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import ovh.delhomme.ytmusic.BuildConfig
import ovh.delhomme.ytmusic.YtMusicApp
import java.util.concurrent.atomic.AtomicLong

/**
 * Remonte crashes / erreurs player vers `/api/telemetry`
 * (stockage serveur + email admin si level error|fatal).
 */
object TelemetryReporter {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()
    private val lastSentAt = AtomicLong(0L)
    private const val MIN_GAP_MS = 8_000L

    fun report(
        level: String,
        kind: String,
        message: String?,
        stack: String? = null,
        meta: Map<String, Any?> = emptyMap(),
        force: Boolean = false,
        blockingMs: Long = 0L,
    ) {
        val work = suspend {
            runCatching {
                if (!force) {
                    val now = System.currentTimeMillis()
                    val prev = lastSentAt.get()
                    if (now - prev < MIN_GAP_MS && level != "fatal") return@runCatching
                    lastSentAt.set(now)
                }
                mutex.withLock {
                    val container = runCatching { YtMusicApp.instance.container }.getOrNull()
                        ?: return@withLock
                    val logs = AppLog.recentLogText(24_000)
                    val crumbs = AppLog.breadcrumbSnapshot()
                    val effectiveStack = when {
                        !stack.isNullOrBlank() -> stack
                        else -> buildString {
                            appendLine("(pas de Throwable — diagnostic AppLog)")
                            appendLine("kind=$kind level=$level")
                            appendLine("message=${message ?: ""}")
                            appendLine()
                            appendLine("--- breadcrumbs ---")
                            crumbs.takeLast(40).forEach { appendLine(it) }
                            appendLine()
                            appendLine("--- recent logs ---")
                            append(logs.take(20_000))
                        }
                    }
                    val body = mutableMapOf<String, Any?>(
                        "env" to container.apiEnvKind(),
                        "level" to level,
                        "kind" to kind,
                        "message" to message,
                        "stack" to effectiveStack,
                        "deviceId" to container.deviceId,
                        "userAgent" to (
                            "PLM-Android/${BuildConfig.VERSION_NAME} " +
                                "(${Build.MANUFACTURER} ${Build.MODEL}; sdk=${Build.VERSION.SDK_INT})"
                            ),
                        "url" to "android://${BuildConfig.APPLICATION_ID}",
                        "meta" to meta + mapOf(
                            "appVersion" to BuildConfig.VERSION_NAME,
                            "versionCode" to BuildConfig.VERSION_CODE,
                            "apiBase" to container.resolvedApiBase(),
                            "debug" to BuildConfig.DEBUG,
                            "manufacturer" to Build.MANUFACTURER,
                            "model" to Build.MODEL,
                            "sdk" to Build.VERSION.SDK_INT,
                            "session" to AppLog.sessionId(),
                            "breadcrumbs" to (meta["breadcrumbs"] ?: crumbs.takeLast(40)),
                            "recentLogs" to (meta["recentLogs"] ?: logs),
                        ),
                    )
                    container.api.telemetry(body)
                    flushPendingLocked(container)
                }
            }.onFailure { e ->
                AppLog.w("telemetry", "upload failed: ${e.message}")
                runCatching {
                    val ctx = YtMusicApp.instance
                    val compact = org.json.JSONObject()
                        .put("ts", System.currentTimeMillis())
                        .put("level", level)
                        .put("kind", kind)
                        .put("message", (message ?: "").take(240))
                        .put("count", 1)
                        .put("key", "$kind|${meta["trackId"]}|${meta["httpStatus"]}|$level")
                    if (meta["trackId"] != null) compact.put("trackId", meta["trackId"].toString())
                    if (meta["httpStatus"] is Number) compact.put("http", (meta["httpStatus"] as Number).toInt())
                    if (meta["errorCode"] is Number) compact.put("code", (meta["errorCode"] as Number).toInt())
                    TelemetryBuffer.enqueue(ctx, compact)
                }
            }
        }

        if (blockingMs > 0L) {
            // Crash fatal : POST sync avant kill process
            runCatching {
                runBlocking {
                    withTimeoutOrNull(blockingMs) { work() }
                }
            }
        } else {
            scope.launch { work() }
        }
    }

    fun reportCrash(t: Throwable, fatal: Boolean) {
        val sw = java.io.StringWriter()
        t.printStackTrace(java.io.PrintWriter(sw))
        report(
            level = if (fatal) "fatal" else "error",
            kind = if (fatal) "android.crash" else "android.coroutine",
            message = t.message ?: t.javaClass.name,
            stack = sw.toString(),
            meta = mapOf(
                "fatal" to fatal,
                "breadcrumbs" to AppLog.breadcrumbSnapshot(),
                "recentLogs" to AppLog.recentLogText(40_000),
                "session" to AppLog.sessionId(),
            ),
            force = true,
            blockingMs = if (fatal) 1_400L else 0L,
        )
    }

    fun reportPlayerError(
        code: Int,
        trackId: String,
        networkish: Boolean,
        local: Boolean,
        streak: Int,
        detail: String? = null,
        httpStatus: Int? = null,
    ) {
        val blob = detail.orEmpty()
        val http = httpStatus ?: extractHttpStatus(blob)
        val serious = isSeriousStreamFailure(code, http, blob, local)
        val eofMid =
            blob.contains("EOFException", ignoreCase = true) &&
                !local &&
                (http == null || http < 400)
        // EOF récupérable (troncature 1 MiB / cache) : pas de mail à chaque reprise.
        val level = when {
            serious || streak >= 3 -> "error"
            eofMid && streak < 3 -> "warn"
            else -> "error"
        }
        val diag = diagnosePlayerError(code, trackId, networkish, local, streak, http, blob)
        val trackMeta = runCatching {
            ovh.delhomme.ytmusic.player.PlaybackService.Holder.queue.firstOrNull { it.id == trackId }
        }.getOrNull()
        val artistLabel = trackMeta?.artistLine()?.takeIf { it != "Artiste" }.orEmpty()
        report(
            level = level,
            kind = "android.player",
            message = buildString {
                append("onPlayerError code=$code")
                if (http != null) append(" http=$http")
                append(" id=$trackId streak=$streak network=$networkish local=$local")
                if (trackMeta != null) {
                    append('\n')
                    append(trackMeta.title)
                    if (artistLabel.isNotBlank()) append(" — ").append(artistLabel)
                }
                append("\n\nPré-diagnostic Android : ")
                append(diag)
            },
            stack = detail,
            meta = mapOf(
                "errorCode" to code,
                "httpStatus" to http,
                "trackId" to trackId,
                "title" to trackMeta?.title,
                "artist" to artistLabel.ifBlank { null },
                "streak" to streak,
                "networkish" to networkish,
                "local" to local,
                "diagnosis" to diag,
                "serious" to serious,
                "eofMid" to eofMid,
                "recentLogs" to AppLog.recentLogText(12_000),
            ),
            force = level == "error",
        )
    }

    private fun extractHttpStatus(text: String): Int? {
        val m = Regex("Response code:\\s*(\\d{3})|HTTP\\s+(\\d{3})", RegexOption.IGNORE_CASE)
            .find(text) ?: return null
        return m.groupValues[1].ifBlank { m.groupValues[2] }.toIntOrNull()
    }

    private fun isSeriousStreamFailure(code: Int, http: Int?, blob: String, local: Boolean): Boolean {
        if (local) return true
        if (http != null && http >= 500) return true
        if (code == 2004 || code == 2002) return true
        return blob.contains("502") ||
            blob.contains("503") ||
            blob.contains("SocketTimeout", ignoreCase = true) ||
            blob.contains("Unable to resolve host", ignoreCase = true) ||
            blob.contains("UnknownHost", ignoreCase = true) ||
            blob.contains("connection abort", ignoreCase = true)
    }

    private fun diagnosePlayerError(
        code: Int,
        trackId: String,
        networkish: Boolean,
        local: Boolean,
        streak: Int,
        http: Int?,
        blob: String,
    ): String {
        val family = when {
            blob.contains("Unable to resolve host", ignoreCase = true) ||
                blob.contains("UnknownHost", ignoreCase = true) ->
                "DNS — hostname API non résolu (pas un bug codec)"
            http == 502 || blob.contains("Response code: 502") ->
                "HTTP 502 — le reverse proxy / API n’a pas pu servir /api/stream/$trackId (YouTube/IP datacenter ou upstream mort). ExoPlayer n’a jamais ouvert le flux."
            http == 503 || http == 504 ->
                "HTTP $http — gateway saturée ou timeout amont sur le stream"
            blob.contains("SocketTimeout", ignoreCase = true) || code == 2002 ->
                "Timeout ouverture flux — le serveur n’a pas renvoyé les en-têtes à temps (souvent le même incident que le 502)"
            blob.contains("connection abort", ignoreCase = true) ->
                "Socket abort — connexion coupée pendant l’open HTTP (proxy / YouTube / trop de DL en parallèle)"
            blob.contains("EOFException", ignoreCase = true) ->
                "EOF mid-flux (souvent ouverture tronquée ~1 MiB / cache Exo) — pas un 502 serveur"
            local ->
                "Fichier local illisible — purge et reprise stream"
            networkish ->
                "Erreur réseau lecteur (code Media3 $code) — source HTTP, pas le décodeur"
            else ->
                "Erreur lecteur (code $code)"
        }
        return "$family · streak=$streak · local=$local · http=${http ?: "—"}"
    }

    fun flushPending() {
        scope.launch {
            runCatching {
                mutex.withLock {
                    val container = runCatching { YtMusicApp.instance.container }.getOrNull()
                        ?: return@withLock
                    flushPendingLocked(container)
                }
            }
        }
    }

    private suspend fun flushPendingLocked(container: ovh.delhomme.ytmusic.data.AppContainer) {
        val ctx = YtMusicApp.instance
        if (TelemetryBuffer.pendingCount(ctx) <= 0) return
        val events = TelemetryBuffer.drain(ctx)
        if (events.isEmpty()) return
        runCatching {
            container.api.telemetryBatch(
                mapOf(
                    "events" to events,
                    "digest" to true,
                    "env" to container.apiEnvKind(),
                    "deviceId" to container.deviceId,
                ),
            )
        }.onFailure {
            events.forEach { ev ->
                val o = org.json.JSONObject()
                ev.forEach { (k, v) -> if (v != null) o.put(k, v) }
                TelemetryBuffer.enqueue(ctx, o)
            }
        }
    }
}
