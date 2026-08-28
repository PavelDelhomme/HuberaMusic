package ovh.delhomme.ytmusic.data

import android.content.Context
import com.squareup.moshi.JsonClass
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import java.io.File
import java.io.FileOutputStream

/** Cache disque bibliothèque (fichier) — 14k titres ne rentrent pas dans SharedPreferences. */
class LibraryCacheStore(context: Context) {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val file = File(appContext.filesDir, "library_cache_v2.json")
    private val moshi = Moshi.Builder()
        .add(FlexibleStringAdapter())
        .add(KotlinJsonAdapterFactory())
        .build()
    private val adapter = moshi.adapter(CachedLibrary::class.java)

    fun read(): LibraryResponse? {
        val fromFile = runCatching {
            if (!file.exists() || file.length() < 32L) return@runCatching null
            adapter.fromJson(file.readText())?.toResponse()
        }.getOrNull()
        if (fromFile != null) return fromFile
        // Migration ancienne clé prefs (souvent tronquée / trop petite)
        val raw = prefs.getString(KEY, null)?.takeIf { it.isNotBlank() } ?: return null
        val legacy = runCatching { adapter.fromJson(raw) }.getOrNull()?.toResponse() ?: return null
        write(legacy)
        prefs.edit().remove(KEY).apply()
        return legacy
    }

    fun write(lib: LibraryResponse) {
        if (lib.songs.isEmpty() && lib.liked.isEmpty() && lib.albums.isEmpty()) return
        // Ne jamais écraser un snapshot plein avec un light=1
        if (lib.partial == true) {
            val existing = read()
            val existingN = (existing?.songs?.size ?: 0).coerceAtLeast(existing?.liked?.size ?: 0)
            val newN = lib.songs.size.coerceAtLeast(lib.liked.size)
            if (existingN > newN + 8) return
        }
        val snap = CachedLibrary.from(lib)
        runCatching {
            val json = adapter.toJson(snap)
            val tmp = File(appContext.filesDir, "library_cache_v2.json.tmp")
            FileOutputStream(tmp).use { fos ->
                fos.write(json.toByteArray())
                fos.flush()
                fos.fd.sync()
            }
            if (!tmp.renameTo(file)) {
                tmp.copyTo(file, overwrite = true)
                tmp.delete()
            }
        }
    }

    companion object {
        private const val PREFS = "ytm_library_cache"
        private const val KEY = "lib_v1"
    }
}

@JsonClass(generateAdapter = false)
data class CachedLibrary(
    val songs: List<TrackDto> = emptyList(),
    val liked: List<TrackDto> = emptyList(),
    val likedPlaylists: List<TrackDto> = emptyList(),
    val albums: List<TrackDto> = emptyList(),
    val artists: List<TrackDto> = emptyList(),
    val mixes: List<TrackDto> = emptyList(),
    val playlists: List<PlaylistDto> = emptyList(),
    val history: List<TrackDto> = emptyList(),
    val downloaded: List<String> = emptyList(),
    val at: Long = 0L,
) {
    fun toResponse(): LibraryResponse = LibraryResponse(
        songs = songs,
        liked = liked,
        likedPlaylists = likedPlaylists,
        albums = albums,
        artists = artists,
        mixes = mixes,
        playlists = playlists,
        history = history,
        downloaded = downloaded,
    )

    companion object {
        fun from(lib: LibraryResponse): CachedLibrary = CachedLibrary(
            songs = lib.songs,
            liked = lib.liked,
            likedPlaylists = lib.likedPlaylists,
            albums = lib.albums,
            artists = lib.artists,
            mixes = lib.mixes,
            playlists = lib.playlists,
            history = lib.history.take(40),
            downloaded = lib.downloaded,
            at = System.currentTimeMillis(),
        )
    }
}
