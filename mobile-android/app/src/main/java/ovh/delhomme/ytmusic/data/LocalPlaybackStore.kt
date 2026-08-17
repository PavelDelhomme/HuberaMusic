package ovh.delhomme.ytmusic.data

import android.content.Context
import com.squareup.moshi.Moshi
import com.squareup.moshi.Types
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/**
 * Persistance locale file + position (survit force-stop / kill / coupure d’alimentation).
 * Prefs + fichier JSON (fsync) — indépendant de la sync multi-appareils.
 */
class LocalPlaybackStore(
    context: Context,
    moshi: Moshi = Moshi.Builder()
        .add(FlexibleStringAdapter())
        .add(KotlinJsonAdapterFactory())
        .build(),
) {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences("ytm_player", Context.MODE_PRIVATE)
    private val backupFile = File(appContext.filesDir, "local_playback.json")
    private val listType = Types.newParameterizedType(List::class.java, TrackDto::class.java)
    private val queueAdapter = moshi.adapter<List<TrackDto>>(listType)

    data class Snapshot(
        val queue: List<TrackDto>,
        val queueIndex: Int,
        val positionMs: Long,
        val userQueueEnd: Int,
        val queueTitle: String,
        val wasPlaying: Boolean,
        val savedAt: Long = 0L,
    )

    fun save(snapshot: Snapshot, durable: Boolean = false) {
        if (snapshot.queue.isEmpty()) {
            clear()
            return
        }
        val playable = snapshot.queue.filter { it.isPlayable() }
        if (playable.isEmpty()) {
            clear()
            return
        }
        val idx = snapshot.queueIndex.coerceIn(0, playable.lastIndex)
        val queueJson = queueAdapter.toJson(playable.take(120))
        val savedAt = System.currentTimeMillis()
        runCatching {
            val ed = prefs.edit()
                .putString(KEY_QUEUE, queueJson)
                .putInt(KEY_INDEX, idx)
                .putLong(KEY_POS, snapshot.positionMs.coerceAtLeast(0L))
                .putInt(KEY_USER_END, snapshot.userQueueEnd.coerceIn(0, playable.size))
                .putString(KEY_TITLE, snapshot.queueTitle.ifBlank { "File d'attente" })
                .putBoolean(KEY_PLAYING, snapshot.wasPlaying)
                .putLong(KEY_SAVED_AT, savedAt)
            if (durable) ed.commit() else ed.apply()
        }
        if (durable) {
            runCatching {
                val blob = JSONObject()
                    .put("queue", queueJson)
                    .put("index", idx)
                    .put("pos", snapshot.positionMs.coerceAtLeast(0L))
                    .put("userEnd", snapshot.userQueueEnd.coerceIn(0, playable.size))
                    .put("title", snapshot.queueTitle.ifBlank { "File d'attente" })
                    .put("playing", snapshot.wasPlaying)
                    .put("savedAt", savedAt)
                    .toString()
                val tmp = File(appContext.filesDir, "local_playback.json.tmp")
                FileOutputStream(tmp).use { fos ->
                    fos.write(blob.toByteArray())
                    fos.flush()
                    fos.fd.sync()
                }
                if (!tmp.renameTo(backupFile)) {
                    tmp.copyTo(backupFile, overwrite = true)
                    tmp.delete()
                }
            }
        }
    }

    fun load(): Snapshot? {
        val fromPrefs = loadPrefs()
        val fromFile = loadFile()
        return when {
            fromPrefs == null -> fromFile
            fromFile == null -> fromPrefs
            fromFile.savedAt > fromPrefs.savedAt -> fromFile
            else -> fromPrefs
        }
    }

    private fun loadPrefs(): Snapshot? {
        val raw = prefs.getString(KEY_QUEUE, null) ?: return null
        return snapshotFrom(raw, prefs.getInt(KEY_INDEX, 0), prefs.getLong(KEY_POS, 0L),
            prefs.getInt(KEY_USER_END, 0), prefs.getString(KEY_TITLE, null),
            prefs.getBoolean(KEY_PLAYING, false), prefs.getLong(KEY_SAVED_AT, 0L))
    }

    private fun loadFile(): Snapshot? {
        if (!backupFile.isFile || backupFile.length() < 8) return null
        return runCatching {
            val o = JSONObject(backupFile.readText())
            snapshotFrom(
                o.optString("queue"),
                o.optInt("index"),
                o.optLong("pos"),
                o.optInt("userEnd"),
                o.optString("title"),
                o.optBoolean("playing"),
                o.optLong("savedAt"),
            )
        }.getOrNull()
    }

    private fun snapshotFrom(
        raw: String?,
        index: Int,
        pos: Long,
        userEnd: Int,
        title: String?,
        playing: Boolean,
        savedAt: Long,
    ): Snapshot? {
        val queue = runCatching { queueAdapter.fromJson(raw.orEmpty()).orEmpty() }
            .getOrDefault(emptyList())
            .filter { it.isPlayable() }
        if (queue.isEmpty()) return null
        val idx = index.coerceIn(0, queue.lastIndex)
        return Snapshot(
            queue = queue,
            queueIndex = idx,
            positionMs = pos.coerceAtLeast(0L),
            userQueueEnd = userEnd.coerceIn(0, queue.size).let { if (it <= 0) queue.size else it },
            queueTitle = title?.ifBlank { null } ?: "File d'attente",
            wasPlaying = playing,
            savedAt = savedAt,
        )
    }

    fun clear() {
        prefs.edit()
            .remove(KEY_QUEUE)
            .remove(KEY_INDEX)
            .remove(KEY_POS)
            .remove(KEY_USER_END)
            .remove(KEY_TITLE)
            .remove(KEY_PLAYING)
            .remove(KEY_SAVED_AT)
            .commit()
        runCatching { backupFile.delete() }
    }

    companion object {
        private const val KEY_QUEUE = "local_queue_json"
        private const val KEY_INDEX = "local_queue_index"
        private const val KEY_POS = "local_position_ms"
        private const val KEY_USER_END = "local_user_queue_end"
        private const val KEY_TITLE = "local_queue_title"
        private const val KEY_PLAYING = "local_was_playing"
        private const val KEY_SAVED_AT = "local_saved_at"
    }
}
