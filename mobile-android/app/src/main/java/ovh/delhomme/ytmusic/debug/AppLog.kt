package ovh.delhomme.ytmusic.debug

import android.content.Context
import android.os.Build
import android.util.Log
import ovh.delhomme.ytmusic.BuildConfig
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedDeque
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Journal fichier + breadcrumbs pour diagnostiquer les plantages en debug.
 *
 * Emplacement : `files/ytm-logs/` (récupérable via `make android-logs` / run-as).
 */
object AppLog {
    private const val TAG = "YtMusic"
    private const val DIR = "ytm-logs"
    private const val APP_LOG = "app.log"
    private const val LAST_CRASH = "last-crash.txt"
    private const val MAX_APP_BYTES = 1_500_000L
    private const val MAX_CRASHES = 12
    private const val BREADCRUMB_CAP = 80

    private val lock = Any()
    private val ready = AtomicBoolean(false)
    private val writer = Executors.newSingleThreadExecutor { r ->
        Thread(r, "ytm-applog").apply { isDaemon = true }
    }
    private val breadcrumbs = ConcurrentLinkedDeque<String>()
    private var filesDir: File? = null
    private var sessionId: String = ""

    fun init(context: Context) {
        if (!ready.compareAndSet(false, true)) return
        filesDir = File(context.applicationContext.filesDir, DIR).also { it.mkdirs() }
        sessionId = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        i(
            "boot",
            "session=$sessionId sdk=${Build.VERSION.SDK_INT} " +
                "device=${Build.MANUFACTURER} ${Build.MODEL} " +
                "app=${BuildConfig.VERSION_NAME}(${BuildConfig.VERSION_CODE}) " +
                "api=${BuildConfig.API_BASE_URL} debug=${BuildConfig.DEBUG}",
        )
    }

    fun breadcrumb(event: String, detail: String = "") {
        val line = ts() + " · " + event + if (detail.isNotBlank()) " · $detail" else ""
        breadcrumbs.addLast(line)
        while (breadcrumbs.size > BREADCRUMB_CAP) breadcrumbs.pollFirst()
        d("crumb", "$event ${detail.take(160)}".trim())
    }

    fun d(tag: String, msg: String) = write("D", tag, msg, null)

    fun i(tag: String, msg: String) = write("I", tag, msg, null)

    fun w(tag: String, msg: String, t: Throwable? = null) = write("W", tag, msg, t)

    fun e(tag: String, msg: String, t: Throwable? = null) = write("E", tag, msg, t)

    fun sessionId(): String = sessionId

    fun breadcrumbSnapshot(): List<String> = breadcrumbs.toList()

    fun crash(t: Throwable, fatal: Boolean = true) {
        val sw = StringWriter()
        t.printStackTrace(PrintWriter(sw))
        val body = buildString {
            appendLine("=== PLM crash ${ts()} fatal=$fatal ===")
            appendLine("session=$sessionId")
            appendLine("sdk=${Build.VERSION.SDK_INT} ${Build.MANUFACTURER} ${Build.MODEL}")
            appendLine("app=${BuildConfig.VERSION_NAME} api=${BuildConfig.API_BASE_URL}")
            appendLine()
            appendLine("--- breadcrumbs ---")
            breadcrumbs.forEach { appendLine(it) }
            appendLine()
            appendLine("--- stack ---")
            appendLine(sw.toString())
        }
        e("crash", t.message ?: t.javaClass.simpleName, t)
        // Sync avant kill process (writer async trop lent pour fatal)
        synchronized(lock) {
            val dir = filesDir
            if (dir != null) {
                runCatching {
                    dir.mkdirs()
                    File(dir, LAST_CRASH).writeText(body)
                    val name = "crash-$sessionId-${System.currentTimeMillis()}.txt"
                    File(dir, name).writeText(body)
                    pruneCrashes(dir)
                }
            }
        }
        runCatching { TelemetryReporter.reportCrash(t, fatal) }
    }

    fun logDir(): File? = filesDir

    fun lastCrashText(): String {
        val f = filesDir?.let { File(it, LAST_CRASH) } ?: return "(aucun crash enregistré)"
        return if (f.isFile) f.readText() else "(aucun crash enregistré)"
    }

    fun recentLogText(maxChars: Int = 120_000, newestFirst: Boolean = true): String {
        val f = filesDir?.let { File(it, APP_LOG) } ?: return "(logs indisponibles)"
        if (!f.isFile) return "(fichier app.log vide)"
        val text = f.readText()
        val slice = if (text.length <= maxChars) text else text.takeLast(maxChars)
        if (!newestFirst) return slice
        // Plus récent en haut (le fichier est chronologique croissant)
        return slice.lineSequence().toList().asReversed().joinToString("\n")
    }

    fun exportBundle(): String {
        return buildString {
            appendLine("=== PLM debug export ${ts()} ===")
            appendLine("session=$sessionId")
            appendLine()
            appendLine("--- last crash ---")
            appendLine(lastCrashText())
            appendLine()
            appendLine("--- breadcrumbs ---")
            breadcrumbs.forEach { appendLine(it) }
            appendLine()
            appendLine("--- app.log (tail) ---")
            appendLine(recentLogText())
        }
    }

    fun clearLogs() {
        writer.execute {
            synchronized(lock) {
                val dir = filesDir ?: return@synchronized
                dir.listFiles()?.forEach { it.delete() }
                breadcrumbs.clear()
            }
        }
        i("boot", "logs cleared")
    }

    private fun write(level: String, tag: String, msg: String, t: Throwable?) {
        val line = "${ts()} $level/$tag: $msg" +
            if (t != null) " :: ${t.javaClass.simpleName}: ${t.message}" else ""
        when (level) {
            "E" -> Log.e(TAG, "$tag: $msg", t)
            "W" -> Log.w(TAG, "$tag: $msg", t)
            "I" -> if (BuildConfig.DEBUG) Log.i(TAG, "$tag: $msg")
            else -> if (BuildConfig.DEBUG) Log.d(TAG, "$tag: $msg")
        }
        // En release : disque seulement pour W/E (+ crash via crash())
        if (!BuildConfig.DEBUG && level != "E" && level != "W") return
        if (!ready.get()) return
        writer.execute {
            synchronized(lock) {
                val dir = filesDir ?: return@synchronized
                dir.mkdirs()
                val file = File(dir, APP_LOG)
                if (file.length() > MAX_APP_BYTES) rotate(file)
                file.appendText(line + "\n")
                if (t != null) {
                    val sw = StringWriter()
                    t.printStackTrace(PrintWriter(sw))
                    file.appendText(sw.toString() + "\n")
                }
            }
        }
    }

    private fun rotate(file: File) {
        val bak = File(file.parentFile, "app.prev.log")
        bak.delete()
        file.renameTo(bak)
    }

    private fun pruneCrashes(dir: File) {
        val crashes = dir.listFiles { f -> f.name.startsWith("crash-") && f.name.endsWith(".txt") }
            ?.sortedByDescending { it.lastModified() }
            .orEmpty()
        crashes.drop(MAX_CRASHES).forEach { it.delete() }
    }

    private fun ts(): String =
        SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date())
}
