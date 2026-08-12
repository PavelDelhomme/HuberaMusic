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

    /** Handler coroutines : log + ne propage pas (évite crash silencieux mal géré). */
    fun coroutineHandler(tag: String = "coroutine"): CoroutineExceptionHandler =
        CoroutineExceptionHandler { _: CoroutineContext, t: Throwable ->
            AppLog.e(tag, "exception non catchée", t)
            AppLog.crash(t, fatal = false)
        }
}
