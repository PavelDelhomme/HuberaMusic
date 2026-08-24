package ovh.delhomme.ytmusic.ui.home

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import ovh.delhomme.ytmusic.ui.util.isLandscape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.LibraryAddCheck
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import android.widget.Toast
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.data.resolvePlayableTracks
import ovh.delhomme.ytmusic.ui.components.AppTopBar
import ovh.delhomme.ytmusic.ui.components.HistorySheet
import ovh.delhomme.ytmusic.ui.components.MediaCover
import ovh.delhomme.ytmusic.ui.components.MixCollageCover
import ovh.delhomme.ytmusic.ui.components.PinnedBadge
import ovh.delhomme.ytmusic.ui.components.TrackRow
import ovh.delhomme.ytmusic.update.ApkUpdateManager

@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    container: AppContainer,
    onPlay: (List<TrackDto>, Int) -> Unit,
    onPlayNamed: (List<TrackDto>, Int, String) -> Unit = { tracks, idx, _ -> onPlay(tracks, idx) },
    onMore: (TrackDto) -> Unit,
    onOpenDetail: (TrackDto) -> Unit,
    onOpenArtist: ((String?, String) -> Unit)? = null,
    onOpenAccount: () -> Unit = {},
    onOpenDownloads: () -> Unit = {},
    onMoreMix: ((id: String, title: String, covers: List<TrackDto>) -> Unit)? = null,
    vm: HomeViewModel = viewModel(factory = HomeViewModel.factory(container)),
) {
    val state by vm.state.collectAsState()
    val pins by container.quickAccess.pins.collectAsState(initial = emptyList())
    val pinIds = remember(pins) { pins.map { it.id }.toHashSet() }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var showHistory by remember { mutableStateOf(false) }
    var userPicture by remember { mutableStateOf<String?>(null) }
    var updateInstalling by remember { mutableStateOf(false) }

    state.updatePrompt?.takeIf { it.available }?.let { upd ->
        AlertDialog(
            onDismissRequest = { vm.dismissUpdatePrompt() },
            title = { Text("Mise à jour disponible") },
            text = {
                Text(
                    upd.info?.versionName?.let { "Version $it prête à installer." }
                        ?: "Une nouvelle version PLM est disponible.",
                )
            },
            confirmButton = {
                TextButton(
                    enabled = !updateInstalling,
                    onClick = {
                        scope.launch {
                            updateInstalling = true
                            val msg = runCatching {
                                ApkUpdateManager(context.applicationContext, container)
                                    .downloadAndInstall(null)
                            }.getOrElse { it.message ?: "Échec" }
                            Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
                            updateInstalling = false
                            vm.consumeUpdatePrompt()
                        }
                    },
                ) { Text(if (updateInstalling) "…" else "Installer") }
            },
            dismissButton = {
                TextButton(onClick = { vm.dismissUpdatePrompt() }) { Text("Plus tard") }
            },
        )
    }

    LaunchedEffect(Unit) {
        userPicture = runCatching {
            container.ensureFreshToken()
            container.api.me().user?.picture
        }.getOrNull()
    }

    val listState = rememberLazyListState()
    LaunchedEffect(listState, state.hasMore, state.loadingMore) {
        snapshotFlow {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: 0
            val total = info.totalItemsCount
            total > 0 && last >= total - 3
        }
            .distinctUntilChanged()
            .filter { it }
            .collect {
                if (state.hasMore && !state.loadingMore) vm.loadMore()
            }
    }

    fun playItem(item: TrackDto, shelfItems: List<TrackDto>) {
        if (item.isPlaylist() || item.isAlbum() || item.isArtist()) {
            onOpenDetail(item)
            return
        }
        scope.launch {
            if (item.isPlayable()) {
                val list = shelfItems.filter { it.isPlayable() }.ifEmpty { listOf(item) }
                val idx = list.indexOfFirst { it.id == item.id }.coerceAtLeast(0)
                onPlay(list, idx)
            } else {
                onOpenDetail(item)
            }
        }
    }

    Column(Modifier.fillMaxSize()) {
        AppTopBar(
            title = "PLM",
            showBrandLogo = true,
            userPictureUrl = userPicture,
            onAccountClick = onOpenAccount,
        )

        when {
            state.loading && state.shelves.isEmpty() -> {
                HomeLoadingSkeleton()
            }
            state.error != null && state.shelves.isEmpty() && state.radios.isEmpty() -> {
                Column(
                    Modifier.fillMaxSize().padding(24.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(state.error!!, color = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.height(12.dp))
                    if (state.error!!.contains("Hors ligne", ignoreCase = true)) {
                        Button(onClick = onOpenDownloads) {
                            Text("Ouvrir Téléchargés")
                        }
                        Spacer(Modifier.height(8.dp))
                    }
                    TextButton(onClick = { vm.refresh(fromUser = true) }) { Text("Réessayer") }
                }
            }
            else -> {
                PullToRefreshBox(
                    isRefreshing = state.refreshing,
                    onRefresh = { vm.refresh(fromUser = true) },
                    modifier = Modifier.fillMaxSize(),
                ) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(bottom = 24.dp),
                ) {
                item {
                    QuickAccessHomeCard(
                        pins = pins,
                        container = container,
                        onPlayItem = { playItem(it, pins.filter { p -> p.isPlayable() }) },
                        onOpenDetail = onOpenDetail,
                        onMore = onMore,
                        onPlayNamed = onPlayNamed,
                        onUnpin = { track ->
                            scope.launch {
                                container.quickAccess.toggle(track, container.api)
                            }
                        },
                    )
                }

                if (state.radios.isNotEmpty()) {
                    item(key = "radios-title") {
                        Text(
                            "Mixés pour toi",
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                            color = MaterialTheme.colorScheme.onBackground,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                        )
                    }
                    item(key = "radios-row") {
                        LazyRow(
                            contentPadding = PaddingValues(horizontal = 12.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            itemsIndexed(
                                state.radios,
                                key = { index, radio -> "${radio.id}-$index" },
                            ) { _, radio ->
                                val loading = state.radioLoadingId == radio.id
                                val preview = state.radioPreviews[radio.id].orEmpty()
                                val saved = state.savedMixIds.contains(radio.id)
                                val tile = if (isLandscape()) 104.dp else 132.dp
                                Column(Modifier.width(tile + 8.dp).padding(4.dp)) {
                                    Box(
                                        Modifier
                                            .size(tile)
                                            .clip(RoundedCornerShape(8.dp))
                                            .clickable(enabled = !loading) {
                                                onOpenDetail(
                                                    TrackDto(
                                                        id = radio.id,
                                                        title = radio.title,
                                                        type = "mix",
                                                        thumbnails = preview.firstOrNull()?.thumbnails,
                                                    ),
                                                )
                                            },
                                    ) {
                                        MixCollageCover(
                                            tracks = preview,
                                            size = tile,
                                            titleFallback = radio.title,
                                            mixId = radio.id,
                                        )
                                        // Play toujours visible (mobile)
                                        Box(
                                            Modifier
                                                .align(Alignment.TopEnd)
                                                .padding(6.dp)
                                                .size(36.dp)
                                                .clip(RoundedCornerShape(18.dp))
                                                .background(MaterialTheme.colorScheme.error)
                                                .clickable(enabled = !loading) {
                                                    vm.playRadio(radio.id) { tracks, title ->
                                                        onPlayNamed(tracks, 0, title)
                                                    }
                                                },
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            Icon(
                                                Icons.Default.PlayArrow,
                                                contentDescription = "Lire",
                                                tint = Color.White,
                                                modifier = Modifier.size(22.dp),
                                            )
                                        }
                                        if (radio.id in pinIds) {
                                            PinnedBadge(
                                                modifier = Modifier
                                                    .align(Alignment.TopStart)
                                                    .padding(6.dp),
                                                size = 28.dp,
                                                onClick = {
                                                    scope.launch {
                                                        container.quickAccess.toggle(
                                                            TrackDto(
                                                                id = radio.id,
                                                                title = radio.title,
                                                                type = "mix",
                                                                thumbnails = preview.firstOrNull()?.thumbnails,
                                                            ),
                                                            container.api,
                                                        )
                                                    }
                                                },
                                            )
                                        }
                                        Row(
                                            Modifier
                                                .align(Alignment.BottomEnd)
                                                .padding(4.dp),
                                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                                        ) {
                                            IconButton(
                                                onClick = { onMoreMix?.invoke(radio.id, radio.title, preview) },
                                                modifier = Modifier
                                                    .size(32.dp)
                                                    .background(
                                                        Color.Black.copy(alpha = 0.7f),
                                                        RoundedCornerShape(16.dp),
                                                    ),
                                            ) {
                                                Icon(
                                                    Icons.Default.MoreVert,
                                                    contentDescription = "Options",
                                                    tint = Color.White,
                                                    modifier = Modifier.size(18.dp),
                                                )
                                            }
                                            IconButton(
                                                onClick = {
                                                    if (!saved) {
                                                        scope.launch {
                                                            vm.saveMix(radio.id, radio.title, preview)
                                                        }
                                                    }
                                                },
                                                enabled = !saved,
                                                modifier = Modifier
                                                    .size(32.dp)
                                                    .background(
                                                        Color.Black.copy(alpha = 0.7f),
                                                        RoundedCornerShape(16.dp),
                                                    ),
                                            ) {
                                                Icon(
                                                    if (saved) Icons.Default.LibraryAddCheck else Icons.Default.Add,
                                                    contentDescription = if (saved) "Enregistré" else "Enregistrer",
                                                    tint = if (saved) MaterialTheme.colorScheme.error else Color.White,
                                                    modifier = Modifier.size(18.dp),
                                                )
                                            }
                                        }
                                        if (loading) {
                                            Box(
                                                Modifier
                                                    .fillMaxSize()
                                                    .background(
                                                        MaterialTheme.colorScheme.scrim.copy(alpha = 0.45f),
                                                    ),
                                                contentAlignment = Alignment.Center,
                                            ) {
                                                CircularProgressIndicator(
                                                    modifier = Modifier.size(28.dp),
                                                    strokeWidth = 2.dp,
                                                    color = MaterialTheme.colorScheme.onPrimary,
                                                )
                                            }
                                        }
                                    }
                                    Spacer(Modifier.height(8.dp))
                                    Text(
                                        radio.title,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                        style = MaterialTheme.typography.bodyMedium,
                                        fontWeight = FontWeight.Medium,
                                        color = MaterialTheme.colorScheme.onBackground,
                                        modifier = Modifier.clickable {
                                            onOpenDetail(
                                                TrackDto(
                                                    id = radio.id,
                                                    title = radio.title,
                                                    type = "mix",
                                                    thumbnails = preview.firstOrNull()?.thumbnails,
                                                ),
                                            )
                                        },
                                    )
                                    Text(
                                        "Mix radio",
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                        Spacer(Modifier.height(8.dp))
                    }
                }

                items(state.shelves, key = { it.title }) { shelf ->
                    val items = shelf.items
                    val mostlyCards = items.count {
                        it.isPlaylist() || it.isAlbum() || it.isArtist()
                    } >= items.size / 2 && items.isNotEmpty()

                    Text(
                        shelf.title,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onBackground,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                    )

                    if (mostlyCards || items.size > 5) {
                        LazyRow(
                            contentPadding = PaddingValues(horizontal = 12.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            itemsIndexed(
                                items.take(16),
                                key = { index, track -> "${track.id}-$index" },
                            ) { _, track ->
                                val isPinned = track.id in pinIds
                                val tile = if (isLandscape()) 104.dp else 132.dp
                                Column(
                                    Modifier
                                        .width(tile + 8.dp)
                                        .combinedClickable(
                                            onClick = { playItem(track, items) },
                                            onLongClick = { onMore(track) },
                                        )
                                        .padding(4.dp),
                                ) {
                                    Box {
                                        MediaCover(
                                            track,
                                            tile,
                                            circle = track.isArtist(),
                                        )
                                        if (isPinned) {
                                            PinnedBadge(
                                                modifier = Modifier
                                                    .align(Alignment.TopStart)
                                                    .padding(6.dp),
                                                size = 28.dp,
                                                onClick = {
                                                    scope.launch {
                                                        container.quickAccess.toggle(track, container.api)
                                                    }
                                                },
                                            )
                                        }
                                    }
                                    Spacer(Modifier.height(8.dp))
                                    Text(
                                        track.title,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                        style = MaterialTheme.typography.bodyMedium,
                                        fontWeight = FontWeight.Medium,
                                        color = MaterialTheme.colorScheme.onBackground,
                                    )
                                    Text(
                                        when {
                                            track.isPlaylist() -> "Playlist"
                                            track.isAlbum() -> "Album"
                                            track.isArtist() -> "Artiste"
                                            else -> track.artistLine()
                                        },
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                        Spacer(Modifier.height(16.dp))
                    } else {
                        items.take(10).forEach { track ->
                            TrackRow(
                                track = track,
                                onClick = { playItem(track, items) },
                                onMore = { onMore(track) },
                                onOpenArtist = onOpenArtist,
                                pinned = track.id in pinIds,
                                onTogglePin = {
                                    scope.launch {
                                        container.quickAccess.toggle(track, container.api)
                                    }
                                },
                            )
                        }
                        Spacer(Modifier.height(8.dp))
                    }
                }

                if (state.loadingMore) {
                    item {
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .padding(16.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            CircularProgressIndicator(Modifier.size(28.dp))
                        }
                    }
                } else if (state.hasMore) {
                    item {
                        TextButton(
                            onClick = { vm.loadMore() },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("Voir plus")
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
            onPlay = onPlay,
            onMore = onMore,
            onOpenEntity = onOpenDetail,
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun QuickAccessHomeCard(
    pins: List<TrackDto>,
    container: AppContainer,
    onPlayItem: (TrackDto) -> Unit,
    onOpenDetail: (TrackDto) -> Unit,
    onMore: (TrackDto) -> Unit,
    onPlayNamed: (List<TrackDto>, Int, String) -> Unit,
    onUnpin: (TrackDto) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var shuffleBusy by remember { mutableStateOf(false) }
    val pages = remember(pins) { buildQuickAccessPages(pins) }
    val pagerState = rememberPagerState(pageCount = { pages.size.coerceAtLeast(1) })

    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(vertical = 12.dp),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                Icons.Default.PushPin,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(18.dp),
            )
            Text(
                "Accès rapide",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
        }

        if (pins.isEmpty()) {
            Text(
                "Épingle titres, playlists ou artistes depuis le menu ⋮",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            )
        } else {
            Spacer(Modifier.height(8.dp))
            HorizontalPager(
                state = pagerState,
                contentPadding = PaddingValues(horizontal = 10.dp),
                pageSpacing = 10.dp,
                modifier = Modifier.fillMaxWidth(),
            ) { page ->
                val slots = pages.getOrElse(page) { emptyList() }
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    // Aléatoire en tête de la 1ʳᵉ page pour un espacement homogène avec les pins
                    slots.forEach { slot ->
                        Box(Modifier.weight(1f)) {
                            when (slot) {
                                is QuickAccessSlot.Pin -> QuickAccessPinCard(
                                    track = slot.track,
                                    onClick = {
                                        val t = slot.track
                                        if (t.isPlaylist() || t.isAlbum() || t.isArtist()) {
                                            onOpenDetail(t)
                                        } else {
                                            onPlayItem(t)
                                        }
                                    },
                                    onLongClick = { onMore(slot.track) },
                                    onUnpin = { onUnpin(slot.track) },
                                )
                                QuickAccessSlot.Shuffle -> QuickAccessShuffleCard(
                                    busy = shuffleBusy,
                                    onClick = {
                                        if (shuffleBusy) return@QuickAccessShuffleCard
                                        shuffleBusy = true
                                        scope.launch {
                                            try {
                                                val pool = mutableListOf<TrackDto>()
                                                for (p in pins) {
                                                    val resolved = runCatching {
                                                        resolvePlayableTracks(container.api, p)
                                                    }.getOrDefault(emptyList())
                                                    pool += resolved
                                                }
                                                val uniq = pool.distinctBy { it.id }.shuffled()
                                                if (uniq.isNotEmpty()) {
                                                    onPlayNamed(uniq, 0, "Accès rapide · Aléatoire")
                                                }
                                            } finally {
                                                shuffleBusy = false
                                            }
                                        }
                                    },
                                )
                            }
                        }
                    }
                    repeat((3 - slots.size).coerceAtLeast(0)) {
                        Spacer(Modifier.weight(1f))
                    }
                }
            }
            if (pages.size > 1) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(top = 10.dp),
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    repeat(pages.size) { i ->
                        val selected = pagerState.currentPage == i
                        Box(
                            Modifier
                                .padding(horizontal = 3.dp)
                                .size(if (selected) 8.dp else 6.dp)
                                .clip(RoundedCornerShape(50))
                                .background(
                                    if (selected) MaterialTheme.colorScheme.primary
                                    else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.28f),
                                )
                                .clickable {
                                    scope.launch { pagerState.animateScrollToPage(i) }
                                },
                        )
                    }
                }
            }
        }
    }
}

private sealed class QuickAccessSlot {
    data class Pin(val track: TrackDto) : QuickAccessSlot()
    data object Shuffle : QuickAccessSlot()
}

private fun buildQuickAccessPages(pins: List<TrackDto>): List<List<QuickAccessSlot>> {
    if (pins.isEmpty()) return listOf(listOf(QuickAccessSlot.Shuffle))
    val pages = mutableListOf<List<QuickAccessSlot>>()
    // Page 1 : Aléatoire + 2 pins (même gap 10.dp partout, y compris après Aléatoire)
    val firstPins = pins.take(2).map { QuickAccessSlot.Pin(it) }
    pages += listOf(QuickAccessSlot.Shuffle) + firstPins
    var i = 2
    while (i < pins.size) {
        pages += pins.subList(i, minOf(i + 3, pins.size)).map { QuickAccessSlot.Pin(it) }
        i += 3
    }
    return pages
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun QuickAccessPinCard(
    track: TrackDto,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
    onUnpin: () -> Unit,
) {
    val landscape = isLandscape()
    Box(
        Modifier
            .fillMaxWidth()
            .then(
                if (landscape) Modifier.height(100.dp)
                else Modifier.aspectRatio(1f),
            )
            .clip(RoundedCornerShape(12.dp))
            .combinedClickable(onClick = onClick, onLongClick = onLongClick),
    ) {
        coil.compose.SubcomposeAsyncImage(
            model = track.coverUrl(320),
            contentDescription = track.title,
            contentScale = androidx.compose.ui.layout.ContentScale.Crop,
            modifier = Modifier.fillMaxSize(),
            loading = {
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(MaterialTheme.colorScheme.surface),
                )
            },
            error = {
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(MaterialTheme.colorScheme.surface),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        track.title.take(1).uppercase(),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontWeight = FontWeight.Bold,
                    )
                }
            },
        )
        Box(
            Modifier
                .fillMaxSize()
                .background(
                    Brush.verticalGradient(
                        0f to Color.Transparent,
                        0.5f to Color.Transparent,
                        1f to Color.Black.copy(alpha = 0.8f),
                    ),
                ),
        )
        PinnedBadge(
            modifier = Modifier
                .align(Alignment.TopStart)
                .padding(6.dp),
            size = 26.dp,
            onClick = onUnpin,
        )
        Text(
            track.title.ifBlank { "Sans titre" },
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold,
            color = Color.White,
            modifier = Modifier
                .align(Alignment.BottomStart)
                .padding(horizontal = 8.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun QuickAccessShuffleCard(
    busy: Boolean,
    onClick: () -> Unit,
) {
    val landscape = isLandscape()
    Box(
        Modifier
            .fillMaxWidth()
            .then(
                if (landscape) Modifier.height(100.dp)
                else Modifier.aspectRatio(1f),
            )
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.18f))
            .clickable(enabled = !busy, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            if (busy) {
                CircularProgressIndicator(
                    modifier = Modifier.size(28.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.primary,
                )
            } else {
                Icon(
                    Icons.Default.Shuffle,
                    contentDescription = "Aléatoire",
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(32.dp),
                )
            }
            Spacer(Modifier.height(6.dp))
            Text(
                "Aléatoire",
                maxLines = 1,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

@Composable
private fun HomeLoadingSkeleton() {
    Column(
        Modifier
            .fillMaxSize()
            .padding(top = 8.dp),
    ) {
        repeat(3) {
            Box(
                Modifier
                    .padding(horizontal = 16.dp, vertical = 10.dp)
                    .fillMaxWidth(0.4f)
                    .height(18.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f)),
            )
            Row(
                Modifier.padding(horizontal = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                repeat(3) {
                    Column(Modifier.width(140.dp)) {
                        Box(
                            Modifier
                                .size(132.dp)
                                .clip(RoundedCornerShape(8.dp))
                                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)),
                        )
                        Spacer(Modifier.height(8.dp))
                        Box(
                            Modifier
                                .fillMaxWidth(0.85f)
                                .height(12.dp)
                                .clip(RoundedCornerShape(4.dp))
                                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)),
                        )
                        Spacer(Modifier.height(6.dp))
                        Box(
                            Modifier
                                .fillMaxWidth(0.55f)
                                .height(10.dp)
                                .clip(RoundedCornerShape(4.dp))
                                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f)),
                        )
                    }
                }
            }
            Spacer(Modifier.height(20.dp))
        }
    }
}
