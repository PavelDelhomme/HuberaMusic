package ovh.delhomme.ytmusic.ui.detail

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.LibraryAdd
import androidx.compose.material.icons.filled.LibraryAddCheck
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.PlaylistAdd
import androidx.compose.material.icons.filled.QueueMusic
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberTooltipState
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.ArtistRef
import ovh.delhomme.ytmusic.data.HistoryEntityBody
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.data.buildRadioQueue
import ovh.delhomme.ytmusic.data.resolvePlayableTracks
import ovh.delhomme.ytmusic.player.PlayerController
import ovh.delhomme.ytmusic.ui.components.MediaCover
import ovh.delhomme.ytmusic.ui.components.PinnedBadge
import ovh.delhomme.ytmusic.ui.components.TrackRow
import ovh.delhomme.ytmusic.ui.components.DownloadStatusIcon
import ovh.delhomme.ytmusic.ui.components.pollOfflineJob
import ovh.delhomme.ytmusic.ui.icons.MixIcon

enum class DetailKind { Album, Artist, Playlist, Mix }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CollectionDetailScreen(
    container: AppContainer,
    kind: DetailKind,
    id: String,
    seed: TrackDto? = null,
    reloadToken: Int = 0,
    player: PlayerController? = null,
    onBack: () -> Unit,
    onPlay: (List<TrackDto>, Int) -> Unit,
    onPlayNamed: (List<TrackDto>, Int, String) -> Unit = { tracks, idx, _ -> onPlay(tracks, idx) },
    onMore: (TrackDto, playlistId: String?) -> Unit,
    onOpenArtist: (String, String) -> Unit = { _, _ -> },
    onOpenAddToPlaylist: (TrackDto) -> Unit = {},
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val pins by container.quickAccess.pins.collectAsState(initial = emptyList())
    val pinIds = remember(pins) { pins.map { it.id }.toHashSet() }
    val collectionPinned = id in pinIds
    var loading by remember { mutableStateOf(true) }
    var radioBusy by remember { mutableStateOf(false) }
    var title by remember { mutableStateOf(seed?.title ?: "") }
    var subtitle by remember { mutableStateOf("") }
    var artistLine by remember { mutableStateOf("") }
    var artistId by remember { mutableStateOf<String?>(null) }
    var releaseType by remember { mutableStateOf("Album") }
    var year by remember { mutableStateOf<String?>(null) }
    var cover by remember { mutableStateOf(seed) }
    var tracks by remember { mutableStateOf<List<TrackDto>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var inLib by remember { mutableStateOf(false) }
    var showAlbumMenu by remember { mutableStateOf(false) }
    var offlineProgress by remember { mutableStateOf<Float?>(null) }
    var offlineDone by remember { mutableStateOf(false) }

    fun recordCollectionPlay() {
        val entityKind = when (kind) {
            DetailKind.Album -> "album"
            DetailKind.Artist -> "artist"
            DetailKind.Playlist -> "playlist"
            DetailKind.Mix -> "mix"
        }
        scope.launch {
            runCatching {
                container.api.recordEntityPlay(
                    HistoryEntityBody(
                        id = id.removePrefix("local:"),
                        kind = entityKind,
                        title = title,
                        thumbnails = cover?.thumbnails,
                        artists = cover?.artists,
                        type = entityKind,
                    ),
                )
            }
        }
    }

    LaunchedEffect(kind, id, reloadToken) {
        loading = true
        error = null
        runCatching {
            when (kind) {
                DetailKind.Album -> {
                    val r = container.api.album(id)
                    title = r.album?.title ?: seed?.title ?: "Album"
                    fun usefulArtists(list: List<ArtistRef>?): List<ArtistRef> =
                        list.orEmpty().filter {
                            val n = it.name.trim()
                            n.isNotEmpty() &&
                                !n.equals("Artiste", true) &&
                                !n.equals("Artist", true) &&
                                !n.equals("Inconnu", true) &&
                                !n.equals("Unknown", true)
                        }
                    val artists = usefulArtists(r.album?.artists)
                        .ifEmpty {
                            usefulArtists(
                                r.tracks.flatMap { it.artists.orEmpty() }
                                    .distinctBy { it.id ?: it.name },
                            )
                        }
                        .ifEmpty { usefulArtists(seed?.artists) }
                        .ifEmpty {
                            // Fallback client : meta du 1er titre si l’API album n’a pas d’artiste
                            val firstId = r.tracks.firstOrNull { it.id.matches(Regex("^[a-zA-Z0-9_-]{11}$")) }?.id
                            if (firstId != null) {
                                usefulArtists(
                                    runCatching { container.api.track(firstId).track.artists }
                                        .getOrNull(),
                                )
                            } else {
                                emptyList()
                            }
                        }
                    artistLine = artists.joinToString(", ") { it.name }.ifBlank {
                        seed?.artistLine()?.takeIf { it != "Artiste" && it != "Artist" } ?: ""
                    }
                    artistId = artists.firstOrNull()?.id
                    year = r.album?.year
                    releaseType = when {
                        !r.album?.releaseType.isNullOrBlank() -> r.album!!.releaseType!!
                        r.tracks.size <= 1 -> "Single"
                        r.tracks.size <= 6 -> "EP"
                        else -> "Album"
                    }
                    subtitle = buildString {
                        append(releaseType)
                        year?.let { append(" - "); append(it) }
                    }
                    cover = (r.album?.asTrack() ?: seed ?: TrackDto(id = id, title = title, type = "album"))
                        .let { c ->
                            val withId = if (c.id != id) c.copy(id = id, type = "album") else c.copy(type = "album")
                            if (usefulArtists(withId.artists).isEmpty() && artists.isNotEmpty()) {
                                withId.copy(artists = artists)
                            } else withId
                        }
                    tracks = r.tracks.filter { it.isPlayable() }.map { t ->
                        if (usefulArtists(t.artists).isEmpty() && artists.isNotEmpty()) {
                            t.copy(artists = artists)
                        } else t.copy(artists = usefulArtists(t.artists).ifEmpty { t.artists })
                    }
                    inLib = runCatching {
                        container.api.library().albums.any { it.id == id }
                    }.getOrDefault(false)
                }
                DetailKind.Artist -> {
                    val r = container.api.artist(id)
                    title = r.artist?.name ?: seed?.title ?: "Artiste"
                    subtitle = r.artist?.subscribers ?: "Artiste"
                    artistLine = title
                    cover = r.artist?.asTrack() ?: seed
                    tracks = (r.songs.orEmpty() + r.tracks.orEmpty())
                        .distinctBy { it.id }
                        .filter { it.isPlayable() }
                    if (tracks.isEmpty()) {
                        tracks = container.api.artistRadio(id).tracks.filter { it.isPlayable() }
                    }
                }
                DetailKind.Playlist -> {
                    val rawId = id.removePrefix("local:")
                    if (id.startsWith("local:")) {
                        val lib = container.api.library()
                        val pl = lib.playlists.firstOrNull { it.id == rawId }
                        title = pl?.displayName() ?: seed?.title ?: "Playlist"
                        subtitle = "${pl?.tracks?.size ?: 0} titres"
                        cover = seed ?: TrackDto(
                            id = id,
                            title = title,
                            thumbnails = pl?.cover()?.let {
                                listOf(ovh.delhomme.ytmusic.data.Thumb(it))
                            },
                            type = "playlist",
                        )
                        tracks = pl?.tracks.orEmpty().filter { it.isPlayable() }
                    } else {
                        val r = container.api.playlist(rawId)
                        title = r.playlist?.displayName() ?: seed?.title ?: "Playlist"
                        subtitle = listOfNotNull(
                            r.playlist?.description?.takeIf { it.isNotBlank() },
                            "${r.tracks.size} titres",
                        ).joinToString(" · ").ifBlank { "Playlist" }
                        cover = r.playlist?.let {
                            TrackDto(
                                id = it.id,
                                title = it.displayName(),
                                thumbnails = it.cover()?.let { u ->
                                    listOf(ovh.delhomme.ytmusic.data.Thumb(u))
                                } ?: it.thumbnails,
                                type = "playlist",
                            )
                        } ?: seed
                        tracks = r.tracks.filter { it.isPlayable() }
                    }
                }
                DetailKind.Mix -> {
                    title = seed?.title ?: id.replace('-', ' ').replace('_', ' ')
                        .split(' ')
                        .joinToString(" ") { w -> w.replaceFirstChar { c -> c.uppercase() } }
                    subtitle = "Mix"
                    cover = seed ?: TrackDto(id = id, title = title, type = "mix")
                    val cacheKey = container.mixCache.keyCategory(id)
                    container.mixCache.get(cacheKey)?.let { cached ->
                        tracks = cached
                        cover = cached.first()
                        subtitle = "${cached.size} titres · Mix"
                        loading = false
                    }
                    // Preview rapide pour afficher la liste sans attendre le mix complet
                    if (tracks.isEmpty()) {
                        runCatching {
                            val preview = container.api.recoRadio(id, preview = 1)
                            val pt = preview.tracks.filter { it.isPlayable() }
                            if (pt.isNotEmpty()) {
                                tracks = pt
                                cover = pt.first()
                                subtitle = "${pt.size}+ titres · Mix"
                                loading = false
                            }
                        }
                    }
                    val r = container.api.recoRadio(id)
                    val list = r.tracks.filter { it.isPlayable() }
                    if (list.isNotEmpty()) {
                        tracks = list
                        cover = list.first()
                        subtitle = "${list.size} titres · Mix"
                        container.mixCache.put(cacheKey, list, r.generatedAt ?: System.currentTimeMillis())
                    }
                    inLib = runCatching {
                        container.api.library().mixes.any { it.id == id }
                    }.getOrDefault(false)
                }
            }
        }.onFailure {
            if (seed != null || tracks.isNotEmpty()) {
                if (tracks.isEmpty()) tracks = resolvePlayableTracks(container.api, seed!!)
                title = title.ifBlank { seed?.title ?: "Mix" }
                subtitle = when (kind) {
                    DetailKind.Album -> "Album"
                    DetailKind.Artist -> "Artiste"
                    DetailKind.Playlist -> "Playlist"
                    DetailKind.Mix -> "Mix"
                }
            } else {
                error = it.message ?: "Impossible de charger"
            }
        }
        loading = false
    }

    LaunchedEffect(tracks) {
        if (tracks.isEmpty()) return@LaunchedEffect
        val base = ovh.delhomme.ytmusic.BuildConfig.API_BASE_URL.trimEnd('/')
        ovh.delhomme.ytmusic.player.StreamPrefetcher.warmAround(
            base,
            tracks.map { it.id },
            0,
            ahead = 4,
            behind = 0,
        )
    }

    Column(Modifier.fillMaxSize()) {
        when {
            loading -> {
                Column(
                    Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) { CircularProgressIndicator() }
            }
            error != null && tracks.isEmpty() -> {
                Row(
                    Modifier.padding(4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Retour")
                    }
                }
                Text(error!!, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(24.dp))
            }
            kind == DetailKind.Album -> {
                LazyColumn(contentPadding = PaddingValues(bottom = 28.dp)) {
                    item {
                        AlbumHeroHeader(
                            title = title,
                            artistLine = artistLine,
                            metaLine = subtitle,
                            cover = cover,
                            inLibrary = inLib,
                            pinned = collectionPinned,
                            radioBusy = radioBusy,
                            onBack = onBack,
                            onTogglePin = {
                                scope.launch {
                                    val pinTrack = cover ?: TrackDto(
                                        id = id,
                                        title = title,
                                        type = "album",
                                        artists = listOf(ArtistRef(artistLine, artistId)),
                                    )
                                    container.quickAccess.toggle(
                                        pinTrack.copy(id = id, type = "album", title = title),
                                        container.api,
                                    )
                                }
                            },
                            onArtistClick = {
                                val aid = artistId
                                if (!aid.isNullOrBlank()) onOpenArtist(aid, artistLine)
                                else Toast.makeText(context, "Artiste indisponible", Toast.LENGTH_SHORT).show()
                            },
                            onShuffle = {
                                if (tracks.isEmpty()) return@AlbumHeroHeader
                                recordCollectionPlay()
                                val shuffled = tracks.shuffled()
                                player?.play(
                                    shuffled,
                                    0,
                                    title = title,
                                    sourceId = id,
                                    sourceKind = "album",
                                ) ?: onPlay(shuffled, 0)
                            },
                            onToggleLibrary = {
                                scope.launch {
                                    runCatching {
                                        if (inLib) {
                                            container.api.removeAlbum(id)
                                            inLib = false
                                        } else {
                                            container.api.saveAlbum(
                                                TrackDto(
                                                    id = id,
                                                    title = title,
                                                    type = "album",
                                                    artists = cover?.artists
                                                        ?: listOf(ArtistRef(artistLine, artistId)),
                                                    thumbnails = cover?.thumbnails,
                                                ),
                                            )
                                            inLib = true
                                        }
                                    }.onFailure {
                                        Toast.makeText(context, it.message ?: "Échec", Toast.LENGTH_SHORT).show()
                                    }
                                }
                            },
                            onPlay = {
                                if (tracks.isEmpty()) return@AlbumHeroHeader
                                recordCollectionPlay()
                                player?.play(
                                    tracks,
                                    0,
                                    title = title,
                                    sourceId = id,
                                    sourceKind = "album",
                                ) ?: onPlay(tracks, 0)
                            },
                            onRadio = {
                                radioBusy = true
                                // Joue tout de suite le 1er titre ; mix append ensuite
                                val seed = tracks.firstOrNull()
                                if (seed != null) {
                                    onPlayNamed(listOf(seed), 0, "Mix album")
                                }
                                scope.launch {
                                    val mix = buildRadioQueue(
                                        container.api,
                                        "album",
                                        id,
                                        seed,
                                        mixCache = container.mixCache,
                                    )
                                    radioBusy = false
                                    val rest = mix.filter { it.id != seed?.id }
                                    when {
                                        rest.isNotEmpty() && player != null -> player.addManyToQueue(rest)
                                        mix.isNotEmpty() && seed == null -> onPlayNamed(mix, 0, "Mix album")
                                        mix.isEmpty() && seed == null ->
                                            Toast.makeText(context, "Mix indisponible", Toast.LENGTH_SHORT).show()
                                    }
                                }
                            },
                            onMore = { showAlbumMenu = true },
                        )
                    }
                    itemsIndexed(tracks, key = { i, t -> "${t.id}-$i" }) { index, track ->
                        TrackRow(
                            track = track,
                            onClick = {
                                player?.play(
                                    tracks,
                                    index,
                                    title = title,
                                    sourceId = id,
                                    sourceKind = "album",
                                ) ?: onPlay(tracks, index)
                            },
                            onMore = { onMore(track, null) },
                            // Artiste déjà dans le hero — lignes plus denses (durée conservée)
                            subtitle = "",
                            indexLabel = "${index + 1}",
                            compact = true,
                            showCover = false,
                        )
                    }
                }
            }
            else -> {
                // Playlist / Mix — layout historique
                val headerLabel = if (kind == DetailKind.Mix) "Mix" else "Playlist"
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
                        headerLabel,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Spacer(Modifier.weight(1f))
                    if (kind == DetailKind.Mix) {
                        IconButton(
                            onClick = {
                                scope.launch {
                                    runCatching {
                                        if (inLib) {
                                            container.api.removeMix(id)
                                            inLib = false
                                            Toast.makeText(context, "Mix retiré", Toast.LENGTH_SHORT).show()
                                        } else {
                                            container.api.saveMix(
                                                mapOf(
                                                    "id" to id,
                                                    "title" to title,
                                                    "covers" to tracks.take(4),
                                                    "tracks" to tracks.take(4),
                                                ),
                                            )
                                            inLib = true
                                            Toast.makeText(context, "Mix enregistré", Toast.LENGTH_SHORT).show()
                                        }
                                    }.onFailure {
                                        Toast.makeText(context, it.message ?: "Échec", Toast.LENGTH_SHORT).show()
                                    }
                                }
                            },
                        ) {
                            Icon(
                                if (inLib) Icons.Default.LibraryAddCheck else Icons.Default.LibraryAdd,
                                contentDescription = if (inLib) "Retiré" else "Enregistrer",
                            )
                        }
                    }
                }
                LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
                    item {
                        Row(
                            Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.Bottom,
                        ) {
                            cover?.let {
                                Box {
                                    MediaCover(it, 140.dp)
                                    if (collectionPinned) {
                                        PinnedBadge(
                                            modifier = Modifier
                                                .align(Alignment.TopStart)
                                                .padding(6.dp),
                                            size = 28.dp,
                                            onClick = {
                                                scope.launch {
                                                    val pinTrack = it.copy(
                                                        id = id,
                                                        type = when (kind) {
                                                            DetailKind.Mix -> "mix"
                                                            DetailKind.Playlist -> "playlist"
                                                            DetailKind.Album -> "album"
                                                            DetailKind.Artist -> "artist"
                                                        },
                                                        title = title.ifBlank { it.title },
                                                    )
                                                    container.quickAccess.toggle(pinTrack, container.api)
                                                }
                                            },
                                        )
                                    }
                                }
                            }
                            Spacer(Modifier.width(16.dp))
                            Column(Modifier.weight(1f)) {
                                Text(
                                    title,
                                    style = MaterialTheme.typography.headlineSmall,
                                    fontWeight = FontWeight.Bold,
                                    maxLines = 3,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    subtitle,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Spacer(Modifier.height(12.dp))
                                if (tracks.isNotEmpty()) {
                                    Row(
                                        Modifier.fillMaxWidth(),
                                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                                    ) {
                                        Button(
                                            onClick = {
                                                recordCollectionPlay()
                                                val kindStr = if (kind == DetailKind.Mix) "mix" else "playlist"
                                                player?.play(
                                                    tracks,
                                                    0,
                                                    title = title,
                                                    sourceId = id,
                                                    sourceKind = kindStr,
                                                ) ?: onPlayNamed(tracks, 0, title)
                                            },
                                            modifier = Modifier.weight(1f),
                                        ) {
                                            Icon(Icons.Default.PlayArrow, null, Modifier.size(20.dp))
                                            Spacer(Modifier.width(4.dp))
                                            Text("Lecture")
                                        }
                                        OutlinedButton(
                                            onClick = {
                                                recordCollectionPlay()
                                                val kindStr = if (kind == DetailKind.Mix) "mix" else "playlist"
                                                val shuffled = tracks.shuffled()
                                                player?.play(
                                                    shuffled,
                                                    0,
                                                    title = title,
                                                    sourceId = id,
                                                    sourceKind = kindStr,
                                                ) ?: onPlayNamed(shuffled, 0, title)
                                            },
                                            modifier = Modifier.weight(1f),
                                        ) {
                                            Icon(Icons.Default.Shuffle, null, Modifier.size(18.dp))
                                            Spacer(Modifier.width(4.dp))
                                            Text("Aléatoire")
                                        }
                                    }
                                }
                            }
                        }
                    }
                    itemsIndexed(tracks, key = { i, t -> "${t.id}-$i" }) { index, track ->
                        TrackRow(
                            track = track,
                            pinned = track.id in pinIds,
                            onTogglePin = {
                                scope.launch { container.quickAccess.toggle(track, container.api) }
                            },
                            onClick = {
                                val kindStr = if (kind == DetailKind.Mix) "mix" else "playlist"
                                player?.play(
                                    tracks,
                                    index,
                                    title = title,
                                    sourceId = id,
                                    sourceKind = kindStr,
                                ) ?: onPlayNamed(tracks, index, title)
                            },
                            onMore = {
                                onMore(track, if (kind == DetailKind.Playlist) id else null)
                            },
                        )
                    }
                }
            }
        }
    }

    if (showAlbumMenu && kind == DetailKind.Album) {
        AlbumOverflowSheet(
            title = title,
            onDismiss = { showAlbumMenu = false },
            downloadProgress = offlineProgress,
            downloaded = offlineDone,
            onDownload = {
                if (offlineDone || offlineProgress != null) return@AlbumOverflowSheet
                scope.launch {
                    offlineProgress = 0.05f
                    runCatching {
                        container.api.offlineStart(
                            mapOf("kind" to "album", "targetId" to id),
                        )
                    }.onSuccess { resp ->
                        val jobId = (resp["jobId"] as? String).orEmpty()
                        if (jobId.isBlank()) {
                            offlineProgress = null
                            Toast.makeText(context, "Téléchargement démarré", Toast.LENGTH_SHORT).show()
                            return@onSuccess
                        }
                        val ok = pollOfflineJob(container.api, jobId) { offlineProgress = it }
                        offlineDone = ok
                        offlineProgress = null
                        Toast.makeText(
                            context,
                            if (ok) "Album téléchargé" else "Téléchargement en cours…",
                            Toast.LENGTH_SHORT,
                        ).show()
                    }.onFailure {
                        offlineProgress = null
                        Toast.makeText(context, it.message ?: "Échec offline", Toast.LENGTH_SHORT).show()
                    }
                }
            },
            onPlayNext = {
                showAlbumMenu = false
                if (tracks.isEmpty()) return@AlbumOverflowSheet
                player?.playNextMany(tracks)
                    ?: run { onPlay(tracks, 0) }
                Toast.makeText(context, "Lecture ensuite", Toast.LENGTH_SHORT).show()
            },
            onAddToQueue = {
                showAlbumMenu = false
                if (tracks.isEmpty()) return@AlbumOverflowSheet
                player?.addManyToQueue(tracks)
                    ?: run { onPlay(tracks, 0) }
                Toast.makeText(context, "Ajouté à la file", Toast.LENGTH_SHORT).show()
            },
            onAddToPlaylist = {
                showAlbumMenu = false
                val seedTrack = tracks.firstOrNull()
                    ?: cover
                    ?: TrackDto(id = id, title = title, type = "album")
                onOpenAddToPlaylist(seedTrack)
            },
            onOpenArtist = {
                showAlbumMenu = false
                val aid = artistId
                if (!aid.isNullOrBlank()) onOpenArtist(aid, artistLine)
                else Toast.makeText(context, "Artiste indisponible", Toast.LENGTH_SHORT).show()
            },
            onQuickAccess = {
                showAlbumMenu = false
                scope.launch {
                    val pinTrack = cover ?: TrackDto(
                        id = id,
                        title = title,
                        type = "album",
                        artists = listOf(ArtistRef(artistLine, artistId)),
                    )
                    val pinned = container.quickAccess.toggle(pinTrack, container.api)
                    Toast.makeText(
                        context,
                        if (pinned) "Ajouté à l'accès rapide" else "Retiré de l'accès rapide",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
            },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AlbumHeroHeader(
    title: String,
    artistLine: String,
    metaLine: String,
    cover: TrackDto?,
    inLibrary: Boolean,
    pinned: Boolean = false,
    radioBusy: Boolean,
    onBack: () -> Unit,
    onTogglePin: (() -> Unit)? = null,
    onArtistClick: () -> Unit,
    onShuffle: () -> Unit,
    onToggleLibrary: () -> Unit,
    onPlay: () -> Unit,
    onRadio: () -> Unit,
    onMore: () -> Unit,
) {
    val screenW = LocalConfiguration.current.screenWidthDp.dp
    // ~moitié moins large qu’avant (~0.72 → ~0.36), lisible sans plein écran
    val coverSize = (screenW * 0.36f).coerceIn(140.dp, 176.dp)

    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 4.dp, vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(
                onClick = onBack,
                modifier = Modifier.size(56.dp),
            ) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "Retour",
                    modifier = Modifier.size(32.dp),
                )
            }
            Column(
                Modifier.weight(1f),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                if (artistLine.isNotBlank()) {
                    Text(
                        artistLine,
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable(onClick = onArtistClick)
                            .padding(horizontal = 4.dp),
                    )
                }
                Text(
                    metaLine,
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                )
            }
            Spacer(Modifier.size(56.dp))
        }

        Spacer(Modifier.height(8.dp))

        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            cover?.let {
                Box {
                    MediaCover(it, coverSize)
                    if (pinned) {
                        PinnedBadge(
                            modifier = Modifier
                                .align(Alignment.TopStart)
                                .padding(8.dp),
                            size = 30.dp,
                            onClick = onTogglePin,
                        )
                    }
                }
            }
        }

        Spacer(Modifier.height(12.dp))

        Text(
            title,
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp),
        )

        Spacer(Modifier.height(14.dp))

        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RoundIconAction(
                icon = Icons.Default.Shuffle,
                label = "Aléatoire",
                hint = "Lecture aléatoire de l'album",
                onClick = onShuffle,
            )
            RoundIconAction(
                icon = if (inLibrary) Icons.Default.LibraryAddCheck else Icons.Default.LibraryAdd,
                label = if (inLibrary) "Bibliothèque" else "Enregistrer",
                hint = if (inLibrary) {
                    "Déjà dans ta bibliothèque — appuie pour retirer"
                } else {
                    "Enregistrer l'album dans ta bibliothèque"
                },
                onClick = onToggleLibrary,
                tint = if (inLibrary) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
            )
            TooltipBox(
                positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(),
                tooltip = {
                    PlainTooltip { Text("Tout lire") }
                },
                state = rememberTooltipState(),
            ) {
                Box(
                    modifier = Modifier
                        .size(68.dp)
                        .clip(CircleShape)
                        .background(Color.White)
                        .clickable(onClick = onPlay),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Icons.Default.PlayArrow,
                        contentDescription = "Tout lire",
                        tint = Color.Black,
                        modifier = Modifier.size(40.dp),
                    )
                }
            }
            RoundIconAction(
                icon = MixIcon,
                label = "",
                hint = "Lancer un mix radio à partir de cet album",
                onClick = onRadio,
                enabled = !radioBusy,
                tint = Color(0xFFFF0033),
            )
            RoundIconAction(
                icon = Icons.Default.MoreVert,
                label = "Plus",
                hint = "Plus d'options",
                onClick = onMore,
            )
        }

        Spacer(Modifier.height(20.dp))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RoundIconAction(
    icon: ImageVector,
    label: String,
    hint: String = label,
    onClick: () -> Unit,
    enabled: Boolean = true,
    tint: Color = MaterialTheme.colorScheme.onSurface,
) {
    val tooltipState = rememberTooltipState()
    TooltipBox(
        positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(),
        tooltip = {
            PlainTooltip { Text(hint) }
        },
        state = tooltipState,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            IconButton(
                onClick = onClick,
                enabled = enabled,
                modifier = Modifier.size(48.dp),
            ) {
                Icon(
                    icon,
                    contentDescription = hint,
                    tint = if (enabled) tint else tint.copy(alpha = 0.4f),
                    modifier = Modifier.size(if (label.isEmpty()) 28.dp else 26.dp),
                )
            }
            if (label.isNotEmpty()) {
                Text(
                    label,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(
                        alpha = if (enabled) 0.85f else 0.4f,
                    ),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            } else {
                Spacer(Modifier.height(16.dp))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AlbumOverflowSheet(
    title: String,
    onDismiss: () -> Unit,
    downloadProgress: Float?,
    downloaded: Boolean,
    onDownload: () -> Unit,
    onPlayNext: () -> Unit,
    onAddToQueue: () -> Unit,
    onAddToPlaylist: () -> Unit,
    onOpenArtist: () -> Unit,
    onQuickAccess: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        Column(Modifier.padding(bottom = 28.dp)) {
            Text(
                title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            )
            HorizontalDivider()
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable(enabled = downloadProgress == null && !downloaded, onClick = onDownload)
                    .padding(horizontal = 20.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                DownloadStatusIcon(
                    downloaded = downloaded,
                    progress = downloadProgress,
                    size = 24.dp,
                    accent = Color(0xFFFF0033),
                )
                Spacer(Modifier.width(16.dp))
                Text(
                    when {
                        downloaded -> "Album téléchargé"
                        downloadProgress != null ->
                            "Téléchargement ${(downloadProgress * 100).toInt()} %"
                        else -> "Télécharger l'album"
                    },
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
            AlbumMenuRow(Icons.Default.SkipNext, "Lire ensuite", onPlayNext)
            AlbumMenuRow(Icons.Default.QueueMusic, "Ajouter à la file d'attente", onAddToQueue)
            AlbumMenuRow(Icons.Default.PlaylistAdd, "Enregistrer dans une playlist", onAddToPlaylist)
            AlbumMenuRow(Icons.Default.Person, "Accéder à la page de l'artiste", onOpenArtist)
            AlbumMenuRow(Icons.Outlined.PushPin, "Ajouter à l'accès rapide", onQuickAccess)
        }
    }
}

@Composable
private fun AlbumMenuRow(icon: ImageVector, label: String, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(24.dp))
        Spacer(Modifier.width(16.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge)
    }
}
