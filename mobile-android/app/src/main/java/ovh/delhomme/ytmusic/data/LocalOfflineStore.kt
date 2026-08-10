package ovh.delhomme.ytmusic.data

import android.content.Context
import android.net.Uri
import com.squareup.moshi.Moshi
import com.squareup.moshi.Types
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Téléchargements vraiment locaux (fichiers sur l’appareil), lisibles hors-ligne
 * même si l’API est injoignable — calqué sur le web `offlineCache.ts`.
 */
class LocalOfflineStore(
    context: Context,
    moshi: Moshi,
) {
    private val dir = File(context.applicationContext.filesDir, "offline").also { it.mkdirs() }
    private val metaFile = File(dir, "meta.json")
    private val mutex = Mutex()
    private val mapAdapter = moshi.adapter<Map<String, TrackDto>>(
        Types.newParameterizedType(Map::class.java, String::class.java, TrackDto::class.java),
    )

    private val _revision = MutableStateFlow(0L)
    /** Incrémente à chaque DL / suppression — la biblio s’abonne pour rafraîchir. */
    val revision: StateFlow<Long> = _revision.asStateFlow()

    private fun bump() {
        _revision.value = _revision.value + 1L
    }

    private val http = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.MINUTES)
        .writeTimeout(60, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    fun audioFile(trackId: String): File = File(dir, "$trackId.m4a")

    fun has(trackId: String): Boolean {
        val f = audioFile(trackId)
        return f.isFile && f.length() > 8_000L
    }

    fun playUri(trackId: String): Uri? {
        if (!has(trackId)) return null
        return Uri.fromFile(audioFile(trackId))
    }

    fun listIds(): List<String> = synchronized(this) {
        dir.listFiles()
            ?.mapNotNull { f ->
                val name = f.name
                if (!name.endsWith(".m4a")) return@mapNotNull null
                val id = name.removeSuffix(".m4a")
                id.takeIf { f.length() > 8_000L }
            }
            ?.sorted()
            .orEmpty()
    }

    fun listTracks(): List<TrackDto> = synchronized(this) {
        val meta = readMetaUnlocked()
        listIds().map { id ->
            meta[id] ?: TrackDto(id = id, title = id, type = "song")
        }
    }

    suspend fun remove(trackId: String) = withContext(Dispatchers.IO) {
        mutex.withLock {
            audioFile(trackId).delete()
            File(dir, "$trackId.part").delete()
            val meta = readMetaUnlocked().toMutableMap()
            meta.remove(trackId)
            writeMetaUnlocked(meta)
            bump()
        }
    }

    /**
     * Télécharge le flux **audio** (`/api/stream/{id}`) vers le stockage local.
     * Mutex uniquement pour meta/rename — le HTTP reste libre (progress UI).
     */
    suspend fun download(
        track: TrackDto,
        streamUrl: String,
        onProgress: ((Float) -> Unit)? = null,
    ): Result<File> = withContext(Dispatchers.IO) {
        val dest = audioFile(track.id)
        if (dest.isFile && dest.length() > 8_000L) {
            mutex.withLock {
                upsertMetaUnlocked(track)
                bump()
            }
            onProgress?.invoke(1f)
            return@withContext Result.success(dest)
        }
        val part = File(dir, "${track.id}.part")
        part.delete()
        runCatching {
            val req = Request.Builder().url(streamUrl).get().build()
            http.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) error("HTTP ${resp.code}")
                val body = resp.body ?: error("Réponse vide")
                val total = body.contentLength().takeIf { it > 0 } ?: -1L
                var readTotal = 0L
                body.byteStream().use { input ->
                    part.outputStream().use { output ->
                        val buf = ByteArray(64 * 1024)
                        var lastPct = -1
                        var lastByteReport = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            output.write(buf, 0, n)
                            readTotal += n
                            if (total > 0) {
                                val pct = ((readTotal * 100) / total).toInt().coerceIn(0, 99)
                                if (pct != lastPct) {
                                    lastPct = pct
                                    onProgress?.invoke(pct / 100f)
                                }
                            } else if (readTotal - lastByteReport >= 256 * 1024L) {
                                lastByteReport = readTotal
                                val soft = (0.08f + (readTotal / (1024f * 1024f)) * 0.04f).coerceAtMost(0.92f)
                                onProgress?.invoke(soft)
                            }
                        }
                        output.flush()
                    }
                }
                if (part.length() < 8_000L) {
                    part.delete()
                    error("Fichier trop petit — stream incomplet")
                }
                mutex.withLock {
                    if (dest.exists()) dest.delete()
                    if (!part.renameTo(dest)) {
                        part.copyTo(dest, overwrite = true)
                        part.delete()
                    }
                    upsertMetaUnlocked(track)
                    bump()
                }
                onProgress?.invoke(1f)
                dest
            }
        }.onFailure {
            part.delete()
        }
    }

    private fun readMetaUnlocked(): Map<String, TrackDto> {
        if (!metaFile.isFile) return emptyMap()
        return runCatching {
            mapAdapter.fromJson(metaFile.readText()) ?: emptyMap()
        }.getOrDefault(emptyMap())
    }

    private fun writeMetaUnlocked(map: Map<String, TrackDto>) {
        metaFile.writeText(mapAdapter.toJson(map))
    }

    private fun upsertMetaUnlocked(track: TrackDto) {
        val meta = readMetaUnlocked().toMutableMap()
        meta[track.id] = track
        writeMetaUnlocked(meta)
    }
}
