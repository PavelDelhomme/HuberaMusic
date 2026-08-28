package ovh.delhomme.ytmusic.data

import android.content.Context
import com.squareup.moshi.JsonClass
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory

/** Cache disque bibliothèque — affichage instantané au retour (Accueil → Biblio, cold start). */
class LibraryCacheStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val moshi = Moshi.Builder()
        .add(FlexibleStringAdapter())
        .add(KotlinJsonAdapterFactory())
        .build()
    private val adapter = moshi.adapter(CachedLibrary::class.java)

    fun read(): LibraryResponse? {
        val raw = prefs.getString(KEY, null)?.takeIf { it.isNotBlank() } ?: return null
        return runCatching { adapter.fromJson(raw) }.getOrNull()?.toResponse()
    }

    fun write(lib: LibraryResponse) {
        if (lib.songs.isEmpty() && lib.liked.isEmpty() && lib.albums.isEmpty()) return
        val snap = CachedLibrary.from(lib)
        runCatching {
            prefs.edit().putString(KEY, adapter.toJson(snap)).apply()
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
