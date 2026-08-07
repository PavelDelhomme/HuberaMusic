package ovh.delhomme.ytmusic.ui.components

import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Album
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Bedtime
import androidx.compose.material.icons.filled.Cast
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.DownloadDone
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.LibraryAdd
import androidx.compose.material.icons.filled.LibraryAddCheck
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.PlaylistAdd
import androidx.compose.material.icons.filled.PlaylistRemove
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.QueueMusic
import androidx.compose.material.icons.filled.RemoveFromQueue
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SpatialAudioOff
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.SyncDisabled
import androidx.compose.material.icons.filled.ThumbDown
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.ArtistRef
import ovh.delhomme.ytmusic.data.CreatePlaylistBody
import ovh.delhomme.ytmusic.data.PlaylistDto
import ovh.delhomme.ytmusic.data.RecoFeedbackBody
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.data.buildRadioQueue
import ovh.delhomme.ytmusic.data.buildRadioQueueContinuation
import ovh.delhomme.ytmusic.data.resolveArtistId
import ovh.delhomme.ytmusic.debug.AppLog
import ovh.delhomme.ytmusic.player.PlayerController

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrackActionsSheet(
    track: TrackDto,
    container: AppContainer,
    player: PlayerController,
    likedIds: Set<String>,
    onDismiss: () -> Unit,
    onLikedChanged: (Set<String>) -> Unit,
    onOpenAddToPlaylist: () -> Unit,
    onOpenAlbum: ((String) -> Unit)? = null,
    onOpenArtist: ((String) -> Unit)? = null,
    onCast: (() -> Unit)? = null,
    playlistId: String? = null,
    onRemovedFromPlaylist: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val maxSheetBody = (LocalConfiguration.current.screenHeightDp * 0.72f).dp
    var enriched by remember(track.id) { mutableStateOf(track) }
    var pinned by remember { mutableStateOf(false) }
    var showSleep by remember { mutableStateOf(false) }
    var downloaded by remember { mutableStateOf(false) }
    var downloadProgress by remember { mutableStateOf<Float?>(null) }
    var albumInLibrary by remember { mutableStateOf(false) }
    var songInLibrary by remember { mutableStateOf(false) }
    var liked by remember(track.id) { mutableStateOf(track.id in likedIds) }
    var receiveRemoteSync by remember { mutableStateOf(container.receiveRemoteSync()) }
    val playerUi by player.state.collectAsState()
    val queueIndex = playerUi.queue.indexOfFirst { it.id == enriched.id }
    val inQueue = queueIndex >= 0
    val isCurrent = inQueue && queueIndex == playerUi.queueIndex
    val inLibrary = songInLibrary ||
        (enriched.isAlbum() && albumInLibrary) ||
        (enriched.album?.id != null && albumInLibrary && !enriched.isPlayable())

    LaunchedEffect(track.id, likedIds) {
        // Sync cœur uniquement — ne pas re-fetch library (écrasait l’optimiste)
        liked = track.id in likedIds
    }

    LaunchedEffect(track.id) {
        enriched = track
        pinned = container.quickAccess.isPinned(track.id)
        songInLibrary = false
        albumInLibrary = false
        runCatching {
            container.ensureFreshToken()
            if (track.isPlayable()) {
                runCatching { container.api.track(track.id).track }.getOrNull()?.let { meta ->
                    enriched = track.copy(
                        artists = when {
                            !meta.artists.isNullOrEmpty() -> meta.artists
                            else -> track.artists
                        },
                        album = meta.album ?: track.album,
                        thumbnails = track.thumbnails?.takeIf { it.isNotEmpty() } ?: meta.thumbnails,
                        duration = track.duration ?: meta.duration,
                    )
                }
            }
            val lib = runCatching { container.api.library() }.getOrNull()
            downloaded = container.offlineStore.has(track.id) ||
                (lib?.downloaded?.contains(track.id) == true)
            if (lib != null) {
                val serverLiked = lib.liked.any { it.id == track.id }
                // Ne réécrit liked que si désync (évite flash)
                if (serverLiked != (track.id in likedIds)) {
                    liked = serverLiked
                    onLikedChanged(
                        if (serverLiked) likedIds + track.id else likedIds - track.id,
                    )
                }
                songInLibrary = lib.songs.any { it.id == track.id } ||
                    (lib.songs.isEmpty() && lib.liked.any { it.id == track.id })
                val albumId = enriched.album?.id ?: enriched.id.takeIf { enriched.isAlbum() }
                albumInLibrary = albumId != null && lib.albums.any { it.id == albumId }
                if (track.type?.equals("mix", ignoreCase = true) == true) {
                    songInLibrary = lib.mixes.any { it.id == track.id }
                }
            } else {
                downloaded = container.offlineStore.has(track.id)
            }
        }
    }

    fun openArtistPage(artist: ArtistRef) {
        scope.launch {
            val id = resolveArtistId(container.api, artist.id, artist.name)
            if (id.isNullOrBlank()) {
                Toast.makeText(context, "Artiste introuvable", Toast.LENGTH_SHORT).show()
            } else {
                onOpenArtist?.invoke(id)
                onDismiss()
            }
        }
    }

    fun openAlbumPage() {
        scope.launch {
            var albumId = enriched.album?.id
            if (albumId.isNullOrBlank() && enriched.isPlayable()) {
                albumId = runCatching { container.api.track(enriched.id).track.album?.id }.getOrNull()
            }
            if (albumId.isNullOrBlank() && !enriched.album?.name.isNullOrBlank()) {
                albumId = runCatching {
                    container.api.search(enriched.album!!.name!!, "album").albums.firstOrNull()?.id
                }.getOrNull()
            }
            if (albumId.isNullOrBlank() && enriched.isAlbum()) albumId = enriched.id
            if (albumId.isNullOrBlank()) {
                Toast.makeText(context, "Album introuvable", Toast.LENGTH_SHORT).show()
            } else {
                onOpenAlbum?.invoke(albumId)
                onDismiss()
            }
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        val onSurface = MaterialTheme.colorScheme.onSurface
        val muted = MaterialTheme.colorScheme.onSurfaceVariant
        val namedArtists = enriched.artists.orEmpty().mapNotNull { a ->
            val name = a.name.trim().takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            if (name.equals("Inconnu", true) || name.equals("Unknown", true)) return@mapNotNull null
            a.copy(name = name)
        }
        val canOpenAlbum = !enriched.album?.id.isNullOrBlank() ||
            !enriched.album?.name.isNullOrBlank() ||
            enriched.isAlbum()

        Column(
            Modifier
                .fillMaxWidth()
                .heightIn(max = maxSheetBody)
                .verticalScroll(rememberScrollState()),
        ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            MediaCover(enriched, 56.dp)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    enriched.title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = onSurface,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    buildString {
                        append(enriched.artistLine())
                        enriched.duration?.takeIf { it.isNotBlank() }?.let {
                            append(" · ")
                            append(it)
                        }
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = muted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (enriched.isPlayable()) {
                IconButton(
                    onClick = {
                        scope.launch {
                            runCatching {
                                AppLog.breadcrumb("like", enriched.id)
                                val r = container.api.like(enriched)
                                liked = r.liked
                                onLikedChanged(
                                    if (r.liked) likedIds + enriched.id else likedIds - enriched.id,
                                )
                                r.library?.let { lib ->
                                    songInLibrary = lib.songs.any { it.id == enriched.id } ||
                                        (lib.songs.isEmpty() && lib.liked.any { it.id == enriched.id })
                                }
                                container.api.recoFeedback(
                                    RecoFeedbackBody(
                                        enriched.id,
                                        if (r.liked) "good" else "bad",
                                        "actions_like",
                                    ),
                                )
                            }.onFailure { AppLog.e("like", "échec like ${enriched.id}", it) }
                        }
                    },
                ) {
                    Icon(
                        if (liked) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                        contentDescription = "J'aime",
                        tint = if (liked) MaterialTheme.colorScheme.primary else onSurface,
                    )
                }
            }
            IconButton(onClick = onDismiss) {
                Icon(Icons.Default.Close, contentDescription = "Fermer", tint = onSurface)
            }
        }

        if (enriched.type?.equals("mix", ignoreCase = true) == true) {
            SheetAction(Icons.Default.PlayArrow, "Lire le mix") {
                scope.launch {
                    runCatching {
                        container.ensureFreshToken()
                        val mix = container.api.recoRadio(enriched.id)
                        val tracks = mix.tracks.filter { it.isPlayable() }
                        if (tracks.isNotEmpty()) {
                            player.play(tracks, 0, enriched.title, userQueueEnd = tracks.size)
                        }
                    }
                    onDismiss()
                }
            }
            SheetAction(
                if (songInLibrary) Icons.Default.LibraryAddCheck else Icons.Default.LibraryAdd,
                if (songInLibrary) "Retirer de la bibliothèque" else "Enregistrer le mix",
            ) {
                scope.launch {
                    runCatching {
                        container.ensureFreshToken()
                        if (songInLibrary) {
                            container.api.removeMix(enriched.id)
                            songInLibrary = false
                            Toast.makeText(context, "Mix retiré", Toast.LENGTH_SHORT).show()
                        } else {
                            container.api.saveMix(
                                mapOf(
                                    "id" to enriched.id,
                                    "title" to enriched.title,
                                ),
                            )
                            songInLibrary = true
                            Toast.makeText(context, "Mix enregistré", Toast.LENGTH_SHORT).show()
                        }
                    }
                    onDismiss()
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.4f))
        }

        if (enriched.isPlayable()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 8.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.SpaceEvenly,
            ) {
                QuickAction(Icons.Default.SkipNext, "Lire ensuite") {
                    player.playNext(enriched)
                    Toast.makeText(context, "Sera lu ensuite", Toast.LENGTH_SHORT).show()
                    onDismiss()
                }
                QuickAction(Icons.Default.PlaylistAdd, "Enregistrer dans une playlist") {
                    onOpenAddToPlaylist()
                }
                QuickAction(Icons.Default.Share, "Partager") {
                    val send = Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(
                            Intent.EXTRA_TEXT,
                            "${enriched.title} — ${enriched.artistLine()}\nhttps://music.youtube.com/watch?v=${enriched.id}",
                        )
                    }
                    context.startActivity(Intent.createChooser(send, "Partager"))
                    onDismiss()
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.4f))
        }

        // Accès artiste / album en haut (toujours visibles + scrollables)
        namedArtists.forEach { a ->
            SheetAction(Icons.Default.Person, "Accéder à ${a.name}") {
                openArtistPage(a)
            }
        }
        if (canOpenAlbum) {
            SheetAction(
                Icons.Default.Album,
                "Accéder à l'album",
                enriched.album?.name ?: enriched.title.takeIf { enriched.isAlbum() },
            ) {
                openAlbumPage()
            }
        }
        if (namedArtists.isNotEmpty() || canOpenAlbum) {
            HorizontalDivider(
                Modifier.padding(vertical = 4.dp),
                color = MaterialTheme.colorScheme.outline.copy(alpha = 0.4f),
            )
        }

        if (enriched.isPlayable()) {
            // Bibliothèque + téléchargement (juste après navigation)
            SheetAction(
                if (songInLibrary) Icons.Default.LibraryAddCheck else Icons.Default.LibraryAdd,
                if (songInLibrary) "Dans la bibliothèque" else "Enregistrer dans la bibliothèque",
                if (songInLibrary) "Retirer (sans toucher au J'aime)" else "Sans ajouter aux J'aime",
            ) {
                scope.launch {
                    runCatching {
                        container.ensureFreshToken()
                        // Optimistic immédiat
                        val next = !songInLibrary
                        songInLibrary = next
                        val r = container.api.toggleLibrarySong(enriched)
                        songInLibrary = r.saved
                        r.library?.let { lib ->
                            songInLibrary = lib.songs.any { it.id == enriched.id } || r.saved
                        }
                        container.bumpLibraryEpoch()
                        Toast.makeText(
                            context,
                            if (r.saved) "Dans la bibliothèque" else "Retiré de la bibliothèque",
                            Toast.LENGTH_SHORT,
                        ).show()
                        // Garde la sheet ouverte pour voir le libellé mis à jour
                    }.onFailure {
                        songInLibrary = !songInLibrary // rollback
                        Toast.makeText(
                            context,
                            it.message ?: "Impossible de modifier la bibliothèque",
                            Toast.LENGTH_SHORT,
                        ).show()
                    }
                }
            }
            SheetAction(
                leading = {
                    DownloadStatusIcon(
                        downloaded = downloaded,
                        progress = downloadProgress,
                        size = 26.dp,
                        accent = Color(0xFFFF0033),
                    )
                },
                label = when {
                    downloaded -> "Sur l'appareil"
                    downloadProgress != null -> "Téléchargement ${(downloadProgress!! * 100).toInt()} %"
                    else -> "Télécharger"
                },
                enabled = downloadProgress == null,
            ) {
                if (downloaded) {
                    Toast.makeText(context, "Déjà sur l'appareil (lisible hors-ligne)", Toast.LENGTH_SHORT).show()
                    return@SheetAction
                }
                scope.launch {
                    downloadProgress = 0.02f
                    runCatching {
                        container.ensureFreshToken()
                        container.offlineStore.download(
                            enriched,
                            container.remoteStreamUrl(enriched.id),
                        ) { p -> downloadProgress = p.coerceIn(0.02f, 0.99f) }
                    }.onSuccess { result ->
                        result.getOrThrow()
                        downloadProgress = 1f
                        downloaded = true
                        // Best-effort sync serveur (n’empêche pas le local)
                        runCatching { container.api.download(enriched.id) }
                        delay(200)
                        downloadProgress = null
                        Toast.makeText(context, "Téléchargé — lisible hors-ligne", Toast.LENGTH_SHORT).show()
                    }.onFailure {
                        downloadProgress = null
                        Toast.makeText(context, it.message ?: "Échec téléchargement", Toast.LENGTH_SHORT).show()
                    }
                }
            }

            // Radios — hard-start + top-up progressif (évite soft-enqueue / file à 1 titre)
            SheetAction(Icons.Default.AutoAwesome, "En rapport", "Mix · similaires + découverte") {
                scope.launch {
                    val ok = runCatching {
                        val mix = buildRadioQueue(
                            container.api, "track", enriched.id, enriched,
                            mixCache = container.mixCache, progressive = true,
                        )
                        if (mix.isEmpty()) {
                            Toast.makeText(context, "Mix indisponible", Toast.LENGTH_SHORT).show()
                            return@runCatching
                        }
                        player.playRadioOrEnqueue(mix, "En rapport")
                        Toast.makeText(
                            context,
                            "Mix démarré · ${mix.size} titres",
                            Toast.LENGTH_SHORT,
                        ).show()
                        // Top-up en arrière-plan
                        val more = buildRadioQueueContinuation(
                            container.api, enriched.id, mix.map { it.id }.toSet(),
                            mixCache = container.mixCache,
                        )
                        if (more.isNotEmpty()) player.appendRadioContinuation(more, forSeedId = enriched.id)
                    }.isSuccess
                    if (!ok) {
                        Toast.makeText(context, "Échec mix", Toast.LENGTH_SHORT).show()
                    }
                    onDismiss()
                }
            }
            if (namedArtists.isNotEmpty()) {
                SheetAction(Icons.Default.SpatialAudioOff, "Radio proche de l'artiste", "Plus du même univers") {
                    scope.launch {
                        runCatching {
                            val mix = buildRadioQueue(
                                container.api, "track", enriched.id, enriched, stayClose = true,
                                mixCache = container.mixCache, progressive = true,
                            )
                            if (mix.isNotEmpty()) {
                                player.playRadioOrEnqueue(mix, "Radio")
                                Toast.makeText(
                                    context,
                                    "Radio démarrée · ${mix.size} titres",
                                    Toast.LENGTH_SHORT,
                                ).show()
                                val more = buildRadioQueueContinuation(
                                    container.api, enriched.id, mix.map { it.id }.toSet(),
                                    mixCache = container.mixCache,
                                )
                                if (more.isNotEmpty()) {
                                    player.appendRadioContinuation(more, forSeedId = enriched.id)
                                }
                            } else {
                                Toast.makeText(context, "Radio indisponible", Toast.LENGTH_SHORT).show()
                            }
                        }.onFailure {
                            Toast.makeText(context, "Radio indisponible", Toast.LENGTH_SHORT).show()
                        }
                        onDismiss()
                    }
                }
            }
            enriched.album?.id?.let { albumId ->
                SheetAction(Icons.Default.Album, "Radio de l'album") {
                    scope.launch {
                        runCatching {
                            val mix = buildRadioQueue(container.api, "album", albumId, enriched, mixCache = container.mixCache)
                            if (mix.isNotEmpty()) {
                                player.playRadioOrEnqueue(mix, "Radio album")
                                val added = (mix.size - 1).coerceAtLeast(0)
                                Toast.makeText(
                                    context,
                                    if (added > 0) "$added titre${if (added > 1) "s" else ""} similaires ajoutés"
                                    else "Radio album démarrée",
                                    Toast.LENGTH_SHORT,
                                ).show()
                            } else {
                                Toast.makeText(context, "Radio album indisponible", Toast.LENGTH_SHORT).show()
                            }
                        }
                        onDismiss()
                    }
                }
            }
            namedArtists.firstOrNull()?.let { artist ->
                SheetAction(Icons.Default.Mic, "Radio de l'artiste", artist.name) {
                    scope.launch {
                        runCatching {
                            val artistId = resolveArtistId(container.api, artist.id, artist.name)
                                ?: return@runCatching
                            val mix = buildRadioQueue(container.api, "artist", artistId, enriched, mixCache = container.mixCache)
                            if (mix.isNotEmpty()) {
                                player.playRadioOrEnqueue(mix, "Radio · ${artist.name}")
                                val added = (mix.size - 1).coerceAtLeast(0)
                                Toast.makeText(
                                    context,
                                    if (added > 0) {
                                        "$added titre${if (added > 1) "s" else ""} en lien avec ${artist.name}"
                                    } else {
                                        "Radio artiste démarrée"
                                    },
                                    Toast.LENGTH_LONG,
                                ).show()
                            }
                        }
                        onDismiss()
                    }
                }
            }

            // File d'attente
            if (inQueue && !isCurrent) {
                SheetAction(Icons.Default.RemoveFromQueue, "Supprimer de la file d'attente") {
                    player.removeFromQueue(queueIndex)
                    Toast.makeText(context, "Retiré de la file", Toast.LENGTH_SHORT).show()
                    onDismiss()
                }
            } else {
                SheetAction(Icons.Default.QueueMusic, "Ajouter à la file d'attente") {
                    player.addToQueue(enriched)
                    Toast.makeText(context, "Ajouté à la file", Toast.LENGTH_SHORT).show()
                    onDismiss()
                }
            }

            enriched.album?.id?.let { albumId ->
                SheetAction(
                    if (albumInLibrary) Icons.Default.CheckCircle else Icons.Default.Album,
                    if (albumInLibrary) "Album dans la bibliothèque" else "Enregistrer l'album",
                    enriched.album?.name,
                ) {
                    scope.launch {
                        runCatching {
                            if (albumInLibrary) {
                                container.api.removeAlbum(albumId)
                                albumInLibrary = false
                                Toast.makeText(context, "Album retiré", Toast.LENGTH_SHORT).show()
                            } else {
                                container.api.saveAlbum(
                                    TrackDto(
                                        id = albumId,
                                        title = enriched.album?.name ?: enriched.title,
                                        artists = enriched.artists,
                                        thumbnails = enriched.thumbnails,
                                        type = "album",
                                    ),
                                )
                                albumInLibrary = true
                                Toast.makeText(context, "Album enregistré", Toast.LENGTH_SHORT).show()
                            }
                        }.onFailure {
                            Toast.makeText(context, it.message ?: "Échec", Toast.LENGTH_SHORT).show()
                        }
                        onDismiss()
                    }
                }
            }

            SheetAction(Icons.Default.ThumbDown, "Je n'aime pas", "Signale au moteur de reco") {
                scope.launch {
                    runCatching {
                        container.api.recoFeedback(
                            RecoFeedbackBody(enriched.id, "bad", "actions_dislike"),
                        )
                        Toast.makeText(context, "Retour enregistré", Toast.LENGTH_SHORT).show()
                    }
                    onDismiss()
                }
            }

            if (onCast != null) {
                SheetAction(Icons.Default.Cast, "Caster", "Écouter sur un autre appareil") {
                    onDismiss()
                    onCast()
                }
            }
            SheetAction(
                if (receiveRemoteSync) Icons.Default.SyncDisabled else Icons.Default.Sync,
                if (receiveRemoteSync) "Désactiver la sync lecture" else "Activer la sync lecture",
                if (receiveRemoteSync) {
                    "File et titre redeviennent locaux à cet appareil"
                } else {
                    "Partager file / titre / position avec tes autres appareils"
                },
            ) {
                val next = !receiveRemoteSync
                container.setReceiveRemoteSync(next)
                receiveRemoteSync = next
                Toast.makeText(
                    context,
                    if (next) "Sync lecture activée" else "Sync lecture désactivée — file locale",
                    Toast.LENGTH_SHORT,
                ).show()
                onDismiss()
            }
        } else if (enriched.isAlbum() || enriched.isPlaylist() || enriched.isArtist()) {
            SheetAction(
                if (inLibrary || albumInLibrary) Icons.Default.LibraryAddCheck else Icons.Default.LibraryAdd,
                if (inLibrary || albumInLibrary) "Dans la bibliothèque" else "Enregistrer dans la bibliothèque",
            ) {
                scope.launch {
                    runCatching {
                        when {
                            enriched.isAlbum() -> {
                                if (albumInLibrary) {
                                    container.api.removeAlbum(enriched.id)
                                    albumInLibrary = false
                                } else {
                                    container.api.saveAlbum(enriched.copy(type = "album"))
                                    albumInLibrary = true
                                }
                            }
                            enriched.isArtist() -> container.api.saveArtist(enriched.copy(type = "artist"))
                            enriched.isPlaylist() -> {
                                // Aimer la playlist seulement — ne pas liker comme un titre
                                container.api.likePlaylist(enriched.copy(type = "playlist"))
                            }
                            else -> container.api.toggleLibrarySong(enriched)
                        }
                        Toast.makeText(context, "Bibliothèque mise à jour", Toast.LENGTH_SHORT).show()
                    }.onFailure {
                        Toast.makeText(context, it.message ?: "Échec", Toast.LENGTH_SHORT).show()
                    }
                    onDismiss()
                }
            }
        }

        if (!playlistId.isNullOrBlank()) {
            SheetAction(Icons.Default.PlaylistRemove, "Supprimer de la playlist") {
                scope.launch {
                    runCatching {
                        container.api.removeFromPlaylist(playlistId, enriched.id)
                        Toast.makeText(context, "Retiré de la playlist", Toast.LENGTH_SHORT).show()
                        onRemovedFromPlaylist?.invoke()
                    }.onFailure {
                        Toast.makeText(context, it.message ?: "Échec", Toast.LENGTH_SHORT).show()
                    }
                    onDismiss()
                }
            }
        }

        SheetAction(
            if (pinned) Icons.Default.PushPin else Icons.Outlined.PushPin,
            if (pinned) "Retirer de l'accès rapide" else "Épingler à l'accès rapide",
        ) {
            scope.launch {
                pinned = container.quickAccess.toggle(enriched, container.api)
                Toast.makeText(
                    context,
                    if (pinned) "Épinglé" else "Retiré de l'accès rapide",
                    Toast.LENGTH_SHORT,
                ).show()
                onDismiss()
            }
        }

        SheetAction(
            Icons.Default.Bedtime,
            "Délai de mise en veille",
            playerUi.sleepLabel?.let { "Actif : $it" },
        ) {
            showSleep = true
        }

        Spacer(Modifier.height(24.dp))
        } // end scroll Column
    }

    if (showSleep) {
        SleepTimerDialog(
            currentLabel = playerUi.sleepLabel,
            onDismiss = { showSleep = false },
            onPick = { delayMs, label ->
                if (delayMs == -1L) {
                    player.clearSleepTimer()
                    Toast.makeText(context, "Mise en veille annulée", Toast.LENGTH_SHORT).show()
                } else {
                    player.setSleepTimer(delayMs, label)
                    Toast.makeText(context, "Veille : $label", Toast.LENGTH_SHORT).show()
                }
                showSleep = false
                onDismiss()
            },
        )
    }
}

