package ovh.delhomme.ytmusic.data

import android.content.Context
import android.net.Uri
import com.squareup.moshi.Moshi
import com.squareup.moshi.Types
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
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
import java.io.RandomAccessFile
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

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
        // HTTP/2 RST fréquents sur proxy maison / CDN pendant la lecture → forcer h1
        .protocols(listOf(okhttp3.Protocol.HTTP_1_1))
        .retryOnConnectionFailure(true)
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
        if (ovh.delhomme.ytmusic.player.StreamPrefetcher.isStreamDown()) {
            return@withContext Result.failure(Exception("stream down — DL différé"))
        }
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
        repeat(3) { attempt ->
            if (ovh.delhomme.ytmusic.player.StreamPrefetcher.isStreamDown()) {
                return@withContext Result.failure(lastError ?: Exception("stream down"))
            }
            val forceSequential = attempt > 0
            val result = downloadOnce(track, streamUrl, onProgress, attempt, forceSequential)
            if (result.isSuccess) return@withContext result
            lastError = result.exceptionOrNull()
            val msg = lastError?.message.orEmpty()
            AppLog.w("offline", "DL retry ${attempt + 1} ${track.id}: $msg")
            if (msg.contains("HTTP 502") || msg.contains("HTTP 503") || msg.contains("HTTP 504")) {
                ovh.delhomme.ytmusic.player.StreamPrefetcher.markStreamDown(120_000L)
                return@withContext Result.failure(lastError ?: Exception("HTTP 5xx"))
            }
            kotlinx.coroutines.delay(1_500L * (attempt + 1) * (attempt + 1))
        }
        Result.failure(lastError ?: Exception("Échec téléchargement"))
    }

    private suspend fun downloadOnce(
        track: TrackDto,
        streamUrl: String,
        onProgress: ((Float) -> Unit)?,
        attempt: Int,
        forceSequential: Boolean = false,
    ): Result<File> {
        val dest = audioFile(track.id)
        val part = File(dir, "${track.id}.part")
        part.delete()
        return runCatching {
            kotlinx.coroutines.currentCoroutineContext().ensureActive()
            val probe = Request.Builder()
                .url(streamUrl)
                .header("Range", "bytes=0-0")
                .get()
                .build()
            val (total, ranged) = http.newCall(probe).execute().use { resp ->
                if (resp.code == 502 || resp.code == 503 || resp.code == 504) {
                    error("HTTP ${resp.code}")
                }
                if (!resp.isSuccessful && resp.code != 206) error("HTTP ${resp.code}")
                val lenHeader = resp.header("Content-Range")
                    ?.substringAfter('/')
                    ?.toLongOrNull()
                    ?.takeIf { it > 0 }
                    ?: resp.header("Content-Length")?.toLongOrNull()?.takeIf { it > 1 }
                    ?: -1L
                val accept = resp.code == 206 ||
                    resp.header("Accept-Ranges").orEmpty().contains("bytes", ignoreCase = true)
                lenHeader to accept
            }
            val metered = !NetworkMonitor.isUnmeteredPreferred(
                ovh.delhomme.ytmusic.YtMusicApp.instance,
            )
            // Parallel multi-Range : fragile si le proxy coupe mid-stream (« unexpected end of stream »)
            if (!forceSequential && ranged && total > 512 * 1024L && !metered) {
                downloadParallel(track, streamUrl, part, dest, total, onProgress, attempt)
            } else {
                downloadSequential(track, streamUrl, part, dest, onProgress, attempt)
            }
        }.onFailure {
            part.delete()
        }
    }

    private suspend fun downloadSequential(
        track: TrackDto,
        streamUrl: String,
        part: File,
        dest: File,
        onProgress: ((Float) -> Unit)?,
        attempt: Int,
    ): File {
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
                        kotlinx.coroutines.currentCoroutineContext().ensureActive()
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
            finalizeDownload(track, part, dest, total, readTotal, onProgress, attempt)
        }
        return dest
    }

    private suspend fun downloadParallel(
        track: TrackDto,
        streamUrl: String,
        part: File,
        dest: File,
        total: Long,
        onProgress: ((Float) -> Unit)?,
        attempt: Int,
    ): File {
        val chunks = 4
        val read = AtomicLong(0L)
        part.parentFile?.mkdirs()
        RandomAccessFile(part, "rw").use { raf ->
            raf.setLength(total)
            coroutineScope {
                val size = total / chunks
                (0 until chunks).map { i ->
                    async(Dispatchers.IO) {
                        val from = i * size
                        val to = if (i == chunks - 1) total - 1 else (from + size - 1)
                        val req = Request.Builder()
                            .url(streamUrl)
                            .header("Range", "bytes=$from-$to")
                            .get()
                            .build()
                        http.newCall(req).execute().use { resp ->
                            if (resp.code != 206 && !resp.isSuccessful) error("HTTP ${resp.code}")
                            val body = resp.body ?: error("Réponse vide")
                            val buf = ByteArray(64 * 1024)
                            var offset = from
                            body.byteStream().use { input ->
                                while (true) {
                                    kotlinx.coroutines.currentCoroutineContext().ensureActive()
                                    val n = input.read(buf)
                                    if (n < 0) break
                                    synchronized(raf) {
                                        raf.seek(offset)
                                        raf.write(buf, 0, n)
                                    }
                                    offset += n
                                    val soFar = read.addAndGet(n.toLong())
                                    if (soFar % (256 * 1024L) < n) {
                                        onProgress?.invoke((soFar.toFloat() / total).coerceIn(0.08f, 0.99f))
                                    }
                                }
                            }
                        }
                    }
                }.forEach { it.await() }
            }
        }
        finalizeDownload(track, part, dest, total, part.length(), onProgress, attempt)
        return dest
    }

    private suspend fun finalizeDownload(
        track: TrackDto,
        part: File,
        dest: File,
        total: Long,
        readTotal: Long,
        onProgress: ((Float) -> Unit)?,
        attempt: Int,
    ) {
        val minBytes = minBytesFor(track)
        if (part.length() < minBytes) {
            val got = part.length()
            part.delete()
            error("Fichier trop petit ($got < $minBytes) — stream incomplet")
        }
        if (total > 0 && readTotal < (total * 98 / 100)) {
            part.delete()
            error("Téléchargement tronqué ($readTotal / $total octets)")
        }
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
