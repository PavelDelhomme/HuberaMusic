package ovh.delhomme.ytmusic.ui.components

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
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
import ovh.delhomme.ytmusic.data.ListenEventDto
import ovh.delhomme.ytmusic.data.TrackDto
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/** Page Historique pleine écran (depuis Compte). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HistoryScreen(
    container: AppContainer,
    onBack: () -> Unit,
    onPlay: (List<TrackDto>, Int) -> Unit,
    onMore: (TrackDto) -> Unit,
    onOpenEntity: ((TrackDto) -> Unit)? = null,
) {
    BackHandler(onBack = onBack)
    Scaffold(
        contentWindowInsets = WindowInsets.safeDrawing,
        topBar = {
            TopAppBar(
                title = { Text("Historique d'écoute") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Retour")
                    }
                },
            )
        },
    ) { padding ->
        HistoryBody(
            container = container,
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            showHeader = false,
            onPlay = onPlay,
            onMore = onMore,
            onOpenEntity = onOpenEntity,
            onConsumed = {},
        )
    }
}

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

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        HistoryBody(
            container = container,
            modifier = Modifier.fillMaxWidth(),
            showHeader = true,
            onPlay = onPlay,
            onMore = onMore,
            onOpenEntity = onOpenEntity,
            onConsumed = onDismiss,
        )
    }
}

@Composable
private fun HistoryBody(
    container: AppContainer,
    modifier: Modifier = Modifier,
    showHeader: Boolean,
    onPlay: (List<TrackDto>, Int) -> Unit,
    onMore: (TrackDto) -> Unit,
    onOpenEntity: ((TrackDto) -> Unit)?,
    onConsumed: () -> Unit,
) {
    var loading by remember { mutableStateOf(true) }
    var history by remember { mutableStateOf<List<TrackDto>>(emptyList()) }
    var entities by remember { mutableStateOf<List<TrackDto>>(emptyList()) }
    var events by remember { mutableStateOf<List<ListenEventDto>>(emptyList()) }

    LaunchedEffect(Unit) {
        loading = true
        runCatching {
            container.ensureFreshToken()
            val detailed = runCatching { container.api.historyDetailed() }.getOrNull()
            val hist = runCatching { container.api.history() }.getOrNull()
            val lib = if (hist == null) {
                runCatching { container.api.library() }.getOrNull()
            } else {
                null
            }
            events = detailed?.events.orEmpty()
            history = hist?.history ?: lib?.history.orEmpty()
            entities = hist?.entities ?: lib?.recentEntities.orEmpty()
        }
        loading = false
    }

    val dayFmt = remember {
        SimpleDateFormat("EEEE d MMMM yyyy", Locale.FRENCH)
    }
    val timeFmt = remember {
        SimpleDateFormat("HH:mm", Locale.FRENCH)
    }
    val grouped = remember(events) {
        events
            .filter { it.createdAt > 0L }
            .groupBy { dayKey(it.createdAt) }
            .toList()
            .sortedByDescending { it.first }
    }
    val playableFromEvents = remember(events) {
        events.mapNotNull { it.track }.distinctBy { it.id }
    }

    Column(modifier) {
        if (showHeader) {
            Text(
                "Historique d'écoute",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            )
            Text(
                "Lancés · partiels · complets — classés par date",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 8.dp),
            )
        } else {
            Text(
                "Lancés · partiels · complets — classés par date",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            )
        }
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
            events.isEmpty() && history.isEmpty() && entities.isEmpty() -> {
                Text(
                    "Aucune écoute récente",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(24.dp),
                )
            }
            else -> {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = 24.dp),
                ) {
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
                                                onConsumed()
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

                    if (grouped.isNotEmpty()) {
                        grouped.forEach { (key, dayEvents) ->
                            item(key = "day-$key") {
                                val label = dayFmt.format(Date(dayEvents.first().createdAt))
                                    .replaceFirstChar { it.uppercase() }
                                Text(
                                    label,
                                    style = MaterialTheme.typography.titleSmall,
                                    fontWeight = FontWeight.SemiBold,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
                                )
                            }
                            items(dayEvents, key = { "ev-${it.id}" }) { ev ->
                                val track = ev.track ?: return@items
                                val statusLabel = when (ev.status) {
                                    "complete" -> "Complet"
                                    "partial" -> "Partiel"
                                    "skipped" -> "Skip"
                                    else -> "Lancé"
                                }
                                val pct = ev.progressPct?.toInt()?.coerceIn(0, 100)
                                Column(Modifier.fillMaxWidth()) {
                                    TrackRow(
                                        track = track,
                                        onClick = {
                                            val list = playableFromEvents.ifEmpty { listOf(track) }
                                            val idx = list.indexOfFirst { it.id == track.id }
                                                .coerceAtLeast(0)
                                            onPlay(list, idx)
                                            onConsumed()
                                        },
                                        onMore = { onMore(track) },
                                    )
                                    Row(
                                        Modifier.padding(start = 72.dp, end = 20.dp, bottom = 8.dp),
                                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                                    ) {
                                        Text(
                                            timeFmt.format(Date(ev.createdAt)),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                        Text(
                                            if (pct != null && pct > 0) "$statusLabel · $pct %" else statusLabel,
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.primary,
                                        )
                                    }
                                }
                            }
                        }
                    } else if (history.isNotEmpty()) {
                        item {
                            Text(
                                "Titres",
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.SemiBold,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
                            )
                        }
                        itemsIndexed(history.take(80), key = { i, t -> "hist-${t.id}-$i" }) { _, track ->
                            TrackRow(
                                track = track,
                                onClick = {
                                    onPlay(
                                        history,
                                        history.indexOfFirst { it.id == track.id }.coerceAtLeast(0),
                                    )
                                    onConsumed()
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

private fun dayKey(ms: Long): Long {
    val cal = Calendar.getInstance()
    cal.timeInMillis = ms
    cal.set(Calendar.HOUR_OF_DAY, 0)
    cal.set(Calendar.MINUTE, 0)
    cal.set(Calendar.SECOND, 0)
    cal.set(Calendar.MILLISECOND, 0)
    return cal.timeInMillis
}
