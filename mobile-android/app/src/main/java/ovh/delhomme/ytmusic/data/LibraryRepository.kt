package ovh.delhomme.ytmusic.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import ovh.delhomme.ytmusic.debug.AppLog

/**
 * Biblio partagée (survit navigation Accueil ↔ Biblio) + cache disque.
 * Affiche le snapshot immédiatement ; refresh réseau en arrière-plan.
 */
class LibraryRepository(
    private val container: AppContainer,
    private val disk: LibraryCacheStore,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutex = Mutex()
    private var lastFetchAt = 0L
    private var refreshJob: kotlinx.coroutines.Job? = null

    private val _library = MutableStateFlow<LibraryResponse?>(null)
    val library: StateFlow<LibraryResponse?> = _library.asStateFlow()

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    /** Tri A–Z pré-calculé — changement de filtre instantané. */
    @Volatile
    var sorted: SortedLibrary? = null
        private set

    data class SortedLibrary(
        val tracks: List<TrackDto>,
        val liked: List<TrackDto>,
        val albums: List<TrackDto>,
        val artists: List<TrackDto>,
        val additions: List<TrackDto>,
        val additionsPlayable: List<TrackDto>,
        val playlists: List<TrackDto>,
    )

    init {
        disk.read()?.let { seed ->
            _library.value = seed
            sorted = buildSorted(seed)
        }
    }

    private fun publish(lib: LibraryResponse, fromDisk: Boolean = false) {
        _library.value = lib
        scope.launch {
            val s = withContext(Dispatchers.Default) { buildSorted(lib) }
            sorted = s
            // Réémet pour recomposer la biblio quand le tri A–Z est prêt
            _library.value = lib.copy()
        }
        if (!fromDisk) {
            scope.launch(Dispatchers.IO) {
                runCatching { disk.write(lib) }
            }
        }
    }

    private fun buildSorted(data: LibraryResponse): SortedLibrary {
        fun az(tracks: List<TrackDto>) = tracks.sortedBy { it.title.lowercase() }
        val libSongs = data.songs.ifEmpty { data.liked }
        val recent = buildList {
            addAll(libSongs.take(40))
            addAll(data.albums.take(20).map { it.copy(type = it.type ?: "album") })
            addAll(data.mixes.take(10).map { it.copy(type = "mix") })
            addAll(
                data.playlists.take(20).map { pl ->
                    TrackDto(
                        id = if (pl.id.startsWith("local:")) pl.id else "local:${pl.id}",
                        title = pl.displayName(),
                        artists = listOf(ArtistRef("${pl.resolvedTrackCount()} titres")),
                        thumbnails = pl.cover()?.let { listOf(Thumb(it)) },
                        type = "playlist",
                    )
                },
            )
            addAll(data.likedPlaylists.take(10).map { it.copy(type = it.type ?: "playlist") })
        }.distinctBy { it.id }
        val tracks = az((data.songs.ifEmpty { data.liked }).filter { it.isPlayable() }.distinctBy { it.id })
        val playlists = buildList {
            addAll(data.playlists.map { pl ->
                TrackDto(
                    id = if (pl.id.startsWith("local:")) pl.id else "local:${pl.id}",
                    title = pl.displayName(),
                    artists = listOf(ArtistRef("${pl.resolvedTrackCount()} titres")),
                    thumbnails = pl.cover()?.let { listOf(Thumb(it)) },
                    type = "playlist",
                )
            })
            addAll(data.likedPlaylists.map { it.copy(type = it.type ?: "playlist") })
        }.distinctBy { it.id.removePrefix("local:").lowercase() }.sortedBy { it.title.lowercase() }
        return SortedLibrary(
            tracks = tracks,
            liked = az(data.liked.filter { it.isPlayable() }.distinctBy { it.id }),
            albums = az(data.albums.distinctBy { it.id }),
            artists = az(data.artists.distinctBy { it.id }),
            additions = recent,
            additionsPlayable = recent.filter { it.isPlayable() },
            playlists = playlists,
        )
    }

    /** Cache mémoire / disque tout de suite ; refresh si stale (>45 s) ou force. */
    fun ensureLoaded(force: Boolean = false) {
        if (_library.value == null) {
            disk.read()?.let { publish(it, fromDisk = true) }
        }
        val now = System.currentTimeMillis()
        if (!force && now - lastFetchAt < 45_000L && _library.value != null) return
        refreshJob?.cancel()
        refreshJob = scope.launch {
            refreshInternal(force, lightFirst = _library.value == null)
        }
    }

    suspend fun refresh(force: Boolean = false) {
        refreshInternal(force, lightFirst = _library.value == null)
    }

    private suspend fun refreshInternal(force: Boolean, lightFirst: Boolean) {
        mutex.withLock {
            val now = System.currentTimeMillis()
            if (!force && now - lastFetchAt < 45_000L && _library.value != null) return
            _refreshing.value = _library.value != null
            val localTracks = container.offlineStore.listTracks()
            try {
                container.ensureFreshToken()
                if (lightFirst || force) {
                    runCatching {
                        container.api.library(light = 1, limit = 24)
                    }.onSuccess { partial ->
                        val merged = mergeLocal(partial, localTracks)
                        publish(merged)
                        _refreshing.value = false
                    }
                }
                runCatching {
                    container.api.library()
                }.onSuccess { full ->
                    publish(mergeLocal(full, localTracks))
                    lastFetchAt = System.currentTimeMillis()
                    AppLog.d("library", "refresh ok songs=${full.songs.size}")
                }.onFailure { e ->
                    AppLog.w("library", "refresh fail ${e.message}")
                }
            } finally {
                _refreshing.value = false
            }
        }
    }

    private fun mergeLocal(lib: LibraryResponse, localTracks: List<TrackDto>): LibraryResponse {
        val mergedIds = (lib.downloaded + localTracks.map { it.id }).distinct()
        return lib.copy(downloaded = mergedIds)
    }

    /** Patch local après add/remove sans refetch complet immédiat. */
    fun patchFromServer(lib: LibraryResponse) {
        publish(lib)
        lastFetchAt = System.currentTimeMillis()
    }
}
