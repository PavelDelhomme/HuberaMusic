package ovh.delhomme.ytmusic.ui.library

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.ArtistRef
import ovh.delhomme.ytmusic.data.LibraryResponse
import ovh.delhomme.ytmusic.data.PlaylistDto
import ovh.delhomme.ytmusic.data.Thumb
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.ui.components.AccountSheet
import ovh.delhomme.ytmusic.ui.components.AppTopBar
import ovh.delhomme.ytmusic.ui.components.HistorySheet
import ovh.delhomme.ytmusic.ui.components.TrackRow

@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
fun LibraryScreen(
    container: AppContainer,
    onPlay: (List<TrackDto>, Int) -> Unit,
    onMore: (TrackDto) -> Unit,
    onOpenDetail: (TrackDto) -> Unit,
    onOpenArtist: ((String?, String) -> Unit)? = null,
    onOpenRecoPrefs: () -> Unit,
    onOpenDebugLogs: () -> Unit = {},
    onOpenYtmImport: () -> Unit = {},
    onLoggedOut: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val filterStore = remember { LibraryFilterStore(context) }
    val hidden by filterStore.hiddenIds.collectAsState(initial = LibraryFilter.defaultHidden)
    val offlineRev by container.offlineStore.revision.collectAsState()

    val pins by container.quickAccess.pins.collectAsState(initial = emptyList())
    val pinIds = remember(pins) { pins.map { it.id }.toHashSet() }

    var lib by remember { mutableStateOf<LibraryResponse?>(null) }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showAccount by remember { mutableStateOf(false) }
    var showHistory by remember { mutableStateOf(false) }
    var userPicture by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf(LibraryFilter.defaultSelected) }
    var lastFetchAt by remember { mutableStateOf(0L) }
    var downloadMeta by remember { mutableStateOf<Map<String, TrackDto>>(emptyMap()) }
    var downloadsEnriching by remember { mutableStateOf(false) }
    var spokenItems by remember { mutableStateOf<List<TrackDto>>(emptyList()) }
    var spokenLoading by remember { mutableStateOf(false) }
    var spokenError by remember { mutableStateOf<String?>(null) }

    suspend fun reloadLibrary(force: Boolean = false, showSpinner: Boolean = false) {
        val now = System.currentTimeMillis()
        if (!force && now - lastFetchAt < 45_000L && lib != null) return
        if (showSpinner && lib == null) loading = true
        if (force && lib != null) refreshing = true
        val localTracks = container.offlineStore.listTracks()
        runCatching {
            container.ensureFreshToken()
            container.api.library()
        }.onSuccess {
            // Fusionne les IDs DL locaux dans downloaded serveur
            val mergedIds = (it.downloaded + localTracks.map { t -> t.id }).distinct()
            lib = it.copy(downloaded = mergedIds)
            lastFetchAt = System.currentTimeMillis()
            error = null
            loading = false
            refreshing = false
            if (localTracks.isNotEmpty()) {
                downloadMeta = downloadMeta + localTracks.associateBy { t -> t.id }
            }
        }.onFailure {
            if (localTracks.isNotEmpty()) {
                // Mode hors-ligne : bibliothèque minimale = fichiers locaux
                lib = LibraryResponse(downloaded = localTracks.map { t -> t.id })
                downloadMeta = localTracks.associateBy { t -> t.id }
                selected = LibraryFilter.Downloads
                error = null
            } else if (lib == null) {
                error = it.message
            }
            loading = false
            refreshing = false
        }
        if (userPicture == null) {
            userPicture = runCatching { container.api.me().user?.picture }.getOrNull()
        }
    }

    val lifecycleOwner = LocalLifecycleOwner.current
    LaunchedEffect(lifecycleOwner) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            LibraryFilter.pendingSelect?.let { pending ->
                selected = pending
                LibraryFilter.pendingSelect = null
            }
            reloadLibrary(force = false, showSpinner = true)
        }
    }

    val libraryEpoch by container.libraryEpoch.collectAsState()
    LaunchedEffect(libraryEpoch) {
        if (libraryEpoch > 0L) reloadLibrary(force = true)
    }

    // Sync live des DL locaux → liste / filtre Téléchargés sans pull-to-refresh
    LaunchedEffect(offlineRev) {
        val local = container.offlineStore.listTracks()
        downloadMeta = downloadMeta + local.associateBy { it.id }
        val ids = local.map { it.id }
        val cur = lib
        if (cur != null) {
            lib = cur.copy(downloaded = (cur.downloaded + ids).distinct())
        } else if (ids.isNotEmpty()) {
            lib = LibraryResponse(downloaded = ids)
            error = null
            loading = false
        }
    }

    LaunchedEffect(selected) {
        if (selected != LibraryFilter.Podcasts && selected != LibraryFilter.Audiobooks) {
            spokenItems = emptyList()
            spokenError = null
            spokenLoading = false
            return@LaunchedEffect
        }
        spokenLoading = true
        spokenError = null
        spokenItems = emptyList()
        val kind = if (selected == LibraryFilter.Audiobooks) "audiobook" else "podcast"
        runCatching {
            container.ensureFreshToken()
            container.api.exploreSpoken(kind).items
        }.onSuccess {
            spokenItems = it
            spokenError = null
        }.onFailure {
            spokenError = it.message ?: "Impossible de charger"
            spokenItems = emptyList()
        }
        spokenLoading = false
    }

    // Enrichit les téléchargements dont on n’a que l’id
    LaunchedEffect(lib?.downloaded, selected) {
        if (selected != LibraryFilter.Downloads) return@LaunchedEffect
        val data = lib ?: return@LaunchedEffect
        val byId = (data.songs + data.liked + data.history).associateBy { it.id }
        val missing = data.downloaded.filter { id ->
            id.length == 11 && byId[id] == null && downloadMeta[id] == null
        }.take(24)
        if (missing.isEmpty()) {
            downloadsEnriching = false
            return@LaunchedEffect
        }
        downloadsEnriching = true
        val fetched = mutableMapOf<String, TrackDto>()
        for (id in missing) {
            runCatching { container.api.track(id).track }
                .getOrNull()
                ?.takeIf { it.isPlayable() }
                ?.let { fetched[id] = it }
        }
        if (fetched.isNotEmpty()) downloadMeta = downloadMeta + fetched
        downloadsEnriching = false
    }

    val visibleFilters = remember(hidden) {
        LibraryFilter.entries.filter { it.name !in hidden }
    }
    LaunchedEffect(visibleFilters, selected) {
        if (selected.name in hidden && visibleFilters.isNotEmpty()) {
            selected = visibleFilters.first()
        }
    }

    Column(Modifier.fillMaxSize()) {
        AppTopBar(
            title = "Bibliothèque",
            userPictureUrl = userPicture,
            onAccountClick = { showAccount = true },
            onHistoryClick = null,
        )

        when {
            loading -> {
                Column(
                    Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) { CircularProgressIndicator() }
            }
            error != null && lib == null -> {
                Column(
                    Modifier
                        .fillMaxSize()
                        .padding(16.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        "Impossible de joindre l’API",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.error,
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        error!!,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Sans connexion : télécharge des titres (menu ⋮) pour les lire hors-ligne dans Téléchargés.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = { scope.launch { reloadLibrary(force = true, showSpinner = true) } }) {
                        Text("Réessayer")
                    }
                    TextButton(onClick = onOpenDebugLogs) {
                        Text("Régler l’URL API")
                    }
                }
            }
            else -> {
                PullToRefreshBox(
                    isRefreshing = refreshing,
                    onRefresh = { scope.launch { reloadLibrary(force = true) } },
                    modifier = Modifier.fillMaxSize(),
                ) {
                val data = lib ?: LibraryResponse()

                Column(Modifier.fillMaxSize()) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    visibleFilters.forEach { filter ->
                        Box(
                            Modifier.combinedClickable(
                                onClick = { selected = filter },
                                onLongClick = {
                                    scope.launch { filterStore.hide(filter) }
                                },
                            ),
                        ) {
                            FilterChip(
                                selected = selected == filter,
                                onClick = { selected = filter },
                                label = { Text(filter.label) },
                                colors = FilterChipDefaults.filterChipColors(
                                    selectedContainerColor = MaterialTheme.colorScheme.onSurface,
                                    selectedLabelColor = MaterialTheme.colorScheme.surface,
                                    containerColor = MaterialTheme.colorScheme.surfaceVariant,
                                    labelColor = MaterialTheme.colorScheme.onSurface,
                                ),
                            )
                        }
                    }
                    if (hidden.isNotEmpty()) {
                        TextButton(onClick = { scope.launch { filterStore.resetHidden() } }) {
                            Text("Réafficher")
                        }
                    }
                }

                val content = remember(data, selected, downloadMeta, offlineRev, spokenItems, spokenLoading, spokenError) {
                    when (selected) {
                        LibraryFilter.Podcasts, LibraryFilter.Audiobooks -> {
                            val title = if (selected == LibraryFilter.Audiobooks) "Livres audio" else "Podcasts"
                            val playable = spokenItems.filter { it.isPlayable() }
                            LibraryContent(
                                headline = title,
                                rows = spokenItems,
                                playableQueue = playable,
                                emptyMessage = when {
                                    spokenLoading -> "Chargement…"
                                    spokenError != null -> spokenError!!
                                    else -> "Aucun résultat. Cherche aussi via Recherche → $title."
                                },
                                showPlayAll = playable.isNotEmpty(),
                                playLabel = "Tout lire",
                                shuffleLabel = "Aléatoire",
                                collectionHint = "Lecture en flux audio (YouTube).",
                            )
                        }
                        else -> buildLibraryContent(data, selected, downloadMeta)
                    }
                }
                when {
                    content.comingSoon != null -> EmptyHint(content.comingSoon!!)
                    content.rows.isEmpty() -> EmptyHint(content.emptyMessage)
                    else -> {
                        LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
                            item {
                                Text(
                                    content.headline,
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.SemiBold,
                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                                )
                            }
                            if (content.playableQueue.isNotEmpty() && content.showPlayAll) {
                                item {
                                    LibraryPlayBar(
                                        playLabel = content.playLabel,
                                        shuffleLabel = content.shuffleLabel,
                                        onPlay = { onPlay(content.playableQueue, 0) },
                                        onShuffle = {
                                            onPlay(content.playableQueue.shuffled(), 0)
                                        },
                                    )
                                }
                            } else if (content.collectionHint != null) {
                                item {
                                    Text(
                                        content.collectionHint!!,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                                    )
                                }
                            }
                            itemsIndexed(content.rows, key = { i, r -> "${selected.name}-${r.id}-$i" }) { _, row ->
                                TrackRow(
                                    track = row,
                                    onClick = {
                                        when {
                                            row.isPlaylist() || row.isAlbum() || row.isArtist() ->
                                                onOpenDetail(row)
                                            row.isPlayable() -> {
                                                val list = content.playableQueue.ifEmpty { listOf(row) }
                                                val idx = list.indexOfFirst { it.id == row.id }.coerceAtLeast(0)
                                                onPlay(list, idx)
                                            }
                                            else -> onOpenDetail(row)
                                        }
                                    },
                                    onMore = { onMore(row) },
                                    onOpenArtist = onOpenArtist,
                                    pinned = row.id in pinIds,
                                    onTogglePin = {
                                        scope.launch {
                                            container.quickAccess.toggle(row, container.api)
                                        }
                                    },
                                )
                            }
                            item {
                                Spacer(Modifier.height(12.dp))
                                Text(
                                    "Appui long sur un filtre pour le masquer de la barre",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                                )
                            }
                        }
                    }
                }
                }
                }
            }
        }
    }

    if (showAccount) {
        AccountSheet(
            container = container,
            onDismiss = { showAccount = false },
            onOpenRecoPrefs = onOpenRecoPrefs,
            onOpenHistory = { showHistory = true },
            onOpenDownloads = {
                selected = LibraryFilter.Downloads
            },
            onOpenDebugLogs = onOpenDebugLogs,
            onOpenYtmImport = onOpenYtmImport,
            onLoggedOut = onLoggedOut,
        )
    }
    if (showHistory) {
        HistorySheet(
            container = container,
            onDismiss = { showHistory = false },
            onPlay = onPlay,
            onMore = onMore,
            onOpenEntity = onOpenDetail,
        )
    }
}

