package ovh.delhomme.ytmusic.ui.detail

import android.widget.Toast
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.LibraryAddCheck
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Radio
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.outlined.LibraryAdd
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.FollowArtistBody
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.data.buildRadioQueue
import ovh.delhomme.ytmusic.player.PlayerController
import ovh.delhomme.ytmusic.ui.components.MediaCover
import ovh.delhomme.ytmusic.ui.components.PinnedBadge
import ovh.delhomme.ytmusic.ui.components.TrackRow
import ovh.delhomme.ytmusic.ui.util.isLandscape

/** Page artiste style YouTube Music : tops, albums, singles, biblio, similaires. */
@Composable
fun ArtistDetailScreen(
    container: AppContainer,
    artistId: String,
    reloadToken: Int = 0,
    onBack: () -> Unit,
    onPlay: (List<TrackDto>, Int) -> Unit,
    onPlayNamed: (List<TrackDto>, Int, String) -> Unit = { tracks, idx, _ -> onPlay(tracks, idx) },
    onMore: (TrackDto) -> Unit,
    onOpenDetail: (TrackDto) -> Unit,
    onOpenAllSongs: () -> Unit = {},
    player: PlayerController? = null,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val pins by container.quickAccess.pins.collectAsState(initial = emptyList())
    val pinIds = remember(pins) { pins.map { it.id }.toHashSet() }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var name by remember { mutableStateOf("") }
    var subscribers by remember { mutableStateOf<String?>(null) }
    var description by remember { mutableStateOf<String?>(null) }
    var cover by remember { mutableStateOf<TrackDto?>(null) }
    var songs by remember { mutableStateOf<List<TrackDto>>(emptyList()) }
    var albums by remember { mutableStateOf<List<TrackDto>>(emptyList()) }
    var singles by remember { mutableStateOf<List<TrackDto>>(emptyList()) }
    var videos by remember { mutableStateOf<List<TrackDto>>(emptyList()) }
    var featured by remember { mutableStateOf<List<TrackDto>>(emptyList()) }
    var similar by remember { mutableStateOf<List<TrackDto>>(emptyList()) }
    var playlists by remember { mutableStateOf<List<TrackDto>>(emptyList()) }
    var libTracks by remember { mutableStateOf<List<TrackDto>>(emptyList()) }
    var libAlbums by remember { mutableStateOf<List<TrackDto>>(emptyList()) }
    var libAlbumIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var inLib by remember { mutableStateOf(false) }
    var following by remember { mutableStateOf(false) }
    var radioBusy by remember { mutableStateOf(false) }
    var showFullBio by remember { mutableStateOf(false) }
    val listState = rememberSaveable(artistId, saver = LazyListState.Saver) {
        LazyListState()
    }

    // Prefetch stream des titres visibles (comme biblio)
    LaunchedEffect(songs.size, listState) {
        if (songs.isEmpty()) return@LaunchedEffect
        val base = container.resolvedApiBase()
        if (base.isBlank()) return@LaunchedEffect
        snapshotFlow {
            listState.layoutInfo.visibleItemsInfo.mapNotNull { info ->
                // items après le header : approx index dans songs
                songs.getOrNull(info.index.coerceAtLeast(0) - 8)?.id
            }.filter { it.length == 11 }
        }.distinctUntilChanged().collect { ids ->
            if (ids.isEmpty()) return@collect
            if (ovh.delhomme.ytmusic.player.StreamPrefetcher.isStreamDown()) return@collect
            ovh.delhomme.ytmusic.player.StreamPrefetcher.warmHeads3s(base, ids, limit = 8)
        }
    }

    LaunchedEffect(artistId, reloadToken) {
        loading = true
        error = null
        runCatching {
            val r = container.api.artist(artistId)
            name = r.artist?.name ?: "Artiste"
            subscribers = r.artist?.subscribers
            description = r.artist?.description?.takeIf { it.isNotBlank() }
            cover = r.artist?.asTrack()
            songs = (r.songs.orEmpty() + r.tracks.orEmpty())
                .distinctBy { it.id }
                .filter { it.isPlayable() }
            if (songs.isEmpty()) {
                songs = container.api.artistRadio(artistId).tracks.filter { it.isPlayable() }
            }
            albums = r.albums.orEmpty().map { it.copy(type = it.type ?: "album") }
            singles = r.singles.orEmpty().map { it.copy(type = it.type ?: "album") }
            videos = r.videos.orEmpty()
            featured = r.featured.orEmpty()
            similar = r.similar.orEmpty().map { it.copy(type = "artist") }
            playlists = r.playlists.orEmpty().map { it.copy(type = it.type ?: "playlist") }
            loading = false

            val lib = container.api.library()
            inLib = lib.artists.any { it.id == artistId }
            val nameLc = name.lowercase()
            fun matches(t: TrackDto): Boolean =
                t.artists.orEmpty().any { a ->
                    a.id == artistId || a.name.trim().equals(nameLc, ignoreCase = true)
                }
            libTracks = lib.liked.filter { it.isPlayable() && matches(it) }.take(20)
            libAlbums = lib.albums.filter { matches(it) || it.id == artistId }.take(12)
            libAlbumIds = lib.albums.map { it.id }.toHashSet()

            following = runCatching {
                container.api.prefs().follows.any {
                    it.artistId() == artistId
                }
            }.getOrDefault(false)
        }.onFailure {
            error = it.message ?: "Impossible de charger l'artiste"
        }
        loading = false
    }

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Retour")
            }
            Text(
                "Artiste",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
        }

        when {
            loading -> {
                Column(
                    Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) { CircularProgressIndicator() }
            }
            error != null && songs.isEmpty() && albums.isEmpty() -> {
                Text(error!!, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(24.dp))
            }
            else -> {
                LazyColumn(state = listState, contentPadding = PaddingValues(bottom = 32.dp)) {
                    item {
                        Column(
                            Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 8.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            cover?.let {
                                Box {
                                    MediaCover(it, if (isLandscape()) 112.dp else 168.dp, circle = true)
                                    if (artistId in pinIds) {
                                        PinnedBadge(
                                            modifier = Modifier
                                                .align(Alignment.TopStart)
                                                .padding(8.dp),
                                            size = 32.dp,
                                            onClick = {
                                                scope.launch {
                                                    container.quickAccess.toggle(
                                                        it.copy(id = artistId, type = "artist"),
                                                        container.api,
                                                    )
                                                }
                                            },
                                        )
                                    }
                                }
                                Spacer(Modifier.height(16.dp))
                            }
                            Text(
                                name,
                                style = MaterialTheme.typography.headlineSmall,
                                fontWeight = FontWeight.Bold,
                                maxLines = 3,
                                overflow = TextOverflow.Ellipsis,
                                textAlign = TextAlign.Center,
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Text(
                                subscribers ?: "Artiste",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                textAlign = TextAlign.Center,
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Spacer(Modifier.height(14.dp))
                            if (songs.isNotEmpty()) {
                                Row(
                                    Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Button(
                                        onClick = {
                                            scope.launch {
                                                ovh.delhomme.ytmusic.ui.library.playQueueWithLead(
                                                    container,
                                                    songs,
                                                    0,
                                                    onPlay,
                                                )
                                            }
                                        },
                                        modifier = Modifier.weight(1f),
                                    ) {
                                        Icon(Icons.Default.PlayArrow, null, Modifier.size(20.dp))
                                        Spacer(Modifier.width(4.dp))
                                        Text("Lecture")
                                    }
                                    OutlinedButton(
                                        onClick = {
                                            scope.launch {
                                                ovh.delhomme.ytmusic.ui.library.playLibraryShuffled(
                                                    container,
                                                    songs,
                                                    onPlay,
                                                    sourceKey = "artist:$artistId",
                                                )
                                            }
                                        },
                                        modifier = Modifier.weight(1f),
                                    ) {
                                        Icon(Icons.Default.Shuffle, null, Modifier.size(18.dp))
                                        Spacer(Modifier.width(4.dp))
                                        Text("Aléatoire")
                                    }
                                }
                                Spacer(Modifier.height(8.dp))
                                OutlinedButton(
                                    onClick = {
                                        radioBusy = true
                                        val seed = songs.firstOrNull()
                                        if (seed != null) {
                                            onPlayNamed(
                                                listOf(seed) + songs.filter { it.id != seed.id }.take(8),
                                                0,
                                                "Radio · $name",
                                            )
                                        }
                                        scope.launch {
                                            val mix = buildRadioQueue(
                                                container.api,
                                                "artist",
                                                artistId,
                                                seed,
                                                mixCache = container.mixCache,
                                            )
                                            radioBusy = false
                                            val rest = mix.filter { it.id != seed?.id }
                                            when {
                                                rest.isNotEmpty() && player != null ->
                                                    player.addManyToQueue(rest)
                                                mix.isNotEmpty() && seed == null ->
                                                    onPlayNamed(mix, 0, "Radio · $name")
                                                mix.isEmpty() && seed == null ->
                                                    Toast.makeText(context, "Radio indisponible", Toast.LENGTH_SHORT).show()
                                                rest.isNotEmpty() && player == null ->
                                                    onPlayNamed(
                                                        (listOfNotNull(seed) + rest).distinctBy { it.id },
                                                        0,
                                                        "Radio · $name",
                                                    )
                                            }
                                            if (mix.isNotEmpty()) {
                                                val added = rest.size
                                                Toast.makeText(
                                                    context,
                                                    if (added > 0) {
                                                        "$added titre${if (added > 1) "s" else ""} en lien avec $name"
                                                    } else {
                                                        "Radio artiste démarrée"
                                                    },
                                                    Toast.LENGTH_LONG,
                                                ).show()
                                            }
                                        }
                                    },
                                    enabled = !radioBusy,
                                    modifier = Modifier.fillMaxWidth(),
                                ) {
                                    Icon(Icons.Default.Radio, null, Modifier.size(18.dp))
                                    Spacer(Modifier.width(6.dp))
                                    Text(if (radioBusy) "Radio…" else "Radio")
                                }
                                Spacer(Modifier.height(8.dp))
                            }
                            Row(
                                Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                OutlinedButton(
                                    onClick = {
                                        scope.launch {
                                            runCatching {
                                                if (inLib) {
                                                    container.api.removeArtist(artistId)
                                                    inLib = false
                                                    Toast.makeText(context, "Retiré de la bibliothèque", Toast.LENGTH_SHORT).show()
                                                } else {
                                                    container.api.saveArtist(
                                                        TrackDto(
                                                            id = artistId,
                                                            title = name,
                                                            type = "artist",
                                                            thumbnails = cover?.thumbnails,
                                                        ),
                                                    )
                                                    inLib = true
                                                    Toast.makeText(context, "Artiste enregistré", Toast.LENGTH_SHORT).show()
                                                }
                                            }.onFailure {
                                                Toast.makeText(context, it.message ?: "Échec", Toast.LENGTH_SHORT).show()
                                            }
                                        }
                                    },
                                    modifier = Modifier.weight(1f),
                                ) {
                                    Icon(
                                        if (inLib) Icons.Default.LibraryAddCheck else Icons.Outlined.LibraryAdd,
                                        null,
                                        Modifier.size(22.dp),
                                        tint = if (inLib) Color(0xFFFF0033) else MaterialTheme.colorScheme.onSurface,
                                    )
                                    Spacer(Modifier.width(6.dp))
                                    Text(
                                        if (inLib) "Retirer" else "Biblio",
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                OutlinedButton(
                                    onClick = {
                                        scope.launch {
                                            runCatching {
                                                if (following) {
                                                    container.api.unfollowArtist(artistId)
                                                    following = false
                                                } else {
                                                    container.api.followArtist(
                                                        artistId,
                                                        FollowArtistBody(artistId, name),
                                                    )
                                                    following = true
                                                }
                                            }.onFailure {
                                                Toast.makeText(context, it.message ?: "Échec", Toast.LENGTH_SHORT).show()
                                            }
                                        }
                                    },
                                    modifier = Modifier.weight(1f),
                                ) {
                                    Icon(
                                        if (following) Icons.Default.Person else Icons.Outlined.PersonAdd,
                                        null,
                                        Modifier.size(22.dp),
                                        tint = if (following) Color(0xFFFF0033) else MaterialTheme.colorScheme.onSurface,
                                    )
                                    Spacer(Modifier.width(6.dp))
                                    Text(
                                        if (following) "Abonné" else "Suivre",
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                        description?.let { bio ->
                            val shown = if (showFullBio || bio.length <= 180) bio else bio.take(180).trimEnd() + "…"
                            Text(
                                shown,
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                            )
                            if (bio.length > 180) {
                                TextButton(onClick = { showFullBio = !showFullBio }) {
                                    Text(if (showFullBio) "Réduire" else "À propos")
                                }
                            }
                        }
                    }

                    if (songs.isNotEmpty()) {
                        item {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 16.dp, vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    "Titres les plus écoutés",
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.SemiBold,
                                    modifier = Modifier.weight(1f),
                                )
                                TextButton(onClick = onOpenAllSongs) {
                                    Text("Plus")
                                }
                            }
                        }
                        itemsIndexed(songs.take(10), key = { i, t -> "song-${t.id}-$i" }) { index, track ->
                            TrackRow(
                                track = track,
                                pinned = track.id in pinIds,
                                onTogglePin = {
                                    scope.launch { container.quickAccess.toggle(track, container.api) }
                                },
                                onClick = { onPlay(songs, index) },
                                onMore = { onMore(track) },
                                onOpenArtist = { id, n ->
                                    if (id != null && id != artistId) onOpenDetail(
                                        TrackDto(id = id, title = n, type = "artist"),
                                    )
                                },
                            )
                        }
                    }

                    if (libTracks.isNotEmpty() || libAlbums.isNotEmpty()) {
                        item { SectionTitle("Dans ma bibliothèque") }
                        if (libAlbums.isNotEmpty()) {
                            item {
                                HorizontalShelf(
                                    items = libAlbums,
                                    pinIds = pinIds,
                                    onTogglePin = { t ->
                                        scope.launch { container.quickAccess.toggle(t, container.api) }
                                    },
                                    onOpen = onOpenDetail,
                                    onPlaySong = { onPlay(listOf(it), 0) },
                                )
                            }
                        }
                        itemsIndexed(libTracks.take(8), key = { i, t -> "lib-${t.id}-$i" }) { _, track ->
                            TrackRow(
                                track = track,
                                pinned = track.id in pinIds,
                                onTogglePin = {
                                    scope.launch { container.quickAccess.toggle(track, container.api) }
                                },
                                onClick = { onPlay(libTracks, libTracks.indexOf(track).coerceAtLeast(0)) },
                                onMore = { onMore(track) },
                            )
                        }
                    }

                    if (albums.isNotEmpty()) {
                        item { SectionTitle("Albums") }
                        item {
                                HorizontalShelf(
                                    items = albums,
                                    pinIds = pinIds,
                                    libraryIds = libAlbumIds,
                                    onTogglePin = { t ->
                                        scope.launch { container.quickAccess.toggle(t, container.api) }
                                    },
                                    onOpen = onOpenDetail,
                                    onPlaySong = { onPlay(listOf(it), 0) },
                                )
                        }
                    }
                    if (singles.isNotEmpty()) {
                        item { SectionTitle("Singles & EP") }
                        item {
                            HorizontalShelf(
                                items = singles,
                                pinIds = pinIds,
                                onTogglePin = { t ->
                                    scope.launch { container.quickAccess.toggle(t, container.api) }
                                },
                                onOpen = onOpenDetail,
                                onPlaySong = { onPlay(listOf(it), 0) },
                            )
                        }
                    }
                    if (featured.isNotEmpty()) {
                        item { SectionTitle("Apparitions") }
                        item {
                            HorizontalShelf(
                                items = featured,
                                pinIds = pinIds,
                                onTogglePin = { t ->
                                    scope.launch { container.quickAccess.toggle(t, container.api) }
                                },
                                onOpen = onOpenDetail,
                                onPlaySong = { onPlay(listOf(it), 0) },
                            )
                        }
                    }
                    if (videos.isNotEmpty()) {
                        item { SectionTitle("Vidéos") }
                        itemsIndexed(videos.take(8), key = { i, t -> "vid-${t.id}-$i" }) { index, track ->
                            TrackRow(
                                track = track,
                                pinned = track.id in pinIds,
                                onTogglePin = {
                                    scope.launch { container.quickAccess.toggle(track, container.api) }
                                },
                                onClick = {
                                    if (track.isPlayable()) onPlay(videos.filter { it.isPlayable() }, index.coerceAtMost(videos.filter { it.isPlayable() }.lastIndex))
                                    else onOpenDetail(track)
                                },
                                onMore = { onMore(track) },
                            )
                        }
                    }
                    if (playlists.isNotEmpty()) {
                        item { SectionTitle("Playlists") }
                        item {
                            HorizontalShelf(
                                items = playlists,
                                pinIds = pinIds,
                                onTogglePin = { t ->
                                    scope.launch { container.quickAccess.toggle(t, container.api) }
                                },
                                onOpen = onOpenDetail,
                                onPlaySong = { onOpenDetail(it) },
                            )
                        }
                    }
                    if (similar.isNotEmpty()) {
                        item { SectionTitle("Les fans aiment aussi") }
                        item {
                            HorizontalShelf(
                                items = similar,
                                circle = true,
                                pinIds = pinIds,
                                onTogglePin = { t ->
                                    scope.launch { container.quickAccess.toggle(t, container.api) }
                                },
                                onOpen = onOpenDetail,
                                onPlaySong = { onOpenDetail(it) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionTitle(title: String) {
    Text(
        title,
        style = MaterialTheme.typography.titleLarge,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
    )
}

@Composable
private fun HorizontalShelf(
    items: List<TrackDto>,
    onOpen: (TrackDto) -> Unit,
    onPlaySong: (TrackDto) -> Unit,
    circle: Boolean = false,
    pinIds: Set<String> = emptySet(),
    libraryIds: Set<String> = emptySet(),
    onTogglePin: ((TrackDto) -> Unit)? = null,
) {
    Row(
        Modifier
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items.take(16).forEach { item ->
            Column(
                Modifier
                    .width(120.dp)
                    .clickable {
                        when {
                            item.isArtist() || item.isAlbum() || item.isPlaylist() -> onOpen(item)
                            item.isPlayable() -> onPlaySong(item)
                            else -> onOpen(item)
                        }
                    }
                    .padding(4.dp),
            ) {
                Box {
                    MediaCover(item, 112.dp, circle = circle || item.isArtist())
                    if (item.id in pinIds) {
                        PinnedBadge(
                            modifier = Modifier
                                .align(Alignment.TopStart)
                                .padding(4.dp),
                            size = 24.dp,
                            onClick = onTogglePin?.let { { it(item) } },
                        )
                    }
                    if (item.id in libraryIds) {
                        Icon(
                            Icons.Default.LibraryAddCheck,
                            contentDescription = "Dans la bibliothèque",
                            tint = Color(0xFFFF0033),
                            modifier = Modifier
                                .align(Alignment.TopEnd)
                                .padding(4.dp)
                                .size(22.dp),
                        )
                    } else if (item.isAlbum() || item.isPlaylist()) {
                        Icon(
                            Icons.Outlined.LibraryAdd,
                            contentDescription = "Pas dans la bibliothèque",
                            tint = Color.White.copy(alpha = 0.9f),
                            modifier = Modifier
                                .align(Alignment.TopEnd)
                                .padding(4.dp)
                                .size(20.dp),
                        )
                    }
                }
                Spacer(Modifier.height(6.dp))
                Text(
                    item.title,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.Medium,
                )
                if (!item.isArtist()) {
                    Text(
                        item.artistLine().takeIf { it != "Artiste" } ?: item.kind().replaceFirstChar { it.uppercase() },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}
