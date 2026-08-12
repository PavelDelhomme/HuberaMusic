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
import ovh.delhomme.ytmusic.debug.AppLog
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

    init {
        // Nettoie les .part orphelins (kill app / cancel mid-download)
        dir.listFiles()?.forEach { f ->
            if (f.name.endsWith(".part")) f.delete()
        }
    }

    fun audioFile(trackId: String): File = File(dir, "$trackId.m4a")

    fun has(trackId: String): Boolean {
        val f = audioFile(trackId)
        if (!f.isFile) return false
        val meta = synchronized(this) { readMetaUnlocked()[trackId] }
        return isFileComplete(f, meta)
    }

    fun playUri(trackId: String): Uri? {
        if (!has(trackId)) return null
        return Uri.fromFile(audioFile(trackId))
    }

    fun listIds(): List<String> = synchronized(this) {
        val meta = readMetaUnlocked()
        dir.listFiles()
            ?.mapNotNull { f ->
                if (!f.name.endsWith(".m4a")) return@mapNotNull null
                val id = f.name.removeSuffix(".m4a")
                if (!isFileComplete(f, meta[id])) {
                    // Purge les tronqués (évite fins anticipées hors-ligne)
                    AppLog.w("offline", "purge incomplet $id size=${f.length()}")
                    f.delete()
                    return@mapNotNull null
                }
                id
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
            sizeHintFile(trackId).delete()
            val meta = readMetaUnlocked().toMutableMap()
            meta.remove(trackId)
            writeMetaUnlocked(meta)
            bump()
        }
    }

    /**
     * Télécharge le flux **audio** (`/api/stream/{id}`) vers le stockage local.
     * Vérifie Content-Length / taille min (évite les .m4a tronqués qui coupent la lecture).
     */
    suspend fun download(
        track: TrackDto,
        streamUrl: String,
        onProgress: ((Float) -> Unit)? = null,
    ): Result<File> = withContext(Dispatchers.IO) {
        val dest = audioFile(track.id)
        if (dest.isFile && isFileComplete(dest, track)) {
            mutex.withLock {
                upsertMetaUnlocked(track)
                bump()
            }
            onProgress?.invoke(1f)
            return@withContext Result.success(dest)
        }
        var lastError: Throwable? = null
        repeat(2) { attempt ->
            val result = downloadOnce(track, streamUrl, onProgress, attempt)
            if (result.isSuccess) return@withContext result
            lastError = result.exceptionOrNull()
            AppLog.w("offline", "DL retry ${attempt + 1} ${track.id}: ${lastError?.message}")
        }
        Result.failure(lastError ?: Exception("Échec téléchargement"))
    }

    private suspend fun downloadOnce(
        track: TrackDto,
        streamUrl: String,
        onProgress: ((Float) -> Unit)?,
        attempt: Int,
    ): Result<File> {
        val dest = audioFile(track.id)
        val part = File(dir, "${track.id}.part")
        part.delete()
        return runCatching {
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
                val minBytes = minBytesFor(track)
                if (part.length() < minBytes) {
                    part.delete()
                    error("Fichier trop petit (${part.length()} < $minBytes) — stream incomplet")
                }
                if (total > 0 && readTotal < (total * 98 / 100)) {
                    part.delete()
                    error("Téléchargement tronqué ($readTotal / $total octets)")
                }
                // Persiste meta + taille attendue
                mutex.withLock {
                    if (dest.exists()) dest.delete()
                    if (!part.renameTo(dest)) {
                        part.copyTo(dest, overwrite = true)
                        part.delete()
                    }
                    upsertMetaUnlocked(track)
                    writeSizeHint(track.id, if (total > 0) total else dest.length())
                    bump()
                }
                onProgress?.invoke(1f)
                AppLog.i("offline", "DL ok ${track.id} ${dest.length()}b attempt=$attempt")
                dest
            }
        }.onFailure {
            part.delete()
        }
    }

    private fun sizeHintFile(trackId: String) = File(dir, "$trackId.size")

    private fun writeSizeHint(trackId: String, bytes: Long) {
        runCatching { sizeHintFile(trackId).writeText(bytes.toString()) }
    }

    private fun readSizeHint(trackId: String): Long? =
        runCatching { sizeHintFile(trackId).readText().trim().toLong() }.getOrNull()?.takeIf { it > 0 }

    private fun isFileComplete(file: File, track: TrackDto?): Boolean {
        if (!file.isFile) return false
        val len = file.length()
        val minBytes = minBytesFor(track)
        if (len < minBytes) return false
        val hinted = readSizeHint(file.nameWithoutExtension)
        if (hinted != null && hinted > minBytes && len < hinted * 98 / 100) return false
        return true
    }

    /** ~96 kb/s floor × durée, ou 96 Ko minimum absolu. */
    private fun minBytesFor(track: TrackDto?): Long {
        val sec = track?.durationMsOrNull()?.div(1000)?.toInt()
            ?: track?.durationSeconds
            ?: 0
        if (sec > 0) return maxOf(96_000L, sec * 12_000L)
        return 96_000L
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