@Composable
private fun LibraryPlayBar(
    playLabel: String,
    shuffleLabel: String,
    onPlay: () -> Unit,
    onShuffle: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Button(
            onClick = onPlay,
            modifier = Modifier.weight(1f),
        ) {
            Icon(Icons.Default.PlayArrow, contentDescription = null, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(6.dp))
            Text(playLabel)
        }
        OutlinedButton(
            onClick = onShuffle,
            modifier = Modifier.weight(1f),
        ) {
            Icon(Icons.Default.Shuffle, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(6.dp))
            Text(shuffleLabel)
        }
    }
}

@Composable
private fun EmptyHint(message: String) {
    Column(
        Modifier
            .fillMaxSize()
            .padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            message,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyLarge,
        )
    }
}

private data class LibraryContent(
    val headline: String,
    val rows: List<TrackDto>,
    val playableQueue: List<TrackDto>,
    val emptyMessage: String,
    val showPlayAll: Boolean = false,
    val playLabel: String = "Tout lire",
    val shuffleLabel: String = "Aléatoire",
    val collectionHint: String? = null,
    val comingSoon: String? = null,
)

private fun buildLibraryContent(
    data: LibraryResponse,
    filter: LibraryFilter,
    downloadMeta: Map<String, TrackDto> = emptyMap(),
): LibraryContent {
    fun az(tracks: List<TrackDto>) = tracks.sortedBy { it.title.lowercase() }

    fun playlistAsTrack(pl: PlaylistDto): TrackDto =
        TrackDto(
            id = if (pl.id.startsWith("local:")) pl.id else "local:${pl.id}",
            title = pl.displayName(),
            artists = listOf(ArtistRef("${pl.tracks?.size ?: 0} titres")),
            thumbnails = pl.cover()?.let { listOf(Thumb(it)) },
            type = "playlist",
        )

    fun likedPlaylistAsTrack(pl: TrackDto): TrackDto =
        pl.copy(type = pl.type ?: "playlist")

    return when (filter) {
        LibraryFilter.Additions -> {
            val libSongs = data.songs.ifEmpty { data.liked }
            val recent = buildList {
                addAll(libSongs.take(40))
                addAll(data.albums.take(20).map { it.copy(type = it.type ?: "album") })
                addAll(data.mixes.take(10).map { it.copy(type = "mix") })
                addAll(data.playlists.take(20).map { playlistAsTrack(it) })
                addAll(data.likedPlaylists.take(10).map { likedPlaylistAsTrack(it) })
            }.distinctBy { it.id }
            val playable = recent.filter { it.isPlayable() }
            LibraryContent(
                headline = "Enregistré récemment",
                rows = recent,
                playableQueue = playable,
                emptyMessage = "Rien d'enregistré. Ajoute un titre ou un album à la bibliothèque.",
                showPlayAll = playable.isNotEmpty(),
                playLabel = "Tout lire",
                shuffleLabel = "Aléatoire",
            )
        }
        LibraryFilter.Tracks -> {
            val tracks = az((data.songs.ifEmpty { data.liked }).filter { it.isPlayable() })
            LibraryContent(
                headline = "Titres · A–Z",
                rows = tracks,
                playableQueue = tracks,
                emptyMessage = "Aucun titre. Utilise « Enregistrer dans la bibliothèque » (≠ J'aime).",
                showPlayAll = tracks.isNotEmpty(),
                playLabel = "Tout lire",
                shuffleLabel = "Aléatoire",
            )
        }
        LibraryFilter.Liked -> {
            val tracks = az(data.liked.filter { it.isPlayable() })
            LibraryContent(
                headline = "J'aime · A–Z",
                rows = tracks,
                playableQueue = tracks,
                emptyMessage = "Aucun J'aime. Appuie sur le cœur d'un titre.",
                showPlayAll = tracks.isNotEmpty(),
                playLabel = "Tout lire",
                shuffleLabel = "Aléatoire",
            )
        }
        LibraryFilter.Playlists -> {
            val rows = buildList {
                addAll(data.playlists.map { playlistAsTrack(it) })
                addAll(data.likedPlaylists.map { likedPlaylistAsTrack(it) })
            }.distinctBy { it.id }.sortedBy { it.title.lowercase() }
            val fromLocal = data.playlists
                .flatMap { it.tracks.orEmpty() }
                .filter { it.isPlayable() }
                .distinctBy { it.id }
            LibraryContent(
                headline = "Playlists · A–Z",
                rows = rows,
                playableQueue = fromLocal,
                emptyMessage = "Aucune playlist. Crée-en une ou enregistre une playlist YT Music.",
                showPlayAll = fromLocal.isNotEmpty(),
                playLabel = "Tout lire",
                shuffleLabel = "Aléatoire",
                collectionHint = if (fromLocal.isEmpty() && rows.isNotEmpty()) {
                    "Ouvre une playlist pour lancer la lecture"
                } else {
                    null
                },
            )
        }
        LibraryFilter.Mixes -> {
            val rows = data.mixes.map { m ->
                m.copy(
                    type = "mix",
                    artists = listOf(ArtistRef("Mix radio")),
                )
            }.sortedBy { it.title.lowercase() }
            LibraryContent(
                headline = if (rows.isEmpty()) "Mixes" else "Mixes · ${rows.size}",
                rows = rows,
                playableQueue = emptyList(),
                emptyMessage = "Aucun mix. Sur Accueil → Mixés pour toi, enregistre un mix (+).",
                showPlayAll = false,
                collectionHint = if (rows.isNotEmpty()) "Ouvre un mix pour voir la liste" else null,
            )
        }
        LibraryFilter.Albums -> {
            val rows = az(data.albums.map { it.copy(type = it.type ?: "album") })
            LibraryContent(
                headline = "Albums · A–Z",
                rows = rows,
                playableQueue = emptyList(),
                emptyMessage = "Aucun album. Utilise « Enregistrer dans la bibliothèque » sur un album.",
                collectionHint = if (rows.isNotEmpty()) {
                    "Ouvre un album pour Lecture ou Aléatoire"
                } else {
                    null
                },
            )
        }
        LibraryFilter.Artists -> {
            val rows = az(data.artists.map { it.copy(type = it.type ?: "artist") })
            LibraryContent(
                headline = "Artistes · A–Z",
                rows = rows,
                playableQueue = emptyList(),
                emptyMessage = "Aucun artiste enregistré.",
                collectionHint = if (rows.isNotEmpty()) {
                    "Ouvre un artiste pour ses titres et sa radio"
                } else {
                    null
                },
            )
        }
        LibraryFilter.Downloads -> {
            val byId = (data.songs + data.liked + data.history).associateBy { it.id } + downloadMeta
            val rows = az(
                data.downloaded.mapNotNull { id ->
                    byId[id] ?: TrackDto(id = id, title = id, type = "song")
                }.distinctBy { it.id },
            )
            val playable = rows.filter { it.isPlayable() }
            val unresolved = rows.any { it.title == it.id && it.id.length == 11 }
            if (downloadsEnriching && (rows.isEmpty() || unresolved)) {
                Column(
                    Modifier
                        .fillMaxSize()
                        .padding(24.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    CircularProgressIndicator()
                    Spacer(Modifier.height(12.dp))
                    Text(
                        "Chargement des téléchargements…",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                LibraryContent(
                    headline = "Téléchargés · A–Z",
                    rows = rows,
                    playableQueue = playable,
                    emptyMessage = "Aucun téléchargement sur l'appareil. Menu ⋮ d'un titre → Télécharger.",
                    showPlayAll = playable.isNotEmpty(),
                    playLabel = "Tout lire",
                    shuffleLabel = "Aléatoire",
                )
            }
        }
        LibraryFilter.Profiles -> LibraryContent(
            headline = "Profils",
            rows = emptyList(),
            playableQueue = emptyList(),
            emptyMessage = "",
            comingSoon = "Profils — bientôt disponible.",
        )
        LibraryFilter.Podcasts, LibraryFilter.Audiobooks -> LibraryContent(
            headline = filter.label,
            rows = emptyList(),
            playableQueue = emptyList(),
            emptyMessage = "Chargement…",
        )
        LibraryFilter.DeviceFiles -> LibraryContent(
            headline = "Fichiers de l'appareil",
            rows = emptyList(),
            playableQueue = emptyList(),
            emptyMessage = "",
            comingSoon = "Fichiers locaux — bientôt disponible.",
        )
    }
}
