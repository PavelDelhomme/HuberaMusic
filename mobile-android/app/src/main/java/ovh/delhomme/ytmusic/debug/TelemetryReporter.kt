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
                }
            }.onFailure { e ->
                AppLog.w("telemetry", "upload failed: ${e.message}")
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
    ) {
        // Ne spam pas les glitches réseau streak=1
        if (networkish && streak < 2 && !local) return
        report(
            level = "error",
            kind = "android.player",
            message = "onPlayerError code=$code id=$trackId streak=$streak network=$networkish local=$local",
            stack = detail,
            meta = mapOf(
                "errorCode" to code,
                "trackId" to trackId,
                "streak" to streak,
                "networkish" to networkish,
                "local" to local,
                "recentLogs" to AppLog.recentLogText(12_000),
            ),
            force = streak >= 3,
        )
    }
}
