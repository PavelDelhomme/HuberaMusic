package ovh.delhomme.ytmusic.debug

import android.content.Context
import org.json.JSONObject
import ovh.delhomme.ytmusic.BuildConfig
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Trace locale persistante de lecture : skips, buffering, crashes,
 * titres qui restent en bibliothèque après un échec.
 *
 * Fichier : `files/ytm-logs/playback-trace.jsonl` (rotation ~1,5 Mo).
 * Visible dans Réglages → Trace, et remonté par paquets via `/api/telemetry`.
 */
object PlaybackTrace {
    private const val FILE = "playback-trace.jsonl"
    private const val PREV = "playback-trace.prev.jsonl"
    private const val MAX_BYTES = 1_500_000L
    private const val STUCK_SKIPS = 2

    private val lock = Any()
    private val writer = Executors.newSingleThreadExecutor { r ->
        Thread(r, "ytm-playback-trace").apply { isDaemon = true }
    }
    private var dir: File? = null
    private val skipCounts = HashMap<String, Int>()
    private val lastTitle = HashMap<String, String>()

    fun init(context: Context) {
        dir = File(context.applicationContext.filesDir, "ytm-logs").also { it.mkdirs() }
        event(
            "boot",
            extra = mapOf(
                "app" to BuildConfig.VERSION_NAME,
                "code" to BuildConfig.VERSION_CODE,
                "session" to AppLog.sessionId(),
            ),
        )
    }

    fun play(trackId: String, title: String? = null, artist: String? = null) {
        if (title != null) lastTitle[trackId] = listOfNotNull(title, artist).joinToString(" — ")
        event("play", trackId = trackId, title = title, artist = artist)
    }

    fun skip(
        trackId: String,
        title: String? = null,
        artist: String? = null,
        reason: String,
        extra: Map<String, Any?> = emptyMap(),
    ) {
        val n = synchronized(lock) {
            val next = (skipCounts[trackId] ?: 0) + 1
            skipCounts[trackId] = next
            next
        }
        if (title != null) lastTitle[trackId] = listOfNotNull(title, artist).joinToString(" — ")
        event(
            "skip",
            trackId = trackId,
            title = title,
            artist = artist,
            extra = extra + mapOf("reason" to reason, "skipCount" to n, "stuck" to (n >= STUCK_SKIPS)),
        )
        if (n >= STUCK_SKIPS) {
            event(
                "stuck_in_library",
                trackId = trackId,
                title = title ?: lastTitle[trackId],
                extra = mapOf("skipCount" to n, "reason" to reason),
            )
        }
    }

    fun buffer(trackId: String, title: String? = null, ms: Long = 0L) {
        event("buffer", trackId = trackId, title = title, extra = mapOf("ms" to ms))
    }

    fun crash(message: String, fatal: Boolean) {
        event("crash", extra = mapOf("message" to message.take(500), "fatal" to fatal))
    }

    fun libraryToggle(trackId: String, title: String?, wantSaved: Boolean, ok: Boolean, error: String? = null) {
        event(
            if (ok) "library_ok" else "library_fail",
            trackId = trackId,
            title = title,
            extra = mapOf(
                "wantSaved" to wantSaved,
                "ok" to ok,
                "error" to (error ?: ""),
                "notDeleted" to (!ok && !wantSaved),
            ),
        )
    }

    fun event(
        kind: String,
        trackId: String? = null,
        title: String? = null,
        artist: String? = null,
        extra: Map<String, Any?> = emptyMap(),
    ) {
        val obj = JSONObject()
            .put("ts", System.currentTimeMillis())
            .put("at", ts())
            .put("kind", kind)
            .put("session", AppLog.sessionId())
            .put("app", BuildConfig.VERSION_NAME)
        if (!trackId.isNullOrBlank()) obj.put("trackId", trackId)
        if (!title.isNullOrBlank()) obj.put("title", title)
        if (!artist.isNullOrBlank()) obj.put("artist", artist)
        for ((k, v) in extra) {
            if (v != null) obj.put(k, v)
        }
        val line = obj.toString()
        writer.execute {
            synchronized(lock) {
                val d = dir ?: return@synchronized
                d.mkdirs()
                val f = File(d, FILE)
                if (f.length() > MAX_BYTES) {
                    val bak = File(d, PREV)
                    bak.delete()
                    f.renameTo(bak)
                }
                f.appendText(line + "\n")
            }
        }
        if (kind == "skip" || kind == "crash" || kind == "stuck_in_library" || kind == "library_fail") {
            AppLog.w("trace", "$kind ${trackId ?: ""} ${title ?: ""} ${extra["reason"] ?: extra["error"] ?: ""}".trim())
        }
        // skip déjà envoyé via android.player.load_skip — on remonte seulement
        // crash, bibliothèque KO, et titres coincés (toujours pas effacés).
        if (kind == "crash" || kind == "stuck_in_library" || kind == "library_fail") {
            runCatching {
                TelemetryReporter.report(
                    level = if (kind == "crash") "error" else "warn",
                    kind = "android.playback.trace",
                    message = "$kind ${title ?: trackId ?: ""}",
                    meta = mapOf(
                        "traceKind" to kind,
                        "trackId" to trackId,
                        "title" to title,
                        "artist" to artist,
                    ) + extra,
                    force = kind == "crash" || kind == "stuck_in_library",
                )
            }
        }
    }

    fun recentText(maxChars: Int = 80_000): String {
        val d = dir ?: return "(trace indisponible)"
        val f = File(d, FILE)
        val prev = File(d, PREV)
        val raw = buildString {
            if (prev.isFile) append(prev.readText())
            if (f.isFile) append(f.readText())
        }
        if (raw.isBlank()) return "(aucune trace encore)"
        val slice = if (raw.length <= maxChars) raw else raw.takeLast(maxChars)
        return buildString {
            appendLine("=== Titres coincés (skips ≥ $STUCK_SKIPS, toujours en file) ===")
            appendLine(stuckSummary().ifBlank { "(aucun)" })
            appendLine()
            appendLine("=== Trace récente (plus récent en haut) ===")
            append(slice.lineSequence().toList().asReversed().joinToString("\n"))
        }
    }

    fun stuckSummary(): String {
        val stuck = synchronized(lock) {
            skipCounts.entries.filter { it.value >= STUCK_SKIPS }.sortedByDescending { it.value }
        }
        if (stuck.isEmpty()) return ""
        return stuck.joinToString("\n") { (id, n) ->
            val label = lastTitle[id] ?: id
            "$n skips · $label · $id"
        }
    }

    private fun ts(): String =
        SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date())
}