@Composable
private fun SleepTimerDialog(
    currentLabel: String?,
    onDismiss: () -> Unit,
    onPick: (delayMs: Long?, label: String) -> Unit,
) {
    val options = listOf(
        5L * 60_000 to "5 minutes",
        15L * 60_000 to "15 minutes",
        30L * 60_000 to "30 minutes",
        60L * 60_000 to "1 heure",
        null to "Fin de la chanson",
        -2L to "Fin de la file d'attente",
    )
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Délai de mise en veille") },
        text = {
            Column {
                currentLabel?.let {
                    Text(
                        "Actuel : $it",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(bottom = 8.dp),
                    )
                }
                options.forEach { (ms, label) ->
                    Text(
                        label,
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onPick(ms, label) }
                            .padding(vertical = 12.dp),
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
                if (currentLabel != null) {
                    Text(
                        "Annuler / manuel",
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onPick(-1L, "") }
                            .padding(vertical = 12.dp),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("Fermer") }
        },
    )
}

@Composable
private fun QuickAction(icon: ImageVector, label: String, onClick: () -> Unit) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 8.dp)
            .width(118.dp),
    ) {
        Box(
            Modifier
                .size(56.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(28.dp))
        }
        Spacer(Modifier.height(8.dp))
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.Center,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun SheetAction(
    icon: ImageVector,
    label: String,
    sub: String? = null,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    SheetAction(
        leading = {
            Icon(icon, null, tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(26.dp))
        },
        label = label,
        sub = sub,
        enabled = enabled,
        onClick = onClick,
    )
}

@Composable
private fun SheetAction(
    leading: @Composable () -> Unit,
    label: String,
    sub: String? = null,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Spacer(Modifier.width(18.dp))
        Column {
            Text(
                label,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface.copy(alpha = if (enabled) 1f else 0.55f),
            )
            if (!sub.isNullOrBlank()) {
                Text(
                    sub,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddToPlaylistSheet(
    track: TrackDto,
    container: AppContainer,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var playlists by remember { mutableStateOf<List<PlaylistDto>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var showCreate by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf("") }
    var containedIds by remember { mutableStateOf<Set<String>>(emptySet()) }

    LaunchedEffect(track.id) {
        loading = true
        playlists = runCatching { container.api.library().playlists }.getOrDefault(emptyList())
            .sortedByDescending { it.updatedAt ?: it.createdAt ?: 0L }
        containedIds = playlists
            .filter { pl -> pl.tracks.orEmpty().any { it.id == track.id } }
            .map { it.id }
            .toSet()
        loading = false
    }

    val recent = playlists.take(8)

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        Box(Modifier.fillMaxWidth()) {
            Column(Modifier.fillMaxWidth().padding(bottom = 88.dp)) {
                Text(
                    "Ajouter à une playlist",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
                )
                Text(
                    track.title,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = 20.dp),
                )
                Spacer(Modifier.height(16.dp))

                if (recent.isNotEmpty()) {
                    Text(
                        "Récentes",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
                    )
                    Row(
                        Modifier
                            .horizontalScroll(rememberScrollState())
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        recent.forEach { pl ->
                            val already = pl.id in containedIds
                            Column(
                                Modifier
                                    .width(96.dp)
                                    .clickable {
                                        if (already) {
                                            Toast.makeText(
                                                context,
                                                "Déjà dans ${pl.displayName()}",
                                                Toast.LENGTH_SHORT,
                                            ).show()
                                            return@clickable
                                        }
                                        scope.launch {
                                            runCatching { container.api.addToPlaylist(pl.id, track) }
                                                .onSuccess {
                                                    containedIds = containedIds + pl.id
                                                    Toast.makeText(
                                                        context,
                                                        "Ajouté à ${pl.displayName()}",
                                                        Toast.LENGTH_SHORT,
                                                    ).show()
                                                }
                                                .onFailure {
                                                    Toast.makeText(
                                                        context,
                                                        it.message?.takeIf { m -> m.isNotBlank() }
                                                            ?: "Impossible d'ajouter à la playlist",
                                                        Toast.LENGTH_SHORT,
                                                    ).show()
                                                }
                                        }
                                    },
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                Box(
                                    Modifier
                                        .size(88.dp)
                                        .clip(RoundedCornerShape(8.dp))
                                        .background(MaterialTheme.colorScheme.surfaceVariant),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    MediaCover(
                                        TrackDto(
                                            id = pl.id,
                                            title = pl.displayName(),
                                            thumbnails = pl.cover()?.let {
                                                listOf(ovh.delhomme.ytmusic.data.Thumb(it))
                                            },
                                            type = "playlist",
                                        ),
                                        88.dp,
                                    )
                                    if (already) {
                                        Box(
                                            Modifier
                                                .matchParentSize()
                                                .background(Color.Black.copy(alpha = 0.45f)),
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            Icon(
                                                Icons.Default.CheckCircle,
                                                contentDescription = "Déjà ajouté",
                                                tint = Color(0xFFFF0033),
                                                modifier = Modifier.size(32.dp),
                                            )
                                        }
                                    }
                                }
                                Spacer(Modifier.height(6.dp))
                                Text(
                                    pl.displayName(),
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.onSurface,
                                )
                                if (already) {
                                    Text(
                                        "Déjà ajouté",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = Color(0xFFFF0033),
                                        maxLines = 1,
                                    )
                                }
                            }
                        }
                    }
                    HorizontalDivider(
                        Modifier.padding(vertical = 8.dp),
                        color = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f),
                    )
                }

                Text(
                    "Toutes les playlists",
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
                )
                LazyColumn(
                    contentPadding = PaddingValues(bottom = 16.dp),
                    modifier = Modifier.height(320.dp),
                ) {
                    itemsIndexed(
                        playlists,
                        key = { index, pl -> "${pl.id}-$index" },
                    ) { _, pl ->
                        val already = pl.id in containedIds
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable {
                                    if (already) {
                                        Toast.makeText(
                                            context,
                                            "Déjà dans ${pl.displayName()}",
                                            Toast.LENGTH_SHORT,
                                        ).show()
                                        return@clickable
                                    }
                                    scope.launch {
                                        runCatching { container.api.addToPlaylist(pl.id, track) }
                                            .onSuccess {
                                                containedIds = containedIds + pl.id
                                                Toast.makeText(
                                                    context,
                                                    "Ajouté à ${pl.displayName()}",
                                                    Toast.LENGTH_SHORT,
                                                ).show()
                                            }
                                            .onFailure {
                                                Toast.makeText(
                                                    context,
                                                    it.message?.takeIf { m -> m.isNotBlank() }
                                                        ?: "Impossible d'ajouter à la playlist",
                                                    Toast.LENGTH_SHORT,
                                                ).show()
                                            }
                                    }
                                }
                                .padding(horizontal = 20.dp, vertical = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            MediaCover(
                                TrackDto(
                                    id = pl.id,
                                    title = pl.displayName(),
                                    thumbnails = pl.cover()?.let {
                                        listOf(ovh.delhomme.ytmusic.data.Thumb(it))
                                    },
                                    type = "playlist",
                                ),
                                48.dp,
                            )
                            Spacer(Modifier.width(14.dp))
                            Column(Modifier.weight(1f)) {
                                Text(
                                    pl.displayName(),
                                    fontWeight = FontWeight.Medium,
                                    color = MaterialTheme.colorScheme.onSurface,
                                )
                                Text(
                                    if (already) "Déjà dans cette playlist"
                                    else "${pl.tracks?.size ?: 0} titres",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = if (already) Color(0xFFFF0033)
                                    else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            if (already) {
                                Icon(
                                    Icons.Default.CheckCircle,
                                    contentDescription = null,
                                    tint = Color(0xFFFF0033),
                                    modifier = Modifier.size(22.dp),
                                )
                            }
                        }
                    }
                }
            }

            FloatingActionButton(
                onClick = { showCreate = true },
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(20.dp),
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
                shape = CircleShape,
            ) {
                Icon(Icons.Default.Add, contentDescription = "Nouvelle playlist")
            }
        }
    }

    if (showCreate) {
        AlertDialog(
            onDismissRequest = { showCreate = false },
            title = { Text("Nouvelle playlist") },
            text = {
                OutlinedTextField(
                    value = newName,
                    onValueChange = { newName = it },
                    singleLine = true,
                    placeholder = { Text("Nom") },
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        val name = newName.trim().ifBlank { "Nouvelle playlist" }
                        scope.launch {
                            runCatching {
                                val pl = container.api.createPlaylist(CreatePlaylistBody(name))
                                container.api.addToPlaylist(pl.id, track)
                                Toast.makeText(context, "Créée et titre ajouté", Toast.LENGTH_SHORT).show()
                                onDismiss()
                            }.onFailure {
                                Toast.makeText(context, it.message ?: "Erreur", Toast.LENGTH_SHORT).show()
                            }
                        }
                    },
                ) { Text("Créer") }
            },
            dismissButton = {
                TextButton(onClick = { showCreate = false }) { Text("Annuler") }
            },
        )
    }
}
