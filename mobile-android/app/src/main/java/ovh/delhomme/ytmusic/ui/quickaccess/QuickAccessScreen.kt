package ovh.delhomme.ytmusic.ui.quickaccess

import androidx.compose.foundation.gestures.detectDragGestures
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.DragHandle
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.ui.components.TrackRow

@Composable
fun QuickAccessScreen(
    container: AppContainer,
    onBack: () -> Unit = {},
    onPlay: (List<TrackDto>, Int) -> Unit,
    onPlayNamed: (List<TrackDto>, Int, String) -> Unit = { tracks, idx, _ -> onPlay(tracks, idx) },
    onMore: (TrackDto) -> Unit,
    onOpenDetail: (TrackDto) -> Unit = {},
) {
    // Flux DataStore live — même source que le carrousel Accueil (pas de snapshot figé)
    val pins by container.quickAccess.pins.collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current

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
        }
        Text(
            "Premier épinglé en haut / à gauche · glisse la poignée pour réordonner",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
        )

        if (pins.isEmpty()) {
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
            LazyColumn(contentPadding = PaddingValues(top = 12.dp, bottom = 24.dp)) {
                itemsIndexed(pins, key = { _, track -> track.id }) { index, track ->
                    var dragAccum by remember(track.id) { mutableFloatStateOf(0f) }
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            Icons.Default.DragHandle,
                            contentDescription = "Déplacer",
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier
                                .size(40.dp)
                                .padding(6.dp)
                                .pointerInput(index, pins.size) {
                                    detectDragGestures(
                                        onDragEnd = { dragAccum = 0f },
                                        onDragCancel = { dragAccum = 0f },
                                        onDrag = { change, amount ->
                                            change.consume()
                                            dragAccum += amount.y
                                            val threshold = with(density) { 40.dp.toPx() }
                                            when {
                                                dragAccum > threshold && index < pins.lastIndex -> {
                                                    scope.launch {
                                                        container.quickAccess.move(
                                                            index,
                                                            index + 1,
                                                            container.api,
                                                        )
                                                    }
                                                    dragAccum = 0f
                                                }
                                                dragAccum < -threshold && index > 0 -> {
                                                    scope.launch {
                                                        container.quickAccess.move(
                                                            index,
                                                            index - 1,
                                                            container.api,
                                                        )
                                                    }
                                                    dragAccum = 0f
                                                }
                                            }
                                        },
                                    )
                                },
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
                                        val music = pins.filter { it.isMusicTrack() }
                                        val list =
                                            if (music.any { it.id == track.id }) music
                                            else listOf(track)
                                        val idx =
                                            list.indexOfFirst { it.id == track.id }.coerceAtLeast(0)
                                        onPlayNamed(list, idx, "Accès rapide")
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
