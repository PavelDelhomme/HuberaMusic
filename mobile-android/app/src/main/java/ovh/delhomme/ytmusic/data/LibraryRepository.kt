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
    // IO : listTracks / refresh ne doivent JAMAIS tourner sur Main
    // (1550+ fichiers offline → ANR « PLM ne répond pas » au démarrage).
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
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

    private val _sortedEpoch = MutableStateFlow(0)
    val sortedEpoch: StateFlow<Int> = _sortedEpoch.asStateFlow()

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
            _sortedEpoch.value = 1
        }
    }

    private fun publish(lib: LibraryResponse, fromDisk: Boolean = false) {
        val cur = _library.value
        // Ne pas remplacer une biblio complète par un échantillon light
        if (lib.partial == true && cur != null && cur.partial != true) {
            val curN = cur.songs.size.coerceAtLeast(cur.liked.size)
            val newN = lib.songs.size.coerceAtLeast(lib.liked.size)
            if (curN > newN + 8) {
                AppLog.d("library", "skip light publish (have $curN, got $newN)")
                return
            }
        }
        // Seule la liste « downloaded » a bougé → pas de tri A–Z (14k titres = freeze UI).
        val onlyDownloaded =
            cur != null &&
                cur.songs === lib.songs &&
                cur.liked === lib.liked &&
                cur.albums === lib.albums &&
                cur.artists === lib.artists &&
                cur.playlists === lib.playlists &&
                cur.history === lib.history &&
                cur.mixes === lib.mixes &&
                cur.likedPlaylists === lib.likedPlaylists &&
                cur.recentEntities === lib.recentEntities &&
                cur.partial == lib.partial
        _library.value = lib
        if (!onlyDownloaded) {
            scope.launch {
                val s = withContext(Dispatchers.Default) { buildSorted(lib) }
                sorted = s
                _sortedEpoch.value += 1
            }
        }
        if (!fromDisk && lib.partial != true) {
            scope.launch(Dispatchers.IO) {
                runCatching { disk.write(lib) }
            }
        }
    }

    /**
     * Met à jour uniquement les IDs téléchargés — sans rescanner / retrier toute la biblio
     * (chaque fin de DL offline bumpait revision → patch → freeze Compose ~30–70 s).
     */
    fun patchDownloadedIds(downloadedIds: Collection<String>) {
        val cur = _library.value ?: return
        val next = downloadedIds.toList()
        if (cur.downloaded == next) return
        // Même références de listes titres → publish détecte onlyDownloaded.
        publish(cur.copy(downloaded = next))
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
            val haveFull = (_library.value?.songs?.size ?: 0) >= 50 && _library.value?.partial != true
            refreshInternal(force, lightFirst = !haveFull)
        }
    }

    suspend fun refresh(force: Boolean = false) {
        val haveFull = (_library.value?.songs?.size ?: 0) >= 50 && _library.value?.partial != true
        refreshInternal(force, lightFirst = !haveFull)
    }

    private suspend fun refreshInternal(force: Boolean, lightFirst: Boolean) {
        mutex.withLock {
            val now = System.currentTimeMillis()
            if (!force && now - lastFetchAt < 45_000L && _library.value != null) return
            _refreshing.value = _library.value != null
            // Scan offline hors Main (déjà sur scope IO) — ne pas bloquer l’UI.
            val localTracks = withContext(Dispatchers.IO) { container.offlineStore.listTracks() }
            try {
                container.ensureFreshToken()
                if (lightFirst) {
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
                    publish(mergeLocal(full.copy(partial = false), localTracks))
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
        publish(lib.copy(partial = false))
        lastFetchAt = System.currentTimeMillis()
    }
}
