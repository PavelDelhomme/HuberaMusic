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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
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
import androidx.compose.runtime.produceState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.ArtistRef
import ovh.delhomme.ytmusic.data.LibraryRepository
import ovh.delhomme.ytmusic.data.LibraryResponse
import ovh.delhomme.ytmusic.data.OfflineKeeper
import ovh.delhomme.ytmusic.data.PlaylistDto
import ovh.delhomme.ytmusic.data.Thumb
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.player.StreamPrefetcher
import ovh.delhomme.ytmusic.ui.components.AppTopBar
import ovh.delhomme.ytmusic.ui.components.HistorySheet
import ovh.delhomme.ytmusic.ui.components.TrackRow
import ovh.delhomme.ytmusic.ui.player.libraryQueueTitle

@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
fun LibraryScreen(
    container: AppContainer,
    onPlayNamed: (List<TrackDto>, Int, String) -> Unit,
    onMore: (TrackDto) -> Unit,
    onOpenDetail: (TrackDto) -> Unit,
    onOpenArtist: ((String?, String) -> Unit)? = null,
    onOpenAccount: () -> Unit = {},
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val filterStore = remember { LibraryFilterStore(context) }
    val hidden by filterStore.hiddenIds.collectAsState(initial = LibraryFilter.defaultHidden)
    val offlineRev by container.offlineStore.revision.collectAsState()

    val pins by container.quickAccess.pins.collectAsState(initial = emptyList())
    val pinIds = remember(pins) { pins.map { it.id }.toHashSet() }

    val repo = container.libraryRepo
    val lib by repo.library.collectAsState()
    val refreshing by repo.refreshing.collectAsState()
    val loading = lib == null
    var error by remember { mutableStateOf<String?>(null) }
    var showHistory by remember { mutableStateOf(false) }
    var userPicture by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf(LibraryFilter.defaultSelected) }
    var downloadMeta by remember { mutableStateOf<Map<String, TrackDto>>(emptyMap()) }
    var downloadsEnriching by remember { mutableStateOf(false) }
    var homeMixes by remember { mutableStateOf<List<TrackDto>>(emptyList()) }

    LaunchedEffect(Unit) {
        LibraryFilter.pendingSelect?.let { pending ->
            selected = pending
            LibraryFilter.pendingSelect = null
        }
        repo.ensureLoaded(force = false)
        error = null
    }

    val libraryEpoch by container.libraryEpoch.collectAsState()
    LaunchedEffect(libraryEpoch) {
        if (libraryEpoch > 0L) repo.ensureLoaded(force = true)
    }

    LaunchedEffect(Unit) {
        if (userPicture == null) {
            userPicture = runCatching { container.api.me().user?.picture }.getOrNull()
        }
    }

    // Préchargement formats — jamais pendant une session média (lecture ou pause)
    LaunchedEffect(lib?.songs?.size) {
        val songCount = lib?.songs?.size ?: 0
        if (songCount < 8) return@LaunchedEffect
        if (libraryPrefetchBlocked()) return@LaunchedEffect
        val base = container.resolvedApiBase()
        if (base.isBlank()) return@LaunchedEffect
        delay(2_500)
        if (StreamPrefetcher.isStreamDown() || libraryPrefetchBlocked()) return@LaunchedEffect
        withContext(Dispatchers.IO) {
            val songs = lib?.songs.orEmpty().filter { it.isPlayable() && it.id.length == 11 }
            if (songs.size < 8) return@withContext
            val sample = songs.shuffled().take(24).map { it.id }
            StreamPrefetcher.warmFormatsLight(base, sample, limit = 24)
            StreamPrefetcher.warmHeads3s(base, sample.take(6), limit = 6)
            ovh.delhomme.ytmusic.data.ShuffleHeadStore.saveHead(
                ovh.delhomme.ytmusic.YtMusicApp.instance,
                ovh.delhomme.ytmusic.data.ShuffleHeadStore.keyFor(
                    "lib:songs",
                    ovh.delhomme.ytmusic.data.ShuffleHeadStore.fingerprint(songs),
                ),
                sample.take(12),
            )
        }
    }

    // Sync live des DL locaux → filtre Téléchargés (sans republier 14k titres à chaque DL).
    LaunchedEffect(offlineRev) {
        val (localMap, localIds) = withContext(Dispatchers.IO) {
            val local = container.offlineStore.listTracks()
            val map = local.associateBy { it.id }
            map to map.keys
        }
        downloadMeta = downloadMeta.filterKeys { it in localIds } + localMap
        val cur = repo.library.value
        when {
            cur != null -> {
                val merged = (cur.downloaded.filter { it in localIds } + localIds).distinct()
                repo.patchDownloadedIds(merged)
            }
            localIds.isNotEmpty() -> {
                // Première hydratation hors-ligne seulement (pas de full songs côté serveur).
                repo.patchFromServer(
                    LibraryResponse(
                        downloaded = localIds.toList(),
                        songs = localMap.values.toList(),
                        liked = localMap.values.toList(),
                    ),
                )
                error = null
            }
        }
    }

    LaunchedEffect(selected, libraryEpoch) {
        if (selected != LibraryFilter.Mixes) return@LaunchedEffect
        runCatching {
            container.ensureFreshToken()
            container.api.home().radios.map { radio ->
                TrackDto(
                    id = radio.id,
                    title = radio.title,
                    type = "mix",
                    artists = listOf(ArtistRef("Mix pour toi")),
                )
            }
        }.onSuccess { homeMixes = it }
    }

    // Enrichit les téléchargements dont on n’a que l’id (sans vider la liste) — online only
    LaunchedEffect(lib?.downloaded, selected) {
        if (selected != LibraryFilter.Downloads) return@LaunchedEffect
        if (!ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()) {
            downloadsEnriching = false
            return@LaunchedEffect
        }
        val data = lib ?: return@LaunchedEffect
        val byId = (data.songs + data.liked + data.history).associateBy { it.id }
        val missing = data.downloaded.filter { id ->
            id.length == 11 && byId[id] == null && downloadMeta[id] == null
        }.take(8)
        if (missing.isEmpty()) {
            downloadsEnriching = false
            return@LaunchedEffect
        }
        downloadsEnriching = true
        val fetched = kotlinx.coroutines.coroutineScope {
            missing.map { id ->
                async {
                    runCatching { container.api.track(id).track }
                        .getOrNull()
                        ?.takeIf { it.isPlayable() }
                        ?.let { id to it }
                }
            }.awaitAll().filterNotNull().toMap()
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
            onAccountClick = onOpenAccount,
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
                    Button(onClick = { scope.launch { repo.refresh(force = true) } }) {
                        Text("Réessayer")
                    }
                    TextButton(onClick = onOpenAccount) {
                        Text("Ouvrir Compte (API & logs)")
                    }
                }
            }
            else -> {
                PullToRefreshBox(
                    isRefreshing = refreshing,
                    onRefresh = { scope.launch { repo.refresh(force = true) } },
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
                    if (selected != LibraryFilter.home) {
                        FilterChip(
                            selected = true,
                            onClick = { selected = LibraryFilter.home },
                            label = { Text(selected.label) },
                            trailingIcon = {
                                Icon(
                                    Icons.Default.Close,
                                    contentDescription = "Fermer le filtre · retour bibliothèque",
                                    modifier = Modifier.size(18.dp),
                                )
                            },
                            colors = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = MaterialTheme.colorScheme.onSurface,
                                selectedLabelColor = MaterialTheme.colorScheme.surface,
                                selectedTrailingIconColor = MaterialTheme.colorScheme.surface,
                            ),
                        )
                    }
                    visibleFilters
                        .filter { filter ->
                            // Accueil : tous sauf « Ajouts » (c’est déjà la page). Filtre actif : les autres options.
                            when {
                                filter == LibraryFilter.home -> false
                                selected != LibraryFilter.home && filter == selected -> false
                                else -> true
                            }
                        }
                        .forEach { filter ->
                        Box(
                            Modifier.combinedClickable(
                                onClick = { selected = filter },
                                onLongClick = {
                                    scope.launch { filterStore.hide(filter) }
                                },
                            ),
                        ) {
                            FilterChip(
                                selected = false,
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

                val monMixIds = remember(offlineRev) { container.offlineKeeper.monMixIds() }
                val sortedEpoch by repo.sortedEpoch.collectAsState()
                val sorted = repo.sorted
                val content by produceState(
                    initialValue = buildLibraryContent(
                        data, selected, downloadMeta, downloadsEnriching, homeMixes, monMixIds, sorted,
                    ),
                    sortedEpoch, sorted, selected, downloadMeta, offlineRev, homeMixes, downloadsEnriching, monMixIds, data,
                ) {
                    value = withContext(Dispatchers.Default) {
                        buildLibraryContent(
                            data, selected, downloadMeta, downloadsEnriching, homeMixes, monMixIds, sorted,
                        )
                    }
                }
                val listState = rememberLazyListState()
                LaunchedEffect(selected, content.playableQueue) {
                    snapshotFlow {
                        listState.firstVisibleItemIndex to listState.layoutInfo.visibleItemsInfo.size
                    }
                        .distinctUntilChanged()
                        .collect { (first, visible) ->
                        if (libraryPrefetchBlocked()) return@collect
                        val start = (first - 2).coerceAtLeast(0)
                        val end = (first + visible + 12).coerceAtMost(content.playableQueue.size)
                        if (start >= end) return@collect
                        val ids = content.playableQueue
                            .subList(start, end)
                            .map { it.id }
                            .filter { it.length == 11 }
                        if (ids.isEmpty()) return@collect
                        container.libraryHeadPrefetcher.boostVisible(ids)
                        ovh.delhomme.ytmusic.player.StreamPrefetcher.warmHeads3s(
                            container.resolvedApiBase(),
                            ids,
                            limit = 8,
                        )
                    }
                }
                when {
                    content.comingSoon != null -> EmptyHint(content.comingSoon!!)
                    content.loading -> {
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
                                content.emptyMessage.ifBlank { "Chargement…" },
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    content.rows.isEmpty() -> EmptyHint(content.emptyMessage)
                    else -> {
                        LazyColumn(
                            state = listState,
                            contentPadding = PaddingValues(bottom = 24.dp),
                        ) {
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
                                    val queueTitle = libraryQueueTitle(content.headline)
                                    LibraryPlayBar(
                                        playLabel = content.playLabel,
                                        shuffleLabel = content.shuffleLabel,
                                        onPlay = {
                                            scope.launch {
                                                playQueueWithLead(
                                                    container,
                                                    content.playableQueue,
                                                    0,
                                                ) { q, i -> onPlayNamed(q, i, queueTitle) }
                                            }
                                        },
                                        onShuffle = {
                                            scope.launch {
                                                playLibraryShuffled(
                                                    container,
                                                    content.playableQueue,
                                                    { q, i -> onPlayNamed(q, i, "$queueTitle · Aléatoire") },
                                                    sourceKey = "lib:${selected.name}",
                                                )
                                            }
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
                                                val queueTitle = libraryQueueTitle(content.headline)
                                                scope.launch {
                                                    playQueueWithLead(
                                                        container,
                                                        list,
                                                        idx,
                                                    ) { q, i -> onPlayNamed(q, i, queueTitle) }
                                                }
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

    if (showHistory) {
        HistorySheet(
            container = container,
            onDismiss = { showHistory = false },
            onPlay = { tracks, idx -> onPlayNamed(tracks, idx, "Historique") },
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
    val loading: Boolean = false,
)

private fun buildLibraryContent(
    data: LibraryResponse,
    filter: LibraryFilter,
    downloadMeta: Map<String, TrackDto> = emptyMap(),
    downloadsEnriching: Boolean = false,
    homeMixes: List<TrackDto> = emptyList(),
    monMixIds: List<String> = emptyList(),
    sorted: LibraryRepository.SortedLibrary? = null,
): LibraryContent {
    fun az(tracks: List<TrackDto>) = tracks.sortedBy { it.title.lowercase() }

    fun playlistKey(id: String): String =
        id.removePrefix("local:").lowercase()

    fun playlistAsTrack(pl: PlaylistDto): TrackDto =
        TrackDto(
            id = if (pl.id.startsWith("local:")) pl.id else "local:${pl.id}",
            title = pl.displayName(),
            artists = listOf(ArtistRef("${pl.resolvedTrackCount()} titres")),
            thumbnails = pl.cover()?.let { listOf(Thumb(it)) },
            type = "playlist",
        )

    fun likedPlaylistAsTrack(pl: TrackDto): TrackDto =
        pl.copy(type = pl.type ?: "playlist")

    fun isSpoken(t: TrackDto, kind: String): Boolean {
        val typ = (t.type ?: "").lowercase()
        val title = t.title.lowercase()
        return when (kind) {
            "audiobook" -> typ.contains("audiobook") || typ.contains("livre") ||
                title.contains("audiobook") || title.contains("livre audio")
            else -> typ.contains("podcast") || title.contains("podcast") || title.contains("épisode")
        }
    }

    return when (filter) {
        LibraryFilter.Additions -> {
            val recent = sorted?.additions ?: run {
                val libSongs = data.songs.ifEmpty { data.liked }
                buildList {
                    addAll(libSongs.take(40))
                    addAll(data.albums.take(20).map { it.copy(type = it.type ?: "album") })
                    addAll(data.mixes.take(10).map { it.copy(type = "mix") })
                    addAll(data.playlists.take(20).map { playlistAsTrack(it) })
                    addAll(data.likedPlaylists.take(10).map { likedPlaylistAsTrack(it) })
                }.distinctBy { it.id }
            }
            val playable = sorted?.additionsPlayable ?: recent.filter { it.isPlayable() }
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
            val offlineOnly = !ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()
            val tracks = if (offlineOnly) {
                az(downloadMeta.values.filter { it.isPlayable() }.distinctBy { it.id })
            } else {
                sorted?.tracks ?: az(
                    (data.songs.ifEmpty { data.liked }).filter { it.isPlayable() }.distinctBy { it.id },
                )
            }
            val totalSec = tracks.sumOf { (it.durationSeconds ?: 0).coerceAtLeast(0).toLong() }
            val hoursLabel = when {
                totalSec <= 0L -> null
                totalSec < 3600L -> "${totalSec / 60} min"
                else -> {
                    val h = totalSec / 3600.0
                    String.format("%.1f h", h)
                }
            }
            LibraryContent(
                headline = buildString {
                    append(if (offlineOnly) "Titres hors ligne" else "Titres")
                    append(" · ")
                    append(tracks.size)
                    if (hoursLabel != null) {
                        append(" · ")
                        append(hoursLabel)
                    }
                },
                rows = tracks,
                playableQueue = tracks,
                emptyMessage = if (offlineOnly) {
                    "Aucun titre téléchargé. En ligne : ⋮ → Télécharger (J'aime se télécharge auto)."
                } else {
                    "Aucun titre. Utilise « Enregistrer dans la bibliothèque » (≠ J'aime)."
                },
                showPlayAll = tracks.isNotEmpty(),
                playLabel = "Tout lire",
                shuffleLabel = if (offlineOnly) "Mix hors-ligne" else "Aléatoire",
            )
        }
        LibraryFilter.Liked -> {
            val offlineOnly = !ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()
            val likedIds = data.liked.map { it.id }.toHashSet()
            val tracks = if (offlineOnly) {
                az(
                    downloadMeta.values.filter { it.isPlayable() && (it.id in likedIds || likedIds.isEmpty()) }
                        .ifEmpty { downloadMeta.values.filter { it.isPlayable() } }
                        .distinctBy { it.id },
                )
            } else {
                sorted?.liked ?: az(data.liked.filter { it.isPlayable() }.distinctBy { it.id })
            }
            LibraryContent(
                headline = if (offlineOnly) "J'aime · hors ligne" else "J'aime · A–Z",
                rows = tracks,
                playableQueue = tracks,
                emptyMessage = "Aucun J'aime. Appuie sur le cœur d'un titre.",
                showPlayAll = tracks.isNotEmpty(),
                playLabel = "Tout lire",
                shuffleLabel = if (offlineOnly) "Mix hors-ligne" else "Aléatoire",
            )
        }
        LibraryFilter.Playlists -> {
            val rows = sorted?.playlists ?: buildList {
                addAll(data.playlists.map { playlistAsTrack(it) })
                addAll(data.likedPlaylists.map { likedPlaylistAsTrack(it) })
            }.distinctBy { playlistKey(it.id) }.sortedBy { it.title.lowercase() }
            LibraryContent(
                headline = if (rows.isEmpty()) "Playlists · A–Z" else "Playlists · ${rows.size}",
                rows = rows,
                playableQueue = emptyList(),
                emptyMessage = "Aucune playlist. Crée-en une ou enregistre une playlist YT Music.",
                showPlayAll = false,
                collectionHint = if (rows.isNotEmpty()) {
                    "Ouvre une playlist pour voir les titres"
                } else {
                    null
                },
            )
        }
        LibraryFilter.Mixes -> {
            val monMixTracks: List<TrackDto> = monMixIds.mapNotNull { mid ->
                downloadMeta[mid]
                    ?: data.history.find { it.id == mid }
                    ?: data.liked.find { it.id == mid }
                    ?: data.songs.find { it.id == mid }
            }
            val monMixRow = if (monMixIds.isNotEmpty()) {
                listOf(
                    TrackDto(
                        id = OfflineKeeper.MON_MIX_ID,
                        title = "${OfflineKeeper.MON_MIX_TITLE} · ${monMixIds.size}",
                        artists = listOf(ArtistRef("Toujours hors ligne")),
                        thumbnails = monMixTracks.firstOrNull()?.thumbnails,
                        type = "mix",
                    ),
                )
            } else {
                emptyList()
            }
            val saved = data.mixes.map { m ->
                m.copy(
                    type = "mix",
                    artists = (m.artists ?: emptyList()).ifEmpty { listOf(ArtistRef("Mix enregistré")) },
                )
            }
            val generated = homeMixes.map { m ->
                m.copy(
                    type = "mix",
                    artists = (m.artists ?: emptyList()).ifEmpty { listOf(ArtistRef("Mix pour toi")) },
                )
            }
            val rows = (monMixRow + saved + generated)
                .distinctBy { it.id }
                .sortedBy { it.title.lowercase() }
            val playableMon = monMixTracks.filter { t -> t.isPlayable() }
            LibraryContent(
                headline = if (rows.isEmpty()) "Mixes" else "Mixes · ${rows.size}",
                rows = rows,
                playableQueue = playableMon,
                emptyMessage = "Aucun mix. Sur Accueil → Mixés pour toi, ou enregistre un mix (+).",
                showPlayAll = playableMon.isNotEmpty(),
                playLabel = "Lire Mon Mix",
                shuffleLabel = "Mix hors-ligne",
                collectionHint = if (rows.isNotEmpty()) {
                    "Mon Mix = ~100 titres (aimés + écoutes) téléchargés en fond."
                } else {
                    null
                },
            )
        }
        LibraryFilter.Albums -> {
            val offlineOnly = !ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()
            val fromDl = downloadMeta.values
                .mapNotNull { t ->
                    val a = t.album ?: return@mapNotNull null
                    val name = a.name?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
                    TrackDto(
                        id = a.id?.takeIf { it.isNotBlank() } ?: "album:${name.lowercase()}",
                        title = name,
                        artists = t.artists,
                        thumbnails = t.thumbnails,
                        type = "album",
                    )
                }
                .distinctBy { it.id }
            val rows = if (offlineOnly || data.albums.isEmpty()) az(fromDl) else {
                sorted?.albums?.map { it.copy(type = it.type ?: "album") }
                    ?: az(data.albums.map { it.copy(type = it.type ?: "album") })
            }
            LibraryContent(
                headline = if (offlineOnly) "Albums hors ligne · A–Z" else "Albums · A–Z",
                rows = rows,
                playableQueue = emptyList(),
                emptyMessage = if (offlineOnly) {
                    "Aucun album dérivé des titres téléchargés."
                } else {
                    "Aucun album. Utilise « Enregistrer dans la bibliothèque » sur un album."
                },
                collectionHint = if (rows.isNotEmpty()) {
                    "Ouvre un album pour Lecture ou Aléatoire"
                } else {
                    null
                },
            )
        }
        LibraryFilter.Artists -> {
            val offlineOnly = !ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline()
            val fromDl = downloadMeta.values
                .flatMap { t -> t.artists.orEmpty().map { ar -> ar to t } }
                .map { (ar, t) ->
                    TrackDto(
                        id = ar.id?.takeIf { it.isNotBlank() } ?: "artist:${ar.name.lowercase()}",
                        title = ar.name,
                        artists = listOf(ar),
                        thumbnails = t.thumbnails,
                        type = "artist",
                    )
                }
                .distinctBy { it.id }
            val rows = if (offlineOnly || data.artists.isEmpty()) az(fromDl) else {
                sorted?.artists?.map { it.copy(type = it.type ?: "artist") }
                    ?: az(data.artists.map { it.copy(type = it.type ?: "artist") })
            }
            LibraryContent(
                headline = if (offlineOnly) "Artistes hors ligne · A–Z" else "Artistes · A–Z",
                rows = rows,
                playableQueue = emptyList(),
                emptyMessage = if (offlineOnly) {
                    "Aucun artiste avec titres téléchargés."
                } else {
                    "Aucun artiste enregistré."
                },
                collectionHint = if (rows.isNotEmpty()) {
                    "Ouvre un artiste pour ses titres téléchargés"
                } else {
                    null
                },
            )
        }
        LibraryFilter.Downloads -> {
            val byId = (data.songs + data.liked + data.history).associateBy { it.id } + downloadMeta
            val all = data.downloaded.mapNotNull { id ->
                byId[id] ?: TrackDto(id = id, title = id, type = "song")
            }.distinctBy { it.id }
            val playlistsDl = az(all.filter { it.isPlaylist() || (it.type ?: "").equals("playlist", true) })
            val albumsDl = az(all.filter { it.isAlbum() || (it.type ?: "").equals("album", true) })
            val tracksDl = az(
                all.filter {
                    it.isPlayable() && !it.isPlaylist() && !it.isAlbum() &&
                        !(it.type ?: "").equals("playlist", true) &&
                        !(it.type ?: "").equals("album", true)
                },
            )
            val rows = buildList {
                addAll(playlistsDl)
                addAll(albumsDl)
                addAll(tracksDl)
            }
            val unresolved = rows.any { it.title == it.id && it.id.length == 11 }
            val enriching = downloadsEnriching && unresolved && rows.isNotEmpty()
            val playable = tracksDl.filter { it.isPlayable() }
            LibraryContent(
                headline = when {
                    enriching -> "Téléchargés · ${rows.size} (infos…)"
                    rows.isNotEmpty() -> "Téléchargés · ${rows.size}"
                    else -> "Téléchargés"
                },
                rows = rows,
                playableQueue = playable,
                emptyMessage = "Aucun téléchargement sur l'appareil. Menu ⋮ d'un titre → Télécharger.",
                showPlayAll = playable.isNotEmpty(),
                playLabel = "Tout lire",
                shuffleLabel = "Mix hors-ligne",
                collectionHint = when {
                    enriching -> "Affichage immédiat — titres enrichis en arrière-plan."
                    playlistsDl.isNotEmpty() || albumsDl.isNotEmpty() ->
                        "Playlists → albums → titres. Lecture / mix = titres uniquement."
                    else -> null
                },
                loading = false,
            )
        }
        LibraryFilter.Profiles -> LibraryContent(
            headline = "Profils",
            rows = emptyList(),
            playableQueue = emptyList(),
            emptyMessage = "",
            comingSoon = "Profils — bientôt disponible.",
        )
        LibraryFilter.Podcasts -> {
            val pool = (data.songs + data.liked + data.albums).distinctBy { it.id }
            val rows = az(pool.filter { isSpoken(it, "podcast") })
            val playable = rows.filter { it.isPlayable() }
            LibraryContent(
                headline = "Podcasts · bibliothèque",
                rows = rows,
                playableQueue = playable,
                emptyMessage = "Aucun podcast ajouté à ta bibliothèque. Enregistre-en un via ⋮ → bibliothèque.",
                showPlayAll = playable.isNotEmpty(),
                collectionHint = if (rows.isNotEmpty()) "Uniquement les podcasts que tu as ajoutés." else null,
            )
        }
        LibraryFilter.Audiobooks -> {
            val pool = (data.songs + data.liked + data.albums).distinctBy { it.id }
            val rows = az(pool.filter { isSpoken(it, "audiobook") })
            val playable = rows.filter { it.isPlayable() }
            LibraryContent(
                headline = "Livres audio · bibliothèque",
                rows = rows,
                playableQueue = playable,
                emptyMessage = "Aucun livre audio ajouté à ta bibliothèque.",
                showPlayAll = playable.isNotEmpty(),
                collectionHint = if (rows.isNotEmpty()) "Uniquement les livres audio que tu as ajoutés." else null,
            )
        }
        LibraryFilter.DeviceFiles -> LibraryContent(
            headline = "Fichiers de l'appareil",
            rows = emptyList(),
            playableQueue = emptyList(),
            emptyMessage = "",
            comingSoon = "Fichiers locaux — bientôt disponible.",
        )
    }
}

/** Ne pas prefetch stream si une file est active (Exo ou UI) — évite coupures audio. */
private fun libraryPrefetchBlocked(): Boolean {
    if (ovh.delhomme.ytmusic.player.PlaybackService.Holder.queue.isNotEmpty()) return true
    val p = ovh.delhomme.ytmusic.player.PlaybackService.Holder.player ?: return false
    return p.mediaItemCount > 0
}
