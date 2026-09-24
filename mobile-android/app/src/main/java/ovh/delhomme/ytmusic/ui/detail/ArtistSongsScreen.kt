package ovh.delhomme.ytmusic.ui.detail

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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.ui.components.MediaCover
import ovh.delhomme.ytmusic.ui.components.TrackRow
import ovh.delhomme.ytmusic.ui.library.playQueueWithLead
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch

/** Liste complète des titres d’un artiste (page dédiée depuis « Plus »). */
@Composable
fun ArtistSongsScreen(
    container: AppContainer,
    artistId: String,
    reloadToken: Int = 0,
    onBack: () -> Unit,
    onPlay: (List<TrackDto>, Int) -> Unit,
    onMore: (TrackDto) -> Unit,
    onOpenDetail: (TrackDto) -> Unit,
) {
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var name by remember { mutableStateOf("Artiste") }
    var cover by remember { mutableStateOf<TrackDto?>(null) }
    var tracks by remember { mutableStateOf<List<TrackDto>>(emptyList()) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(artistId, reloadToken) {
        loading = true
        error = null
        runCatching {
            val r = container.api.artistSongs(artistId)
            name = r.artist?.name ?: "Artiste"
            cover = r.artist?.asTrack()
            tracks = r.tracks.filter { it.isPlayable() }.distinctBy { it.id }
        }.onFailure {
            error = it.message ?: "Impossible de charger les titres"
        }
        loading = false
    }

    LaunchedEffect(tracks) {
        val ids = tracks.map { it.id }.filter { it.length == 11 }.take(20)
        if (ids.isEmpty()) return@LaunchedEffect
        container.libraryHeadPrefetcher.warmDisplayedList(ids)
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
                "Tous les titres",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
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
            error != null && tracks.isEmpty() -> {
                Text(error!!, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(24.dp))
            }
            else -> {
                LazyColumn(contentPadding = PaddingValues(bottom = 32.dp)) {
                    item {
                        Column(
                            Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 8.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            cover?.let {
                                MediaCover(it, 140.dp, circle = true)
                                Spacer(Modifier.height(14.dp))
                            }
                            Text(
                                "Discographie",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                name,
                                style = MaterialTheme.typography.headlineSmall,
                                fontWeight = FontWeight.Bold,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Text(
                                "${tracks.size} titre${if (tracks.size > 1) "s" else ""}",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            if (tracks.isNotEmpty()) {
                                Spacer(Modifier.height(14.dp))
                                Row(
                                    Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Button(
                                        onClick = {
                                            scope.launch {
                                                playQueueWithLead(container, tracks, 0, onPlay)
                                            }
                                        },
                                        modifier = Modifier.weight(1f),
                                    ) {
                                        Icon(Icons.Default.PlayArrow, null, Modifier.size(20.dp))
                                        Spacer(Modifier.width(4.dp))
                                        Text("Lecture")
                                    }
                                    OutlinedButton(
                                        onClick = { onPlay(tracks.shuffled(), 0) },
                                        modifier = Modifier.weight(1f),
                                    ) {
                                        Icon(Icons.Default.Shuffle, null, Modifier.size(18.dp))
                                        Spacer(Modifier.width(4.dp))
                                        Text("Aléatoire")
                                    }
                                }
                            }
                        }
                        Spacer(Modifier.height(8.dp))
                    }

                    itemsIndexed(tracks, key = { i, t -> "all-${t.id}-$i" }) { index, track ->
                        TrackRow(
                            track = track,
                            onClick = {
                                scope.launch {
                                    playQueueWithLead(container, tracks, index, onPlay)
                                }
                            },
                            onMore = { onMore(track) },
                            onOpenArtist = { id, n ->
                                if (id != null && id != artistId) {
                                    onOpenDetail(TrackDto(id = id, title = n, type = "artist"))
                                }
                            },
                        )
                    }
                }
            }
        }
    }
}
