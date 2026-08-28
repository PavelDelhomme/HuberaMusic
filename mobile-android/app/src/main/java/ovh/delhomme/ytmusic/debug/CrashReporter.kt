package ovh.delhomme.ytmusic.debug

import android.content.Context
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlin.coroutines.CoroutineContext

object CrashReporter {
    private var previous: Thread.UncaughtExceptionHandler? = null

    fun install(context: Context) {
        AppLog.init(context.applicationContext)
        if (previous != null) return
        previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            val soft = isSoftNetworkFailure(throwable)
            if (soft) {
                // Ne pas tuer l’app ni mail « fatal » pour timeout/DNS offline — circuit-breaker.
                runCatching {
                    AppLog.e("crash", "uncaught soft network — swallowed", throwable)
                    ovh.delhomme.ytmusic.player.StreamPrefetcher.markStreamDown(180_000L)
                    ovh.delhomme.ytmusic.YtMusicApp.instance.container.downloadManager.cancelAll()
                    TelemetryReporter.report(
                        level = "warn",
                        kind = "android.offline-soft",
                        message = throwable.message ?: throwable.javaClass.simpleName,
                        stack = throwable.stackTraceToString().take(4_000),
                        force = false,
                    )
                }
                return@setDefaultUncaughtExceptionHandler
            }
            runCatching { AppLog.crash(throwable, fatal = true) }
            // Sync disque déjà fait ; POST télémétrie sync (~1.4s) dans AppLog.crash
            try {
                Thread.sleep(200)
            } catch (_: InterruptedException) {
            }
            previous?.uncaughtException(thread, throwable)
        }
        AppLog.i("crash", "UncaughtExceptionHandler installé")
    }

    fun coroutineHandler(tag: String = "coroutine"): CoroutineExceptionHandler =
        CoroutineExceptionHandler { _: CoroutineContext, t: Throwable ->
            // Timeouts / DNS pendant offline ou warm : jamais « fatal » mail — stream down.
            val soft = isSoftNetworkFailure(t)
            AppLog.e(tag, "exception non catchée${if (soft) " (réseau soft)" else ""}", t)
            if (soft) {
                runCatching {
                    ovh.delhomme.ytmusic.player.StreamPrefetcher.markStreamDown(180_000L)
                    ovh.delhomme.ytmusic.YtMusicApp.instance.container.downloadManager.cancelAll()
                }
                TelemetryReporter.report(
                    level = "warn",
                    kind = "android.offline-soft",
                    message = t.message ?: t.javaClass.simpleName,
                    stack = t.stackTraceToString().take(4_000),
                    force = false,
                )
            } else {
                AppLog.crash(t, fatal = false)
            }
        }

    private fun isSoftNetworkFailure(t: Throwable): Boolean {
        var cur: Throwable? = t
        while (cur != null) {
            if (cur is java.net.SocketTimeoutException) return true
            if (cur is java.net.UnknownHostException) return true
            val m = cur.message.orEmpty()
            if (m.contains("timeout", ignoreCase = true)) return true
            if (m.contains("Unable to resolve host", ignoreCase = true)) return true
            if (m.contains("HTTP 502") || m.contains("HTTP 503") || m.contains("HTTP 504")) return true
            cur = cur.cause
        }
        return false
    }
}
