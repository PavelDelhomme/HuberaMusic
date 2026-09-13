package ovh.delhomme.ytmusic.ui.quickaccess

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.DragHandle
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
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
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.ui.components.TrackRow
import ovh.delhomme.ytmusic.ui.components.dragReorderHandle
import ovh.delhomme.ytmusic.ui.components.dragReorderItem
import ovh.delhomme.ytmusic.ui.components.dragReorderLongPress
import ovh.delhomme.ytmusic.ui.components.rememberDragReorderState
import ovh.delhomme.ytmusic.ui.library.playQueueWithLead
import ovh.delhomme.ytmusic.ui.library.playQuickAccessShuffled
import ovh.delhomme.ytmusic.ui.util.toastMain

@Composable
fun QuickAccessScreen(
    container: AppContainer,
    onBack: () -> Unit = {},
    onPlay: (List<TrackDto>, Int) -> Unit,
    onPlayNamed: (List<TrackDto>, Int, String) -> Unit = { q, i, _ -> onPlay(q, i) },
    onMore: (TrackDto) -> Unit = {},
    onOpenDetail: (TrackDto) -> Unit = {},
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val pinsRemote by container.quickAccess.pins.collectAsState(initial = emptyList())
    var order by remember { mutableStateOf(pinsRemote) }
    var shuffleBusy by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val reorderState = rememberDragReorderState(
        listState = listState,
        onMove = { from, to ->
            if (from !in order.indices || to !in order.indices || from == to) return@rememberDragReorderState
            order = order.toMutableList().also { list ->
                val item = list.removeAt(from)
                list.add(to, item)
            }
        },
        onDragEnd = {
            scope.launch {
                container.quickAccess.reorder(order.map { it.id }, container.api)
            }
        },
    )
    LaunchedEffect(pinsRemote) {
        if (!reorderState.isDragging) order = pinsRemote
    }
    val keys = remember(order) { order.map { it.id }.toSet() }
    val keyToIndex = remember(order) { order.mapIndexed { i, t -> t.id to i }.toMap() }
    LaunchedEffect(keys, keyToIndex) {
        reorderState.configure(keys) { keyToIndex[it] }
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
                "Accès rapide",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold,
                modifier = Modifier.weight(1f),
            )
            if (order.isNotEmpty()) {
                IconButton(
                    onClick = {
                        if (shuffleBusy) return@IconButton
                        shuffleBusy = true
                        scope.launch {
                            try {
                                val ok = playQuickAccessShuffled(container, order) { q, i ->
                                    onPlayNamed(q, i, "Accès rapide · Aléatoire")
                                }
                                if (!ok) context.toastMain("Aucun titre jouable")
                            } finally {
                                shuffleBusy = false
                            }
                        }
                    },
                ) {
                    if (shuffleBusy) {
                        CircularProgressIndicator(Modifier.size(22.dp))
                    } else {
                        Icon(Icons.Default.Shuffle, contentDescription = "Aléatoire")
                    }
                }
            }
        }
        Text(
            "Reste appuyé ou glisse ≡ pour réordonner",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp),
        )

        if (order.isEmpty()) {
            Column(
                Modifier
                    .fillMaxSize()
                    .padding(32.dp),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    "Rien d'épinglé pour l'instant",
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    "Utilise « Épingler dans l'accès rapide » sur un titre, album ou playlist.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        } else {
            LazyColumn(
                state = listState,
                contentPadding = PaddingValues(top = 12.dp, bottom = 24.dp),
            ) {
                itemsIndexed(order, key = { _, track -> track.id }) { index, track ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .dragReorderItem(reorderState, track.id)
                            .dragReorderLongPress(reorderState, listState, index, track.id),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            Icons.Default.DragHandle,
                            contentDescription = "Déplacer",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier
                                .size(40.dp)
                                .padding(6.dp)
                                .dragReorderHandle(reorderState, listState, index, track.id),
                        )
                        TrackRow(
                            track = track,
                            onClick = {
                                if (
                                    track.isPlaylist() ||
                                    track.isAlbum() ||
                                    track.isArtist() ||
                                    track.isMix()
                                ) {
                                    onOpenDetail(track)
                                    return@TrackRow
                                }
                                scope.launch {
                                    if (track.isPlayable()) {
                                        val music = order.filter { it.isMusicTrack() }
                                        val list =
                                            if (music.any { it.id == track.id }) music
                                            else listOf(track)
                                        val idx =
                                            list.indexOfFirst { it.id == track.id }.coerceAtLeast(0)
                                        playQueueWithLead(container, list, idx) { q, i ->
                                            onPlayNamed(q, i, "Accès rapide")
                                        }
                                    } else {
                                        onOpenDetail(track)
                                    }
                                }
                            },
                            onMore = { onMore(track) },
                            pinned = true,
                            onTogglePin = {
                                scope.launch {
                                    container.quickAccess.toggle(track, container.api)
                                }
                            },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
        }
    }
}
