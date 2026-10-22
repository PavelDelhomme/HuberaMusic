package ovh.delhomme.ytmusic.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import coil.imageLoader
import java.io.File
import java.util.concurrent.Executors

/**
 * Pochettes déjà affichées (titre, album, artiste, mix).
 * Le fichier survit à la fermeture de l’app. On n’enregistre que ce qui a été vu.
 */
object CoverStore {
    const val MAX_FILES = 160
    private const val MIN_BYTES = 800
    private val io = Executors.newSingleThreadExecutor()

    fun directory(context: Context): File =
        File(context.applicationContext.filesDir, "cover-disk").apply { mkdirs() }

    fun peek(context: Context, id: String): File? = peek(directory(context), id)

    fun peek(dir: File, id: String): File? {
        val file = fileFor(dir, id) ?: return null
        if (!file.isFile || file.length() < MIN_BYTES) return null
        file.setLastModified(System.currentTimeMillis())
        return file
    }

    fun saveDrawable(context: Context, id: String, drawable: Drawable) {
        val software = raster(drawable) ?: return
        val dir = directory(context)
        io.execute {
            runCatching {
                val file = fileFor(dir, id) ?: return@execute
                val tmp = File(dir, "${file.name}.part")
                tmp.outputStream().use { out ->
                    if (!software.compress(Bitmap.CompressFormat.JPEG, 82, out)) return@execute
                }
                if (tmp.length() < MIN_BYTES) {
                    tmp.delete()
                    return@execute
                }
                if (!tmp.renameTo(file)) {
                    tmp.copyTo(file, overwrite = true)
                    tmp.delete()
                }
                evict(dir, MAX_FILES)
            }
            software.recycle()
        }
    }

    fun importCoilDisk(context: Context, id: String) {
        val dir = directory(context)
        io.execute {
            runCatching {
                val snap = context.applicationContext.imageLoader.diskCache?.openSnapshot("cover:$id")
                    ?: return@runCatching
                snap.use { opened ->
                    val bytes = opened.data.toFile().readBytes()
                    write(dir, id, bytes)
                }
            }
        }
    }

    fun write(dir: File, id: String, bytes: ByteArray): File? {
        if (bytes.size < MIN_BYTES) return null
        val file = fileFor(dir, id) ?: return null
        dir.mkdirs()
        file.writeBytes(bytes)
        evict(dir, MAX_FILES)
        return file
    }

    fun evict(dir: File, maxFiles: Int) {
        val files = dir.listFiles { f -> f.isFile && !f.name.endsWith(".part") } ?: return
        if (files.size <= maxFiles) return
        files.sortedBy { it.lastModified() }
            .take(files.size - maxFiles)
            .forEach { it.delete() }
    }

    /** Bitmap logiciel, y compris si Coil a rendu une image matérielle. */
    private fun raster(drawable: Drawable): Bitmap? {
        val source = (drawable as? BitmapDrawable)?.bitmap
        if (source != null && !source.isRecycled) {
            if (source.config != Bitmap.Config.HARDWARE) {
                return source.copy(Bitmap.Config.ARGB_8888, false)
            }
            val copy = Bitmap.createBitmap(source.width, source.height, Bitmap.Config.ARGB_8888)
            Canvas(copy).drawBitmap(source, 0f, 0f, null)
            return copy
        }
        val width = drawable.intrinsicWidth.takeIf { it > 1 } ?: 320
        val height = drawable.intrinsicHeight.takeIf { it > 1 } ?: 320
        val out = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(out)
        drawable.setBounds(0, 0, width, height)
        drawable.draw(canvas)
        return out
    }

    fun fileFor(dir: File, id: String): File? {
        val name = safeName(id) ?: return null
        return File(dir, name)
    }

    fun safeName(id: String): String? {
        val trimmed = id.trim()
        if (trimmed.isEmpty()) return null
        val clean = trimmed.replace(Regex("[^a-zA-Z0-9_-]"), "_")
        if (clean.length in 1..80) return "$clean.jpg"
        val hash = trimmed.hashCode().toUInt().toString(16)
        return "h$hash.jpg"
    }
}
