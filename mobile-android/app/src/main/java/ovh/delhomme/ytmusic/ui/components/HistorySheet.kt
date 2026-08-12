package ovh.delhomme.ytmusic.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HistorySheet(
    container: AppContainer,
    onDismiss: () -> Unit,
    onPlay: (List<TrackDto>, Int) -> Unit,
    onMore: (TrackDto) -> Unit,
    onOpenEntity: ((TrackDto) -> Unit)? = null,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var loading by remember { mutableStateOf(true) }
    var history by remember { mutableStateOf<List<TrackDto>>(emptyList()) }
    var entities by remember { mutableStateOf<List<TrackDto>>(emptyList()) }

    LaunchedEffect(Unit) {
        loading = true
        runCatching {
            container.ensureFreshToken()
            container.api.library()
        }.onSuccess { lib ->
            history = lib.history
            entities = lib.recentEntities
        }
        loading = false
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        Text(
            "Historique",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
        )
        when {
            loading -> {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .padding(40.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) { CircularProgressIndicator() }
            }
            history.isEmpty() && entities.isEmpty() -> {
                Text(
                    "Aucune écoute récente",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(24.dp),
                )
            }
            else -> {
                LazyColumn(contentPadding = PaddingValues(bottom = 32.dp)) {
                    if (entities.isNotEmpty()) {
                        item {
                            Text(
                                "Playlists & albums récents",
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.SemiBold,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
                            )
                        }
                        item {
                            LazyRow(
                                contentPadding = PaddingValues(horizontal = 16.dp),
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                items(entities.take(16), key = { "ent-${it.type}-${it.id}" }) { item ->
                                    Column(
                                        Modifier
                                            .width(120.dp)
                                            .clickable {
                                                onOpenEntity?.invoke(item)
                                                onDismiss()
                                            },
                                    ) {
                                        MediaCover(item, 120.dp, circle = item.isArtist())
                                        Text(
                                            item.title,
                                            maxLines = 2,
                                            overflow = TextOverflow.Ellipsis,
                                            style = MaterialTheme.typography.bodySmall,
                                            modifier = Modifier.padding(top = 6.dp),
                                        )
                                        Text(
                                            item.kind().replaceFirstChar { it.uppercase() },
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            }
                        }
                    }
                    if (history.isNotEmpty()) {
                        item {
                            Text(
                                "Titres",
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.SemiBold,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
                            )
                        }
                        itemsIndexed(history.take(60), key = { i, t -> "hist-${t.id}-$i" }) { _, track ->
                            TrackRow(
                                track = track,
                                onClick = {
                                    onPlay(history, history.indexOfFirst { it.id == track.id }.coerceAtLeast(0))
                                    onDismiss()
                                },
                                onMore = { onMore(track) },
                            )
                        }
                    }
                }
            }
        }
    }
}
