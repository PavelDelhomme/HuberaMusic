package ovh.delhomme.ytmusic.ui.player

import android.content.Context
import android.os.SystemClock
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.basicMarquee
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.ui.layout.onSizeChanged
import ovh.delhomme.ytmusic.ui.util.isLandscape
import ovh.delhomme.ytmusic.ui.util.screenHeightDp
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ClearAll
import androidx.compose.material.icons.filled.Cast
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.DragHandle
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.FavoriteBorder
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Lyrics
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.PlaylistAdd
import androidx.compose.material.icons.filled.QueueMusic
import androidx.compose.material.icons.filled.Radio
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.RepeatOne
import androidx.compose.material.icons.filled.Save
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import coil.compose.AsyncImage
import coil.compose.SubcomposeAsyncImage
import coil.request.ImageRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.CreatePlaylistBody
import ovh.delhomme.ytmusic.data.PlaylistDto
import ovh.delhomme.ytmusic.data.RecoFeedbackBody
import ovh.delhomme.ytmusic.data.TimedLyricLine
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.data.buildRadioQueue
import ovh.delhomme.ytmusic.data.fetchAutoplayTracksFast
import ovh.delhomme.ytmusic.data.fetchAutoplayTracksFull
import ovh.delhomme.ytmusic.debug.AppLog
import ovh.delhomme.ytmusic.player.CoverPrefetcher
import ovh.delhomme.ytmusic.player.PlayerController
import ovh.delhomme.ytmusic.player.PlayerUiState
import ovh.delhomme.ytmusic.player.RepeatMode
import ovh.delhomme.ytmusic.player.StreamPrefetcher
import ovh.delhomme.ytmusic.ui.components.ArtistLinksText
import ovh.delhomme.ytmusic.ui.components.DownloadStatusIcon
import ovh.delhomme.ytmusic.ui.components.EqualizerSheet
import ovh.delhomme.ytmusic.ui.components.HoldSeekIconButton
import ovh.delhomme.ytmusic.ui.components.MediaCover
import ovh.delhomme.ytmusic.ui.icons.MixIcon
import kotlin.math.abs
import kotlin.math.roundToInt

private enum class NowPlayingDragAxis { None, Horizontal, Vertical }

/** Cache léger onglet Similaires (scroll + titres par seed). */
private data class SimilarTabCache(
    val tracks: List<TrackDto> = emptyList(),
    val scrollIndex: Int = 0,
    val scrollOffset: Int = 0,
    val loadingMore: Boolean = false,
    val exhausted: Boolean = false,
)

private val SeekRed = Color(0xFFFF0033)
private val PlayerFg = Color(0xFFF5F5F5)
private val PlayerMuted = Color(0xFFCFCFCF)

@Composable
private fun MediaModeSwitch(
    video: Boolean,
    onChange: (Boolean) -> Unit,
) {
    Row(
        Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(Color(0xFF1D1D1D))
            .padding(2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        listOf(false to "Titre", true to "Vidéo").forEach { (isVideo, label) ->
            val active = video == isVideo
            Text(
                label,
                color = if (active) PlayerFg else PlayerMuted,
                style = MaterialTheme.typography.labelMedium,
                fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
                modifier = Modifier
                    .clip(RoundedCornerShape(18.dp))
                    .background(if (active) Color.White.copy(alpha = 0.15f) else Color.Transparent)
                    .clickable { onChange(isVideo) }
                    .padding(horizontal = 12.dp, vertical = 6.dp),
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
fun NowPlayingScreen(
    player: PlayerController,
    ui: PlayerUiState,
    container: AppContainer,
    likedIds: Set<String>,
    onLikedChanged: (Set<String>) -> Unit,
    onClose: () -> Unit,
    onMore: ((TrackDto) -> Unit)? = null,
    onCast: (() -> Unit)? = null,
    onOpenAddToPlaylist: ((TrackDto) -> Unit)? = null,
    onOpenArtist: ((id: String?, name: String) -> Unit)? = null,
    /** Incrémenté au clic notif → recentre sur la cover / contrôles. */
    focusPlayerToken: Int = 0,
    /** Incrémenté depuis notif « Paroles » → ouvre le panneau paroles. */
    openLyricsToken: Int = 0,
    /** Sheet Now Playing visible (sinon pause Exo vidéo). */
    sheetVisible: Boolean = true,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var scrub by remember(ui.track?.id) { mutableFloatStateOf(-1f) }
    var dragOffset by remember { mutableFloatStateOf(0f) }
    var mediaSlideX by remember { mutableFloatStateOf(0f) }
    val queueProgress = remember { Animatable(0f) }
    var showLyrics by remember { mutableStateOf(false) }
    var videoFullscreen by remember { mutableStateOf(false) }
    var showEqualizer by remember { mutableStateOf(false) }
    var showSpeedMenu by remember { mutableStateOf(false) }
    var showSaveQueue by remember { mutableStateOf(false) }
    var queuePanelTab by remember { mutableIntStateOf(0) } // 0 = file, 1 = similaires
    var lastPrevTap by remember { mutableLongStateOf(0L) }
    /** Après repli file → lecteur : bloquer le dismiss jusqu’à stabilisation. */
    var dismissArmed by remember { mutableStateOf(true) }
    val density = LocalDensity.current
    val dismissPx = with(density) { 110.dp.toPx() }
    val queueRangePx = with(density) { 380.dp.toPx() }
    val flingDismiss = 2200f
    val listState = rememberLazyListState()
    val queueListState = rememberLazyListState()
    val similarListState = rememberLazyListState()
    val similarPanelCache = remember { mutableStateMapOf<String, SimilarTabCache>() }
    val queueOpen = queueProgress.value > 0.55f
    val queueInteractive = queueProgress.value > 0.02f

    // Jamais d’écran mort « Rien en lecture » — retour immédiat à l’accueil / biblio
    LaunchedEffect(ui.track?.id, ui.queue.size, sheetVisible) {
        if (sheetVisible && ui.track == null && ui.queue.isEmpty()) {
            onClose()
        }
    }

    // Remplit « À suivre » — ne PAS clear/rebuild à chaque ouverture du plein écran
    // (sinon setMediaItems+prepare → coupe l’audio). Clear seulement si le seed change.
    var lastAutoplaySeed by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(ui.track?.id, ui.sourceKind, ui.userQueueEnd, ui.queueIndex) {
        // Toujours remplir « À suivre » pour l’affichage — autoplay = auto-avance seulement
        val seed = ui.track?.id ?: return@LaunchedEffect
        val remainingUser = (ui.userQueueEnd - ui.queueIndex - 1).coerceAtLeast(0)
        if (ovh.delhomme.ytmusic.data.isPrecomputedMixSource(ui.sourceKind, remainingUser)) {
            return@LaunchedEffect
        }
        val seedChanged = lastAutoplaySeed != null && lastAutoplaySeed != seed
        lastAutoplaySeed = seed
        if (seedChanged) {
            player.clearAutoTracks()
        }
        val remaining = (player.state.value.queue.size - player.state.value.queueIndex - 1)
            .coerceAtLeast(0)
        if (remaining >= 8) return@LaunchedEffect
        val fast = fetchAutoplayTracksFast(container.api, seed)
        if (fast.isNotEmpty() && player.state.value.track?.id == seed) {
            player.appendAutoTracks(fast, forSeedId = seed)
        }
        val full = fetchAutoplayTracksFull(container.api, seed)
        if (full.isNotEmpty() && player.state.value.track?.id == seed) {
            player.appendAutoTracks(full, forSeedId = seed)
        }
    }

    // Pochette NP en cache même sheet rétracté (LazyColumn hors écran ne compose pas la cover)
    LaunchedEffect(ui.track?.id) {
        val t = ui.track ?: return@LaunchedEffect
        CoverPrefetcher.warm(t.coverUrl(800))
        CoverPrefetcher.warm(t.coverUrl(360))
    }

    // Pré-chauffe + resolve clip visuel (fallback titre+artiste si ATV sans vidéo)
    var visualVideoUrl by remember { mutableStateOf<String?>(null) }
    var visualVideoError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(ui.track?.id, SessionMediaMode.video, sheetVisible) {
        val track = ui.track
        visualVideoUrl = null
        visualVideoError = null
        if (!sheetVisible || track == null || !SessionMediaMode.video) return@LaunchedEffect
        runCatching {
            container.ensureFreshToken()
            val vis = container.api.trackVisual(
                track.id,
                title = track.title,
                artist = track.artistLine().takeIf { it != "Artiste" },
                durationSeconds = track.durationSeconds,
            )
            val vid = vis.visualId?.takeIf { it.isNotBlank() }
            if (vid == null) {
                visualVideoError = "Pas de clip vidéo"
                return@runCatching
            }
            runCatching { container.api.streamResolveUrl(vid, "video") }
            visualVideoUrl = container.videoStreamUrl(vid)
        }.onFailure {
            visualVideoError = it.message ?: "Vidéo indisponible"
        }
    }
    // Prefetch clip du titre suivant (mode vidéo) pour enchaîner sans blanc
    LaunchedEffect(ui.track?.id, ui.queueIndex, SessionMediaMode.video, ui.queue.size) {
        if (!SessionMediaMode.video) return@LaunchedEffect
        val next = ui.queue.getOrNull(ui.queueIndex + 1) ?: return@LaunchedEffect
        runCatching {
            container.ensureFreshToken()
            val vis = container.api.trackVisual(
                next.id,
                title = next.title,
                artist = next.artistLine().takeIf { it != "Artiste" },
                durationSeconds = next.durationSeconds,
            )
            val vid = vis.visualId?.takeIf { it.isNotBlank() } ?: return@runCatching
            runCatching { container.api.streamResolveUrl(vid, "video") }
            // Tête HTTP légère pour chauffer le CDN / proxy
            runCatching {
                val url = container.videoStreamUrl(vid)
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                    val req = okhttp3.Request.Builder()
                        .url(url)
                        .header("Range", "bytes=0-65535")
                        .header("X-YTM-Client", "android")
                        .get()
                        .build()
                    container.httpPlain.newCall(req).execute().close()
                }
            }
        }
    }

    // Précharge similaires dès le titre courant (avant d’ouvrir le panneau file)
    LaunchedEffect(ui.track?.id) {
        val seedId = ui.track?.id ?: return@LaunchedEffect
        if (seedId.length != 11) return@LaunchedEffect
        if (similarPanelCache[seedId]?.tracks?.isNotEmpty() == true) return@LaunchedEffect
        val fast = runCatching {
            val rel = container.api.related(seedId, fast = 1)
            dedupeSimilar(
                seedId,
                rel.tracks.orEmpty() + rel.related.orEmpty() + rel.radio.orEmpty(),
            ).take(12)
        }.getOrDefault(emptyList())
        if (ui.track?.id != seedId || fast.isEmpty()) return@LaunchedEffect
        similarPanelCache[seedId] = SimilarTabCache(tracks = fast)
        // Enrichissement en fond (n’bloque pas l’UI file)
        val mid = runCatching {
            val rel = container.api.related(seedId, full = 0)
            dedupeSimilar(
                seedId,
                rel.tracks.orEmpty() + rel.related.orEmpty() + rel.radio.orEmpty(),
            )
        }.getOrDefault(emptyList())
        if (ui.track?.id != seedId || mid.isEmpty()) return@LaunchedEffect
        val seen = fast.map { it.id }.toHashSet()
        val merged = (fast + mid.filter { it.id !in seen }).distinctBy { it.id }.take(48)
        similarPanelCache[seedId] = SimilarTabCache(tracks = merged)
    }

    fun armDismissAfterSettle() {
        dismissArmed = false
        dragOffset = 0f
        scope.launch {
            delay(450L)
            dragOffset = 0f
            dismissArmed = true
        }
    }

    fun settleOrClose() {
        scope.launch {
            // File encore visible → ne jamais fermer le lecteur, juste replier la file
            if (queueProgress.value > 0.02f) {
                dragOffset = 0f
                queueProgress.animateTo(
                    0f,
                    spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = Spring.DampingRatioNoBouncy),
                )
                armDismissAfterSettle()
                return@launch
            }
            if (!dismissArmed) {
                dragOffset = 0f
                return@launch
            }
            if (dragOffset >= dismissPx) {
                onClose()
                dragOffset = 0f
            } else if (dragOffset > 0f) {
                val anim = Animatable(dragOffset)
                anim.animateTo(
                    0f,
                    spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = Spring.DampingRatioNoBouncy),
                ) {
                    dragOffset = value
                }
            }
        }
    }

    fun settleQueue(velocityY: Float = 0f) {
        scope.launch {
            val wasOpen = queueProgress.value > 0.02f
            // Snap binaire uniquement : jamais laisser le « petit lecteur » à mi-chemin
            val target = when {
                velocityY < -900f -> 1f
                // Fling vers le bas depuis la file → lecteur plein, jamais dismiss
                velocityY > 900f -> 0f
                queueProgress.value >= 0.5f -> 1f
                else -> 0f
            }
            queueProgress.animateTo(
                target,
                spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = Spring.DampingRatioNoBouncy),
            )
            if (target == 0f && wasOpen) {
                armDismissAfterSettle()
            } else if (target == 0f) {
                dragOffset = 0f
            }
        }
    }

    fun expandQueue() {
        scope.launch {
            dismissArmed = false
            queueProgress.animateTo(
                1f,
                spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = Spring.DampingRatioNoBouncy),
            )
        }
    }

    fun collapseQueue() {
        scope.launch {
            dragOffset = 0f
            val wasOpen = queueProgress.value > 0.02f
            queueProgress.animateTo(
                0f,
                spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = Spring.DampingRatioNoBouncy),
            )
            if (wasOpen) armDismissAfterSettle() else dragOffset = 0f
        }
    }

    fun onQueueDrag(deltaY: Float) {
        // deltaY < 0 = doigt vers le haut → ouvrir la file
        scope.launch {
            queueProgress.snapTo(
                (queueProgress.value - deltaY / queueRangePx).coerceIn(0f, 1f),
            )
        }
    }

    fun skipNextFromSwipe() {
        mediaSlideX = 0f
        player.skipNext()
    }

    fun skipPrevFromSwipe() {
        mediaSlideX = 0f
        player.skipPrevOrRestart(forcePrevious = true)
    }

    val dismissScroll = remember(queueInteractive, dismissPx, showLyrics, dismissArmed) {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                // Paroles : scroll libre, pas de dismiss du lecteur
                if (showLyrics) return Offset.Zero
                // File ouverte / en transition → pas de dismiss du lecteur
                if (queueProgress.value > 0.02f) return Offset.Zero
                if (!dismissArmed) {
                    dragOffset = 0f
                    return Offset.Zero
                }
                if (available.y < 0f && dragOffset > 0f) {
                    val next = (dragOffset + available.y).coerceAtLeast(0f)
                    val consumed = next - dragOffset
                    dragOffset = next
                    return Offset(0f, consumed)
                }
                return Offset.Zero
            }

            override fun onPostScroll(
                consumed: Offset,
                available: Offset,
                source: NestedScrollSource,
            ): Offset {
                if (showLyrics) return Offset.Zero
                if (queueProgress.value > 0.02f) return Offset.Zero
                if (!dismissArmed) {
                    dragOffset = 0f
                    return Offset.Zero
                }
                if (available.y > 0f) {
                    dragOffset += available.y
                    return Offset(0f, available.y)
                }
                return Offset.Zero
            }

            override suspend fun onPostFling(consumed: Velocity, available: Velocity): Velocity {
                if (showLyrics) {
                    dragOffset = 0f
                    return Velocity.Zero
                }
                if (queueProgress.value > 0.02f || !dismissArmed) {
                    dragOffset = 0f
                    return Velocity.Zero
                }
                if (dragOffset >= dismissPx || available.y > flingDismiss) {
                    onClose()
                    dragOffset = 0f
                    return available
                }
                if (dragOffset > 0f) {
                    val anim = Animatable(dragOffset)
                    anim.animateTo(
                        0f,
                        spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = Spring.DampingRatioNoBouncy),
                    ) {
                        dragOffset = value
                    }
                }
                return Velocity.Zero
            }
        }
    }

    LaunchedEffect(showLyrics) {
        if (showLyrics) {
            runCatching { listState.scrollToItem(0) }
        }
    }

    LaunchedEffect(ui.playing, showLyrics, sheetVisible) {
        if (!sheetVisible) return@LaunchedEffect
        while (isActive) {
            player.tick()
            delay(
                when {
                    showLyrics && ui.playing -> 120L
                    ui.playing -> 400L
                    else -> 1_200L
                },
            )
        }
    }

    LaunchedEffect(ui.track?.id) {
        dragOffset = 0f
        mediaSlideX = 0f
    }

    LaunchedEffect(SessionMediaMode.video) {
        if (!SessionMediaMode.video) videoFullscreen = false
    }

    // File dépliée : le retour la replie d'abord, il ferme le lecteur au coup suivant.
    BackHandler(enabled = queueInteractive) { collapseQueue() }

    BackHandler(enabled = videoFullscreen) { videoFullscreen = false }

    LaunchedEffect(ui.queueIndex, ui.queue.size, sheetVisible) {
        if (!sheetVisible || ui.queue.isEmpty()) return@LaunchedEffect
        player.prefetchQueueFocus(ui.queueIndex.coerceIn(0, ui.queue.lastIndex), radius = 2)
        val base = container.remoteStreamUrl("_").substringBefore("/api/stream/")
        StreamPrefetcher.maintainRollingPrefetch(
            base,
            ui.queue.map { it.id },
            ui.queueIndex.coerceIn(0, ui.queue.lastIndex),
            window = 3,
        )
    }

    // Dès que la file s'ouvre (même partiellement), ancrer sur le titre courant — une seule fois à l'ouverture
    LaunchedEffect(queueInteractive, queuePanelTab) {
        if (!queueInteractive || queuePanelTab != 0 || ui.queue.isEmpty()) return@LaunchedEffect
        val boundary = ui.userQueueEnd.coerceIn(0, ui.queue.size)
        val target = when {
            ui.queueIndex < boundary -> ui.queueIndex
            else -> ui.queueIndex + 1
        }.coerceAtLeast(0)
        runCatching { queueListState.scrollToItem(target) }
    }

    // Aperçu file dans le lecteur : suivre le courant dès qu’on a scrollé sous la cover
    LaunchedEffect(ui.queueIndex) {
        if (queueInteractive || ui.queue.isEmpty()) return@LaunchedEffect
        if (listState.firstVisibleItemIndex <= 1) return@LaunchedEffect
        val target = (ui.queueIndex + 2).coerceAtLeast(0)
        runCatching { listState.scrollToItem(target) }
    }

    // Clic notification / réouverture → zone média (pas la file)
    LaunchedEffect(focusPlayerToken) {
        if (focusPlayerToken <= 0) return@LaunchedEffect
        queueProgress.snapTo(0f)
        dragOffset = 0f
        runCatching { listState.scrollToItem(0) }
    }

    LaunchedEffect(openLyricsToken) {
        if (openLyricsToken <= 0) return@LaunchedEffect
        showLyrics = true
        queueProgress.snapTo(0f)
        runCatching { listState.scrollToItem(0) }
    }

    LaunchedEffect(sheetVisible) {
        if (sheetVisible) {
            // Évite dismiss / gestes accidentels pendant l’ouverture (spam next/pause)
            dismissArmed = false
            delay(420)
            dismissArmed = true
        } else {
            queueProgress.snapTo(0f)
            dragOffset = 0f
            dismissArmed = true
        }
    }

    val dragProgress = (dragOffset / (dismissPx * 2.2f)).coerceIn(0f, 1f)
    val qp = queueProgress.value

    Box(
        Modifier
            .fillMaxSize()
            .offset { IntOffset(0, dragOffset.roundToInt().coerceAtLeast(0)) }
            .alpha(1f - dragProgress * 0.35f)
            .background(MaterialTheme.colorScheme.background)
            // Bloque tout pointer vers Accueil/Biblio derrière (zones hors enfants cliquables)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = {},
            )
            .statusBarsPadding()
            .navigationBarsPadding()
            .nestedScroll(dismissScroll),
    ) {
        val track = ui.track
        if (track == null) {
            return@Box
        }
        // Ambient blur — fond unifié sous cover + chrome (sheet visible uniquement)
        if (sheetVisible) {
            AsyncImage(
                model = track.coverUrl(160),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier
                    .fillMaxSize()
                    .blur(56.dp)
                    .alpha(0.52f),
            )
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.42f)),
            )
        }
        val duration = ui.durationMs.coerceAtLeast(1L).toFloat()
        val progress = if (scrub >= 0f) scrub else (ui.positionMs / duration).coerceIn(0f, 1f)
        val liked = track.id in likedIds

        Column(Modifier.fillMaxSize()) {
            // Chrome lecteur (masqué quand la file est ouverte — le header file porte les contrôles)
            if (!queueInteractive) {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .pointerInput(dismissArmed) {
                            detectVerticalDragGestures(
                                onVerticalDrag = { _, amount ->
                                    if (!dismissArmed) {
                                        dragOffset = 0f
                                        return@detectVerticalDragGestures
                                    }
                                    if (amount > 0f || dragOffset > 0f) {
                                        dragOffset = (dragOffset + amount).coerceAtLeast(0f)
                                    }
                                },
                                onDragEnd = { settleOrClose() },
                                onDragCancel = { settleOrClose() },
                            )
                        },
                ) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .padding(top = 6.dp, bottom = 2.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(
                            Modifier
                                .width(40.dp)
                                .height(4.dp)
                                .clip(RoundedCornerShape(2.dp))
                                .background(PlayerFg.copy(alpha = 0.35f)),
                        )
                    }
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 8.dp, vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(onClick = onClose) {
                            Icon(
                                Icons.Default.KeyboardArrowDown,
                                contentDescription = "Replier",
                                tint = PlayerFg,
                                modifier = Modifier.size(32.dp),
                            )
                        }
                        Spacer(Modifier.weight(1f))
                        MediaModeSwitch(
                            video = SessionMediaMode.video,
                            onChange = { SessionMediaMode.video = it },
                        )
                        Spacer(Modifier.weight(1f))
                        NowPlayingChrome.topBarActions.forEach { slot ->
                            if (!slot.enabled) return@forEach
                            when (slot.id) {
                                PlayerChromeAction.More -> if (onMore != null) {
                                    IconButton(onClick = { onMore(track) }) {
                                        Icon(Icons.Default.MoreVert, slot.label, tint = PlayerFg)
                                    }
                                }
                                else -> Unit
                            }
                        }
                    }
                }
            }

            Box(Modifier.weight(1f).fillMaxWidth()) {
                // Lecteur « plein » : cover + contrôles + aperçu file (portrait : file ancrée en bas)
                val landscapeLayout = isLandscape()
                // File ouverte (≥ ~15 %) : panneau dédié (mini-lecteur + onglets + liste), pas un overlay semi-transparent
                val showQueuePanel = qp > 0.15f
                if (showQueuePanel) {
                    Column(
                        Modifier
                            .fillMaxSize()
                            .background(MaterialTheme.colorScheme.background)
                            .navigationBarsPadding()
                            .graphicsLayer {
                                // Slide opaque (pas d’alpha → plus de grisé pendant le swipe)
                                val t = ((qp - 0.15f) / 0.85f).coerceIn(0f, 1f)
                                translationY = (1f - t) * 56f
                            },
                    ) {
                        QueueExpandedHeader(
                            track = track,
                            playing = ui.playing,
                            shuffle = ui.shuffle,
                            repeat = ui.repeat,
                            queueTitle = ui.queueTitle,
                            progressHint = qp,
                            positionMs = ui.positionMs,
                            durationMs = ui.durationMs,
                            onSeek = { player.seek(it) },
                            onCollapse = { collapseQueue() },
                            onToggle = player::toggle,
                            onSkipPrev = {
                                val now = SystemClock.elapsedRealtime()
                                val double = now - lastPrevTap < 380L
                                lastPrevTap = now
                                player.skipPrevOrRestart(forcePrevious = double)
                            },
                            onSkipNext = player::skipNext,
                            onToggleShuffle = player::toggleShuffle,
                            onCycleRepeat = player::cycleRepeat,
                            onOpenArtist = onOpenArtist,
                            onQueueDrag = ::onQueueDrag,
                            onQueueDragEnd = { settleQueue(it) },
                            onSwipeToSimilar = { queuePanelTab = 1 },
                            onSwipeToQueue = { queuePanelTab = 0 },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        QueueExpandedBody(
                            ui = ui,
                            container = container,
                            player = player,
                            listState = queueListState,
                            panelTab = queuePanelTab,
                            onPanelTabChange = { queuePanelTab = it },
                            similarListState = similarListState,
                            similarPanelCache = similarPanelCache,
                            onPlayAt = player::playAt,
                            onMore = onMore,
                            onMove = player::moveInQueue,
                            onSave = { showSaveQueue = true },
                            onClear = {
                                player.clearUpcomingFromQueue()
                                Toast.makeText(context, "File vidée", Toast.LENGTH_SHORT).show()
                            },
                            onStartMix = {
                                val t = ui.track ?: return@QueueExpandedBody
                                scope.launch {
                                    val mix = buildRadioQueue(container.api, "track", t.id, t, mixCache = container.mixCache)
                                    if (mix.isNotEmpty()) {
                                        player.playRadioOrEnqueue(mix, "Mix", sourceKind = "radio")
                                        Toast.makeText(context, "Mix ajouté après le titre en cours", Toast.LENGTH_SHORT).show()
                                    }
                                }
                            },
                            onToggleAutoplay = player::toggleAutoplaySuggestions,
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth()
                                .fillMaxHeight(),
                        )
                    }
                }
                if (!showQueuePanel) {
                Column(Modifier.fillMaxSize()) {
                Column(
                    Modifier
                        // Portrait : un peu moins pour la pochette, un peu plus pour
                        // l'aperçu de la file — c'est là qu'on lit ce qui vient ensuite.
                        .weight(if (landscapeLayout) 1f else 0.66f)
                        .fillMaxWidth()
                        .clipToBounds()
                        .graphicsLayer {
                            // Léger slide sans assombrir (évite lag + grisé)
                            translationY = -qp * 24f
                        },
                ) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .clipToBounds(),
                    horizontalAlignment = Alignment.Start,
                    // Portrait : pas de scroll — cover remplit, chrome (titre/chips/seek) épinglé dessous
                    userScrollEnabled = landscapeLayout,
                ) {
                    item {
                        val landscape = landscapeLayout
                        // Paysage : cover compacte. Portrait : remplie via fillParentMaxHeight plus bas.
                        val coverHLandscape = (screenHeightDp() * 0.62f).dp.coerceIn(110.dp, 200.dp)
                        val mediaBlock: @Composable (Dp) -> Unit = { coverH ->
                            val lyricsH = coverH
                            Column(
                                Modifier
                                    .fillMaxWidth()
                                    .then(
                                        if (showLyrics) Modifier
                                        else Modifier.nowPlayingMediaGestures(
                                            key = track.id,
                                            onDismissDelta = { delta ->
                                                if (queueProgress.value > 0.02f) {
                                                    onQueueDrag(delta)
                                                } else if (!dismissArmed) {
                                                    dragOffset = 0f
                                                } else {
                                                    dragOffset = (dragOffset + delta).coerceAtLeast(0f)
                                                }
                                            },
                                            onDismissEnd = {
                                                if (queueProgress.value > 0.02f) settleQueue(0f)
                                                else settleOrClose()
                                            },
                                            onHorizontalDelta = { dx ->
                                                mediaSlideX = (mediaSlideX + dx).coerceIn(-120f, 120f)
                                            },
                                            onHorizontalEnd = { totalX ->
                                                when {
                                                    totalX < -72f -> skipNextFromSwipe()
                                                    totalX > 72f -> skipPrevFromSwipe()
                                                    else -> mediaSlideX = 0f
                                                }
                                            },
                                            onHorizontalCancel = { mediaSlideX = 0f },
                                        ),
                                    ),
                                horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                // Paroles = même emplacement / hauteur que cover|vidéo ; titre + artiste restent dessous.
                                if (showLyrics) {
                                    InlineSyncedLyrics(
                                        container = container,
                                        track = track,
                                        positionMs = ui.positionMs,
                                        durationMs = ui.durationMs,
                                        onSeek = { player.seek(it) },
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .height(lyricsH)
                                            .clip(RoundedCornerShape(12.dp))
                                            .background(Color.Black.copy(alpha = 0.42f)),
                                    )
                                } else if (SessionMediaMode.video) {
                                    when {
                                        visualVideoUrl != null -> SyncedVideoSurface(
                                            streamUrl = visualVideoUrl!!,
                                            positionMs = ui.positionMs,
                                            playing = ui.playing,
                                            active = sheetVisible && SessionMediaMode.video,
                                            fullscreen = false,
                                            onToggleFullscreen = { videoFullscreen = true },
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .height(coverH)
                                                .clip(RoundedCornerShape(12.dp)),
                                        )
                                        visualVideoError != null -> Box(
                                            Modifier
                                                .fillMaxWidth()
                                                .height(coverH)
                                                .clip(RoundedCornerShape(12.dp)),
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            AsyncImage(
                                                model = track.coverUrl(400),
                                                contentDescription = track.title,
                                                contentScale = ContentScale.Crop,
                                                modifier = Modifier
                                                    .fillMaxSize()
                                                    .graphicsLayer {
                                                        scaleX = 1.14f
                                                        scaleY = 1.14f
                                                    },
                                            )
                                            Text(
                                                visualVideoError!!,
                                                color = PlayerMuted,
                                                modifier = Modifier
                                                    .align(Alignment.BottomCenter)
                                                    .padding(12.dp),
                                            )
                                        }
                                        else -> Box(
                                            Modifier
                                                .fillMaxWidth()
                                                .height(coverH)
                                                .clip(RoundedCornerShape(12.dp))
                                                .background(Color.Black.copy(alpha = 0.35f)),
                                            contentAlignment = Alignment.Center,
                                        ) {
                                            Text("Chargement vidéo…", color = PlayerMuted)
                                        }
                                    }
                                } else {
                                    NowPlayingHeroCover(
                                        track = track,
                                        coverH = coverH,
                                        landscape = landscape,
                                    )
                                }
                            }
                        }
                        val metaAndControls: @Composable () -> Unit = {
                            if (landscape) {
                                Text(
                                    track.title,
                                    style = MaterialTheme.typography.titleLarge,
                                    fontWeight = FontWeight.Bold,
                                    color = PlayerFg,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.fillMaxWidth(),
                                )
                                if (onOpenArtist != null) {
                                    ArtistLinksText(
                                        track = track,
                                        onOpenArtist = onOpenArtist,
                                        color = PlayerMuted,
                                        style = MaterialTheme.typography.bodyMedium,
                                        maxLines = 1,
                                        modifier = Modifier.fillMaxWidth(),
                                    )
                                } else {
                                    Text(
                                        track.artistLine(),
                                        color = PlayerMuted,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.fillMaxWidth(),
                                    )
                                }
                                Spacer(Modifier.height(6.dp))
                            }
                            if (!landscape) Spacer(Modifier.height(4.dp))
                            ui.sleepLabel?.let { label ->
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(20.dp))
                                        .background(Color(0x33FFB300))
                                        .clickable { /* ouvert via ⋮ */ }
                                        .padding(horizontal = 12.dp, vertical = 8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                ) {
                                    Text(
                                        "Minuteur · $label",
                                        color = PlayerFg,
                                        style = MaterialTheme.typography.labelMedium,
                                    )
                                    Text(
                                        "Annuler",
                                        color = PlayerFg,
                                        style = MaterialTheme.typography.labelMedium,
                                        fontWeight = FontWeight.SemiBold,
                                        modifier = Modifier.clickable { player.clearSleepTimer() },
                                    )
                                }
                                Spacer(Modifier.height(8.dp))
                            }
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .horizontalScroll(rememberScrollState()),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                NowPlayingChrome.secondaryActions.forEach { slot ->
                                    if (!slot.enabled) return@forEach
                                    when (slot.id) {
                                        PlayerChromeAction.Like -> SecondaryChip(
                                            icon = if (liked) Icons.Default.Favorite else Icons.Default.FavoriteBorder,
                                            label = slot.label,
                                            tint = if (liked) MaterialTheme.colorScheme.primary else PlayerFg,
                                            showLabel = false,
                                        ) {
                                            val was = liked
                                            onLikedChanged(
                                                if (was) likedIds - track.id else likedIds + track.id,
                                            )
                                            container.appScope().launch {
                                                runCatching {
                                                    AppLog.breadcrumb("like", track.id)
                                                    val r = container.api.like(track)
                                                    onLikedChanged(
                                                        if (r.liked) likedIds + track.id
                                                        else likedIds - track.id,
                                                    )
                                                    container.api.recoFeedback(
                                                        RecoFeedbackBody(
                                                            track.id,
                                                            if (r.liked) "good" else "bad",
                                                            "now_playing_like",
                                                        ),
                                                    )
                                                }.onFailure { e ->
                                                    if (e is kotlinx.coroutines.CancellationException) throw e
                                                    onLikedChanged(
                                                        if (was) likedIds + track.id else likedIds - track.id,
                                                    )
                                                    AppLog.e("like", "échec like ${track.id}", e)
                                                }
                                            }
                                        }
                                        PlayerChromeAction.Lyrics -> SecondaryChip(
                                            Icons.Default.Lyrics,
                                            slot.label,
                                            if (showLyrics) SeekRed else PlayerFg,
                                            showLabel = false,
                                            active = showLyrics,
                                        ) { showLyrics = !showLyrics }
                                        PlayerChromeAction.AddToPlaylist -> SecondaryChip(
                                            Icons.Default.PlaylistAdd, slot.label, PlayerFg, showLabel = true,
                                        ) { onOpenAddToPlaylist?.invoke(track) }
                                        PlayerChromeAction.Download -> {
                                            val dlMap by container.downloadManager.progress.collectAsState()
                                            val offlineRev by container.offlineStore.revision.collectAsState()
                                            val dlProgress = dlMap[track.id]
                                            var dlDone by remember(track.id) { mutableStateOf(false) }
                                            LaunchedEffect(track.id, offlineRev, dlProgress) {
                                                if (dlProgress == null) {
                                                    dlDone = container.offlineStore.has(track.id) ||
                                                        runCatching {
                                                            container.api.library().downloaded.contains(track.id)
                                                        }.getOrDefault(false)
                                                }
                                            }
                                            Row(
                                                modifier = Modifier
                                                    .clip(RoundedCornerShape(20.dp))
                                                    .background(PlayerFg.copy(alpha = 0.08f))
                                                    .clickable {
                        if (dlDone) return@clickable
                        if (dlProgress != null) {
                            container.downloadManager.cancel(track.id)
                            Toast.makeText(context, "Téléchargement annulé", Toast.LENGTH_SHORT).show()
                            return@clickable
                        }
                        val started = container.downloadManager.enqueue(track)
                        if (!started && container.offlineStore.has(track.id)) {
                            dlDone = true
                            Toast.makeText(context, "Déjà sur l'appareil", Toast.LENGTH_SHORT).show()
                        } else if (started) {
                            Toast.makeText(context, "Téléchargement…", Toast.LENGTH_SHORT).show()
                        }
                    }
                                                    .padding(horizontal = 10.dp, vertical = 8.dp),
                                                verticalAlignment = Alignment.CenterVertically,
                                            ) {
                                                DownloadStatusIcon(
                                                    downloaded = dlDone,
                                                    progress = dlProgress,
                                                    size = 22.dp,
                                                    tint = PlayerFg,
                                                    accent = SeekRed,
                                                )
                                            }
                                        }
                                        PlayerChromeAction.Mix -> SecondaryChip(
                                            MixIcon, "Mix", SeekRed, showLabel = false,
                                        ) {
                                            scope.launch {
                                                val mix = buildRadioQueue(container.api, "track", track.id, track, mixCache = container.mixCache)
                                                if (mix.isNotEmpty()) {
                                                    player.playRadioOrEnqueue(mix, "Mix", sourceKind = "radio")
                                                    Toast.makeText(context, "Mix ajouté après le titre en cours", Toast.LENGTH_SHORT).show()
                                                }
                                            }
                                        }
                                        PlayerChromeAction.Equalizer -> SecondaryChip(
                                            Icons.Default.Tune,
                                            "Égaliseur",
                                            if (ovh.delhomme.ytmusic.player.AudioEqualizer.isEnabled()) SeekRed else PlayerFg,
                                            showLabel = false,
                                        ) { showEqualizer = true }
                                        PlayerChromeAction.Speed -> Box {
                                            SecondaryChip(
                                                Icons.Default.Speed,
                                                speedLabel(ui.playbackSpeed),
                                                if (kotlin.math.abs(ui.playbackSpeed - 1f) > 0.02f) SeekRed else PlayerFg,
                                                showLabel = true,
                                            ) { showSpeedMenu = true }
                                            DropdownMenu(
                                                expanded = showSpeedMenu,
                                                onDismissRequest = { showSpeedMenu = false },
                                            ) {
                                                PlayerController.PLAYBACK_SPEEDS.forEach { sp ->
                                                    val selected = kotlin.math.abs(ui.playbackSpeed - sp) < 0.02f
                                                    DropdownMenuItem(
                                                        text = {
                                                            Text(
                                                                speedLabel(sp),
                                                                color = if (selected) SeekRed else PlayerFg,
                                                            )
                                                        },
                                                        onClick = {
                                                            player.setPlaybackSpeed(sp)
                                                            showSpeedMenu = false
                                                        },
                                                    )
                                                }
                                            }
                                        }
                                        else -> Unit
                                    }
                                }
                            }
                        }

                        Column(
                            Modifier
                                .fillMaxWidth()
                                .fillParentMaxWidth()
                                .padding(horizontal = if (landscape) 12.dp else 0.dp)
                                .graphicsLayer { translationX = mediaSlideX * 0.35f },
                            horizontalAlignment = Alignment.CenterHorizontally,
                        ) {
                            if (landscape) {
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .heightIn(max = (screenHeightDp() - 52).dp),
                                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Box(Modifier.weight(0.40f)) { mediaBlock(coverHLandscape) }
                                    Column(
                                        Modifier
                                            .weight(0.60f)
                                            .fillMaxHeight()
                                            .verticalScroll(rememberScrollState()),
                                    ) {
                                        metaAndControls()
                                        NowPlayingSeekTransport(
                                            ui = ui,
                                            player = player,
                                            progress = progress,
                                            scrub = scrub,
                                            onScrub = { scrub = it },
                                            duration = duration,
                                            landscape = true,
                                            lastPrevTap = lastPrevTap,
                                            onPrevTap = { lastPrevTap = it },
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .zIndex(4f)
                                                .background(Color.Black.copy(alpha = 0.72f))
                                                .clickable(
                                                    interactionSource = remember { MutableInteractionSource() },
                                                    indication = null,
                                                    onClick = {},
                                                ),
                                        )
                                    }
                                }
                            } else {
                                // Portrait : cover remplit toute la zone au-dessus du chrome
                                // (plus de carré « carte » flottant dans un bandeau noir).
                                Column(
                                    Modifier
                                        .fillParentMaxWidth()
                                        .fillMaxWidth()
                                        .fillParentMaxHeight(),
                                ) {
                                    BoxWithConstraints(
                                        Modifier
                                            .weight(1f)
                                            .fillMaxWidth(),
                                    ) {
                                        // Hauteur = zone dispo ; Crop enlève les piliers 16:9.
                                        mediaBlock(maxHeight)
                                    }
                                    Column(
                                        Modifier
                                            .fillMaxWidth()
                                            .zIndex(5f)
                                            .background(Color.Black.copy(alpha = 0.72f))
                                            .padding(horizontal = 18.dp)
                                            .padding(top = 10.dp, bottom = 0.dp),
                                    ) {
                                        Text(
                                            track.title,
                                            style = MaterialTheme.typography.titleLarge,
                                            fontWeight = FontWeight.SemiBold,
                                            color = PlayerFg,
                                            maxLines = 1,
                                            overflow = TextOverflow.Ellipsis,
                                            textAlign = TextAlign.Start,
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .then(
                                                    if (sheetVisible && !queueInteractive) {
                                                        Modifier.basicMarquee(
                                                            iterations = 3,
                                                            initialDelayMillis = 1_800,
                                                        )
                                                    } else {
                                                        Modifier
                                                    },
                                                ),
                                        )
                                        if (ui.buffering) {
                                            Text(
                                                "Chargement du flux…",
                                                color = Color(0xFFFF8A80),
                                                style = MaterialTheme.typography.bodySmall,
                                                modifier = Modifier
                                                    .fillMaxWidth()
                                                    .padding(top = 2.dp),
                                            )
                                        }
                                        if (onOpenArtist != null) {
                                            ArtistLinksText(
                                                track = track,
                                                onOpenArtist = onOpenArtist,
                                                color = PlayerMuted,
                                                style = MaterialTheme.typography.bodyMedium,
                                                maxLines = 1,
                                                modifier = Modifier.fillMaxWidth(),
                                            )
                                        } else {
                                            Text(
                                                track.artistLine(),
                                                color = PlayerMuted,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                                modifier = Modifier.fillMaxWidth(),
                                            )
                                        }
                                        // Chips collés sous l’artiste, juste au-dessus du seek
                                        metaAndControls()
                                        NowPlayingSeekTransport(
                                            ui = ui,
                                            player = player,
                                            progress = progress,
                                            scrub = scrub,
                                            onScrub = { scrub = it },
                                            duration = duration,
                                            landscape = false,
                                            lastPrevTap = lastPrevTap,
                                            onPrevTap = { lastPrevTap = it },
                                            modifier = Modifier
                                                .fillMaxWidth()
                                                .zIndex(4f)
                                                .clickable(
                                                    interactionSource = remember { MutableInteractionSource() },
                                                    indication = null,
                                                    onClick = {},
                                                ),
                                        )
                                    }
                                }
                            }
                        }
                    }

                    // Paysage : aperçu file dans le même scroll. Portrait : panneau dédié en bas.
                    if (landscapeLayout) {
                        item {
                            val qh = queueHeaderLabels(ui)
                            QueueSectionHeader(
                                caption = qh.caption,
                                title = qh.title,
                                canClear = ui.queue.size > 1,
                                onExpand = { expandQueue() },
                                onSave = { showSaveQueue = true },
                                onClear = {
                                    player.clearUpcomingFromQueue()
                                    Toast.makeText(context, "File vidée", Toast.LENGTH_SHORT).show()
                                },
                                onStartMix = {
                                    val t = ui.track ?: return@QueueSectionHeader
                                    scope.launch {
                                        val mix = buildRadioQueue(container.api, "track", t.id, t, mixCache = container.mixCache)
                                        if (mix.isNotEmpty()) {
                                            player.playRadioOrEnqueue(mix, "Mix", sourceKind = "radio")
                                            Toast.makeText(context, "Mix ajouté après le titre en cours", Toast.LENGTH_SHORT).show()
                                        }
                                    }
                                },
                                onQueueDrag = ::onQueueDrag,
                                onQueueDragEnd = { settleQueue(it) },
                            )
                        }

                        val boundary = ui.userQueueEnd.coerceIn(0, ui.queue.size)
                        val playedBefore = ui.queue.take(ui.queueIndex.coerceIn(0, ui.queue.size))
                        if (playedBefore.isNotEmpty()) {
                            item {
                                Text(
                                    "Déjà joués",
                                    Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                                    style = MaterialTheme.typography.labelMedium,
                                    color = PlayerMuted,
                                    fontWeight = FontWeight.SemiBold,
                                )
                            }
                            itemsIndexed(
                                playedBefore,
                                key = { i, t -> "played-c-${t.id}-$i" },
                            ) { index, item ->
                                QueueTrackRow(
                                    track = item,
                                    index = index,
                                    highlighted = false,
                                    onClick = { player.playAt(index) },
                                    onLongClick = { onMore?.invoke(item) },
                                    onMove = { from, to -> player.moveInQueue(from, to) },
                                    onMore = onMore?.let { { it(item) } },
                                    onMix = {
                                        scope.launch {
                                            val mix = buildRadioQueue(container.api, "track", item.id, item, mixCache = container.mixCache)
                                            if (mix.isNotEmpty()) {
                                                player.playRadioOrEnqueue(mix, "Mix", sourceKind = "radio")
                                                Toast.makeText(context, "Mix ajouté après le titre en cours", Toast.LENGTH_SHORT).show()
                                            }
                                        }
                                    },
                                    radioActive = ui.sourceKind == "radio" && ui.sourceId == item.id,
                                )
                            }
                        }
                        item {
                            Text(
                                "En cours",
                                Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                                style = MaterialTheme.typography.labelMedium,
                                color = PlayerMuted,
                                fontWeight = FontWeight.SemiBold,
                            )
                        }
                        // Aperçu : titre courant + suite user (pas seulement à partir du courant sans label)
                        val previewFrom = ui.queueIndex.coerceIn(0, boundary)
                        itemsIndexed(
                            ui.queue.subList(previewFrom, boundary),
                            key = { i, t -> "iu-${t.id}-${previewFrom + i}" },
                        ) { index, item ->
                            val abs = previewFrom + index
                            QueueTrackRow(
                                track = item,
                                index = abs,
                                highlighted = abs == ui.queueIndex,
                                onClick = { player.playAt(abs) },
                                onLongClick = { onMore?.invoke(item) },
                                onMove = { from, to -> player.moveInQueue(from, to) },
                                onMore = onMore?.let { { it(item) } },
                                onMix = {
                                    scope.launch {
                                        val mix = buildRadioQueue(container.api, "track", item.id, item, mixCache = container.mixCache)
                                        if (mix.isNotEmpty()) {
                                            player.playRadioOrEnqueue(mix, "Mix", sourceKind = "radio")
                                            Toast.makeText(context, "Mix ajouté après le titre en cours", Toast.LENGTH_SHORT).show()
                                        }
                                    }
                                },
                                radioActive = ui.sourceKind == "radio" && ui.sourceId == item.id,
                            )
                        }
                        item {
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 16.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text("À suivre", fontWeight = FontWeight.SemiBold, color = PlayerFg)
                                    Text(
                                        "Lecture automatique",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = PlayerMuted,
                                    )
                                }
                                Switch(
                                    checked = ui.autoplaySuggestions,
                                    onCheckedChange = { player.toggleAutoplaySuggestions() },
                                    colors = SwitchDefaults.colors(
                                        checkedTrackColor = SeekRed,
                                        checkedThumbColor = Color.White,
                                    ),
                                )
                            }
                        }
                        if (!ui.autoplaySuggestions) {
                            item {
                                Text(
                                    "Lecture auto désactivée — stop en fin de file ; Suivant charge la suite",
                                    Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = PlayerMuted,
                                )
                            }
                        }
                        itemsIndexed(
                            ui.queue.drop(boundary),
                            key = { i, t -> "ia-${t.id}-${boundary + i}" },
                        ) { i, item ->
                                val abs = boundary + i
                                QueueTrackRow(
                                    track = item,
                                    index = abs,
                                    highlighted = abs == ui.queueIndex,
                                    onClick = { player.playAt(abs) },
                                    onLongClick = { onMore?.invoke(item) },
                                    onMove = { from, to -> player.moveInQueue(from, to) },
                                    onMore = onMore?.let { { it(item) } },
                                    onMix = {
                                        scope.launch {
                                            val mix = buildRadioQueue(container.api, "track", item.id, item, mixCache = container.mixCache)
                                            if (mix.isNotEmpty()) {
                                                player.playRadioOrEnqueue(mix, "Mix", sourceKind = "radio")
                                                Toast.makeText(context, "Mix ajouté après le titre en cours", Toast.LENGTH_SHORT).show()
                                            }
                                        }
                                    },
                                )
                            }
                        item { Spacer(Modifier.height(40.dp)) }
                    }
                }

                // Seek portrait est dans l’item LazyColumn (collé sous chips). Paysage : seek dans la colonne droite.
                } // Column lecteur (LazyColumn + chrome)

                if (!landscapeLayout) {
                    PortraitQueuePreview(
                        ui = ui,
                        player = player,
                        container = container,
                        scope = scope,
                        context = context,
                        onMore = onMore,
                        onExpand = { expandQueue() },
                        onSave = { showSaveQueue = true },
                        onQueueDrag = ::onQueueDrag,
                        onQueueDragEnd = { settleQueue(it) },
                        modifier = Modifier
                            .weight(0.34f)
                            .fillMaxWidth()
                            .zIndex(1f)
                            .clipToBounds()
                            .navigationBarsPadding(),
                    )
                }
                } // Column lecteur plein
                } // if (!showQueuePanel)
            } // Box
        }
        if (videoFullscreen && visualVideoUrl != null && SessionMediaMode.video && track != null) {
            Box(
                Modifier
                    .fillMaxSize()
                    .background(Color.Black),
            ) {
                SyncedVideoSurface(
                    streamUrl = visualVideoUrl!!,
                    positionMs = ui.positionMs,
                    playing = ui.playing,
                    active = sheetVisible,
                    fullscreen = true,
                    onToggleFullscreen = { videoFullscreen = false },
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }

    if (showSaveQueue) {
        SaveQueueSheet(
            container = container,
            queue = ui.queue.take(ui.userQueueEnd.coerceIn(0, ui.queue.size)).ifEmpty { ui.queue },
            defaultName = ui.queueTitle.takeIf { it != "File d'attente" } ?: "Ma file d'attente",
            onDismiss = { showSaveQueue = false },
            onSaved = { name ->
                showSaveQueue = false
                player.setQueueTitle(name)
                Toast.makeText(context, "File enregistrée « $name »", Toast.LENGTH_SHORT).show()
            },
        )
    }
    if (showEqualizer) {
        EqualizerSheet(onDismiss = { showEqualizer = false })
    }
}

/** Seek + shuffle/prev/play/next/repeat — hors scroll paroles pour rester ancré. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NowPlayingSeekTransport(
    ui: PlayerUiState,
    player: PlayerController,
    progress: Float,
    scrub: Float,
    onScrub: (Float) -> Unit,
    duration: Float,
    landscape: Boolean,
    lastPrevTap: Long,
    onPrevTap: (Long) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Spacer(Modifier.height(2.dp))
        // Seek par position X (tap court + glissé) — pas le Slider Material3
        // qui mappe mal les taps → ratio 0 / reprise au début.
        var dragRatio by remember { mutableFloatStateOf(-1f) }
        val shownProgress = if (dragRatio >= 0f) dragRatio else progress
        val bufferedFrac = if (ui.durationMs > 0) {
            (ui.bufferedMs.toFloat() / ui.durationMs).coerceIn(0f, 1f)
        } else {
            0f
        }
        PlayerSeekBar(
            progress = shownProgress.coerceIn(0f, 1f),
            buffered = bufferedFrac,
            // Les 64 dp étaient surtout du vide autour d'un trait de 4 dp. On en
            // rend la moitié à la file d'attente, en gardant une prise franche.
            touchHeight = 40.dp,
            trackHeight = 4.dp,
            thumbSize = if (dragRatio >= 0f || scrub >= 0f) 16.dp else 12.dp,
            onScrub = { ratio ->
                dragRatio = ratio
                onScrub(ratio)
            },
            onSeekCommit = { ratio ->
                if (ratio >= 0f && duration > 1f) {
                    player.seek((ratio * duration).toLong().coerceAtLeast(0L))
                }
                dragRatio = -1f
                onScrub(-1f)
            },
            modifier = Modifier.fillMaxWidth(),
        )
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            val scrubPos = when {
                dragRatio >= 0f -> (dragRatio * duration).toLong()
                scrub >= 0f -> (scrub * duration).toLong()
                else -> ui.positionMs
            }
            val remainingMs = (ui.durationMs - scrubPos).coerceAtLeast(0L)
            Text(
                "-${formatMs(remainingMs)}",
                style = MaterialTheme.typography.labelSmall,
                color = PlayerMuted,
            )
            Text(
                formatMs(ui.durationMs.coerceAtLeast(0L)),
                style = MaterialTheme.typography.labelSmall,
                color = PlayerMuted,
            )
        }
        Spacer(Modifier.height(2.dp))
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            NowPlayingChrome.transportActions.forEach { slot ->
                if (!slot.enabled) return@forEach
                when (slot.id) {
                    PlayerChromeAction.Shuffle -> IconButton(onClick = player::toggleShuffle) {
                        Icon(
                            Icons.Default.Shuffle,
                            slot.label,
                            tint = if (ui.shuffle) MaterialTheme.colorScheme.primary else PlayerFg,
                        )
                    }
                    PlayerChromeAction.Previous -> HoldSeekIconButton(
                        onClick = {
                            val now = SystemClock.elapsedRealtime()
                            val double = now - lastPrevTap < 380L
                            onPrevTap(now)
                            player.skipPrevOrRestart(forcePrevious = double)
                        },
                        onHoldTick = { player.seekBy(-2_000L) },
                    ) {
                        Icon(
                            Icons.Default.SkipPrevious,
                            slot.label,
                            tint = PlayerFg,
                            modifier = Modifier.size(if (landscape) 34.dp else 40.dp),
                        )
                    }
                    PlayerChromeAction.PlayPause -> IconButton(onClick = player::toggle) {
                        Icon(
                            if (ui.playing) Icons.Default.Pause else Icons.Default.PlayArrow,
                            slot.label,
                            tint = PlayerFg,
                            modifier = Modifier.size(if (landscape) 48.dp else 56.dp),
                        )
                    }
                    PlayerChromeAction.Next -> HoldSeekIconButton(
                        onClick = player::skipNext,
                        onHoldTick = { player.seekBy(2_000L) },
                    ) {
                        Icon(
                            Icons.Default.SkipNext,
                            slot.label,
                            tint = PlayerFg,
                            modifier = Modifier.size(if (landscape) 34.dp else 40.dp),
                        )
                    }
                    PlayerChromeAction.Repeat -> IconButton(onClick = player::cycleRepeat) {
                        Icon(
                            when (ui.repeat) {
                                RepeatMode.One -> Icons.Default.RepeatOne
                                else -> Icons.Default.Repeat
                            },
                            slot.label,
                            tint = when (ui.repeat) {
                                RepeatMode.Off -> PlayerMuted
                                else -> MaterialTheme.colorScheme.primary
                            },
                        )
                    }
                    else -> Unit
                }
            }
        }
        if (!landscape) Spacer(Modifier.height(4.dp))
    }
}

@Composable
private fun SecondaryChip(
    icon: ImageVector,
    label: String,
    tint: Color,
    showLabel: Boolean,
    active: Boolean = false,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(20.dp))
            .background(
                if (active) SeekRed.copy(alpha = 0.18f) else PlayerFg.copy(alpha = 0.08f),
            )
            .clickable(onClick = onClick)
            .padding(
                horizontal = if (showLabel) 12.dp else 10.dp,
                vertical = 8.dp,
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(icon, contentDescription = label, tint = tint, modifier = Modifier.size(22.dp))
        if (showLabel) {
            Text(
                label,
                style = MaterialTheme.typography.labelMedium,
                color = if (active) SeekRed else PlayerFg,
                maxLines = 1,
            )
        }
    }
}

/** Aperçu file d’attente ancré en bas (portrait) — liste scrollable, sans doublon transport. */
@Composable
private fun PortraitQueuePreview(
    ui: PlayerUiState,
    player: PlayerController,
    container: AppContainer,
    scope: CoroutineScope,
    context: Context,
    onMore: ((TrackDto) -> Unit)?,
    onExpand: () -> Unit,
    onSave: () -> Unit,
    onQueueDrag: (Float) -> Unit,
    onQueueDragEnd: (Float) -> Unit,
    modifier: Modifier = Modifier,
) {
    val previewList = rememberLazyListState()
    // Empêche l’overscroll de la file de shrink/dismiss le lecteur plein écran
    val blockParentDismiss = remember {
        object : NestedScrollConnection {
            override fun onPostScroll(
                consumed: Offset,
                available: Offset,
                source: NestedScrollSource,
            ): Offset {
                if (available.y == 0f) return Offset.Zero
                return Offset(0f, available.y)
            }

            override suspend fun onPostFling(
                consumed: Velocity,
                available: Velocity,
            ): Velocity {
                if (available.y == 0f) return Velocity.Zero
                return Velocity(0f, available.y)
            }
        }
    }
    val boundary = ui.userQueueEnd.coerceIn(0, ui.queue.size)
    // L’aperçu replié montre ce qui vient — pas le titre déjà affiché au-dessus.
    // Header Mix sticky hors LazyColumn — reste visible pendant le scroll
    Column(modifier = modifier.nestedScroll(blockParentDismiss)) {
        val qh = queueHeaderLabels(ui)
        QueueSectionHeader(
            caption = qh.caption,
            title = qh.title,
            canClear = ui.queue.size > 1,
            onExpand = onExpand,
            onSave = onSave,
            onClear = {
                player.clearUpcomingFromQueue()
                Toast.makeText(context, "File vidée", Toast.LENGTH_SHORT).show()
            },
            onStartMix = {
                val t = ui.track ?: return@QueueSectionHeader
                scope.launch {
                    val mix = buildRadioQueue(container.api, "track", t.id, t, mixCache = container.mixCache)
                    if (mix.isNotEmpty()) {
                        player.playRadioOrEnqueue(mix, "Mix", sourceKind = "radio")
                        Toast.makeText(context, "Mix ajouté après le titre en cours", Toast.LENGTH_SHORT).show()
                    }
                }
            },
            onQueueDrag = onQueueDrag,
            onQueueDragEnd = onQueueDragEnd,
        )
        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f, fill = false),
            state = previewList,
        ) {
        val previewFrom = (ui.queueIndex + 1).coerceIn(0, boundary)
        itemsIndexed(
            ui.queue.subList(previewFrom, boundary),
            key = { i, t -> "ip-${t.id}-${previewFrom + i}" },
        ) { index, item ->
            val abs = previewFrom + index
            QueueTrackRow(
                track = item,
                index = abs,
                highlighted = abs == ui.queueIndex,
                onClick = { player.playAt(abs) },
                onLongClick = { onMore?.invoke(item) },
                onMove = { from, to -> player.moveInQueue(from, to) },
                onMore = onMore?.let { { it(item) } },
                onMix = {
                    scope.launch {
                        val mix = buildRadioQueue(container.api, "track", item.id, item, mixCache = container.mixCache)
                        if (mix.isNotEmpty()) {
                            player.playRadioOrEnqueue(mix, "Mix", sourceKind = "radio")
                        }
                    }
                },
                radioActive = ui.sourceKind == "radio" && ui.sourceId == item.id,
            )
        }
        item {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("À suivre", fontWeight = FontWeight.SemiBold, color = PlayerFg)
                    Text(
                        "Lecture automatique",
                        style = MaterialTheme.typography.labelSmall,
                        color = PlayerMuted,
                    )
                }
                Switch(
                    checked = ui.autoplaySuggestions,
                    onCheckedChange = { player.toggleAutoplaySuggestions() },
                    colors = SwitchDefaults.colors(
                        checkedTrackColor = SeekRed,
                        checkedThumbColor = Color.White,
                    ),
                )
            }
        }
        itemsIndexed(
            ui.queue.drop(boundary).take(12),
            key = { i, t -> "ap-${t.id}-${boundary + i}" },
        ) { i, item ->
            val abs = boundary + i
            QueueTrackRow(
                track = item,
                index = abs,
                highlighted = abs == ui.queueIndex,
                onClick = { player.playAt(abs) },
                onLongClick = { onMore?.invoke(item) },
                onMove = { from, to -> player.moveInQueue(from, to) },
                onMore = onMore?.let { { it(item) } },
                onMix = {
                    scope.launch {
                        val mix = buildRadioQueue(container.api, "track", item.id, item, mixCache = container.mixCache)
                        if (mix.isNotEmpty()) {
                            player.playRadioOrEnqueue(mix, "Mix", sourceKind = "radio")
                        }
                    }
                },
            )
        }
        item { Spacer(Modifier.height(8.dp)) }
    }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun QueueSectionHeader(
    caption: String,
    title: String,
    canClear: Boolean = false,
    onExpand: () -> Unit,
    onSave: () -> Unit,
    onClear: () -> Unit = {},
    onStartMix: () -> Unit,
    onQueueDrag: (Float) -> Unit,
    onQueueDragEnd: (velocityY: Float) -> Unit,
) {
    var dragVelocity by remember { mutableFloatStateOf(0f) }
    Column(
        Modifier
            .fillMaxWidth()
            .combinedClickable(onClick = onExpand, onLongClick = onExpand)
            .pointerInput(Unit) {
                detectVerticalDragGestures(
                    onVerticalDrag = { change, amount ->
                        change.consume()
                        dragVelocity = amount
                        onQueueDrag(amount)
                    },
                    onDragEnd = { onQueueDragEnd(dragVelocity * 60f) },
                    onDragCancel = { onQueueDragEnd(0f) },
                )
            }
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Box(
            Modifier
                .align(Alignment.CenterHorizontally)
                .width(36.dp)
                .height(4.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(PlayerFg.copy(alpha = 0.35f)),
        )
        Spacer(Modifier.height(10.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.QueueMusic, null, tint = PlayerFg, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    caption,
                    style = MaterialTheme.typography.labelSmall,
                    color = PlayerMuted,
                )
                Text(title, fontWeight = FontWeight.SemiBold, color = PlayerFg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (canClear) {
                IconButton(onClick = onClear) {
                    Icon(
                        Icons.Default.ClearAll,
                        contentDescription = "Vider la file",
                        tint = PlayerFg,
                        modifier = Modifier.size(22.dp),
                    )
                }
            }
            IconButton(onClick = onStartMix) {
                Icon(
                    MixIcon,
                    contentDescription = "Lancer un mix",
                    tint = SeekRed,
                    modifier = Modifier.size(22.dp),
                )
            }
            IconButton(onClick = onSave) {
                Icon(Icons.Default.Save, "Enregistrer la file", tint = PlayerFg)
            }
        }
    }
}

@Composable
private fun QueueExpandedHeader(
    track: TrackDto,
    playing: Boolean,
    shuffle: Boolean,
    repeat: RepeatMode,
    queueTitle: String,
    progressHint: Float,
    positionMs: Long,
    durationMs: Long,
    onSeek: (Long) -> Unit,
    onCollapse: () -> Unit,
    onToggle: () -> Unit,
    onSkipPrev: () -> Unit,
    onSkipNext: () -> Unit,
    onToggleShuffle: () -> Unit,
    onCycleRepeat: () -> Unit,
    onOpenArtist: ((id: String?, name: String) -> Unit)? = null,
    onQueueDrag: (Float) -> Unit,
    onQueueDragEnd: (velocityY: Float) -> Unit,
    onSwipeToSimilar: () -> Unit,
    onSwipeToQueue: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var dragVelocity by remember { mutableFloatStateOf(0f) }
    val dur = durationMs.coerceAtLeast(1L)
    val pos = positionMs.coerceIn(0L, dur)
    Column(
        modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.background.copy(alpha = 0.97f))
            .pointerInput(track.id) {
                var axis = NowPlayingDragAxis.None
                var totalX = 0f
                var totalY = 0f
                detectDragGestures(
                    onDragStart = {
                        axis = NowPlayingDragAxis.None
                        totalX = 0f
                        totalY = 0f
                        dragVelocity = 0f
                    },
                    onDragEnd = {
                        when (axis) {
                            NowPlayingDragAxis.Vertical -> onQueueDragEnd(dragVelocity * 60f)
                            NowPlayingDragAxis.Horizontal -> when {
                                totalX < -72f -> onSwipeToSimilar()
                                totalX > 72f -> onSwipeToQueue()
                            }
                            NowPlayingDragAxis.None -> Unit
                        }
                    },
                    onDragCancel = {
                        if (axis == NowPlayingDragAxis.Vertical) onQueueDragEnd(0f)
                    },
                    onDrag = { change, amount ->
                        totalX += amount.x
                        totalY += amount.y
                        if (axis == NowPlayingDragAxis.None && (abs(totalX) > 16f || abs(totalY) > 16f)) {
                            axis = if (abs(totalX) > abs(totalY)) {
                                NowPlayingDragAxis.Horizontal
                            } else {
                                NowPlayingDragAxis.Vertical
                            }
                        }
                        when (axis) {
                            NowPlayingDragAxis.Vertical -> {
                                change.consume()
                                dragVelocity = amount.y
                                onQueueDrag(amount.y)
                            }
                            NowPlayingDragAxis.Horizontal -> change.consume()
                            NowPlayingDragAxis.None -> Unit
                        }
                    },
                )
            }
            .padding(horizontal = 10.dp, vertical = 6.dp),
    ) {
        Box(
            Modifier
                .align(Alignment.CenterHorizontally)
                .width(36.dp)
                .height(4.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(PlayerFg.copy(alpha = (0.25f + 0.2f * progressHint).coerceIn(0.25f, 0.55f))),
        )
        Spacer(Modifier.height(6.dp))
        // Seek + transport shuffle|prev|play|next|repeat (file plein écran)
        var scrub by remember(track.id) { mutableFloatStateOf(-1f) }
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            MediaCover(track, 44.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    track.title,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = PlayerFg,
                    fontWeight = FontWeight.SemiBold,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    track.artistLine(),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = PlayerMuted,
                    style = MaterialTheme.typography.labelMedium,
                )
            }
            IconButton(onClick = onCollapse, modifier = Modifier.size(40.dp)) {
                Icon(Icons.Default.KeyboardArrowDown, "Replier la file", tint = PlayerFg)
            }
        }
        Spacer(Modifier.height(4.dp))
        var dragRatio by remember(track.id) { mutableFloatStateOf(-1f) }
        val shown = when {
            dragRatio >= 0f -> dragRatio
            scrub >= 0f -> scrub
            else -> (pos.toFloat() / dur.toFloat()).coerceIn(0f, 1f)
        }
        PlayerSeekBar(
            progress = shown,
            buffered = 0f,
            touchHeight = 32.dp,
            trackHeight = 3.dp,
            thumbSize = 10.dp,
            onScrub = { ratio ->
                dragRatio = ratio
                scrub = ratio
            },
            onSeekCommit = { ratio ->
                if (ratio >= 0f && dur > 0L) onSeek((ratio * dur).toLong().coerceAtLeast(0L))
                dragRatio = -1f
                scrub = -1f
            },
            modifier = Modifier.fillMaxWidth(),
        )
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                formatMs(
                    when {
                        dragRatio >= 0f -> (dragRatio * dur).toLong()
                        scrub >= 0f -> (scrub * dur).toLong()
                        else -> pos
                    },
                ),
                style = MaterialTheme.typography.labelSmall,
                color = PlayerMuted,
            )
            Text(formatMs(dur), style = MaterialTheme.typography.labelSmall, color = PlayerMuted)
        }
        Spacer(Modifier.height(2.dp))
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceEvenly,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onToggleShuffle) {
                Icon(
                    Icons.Default.Shuffle,
                    "Aléatoire",
                    tint = if (shuffle) MaterialTheme.colorScheme.primary else PlayerFg,
                )
            }
            IconButton(onClick = onSkipPrev, modifier = Modifier.size(44.dp)) {
                Icon(Icons.Default.SkipPrevious, "Précédent", tint = PlayerFg, modifier = Modifier.size(28.dp))
            }
            IconButton(onClick = onToggle, modifier = Modifier.size(52.dp)) {
                Icon(
                    if (playing) Icons.Default.Pause else Icons.Default.PlayArrow,
                    "Lecture",
                    tint = PlayerFg,
                    modifier = Modifier.size(36.dp),
                )
            }
            IconButton(onClick = onSkipNext, modifier = Modifier.size(44.dp)) {
                Icon(Icons.Default.SkipNext, "Suivant", tint = PlayerFg, modifier = Modifier.size(28.dp))
            }
            IconButton(onClick = onCycleRepeat) {
                Icon(
                    when (repeat) {
                        RepeatMode.One -> Icons.Default.RepeatOne
                        else -> Icons.Default.Repeat
                    },
                    when (repeat) {
                        RepeatMode.One -> "Boucler le titre"
                        RepeatMode.All -> "Boucler la file"
                        RepeatMode.Off -> "Boucle désactivée"
                    },
                    tint = if (repeat != RepeatMode.Off) MaterialTheme.colorScheme.primary else PlayerFg,
                )
            }
        }
    }
}

private fun similarFingerprint(t: TrackDto): String {
    val title = t.title.lowercase()
        .replace(Regex("\\(.*?\\)|\\[.*?\\]"), " ")
        .replace(Regex("[^a-z0-9àâäéèêëïîôùûüç]+"), " ")
        .trim()
    val artist = t.artists?.firstOrNull()?.name.orEmpty().lowercase().trim()
    return "$title|$artist"
}

private fun dedupeSimilar(seedId: String, list: List<TrackDto>): List<TrackDto> {
    val seenId = HashSet<String>()
    val seenFp = HashSet<String>()
    val out = ArrayList<TrackDto>()
    for (t in list) {
        if (!t.isPlayable() || t.id == seedId) continue
        if (!seenId.add(t.id)) continue
        val fp = similarFingerprint(t)
        if (fp.isNotBlank() && !seenFp.add(fp)) continue
        out += t
    }
    return out
}

@Composable
private fun QueueExpandedBody(
    ui: PlayerUiState,
    container: AppContainer,
    player: PlayerController,
    listState: LazyListState,
    panelTab: Int,
    onPanelTabChange: (Int) -> Unit,
    similarListState: LazyListState,
    similarPanelCache: MutableMap<String, SimilarTabCache>,
    onPlayAt: (Int) -> Unit,
    onMore: ((TrackDto) -> Unit)?,
    onMove: (Int, Int) -> Unit,
    onSave: () -> Unit,
    onClear: () -> Unit = {},
    onStartMix: () -> Unit,
    onToggleAutoplay: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var tabDragX by remember { mutableFloatStateOf(0f) }
    val online by ovh.delhomme.ytmusic.data.NetworkMonitor.onlineFlow.collectAsState()
    val offlineRev by container.offlineStore.revision.collectAsState()
    val unavailable: (TrackDto) -> Boolean = remember(online, offlineRev) {
        { t -> !online && !container.offlineStore.has(t.id) }
    }
    val boundary = ui.userQueueEnd.coerceIn(0, ui.queue.size)
    val playedBefore = ui.queue.take(ui.queueIndex.coerceIn(0, ui.queue.size))
    val currentAndUpcomingUser = if (ui.queueIndex < boundary) {
        ui.queue.subList(ui.queueIndex.coerceAtLeast(0), boundary)
    } else {
        emptyList()
    }
    val autoTracks = ui.queue.drop(boundary)

    var similarTracks by remember { mutableStateOf<List<TrackDto>>(emptyList()) }
    var similarLoading by remember { mutableStateOf(false) }
    var similarLoadingMore by remember { mutableStateOf(false) }
    var similarExhausted by remember { mutableStateOf(false) }
    val seedId = ui.track?.id
    val scope = rememberCoroutineScope()
    var lastPanelTab by remember { mutableIntStateOf(panelTab) }

    LaunchedEffect(panelTab, seedId, similarTracks.size, similarListState) {
        if (panelTab != 1 || seedId.isNullOrBlank()) return@LaunchedEffect
        snapshotFlow {
            similarListState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
        }.distinctUntilChanged().collect { lastVisible ->
            val size = similarTracks.size
            if (size == 0 || similarLoadingMore || similarExhausted) return@collect
            if (lastVisible < size - 5) return@collect
            similarLoadingMore = true
            val anchor = similarTracks.lastOrNull()?.id ?: seedId
            val more = runCatching {
                val rel = container.api.related(anchor, full = 0)
                dedupeSimilar(
                    seedId,
                    rel.tracks.orEmpty() + rel.related.orEmpty() + rel.radio.orEmpty(),
                )
            }.getOrDefault(emptyList())
            val up = runCatching {
                container.api.upNext(anchor).tracks.orEmpty().filter { it.isPlayable() }
            }.getOrDefault(emptyList())
            val seen = similarTracks.map { it.id }.toHashSet()
            val extras = (more + up).filter { it.id !in seen && it.id != seedId }
            if (extras.isEmpty()) {
                similarExhausted = true
            } else {
                val merged = (similarTracks + extras).distinctBy { it.id }
                val trimmed = if (merged.size > 64) merged.takeLast(64) else merged
                similarTracks = trimmed
                similarPanelCache[seedId] = (similarPanelCache[seedId] ?: SimilarTabCache()).copy(
                    tracks = trimmed,
                    exhausted = similarExhausted,
                )
            }
            similarLoadingMore = false
        }
    }

    LaunchedEffect(panelTab) {
        val sid = seedId
        if (lastPanelTab == 1 && !sid.isNullOrBlank()) {
            similarPanelCache[sid] = (similarPanelCache[sid] ?: SimilarTabCache()).copy(
                tracks = similarTracks,
                scrollIndex = similarListState.firstVisibleItemIndex,
                scrollOffset = similarListState.firstVisibleItemScrollOffset,
                loadingMore = similarLoadingMore,
                exhausted = similarExhausted,
            )
        }
        if (panelTab == 1 && !sid.isNullOrBlank()) {
            val cached = similarPanelCache[sid]
            if (cached != null && cached.tracks.isNotEmpty()) {
                similarTracks = cached.tracks
                similarExhausted = cached.exhausted
                similarLoading = false
                runCatching {
                    similarListState.scrollToItem(cached.scrollIndex, cached.scrollOffset)
                }
            }
        }
        lastPanelTab = panelTab
    }
    val startMixFor: (TrackDto) -> Unit = { track ->
        scope.launch {
            val mix = buildRadioQueue(container.api, "track", track.id, track, mixCache = container.mixCache)
            if (mix.isNotEmpty()) {
                player.playRadioOrEnqueue(mix, "Mix", sourceKind = "radio")
            }
        }
    }

    LaunchedEffect(panelTab, listState, ui.queueIndex) {
        if (panelTab != 0 || ui.queue.isEmpty()) return@LaunchedEffect
        // Mode vidéo / API saturée : ne pas bombarder /api/stream (ralentit file + similaires)
        if (SessionMediaMode.video || StreamPrefetcher.isStreamDown()) return@LaunchedEffect
        snapshotFlow {
            listState.layoutInfo.visibleItemsInfo.mapNotNull { info ->
                ui.queue.getOrNull(info.index)?.id
            }
        }.distinctUntilChanged().collect { ids ->
            if (ids.isEmpty()) return@collect
            StreamPrefetcher.prefetchTrackIds(container.resolvedApiBase(), ids, limit = 10)
        }
    }

    LaunchedEffect(panelTab, similarTracks.size) {
        if (panelTab != 1 || similarTracks.isEmpty()) return@LaunchedEffect
        if (SessionMediaMode.video || StreamPrefetcher.isStreamDown()) return@LaunchedEffect
        StreamPrefetcher.prefetchTrackIds(
            container.resolvedApiBase(),
            similarTracks.map { it.id },
            limit = 14,
        )
    }

    LaunchedEffect(seedId) {
        if (seedId.isNullOrBlank()) return@LaunchedEffect
        val cached = similarPanelCache[seedId]
        if (cached != null && cached.tracks.isNotEmpty()) {
            similarTracks = cached.tracks
            similarExhausted = cached.exhausted
            similarLoading = false
            runCatching {
                similarListState.scrollToItem(cached.scrollIndex, cached.scrollOffset)
            }
            return@LaunchedEffect
        }
        similarLoading = true
        similarExhausted = false
        val fast = runCatching {
            val rel = container.api.related(seedId, fast = 1)
            dedupeSimilar(
                seedId,
                rel.tracks.orEmpty() + rel.related.orEmpty() + rel.radio.orEmpty(),
            ).take(12)
        }.getOrDefault(emptyList())
        if (ui.track?.id != seedId) return@LaunchedEffect
        similarTracks = fast
        similarLoading = false
        similarPanelCache[seedId] = SimilarTabCache(tracks = fast)
        // Enrichissement async — ne pas bloquer l’affichage
        val mid = runCatching {
            val rel = container.api.related(seedId, full = 0)
            dedupeSimilar(
                seedId,
                rel.tracks.orEmpty() + rel.related.orEmpty() + rel.radio.orEmpty(),
            )
        }.getOrDefault(emptyList())
        if (ui.track?.id != seedId) return@LaunchedEffect
        val seenId = similarTracks.map { it.id }.toHashSet()
        val extras = mid.filter { it.id !in seenId }
        if (extras.isNotEmpty()) {
            val merged = (similarTracks + extras).distinctBy { it.id }.take(48)
            similarTracks = merged
            similarPanelCache[seedId] = (similarPanelCache[seedId] ?: SimilarTabCache()).copy(tracks = merged)
        }
    }

    // Scroll file = liste uniquement. Sticky : Mix + actions, puis onglets, puis liste.
    Column(
        modifier
            .fillMaxSize()
            .pointerInput(panelTab) {
                detectHorizontalDragGestures(
                    onDragEnd = {
                        when {
                            tabDragX < -72f && panelTab == 0 -> onPanelTabChange(1)
                            tabDragX > 72f && panelTab == 1 -> onPanelTabChange(0)
                        }
                        tabDragX = 0f
                    },
                    onDragCancel = { tabDragX = 0f },
                    onHorizontalDrag = { _, amount -> tabDragX += amount },
                )
            },
    ) {
        val qh = queueHeaderLabels(ui)
        // Toujours visible (File + Similaires) : contexte file / mix + actions
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(
                    qh.caption,
                    style = MaterialTheme.typography.labelSmall,
                    color = PlayerMuted,
                )
                Text(
                    qh.title,
                    fontWeight = FontWeight.SemiBold,
                    color = PlayerFg,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (ui.queue.size > 1) {
                IconButton(onClick = onClear) {
                    Icon(
                        Icons.Default.ClearAll,
                        contentDescription = "Vider la file",
                        tint = PlayerFg,
                        modifier = Modifier.size(22.dp),
                    )
                }
            }
            IconButton(onClick = onStartMix) {
                Icon(
                    MixIcon,
                    contentDescription = "Lancer un mix",
                    tint = SeekRed,
                    modifier = Modifier.size(22.dp),
                )
            }
            IconButton(onClick = onSave) {
                Icon(
                    Icons.Default.Save,
                    contentDescription = "Enregistrer la file",
                    tint = PlayerFg,
                )
            }
        }

        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            QueuePanelTab(
                label = "File d'attente",
                selected = panelTab == 0,
                onClick = { onPanelTabChange(0) },
                modifier = Modifier.weight(1f),
            )
            QueuePanelTab(
                label = "Similaires",
                selected = panelTab == 1,
                onClick = { onPanelTabChange(1) },
                modifier = Modifier.weight(1f),
            )
        }

        if (panelTab == 0) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .weight(1f),
            ) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    state = listState,
                ) {
                if (playedBefore.isNotEmpty()) {
                    item {
                        Text(
                            "Déjà joués",
                            Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                            style = MaterialTheme.typography.labelMedium,
                            color = PlayerMuted,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    itemsIndexed(playedBefore, key = { i, t -> "played-${t.id}-$i" }) { index, item ->
                        QueueTrackRow(
                            track = item,
                            index = index,
                            highlighted = false,
                            onClick = { onPlayAt(index) },
                            onLongClick = { onMore?.invoke(item) },
                            onMove = onMove,
                            onMore = onMore?.let { { it(item) } },
                            onMix = { startMixFor(item) },
                            radioActive = ui.sourceKind == "radio" && ui.sourceId == item.id,
                        )
                    }
                }
                item {
                    Text(
                        "En cours",
                        Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.labelMedium,
                        color = PlayerMuted,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
                itemsIndexed(currentAndUpcomingUser, key = { i, t -> "u-${t.id}-${ui.queueIndex + i}" }) { i, item ->
                    val abs = ui.queueIndex + i
                    QueueTrackRow(
                        track = item,
                        index = abs,
                        highlighted = abs == ui.queueIndex,
                        onClick = { onPlayAt(abs) },
                        onLongClick = { onMore?.invoke(item) },
                        onMove = onMove,
                        onMore = onMore?.let { { it(item) } },
                        onMix = { startMixFor(item) },
                        radioActive = ui.sourceKind == "radio" && ui.sourceId == item.id,
                        offlineUnavailable = unavailable(item),
                    )
                }
                item {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                "À suivre",
                                fontWeight = FontWeight.SemiBold,
                                color = PlayerFg,
                            )
                            Text(
                                "Lecture automatique",
                                style = MaterialTheme.typography.labelSmall,
                                color = PlayerMuted,
                            )
                        }
                        Switch(
                            checked = ui.autoplaySuggestions,
                            onCheckedChange = { onToggleAutoplay() },
                            colors = SwitchDefaults.colors(
                                checkedTrackColor = SeekRed,
                                checkedThumbColor = Color.White,
                            ),
                        )
                    }
                }
                if (!ui.autoplaySuggestions) {
                    item {
                        Text(
                            "Lecture auto désactivée — stop en fin de file ; Suivant charge la suite",
                            Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                            style = MaterialTheme.typography.bodySmall,
                            color = PlayerMuted,
                        )
                    }
                }
                itemsIndexed(autoTracks, key = { i, t -> "a-${t.id}-${boundary + i}" }) { i, item ->
                    val abs = boundary + i
                    QueueTrackRow(
                        track = item,
                        index = abs,
                        highlighted = abs == ui.queueIndex,
                        onClick = { onPlayAt(abs) },
                        onLongClick = { onMore?.invoke(item) },
                        onMove = onMove,
                        onMore = onMore?.let { { it(item) } },
                        onMix = { startMixFor(item) },
                        radioActive = ui.sourceKind == "radio" && ui.sourceId == item.id,
                        offlineUnavailable = unavailable(item),
                    )
                }
                item { Spacer(Modifier.height(48.dp)) }
            }
            }
        } else {
            // Découverte type YTM — cache par titre + scroll infini
            Box(
                Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .navigationBarsPadding(),
            ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                state = similarListState,
            ) {
                item {
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                "Découvrez également",
                                fontWeight = FontWeight.SemiBold,
                                color = PlayerFg,
                            )
                            Text(
                                "Même style · se met à jour avec le titre",
                                style = MaterialTheme.typography.labelSmall,
                                color = PlayerMuted,
                            )
                        }
                        if (similarTracks.isNotEmpty()) {
                            TextButton(
                                onClick = {
                                    similarTracks.take(30).forEach { player.addToQueue(it) }
                                },
                            ) {
                                Text("Tout ajouter")
                            }
                        }
                    }
                }
                when {
                    similarLoading && similarTracks.isEmpty() -> {
                        item {
                            Text(
                                "Chargement des similaires…",
                                Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                                color = PlayerMuted,
                            )
                        }
                    }
                    similarTracks.isEmpty() -> {
                        item {
                            Text(
                                "Aucun titre similaire pour le moment.",
                                Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                                color = PlayerMuted,
                            )
                        }
                    }
                    else -> {
                        itemsIndexed(
                            similarTracks,
                            key = { index, t -> "s-${t.id}-$index" },
                        ) { _, item ->
                            QueueTrackRow(
                                track = item,
                                index = -1,
                                highlighted = false,
                                onClick = {
                                    val idx = similarTracks.indexOfFirst { it.id == item.id }
                                        .coerceAtLeast(0)
                                    player.play(
                                        similarTracks,
                                        startIndex = idx,
                                        title = "Similaires",
                                    )
                                    onPanelTabChange(0)
                                },
                                onLongClick = { onMore?.invoke(item) },
                                onMove = { _, _ -> },
                                onMore = onMore?.let { { it(item) } },
                                onMix = { startMixFor(item) },
                            )
                        }
                    }
                }
                if (similarLoadingMore) {
                    item {
                        Text(
                            "Chargement…",
                            Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                            color = PlayerMuted,
                        )
                    }
                }
                item { Spacer(Modifier.height(72.dp)) }
            }
            }
        }
    }
}

@Composable
private fun QueuePanelTab(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            label.uppercase(),
            style = MaterialTheme.typography.labelLarge,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
            color = if (selected) PlayerFg else PlayerMuted,
            maxLines = 1,
        )
        Spacer(Modifier.height(6.dp))
        Box(
            Modifier
                .fillMaxWidth(0.55f)
                .height(2.dp)
                .background(if (selected) Color.White else Color.Transparent),
        )
    }
}

/** Swipe bas = replier le lecteur ; swipe H = titre suivant / précédent. */
private fun Modifier.nowPlayingMediaGestures(
    key: Any?,
    onDismissDelta: (Float) -> Unit,
    onDismissEnd: () -> Unit,
    onHorizontalDelta: (Float) -> Unit,
    onHorizontalEnd: (totalX: Float) -> Unit,
    onHorizontalCancel: () -> Unit,
): Modifier = pointerInput(key) {
    var axis = NowPlayingDragAxis.None
    var totalX = 0f
    var totalY = 0f
    var verticalAccum = 0f
    detectDragGestures(
        onDragStart = {
            axis = NowPlayingDragAxis.None
            totalX = 0f
            totalY = 0f
            verticalAccum = 0f
        },
        onDragEnd = {
            when (axis) {
                NowPlayingDragAxis.Vertical -> onDismissEnd()
                NowPlayingDragAxis.Horizontal -> onHorizontalEnd(totalX)
                NowPlayingDragAxis.None -> Unit
            }
        },
        onDragCancel = {
            when (axis) {
                NowPlayingDragAxis.Vertical -> onDismissEnd()
                NowPlayingDragAxis.Horizontal -> onHorizontalCancel()
                NowPlayingDragAxis.None -> Unit
            }
        },
        onDrag = { change, amount ->
            totalX += amount.x
            totalY += amount.y
            if (axis == NowPlayingDragAxis.None && (abs(totalX) > 18f || abs(totalY) > 18f)) {
                axis = if (abs(totalX) > abs(totalY)) {
                    NowPlayingDragAxis.Horizontal
                } else {
                    NowPlayingDragAxis.Vertical
                }
            }
            when (axis) {
                NowPlayingDragAxis.Vertical -> {
                    val next = (verticalAccum + amount.y).coerceAtLeast(0f)
                    val consumed = next - verticalAccum
                    if (consumed != 0f || amount.y > 0f) {
                        change.consume()
                        verticalAccum = next
                        onDismissDelta(consumed)
                    }
                }
                NowPlayingDragAxis.Horizontal -> {
                    change.consume()
                    onHorizontalDelta(amount.x)
                }
                NowPlayingDragAxis.None -> Unit
            }
        },
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun QueueTrackRow(
    track: TrackDto,
    index: Int,
    highlighted: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
    onMove: (from: Int, to: Int) -> Unit,
    onMore: (() -> Unit)? = null,
    onMix: (() -> Unit)? = null,
    radioActive: Boolean = false,
    /** Hors-ligne : titre non téléchargé → grisé / non cliquable. */
    offlineUnavailable: Boolean = false,
) {
    var dragAccum by remember { mutableFloatStateOf(0f) }
    val enabled = !offlineUnavailable
    Row(
        Modifier
            .fillMaxWidth()
            .alpha(if (enabled) 1f else 0.38f)
            .background(
                if (highlighted) MaterialTheme.colorScheme.primary.copy(alpha = 0.14f)
                else Color.Transparent,
            )
            .combinedClickable(
                enabled = enabled,
                onClick = onClick,
                onLongClick = onLongClick,
            )
            .padding(horizontal = 4.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Poignée drag (style YTM) — scroll de la liste reste libre ailleurs
        Icon(
            Icons.Default.DragHandle,
            contentDescription = "Déplacer",
            tint = PlayerMuted,
            modifier = Modifier
                .size(40.dp)
                .padding(6.dp)
                .pointerInput(index) {
                    detectDragGestures(
                        onDragEnd = { dragAccum = 0f },
                        onDragCancel = { dragAccum = 0f },
                        onDrag = { change, amount ->
                            change.consume()
                            dragAccum += amount.y
                            val threshold = 40.dp.toPx()
                            when {
                                dragAccum > threshold -> {
                                    onMove(index, index + 1)
                                    dragAccum = 0f
                                }
                                dragAccum < -threshold -> {
                                    if (index > 0) onMove(index, index - 1)
                                    dragAccum = 0f
                                }
                            }
                        },
                    )
                },
        )
        MediaCover(track, 48.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
                Text(
                    track.title,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    color = if (highlighted) MaterialTheme.colorScheme.primary else PlayerFg,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row {
                    Text(
                        track.artistLine(),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodySmall,
                        color = PlayerMuted,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    track.durationLabel()?.let {
                        Text(" · $it", style = MaterialTheme.typography.bodySmall, color = PlayerMuted)
                    }
                }
        }
        if (onMix != null) {
            IconButton(onClick = onMix) {
                Icon(
                    Icons.Default.Radio,
                    contentDescription = if (radioActive) "Mix actif" else "Lancer un mix",
                    tint = if (radioActive) SeekRed else Color.White,
                    modifier = Modifier.size(22.dp),
                )
            }
        }
        if (onMore != null) {
            IconButton(onClick = onMore) {
                Icon(
                    Icons.Default.MoreVert,
                    contentDescription = "Options",
                    tint = PlayerMuted,
                )
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun InlineSyncedLyrics(
    container: AppContainer,
    track: TrackDto,
    positionMs: Long,
    durationMs: Long = 0L,
    onSeek: (Long) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var text by remember(track.id) { mutableStateOf<String?>(null) }
    var timed by remember(track.id) { mutableStateOf<List<TimedLyricLine>>(emptyList()) }
    var lyricsSource by remember(track.id) { mutableStateOf<String?>(null) }
    var loading by remember(track.id) { mutableStateOf(true) }
    val syncPrefs = remember { container.sharedPrefs("plm_lyric_sync_v1") }
    var userOffsetMs by remember(track.id) {
        mutableLongStateOf(syncPrefs.getLong(track.id, 0L))
    }

    LaunchedEffect(track.id) {
        loading = true
        userOffsetMs = syncPrefs.getLong(track.id, 0L)
        val lyricsCache = container.sharedPrefs("plm_lyrics_cache_v5")
        val cachedText = lyricsCache.getString("t_${track.id}", null)
        val cachedTimed = lyricsCache.getString("l_${track.id}", null)
        if (!cachedText.isNullOrBlank()) {
            text = cachedText
            val raw = if (!cachedTimed.isNullOrBlank()) {
                cachedTimed.lineSequence().mapNotNull { line ->
                    val p = line.split('|', limit = 2)
                    if (p.size < 2) return@mapNotNull null
                    val ms = p[0].toLongOrNull() ?: return@mapNotNull null
                    TimedLyricLine(startMs = ms.toDouble(), text = p[1])
                }.toList()
            } else {
                parseLrcLines(cachedText)
            }
            timed = normalizeTimedLines(raw, durationMs)
            if (timed.isEmpty()) {
                timed = estimateTimedFromPlain(cachedText, durationMs)
                if (timed.isNotEmpty()) lyricsSource = "estimated"
            }
            if (lyricsSource == null) {
                lyricsSource = lyricsCache.getString("s_${track.id}", null)
            }
            loading = false
        }
        if (!ovh.delhomme.ytmusic.data.NetworkMonitor.isOnline() && !cachedText.isNullOrBlank()) {
            return@LaunchedEffect
        }
        runCatching { container.api.lyrics(track.id) }
            .onSuccess {
                text = it.lyrics
                lyricsSource = it.source
                val apiTimed = it.timed.orEmpty()
                val raw = if (apiTimed.isNotEmpty()) apiTimed else parseLrcLines(it.lyrics)
                timed = normalizeTimedLines(raw, durationMs.coerceAtLeast(0L))
                if (timed.isEmpty()) {
                    timed = estimateTimedFromPlain(it.lyrics, durationMs.coerceAtLeast(0L))
                    if (timed.isNotEmpty()) lyricsSource = "estimated"
                }
                runCatching {
                    lyricsCache.edit()
                        .putString("t_${track.id}", it.lyrics)
                        .putString("s_${track.id}", lyricsSource ?: it.source)
                        .putString(
                            "l_${track.id}",
                            timed.joinToString("\n") { l -> "${l.startMsLong()}|${l.text}" },
                        )
                        .apply()
                }
            }
            .onFailure {
                if (cachedText.isNullOrBlank()) {
                    text = null
                    timed = emptyList()
                    lyricsSource = null
                }
            }
        loading = false
    }

    // Collé au son ; l’API aligne déjà LRCLIB (stretch/offset). Affiner via appui long.
    val leadMs = 120L
    val sourceLagMs = 0L
    val syncPos = positionMs + leadMs - userOffsetMs - sourceLagMs
    // Ne PAS forcer l’index 0 avant la 1ʳᵉ ligne (sinon « désync » totale en intro)
    val active = if (timed.isEmpty()) -1
    else timed.indexOfLast { it.startMsLong() <= syncPos }
    // Nouvelle chanson, nouveau défilement : sans cela le panneau garde la position de
    // la fin des paroles précédentes jusqu'à ce que la lecture atteigne la première
    // ligne synchronisée.
    val listState = remember(track.id) { LazyListState() }
    LaunchedEffect(active, track.id) {
        if (active < 0) return@LaunchedEffect
        runCatching {
            listState.animateScrollToItem(
                index = active.coerceIn(0, timed.lastIndex),
                scrollOffset = -120,
            )
        }
    }
    LaunchedEffect(positionMs / 2_000L, track.id) {
        if (active < 0 || timed.isEmpty()) return@LaunchedEffect
        val visible = listState.layoutInfo.visibleItemsInfo
        val onScreen = visible.any { it.index == active }
        if (!onScreen) {
            runCatching {
                listState.animateScrollToItem(
                    index = active.coerceIn(0, timed.lastIndex),
                    scrollOffset = -120,
                )
            }
        }
    }

    fun persistOffset(next: Long) {
        val clamped = next.coerceIn(-15_000L, 15_000L)
        userOffsetMs = clamped
        syncPrefs.edit().putLong(track.id, clamped).apply()
    }

    fun nudgeOffset(delta: Long) {
        persistOffset(userOffsetMs + delta)
    }

    /** Appui long sur une ligne = « c’est celle qui est chantée maintenant ». */
    fun calibrateToLine(lineStartMs: Long) {
        persistOffset(positionMs + leadMs - sourceLagMs - lineStartMs)
        Toast.makeText(
            context,
            "Sync calé sur cette ligne",
            Toast.LENGTH_SHORT,
        ).show()
    }

    Column(modifier = modifier.padding(horizontal = 6.dp, vertical = 4.dp)) {
        // Sync compact : ±1 s et ±0,75 s (place pour les paroles).
        if (timed.isNotEmpty()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(bottom = 2.dp),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                TextButton(
                    onClick = { nudgeOffset(1000L) },
                    contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                ) {
                    Text("−1 s", style = MaterialTheme.typography.labelSmall)
                }
                TextButton(
                    onClick = { nudgeOffset(750L) },
                    contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                ) {
                    Text("−0,75", style = MaterialTheme.typography.labelSmall)
                }
                Text(
                    if (userOffsetMs == 0L) "sync" else String.format("%+.2f s", userOffsetMs / 1000.0),
                    color = if (userOffsetMs == 0L) PlayerMuted else SeekRed,
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier
                        .padding(horizontal = 2.dp)
                        .clickable { persistOffset(0L) },
                )
                TextButton(
                    onClick = { nudgeOffset(-750L) },
                    contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                ) {
                    Text("+0,75", style = MaterialTheme.typography.labelSmall)
                }
                TextButton(
                    onClick = { nudgeOffset(-1000L) },
                    contentPadding = PaddingValues(horizontal = 4.dp, vertical = 0.dp),
                ) {
                    Text("+1 s", style = MaterialTheme.typography.labelSmall)
                }
            }
        }
        when {
            loading -> Text(
                "Chargement…",
                color = PlayerMuted,
                modifier = Modifier.padding(top = 24.dp),
            )
            timed.isNotEmpty() -> {
                LazyColumn(
                    state = listState,
                    contentPadding = PaddingValues(horizontal = 2.dp, vertical = 12.dp),
                    modifier = Modifier.fillMaxSize(),
                    userScrollEnabled = true,
                ) {
                    itemsIndexed(timed) { i, line ->
                        val isActive = i == active
                        val past = active >= 0 && i < active
                        Text(
                            line.text.ifBlank { " " },
                            style = if (isActive) {
                                MaterialTheme.typography.headlineSmall
                            } else {
                                MaterialTheme.typography.titleMedium
                            },
                            fontWeight = if (isActive) FontWeight.ExtraBold else FontWeight.Normal,
                            color = when {
                                isActive -> Color.White
                                past -> PlayerMuted.copy(alpha = 0.28f)
                                else -> PlayerMuted.copy(alpha = 0.72f)
                            },
                            textAlign = TextAlign.Start,
                            softWrap = true,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(10.dp))
                                .background(
                                    if (isActive) SeekRed.copy(alpha = 0.22f) else Color.Transparent,
                                )
                                .combinedClickable(
                                    onClick = { onSeek(line.startMsLong()) },
                                    onLongClick = { calibrateToLine(line.startMsLong()) },
                                )
                                .padding(horizontal = 8.dp)
                                .padding(vertical = if (isActive) 12.dp else 6.dp),
                        )
                    }
                }
            }
            !text.isNullOrBlank() -> {
                LazyColumn(modifier = Modifier.fillMaxSize()) {
                    item {
                        Text(
                            text!!,
                            color = PlayerFg,
                            style = MaterialTheme.typography.bodyLarge,
                            softWrap = true,
                            modifier = Modifier.padding(horizontal = 4.dp, vertical = 12.dp),
                        )
                    }
                }
            }
            else -> Column(
                Modifier
                    .fillMaxWidth()
                    .padding(top = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text("Paroles indisponibles", color = PlayerMuted)
                Spacer(Modifier.height(12.dp))
                TextButton(
                    onClick = {
                        val artist = track.artistLine().takeIf { it != "Artiste" }.orEmpty()
                        val q = buildString {
                            append(track.title)
                            if (artist.isNotBlank()) append(' ').append(artist)
                        }
                        // Genius d’abord (souvent mieux que Google pour les paroles)
                        val geniusUri = android.net.Uri.parse(
                            "https://genius.com/search?q=" +
                                java.net.URLEncoder.encode(q, Charsets.UTF_8.name()),
                        )
                        val googleUri = android.net.Uri.parse(
                            "https://www.google.com/search?q=" +
                                java.net.URLEncoder.encode("$q paroles", Charsets.UTF_8.name()),
                        )
                        runCatching {
                            context.startActivity(
                                android.content.Intent(android.content.Intent.ACTION_VIEW, geniusUri),
                            )
                        }.onFailure {
                            runCatching {
                                context.startActivity(
                                    android.content.Intent(android.content.Intent.ACTION_VIEW, googleUri),
                                )
                            }
                        }
                    },
                ) {
                    Text("Chercher sur Genius / le web")
                }
            }
        }
    }
}

/**
 * Si l’API / LRC envoie des secondes dans `startMs` (plage &lt; 600), convertir en ms.
 * Aligné sur le heuristique web NowPlaying.
 */
private fun normalizeTimedLines(
    lines: List<TimedLyricLine>,
    durationMs: Long,
): List<TimedLyricLine> {
    if (lines.size < 2) return lines
    val values = lines.map { it.startMs }
    val maxRaw = values.maxOrNull() ?: 0.0
    val durSec = if (durationMs > 0L) durationMs / 1000.0 else 0.0
    val looksLikeSeconds =
        maxRaw > 0.0 &&
            maxRaw < 600.0 &&
            (durSec <= 0.0 || maxRaw <= durSec * 1.5) &&
            values.count { it > 0.0 } >= 2
    return if (looksLikeSeconds) {
        lines.map { it.copy(startMs = it.startMs * 1000.0) }
    } else {
        lines
    }
}

/**
 * Même idée que le serveur : sans LRC, on répartit les lignes sur la durée
 * pour que le suivi avance — comme sur un titre qui a des timings officiels.
 */
private fun estimateTimedFromPlain(raw: String?, durationMs: Long): List<TimedLyricLine> {
    if (raw.isNullOrBlank()) return emptyList()
    val lines = raw.split('\n', '\r').map { it.replace('\u00a0', ' ').trim() }.filter { line ->
        when {
            line.isEmpty() -> false
            line.matches(Regex("""^\[.+]$""")) -> false
            line.matches(Regex("""^\(.+\)$""")) && line.length < 28 -> false
            line.length < 28 &&
                line.matches(
                    Regex(
                        """^(intro|outro|instrumental|bridge|chorus|refrain|couplet|verse|hook|solo)\b.*""",
                        RegexOption.IGNORE_CASE,
                    ),
                ) -> false
            else -> true
        }
    }
    if (lines.size < 2) return emptyList()
    val durSec = if (durationMs >= 20_000L) durationMs / 1000.0 else (lines.size * 3.2).coerceAtLeast(60.0)
    val intro = (durSec * 0.08).coerceIn(6.0, 18.0)
    val outro = (durSec * 0.07).coerceIn(5.0, 16.0)
    val window = (durSec - intro - outro).coerceAtLeast(lines.size * 1.2)
    val weights = lines.map { it.length.coerceAtLeast(8) }
    val total = weights.sum().coerceAtLeast(1)
    var acc = 0
    return lines.mapIndexed { i, text ->
        val startMs = ((intro + (acc.toDouble() / total) * window) * 1000.0)
        acc += weights[i]
        TimedLyricLine(startMs = startMs, text = text)
    }
}

/** Parse LRC `[mm:ss.xx] texte` si l’API ne renvoie que du texte. */
private fun parseLrcLines(raw: String?): List<TimedLyricLine> {
    if (raw.isNullOrBlank()) return emptyList()
    val re = Regex("""^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?]\s*(.*)$""")
    val out = ArrayList<TimedLyricLine>()
    for (row in raw.split('\n', '\r')) {
        val m = re.matchEntire(row.trim()) ?: continue
        val min = m.groupValues[1].toIntOrNull() ?: continue
        val sec = m.groupValues[2].toIntOrNull() ?: continue
        val fracRaw = m.groupValues[3]
        val fracMs = when {
            fracRaw.isBlank() -> 0
            fracRaw.length <= 2 -> (fracRaw.padEnd(2, '0').toIntOrNull() ?: 0) * 10
            else -> fracRaw.padEnd(3, '0').take(3).toIntOrNull() ?: 0
        }
        val text = m.groupValues[4].trim()
        if (text.isEmpty()) continue
        out += TimedLyricLine(startMs = ((min * 60 + sec) * 1000L + fracMs).toDouble(), text = text)
    }
    return out
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SaveQueueSheet(
    container: AppContainer,
    queue: List<TrackDto>,
    defaultName: String,
    onDismiss: () -> Unit,
    onSaved: (String) -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var playlists by remember { mutableStateOf<List<PlaylistDto>>(emptyList()) }
    var name by remember { mutableStateOf(defaultName) }
    var creating by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val playable = remember(queue) { queue.filter { it.isPlayable() } }

    LaunchedEffect(Unit) {
        playlists = runCatching { container.api.library().playlists }.getOrDefault(emptyList())
    }

    fun addAllTo(playlistId: String, label: String) {
        if (busy || playable.isEmpty()) return
        busy = true
        scope.launch {
            runCatching {
                playable.forEach { t ->
                    runCatching { container.api.addToPlaylist(playlistId, t) }
                }
                onSaved(label)
            }.onFailure {
                Toast.makeText(context, it.message ?: "Échec", Toast.LENGTH_SHORT).show()
            }
            busy = false
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .padding(bottom = 28.dp),
        ) {
            Text(
                "Enregistrer la file",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                "${playable.size} titres → playlist",
                style = MaterialTheme.typography.bodySmall,
                color = PlayerMuted,
                modifier = Modifier.padding(top = 4.dp, bottom = 16.dp),
            )

            TextButton(
                onClick = { creating = !creating },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Default.PlaylistAdd, null, modifier = Modifier.padding(end = 8.dp))
                Text(if (creating) "Masquer" else "Nouvelle playlist")
            }

            if (creating) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    singleLine = true,
                    label = { Text("Nom de la playlist") },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 8.dp),
                )
                TextButton(
                    enabled = !busy && playable.isNotEmpty(),
                    onClick = {
                        val n = name.trim().ifBlank { defaultName }
                        busy = true
                        scope.launch {
                            runCatching {
                                val pl = container.api.createPlaylist(CreatePlaylistBody(n))
                                playable.forEach { t ->
                                    runCatching { container.api.addToPlaylist(pl.id, t) }
                                }
                                onSaved(n)
                            }.onFailure {
                                Toast.makeText(context, it.message ?: "Échec", Toast.LENGTH_SHORT).show()
                            }
                            busy = false
                        }
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 8.dp),
                ) {
                    Text(if (busy) "Enregistrement…" else "Créer et enregistrer")
                }
            }

            Text(
                "Playlists existantes",
                style = MaterialTheme.typography.labelLarge,
                color = PlayerMuted,
                modifier = Modifier.padding(top = 20.dp, bottom = 8.dp),
            )
            if (playlists.isEmpty()) {
                Text("Aucune playlist pour l’instant.", color = PlayerMuted)
            } else {
                playlists.forEach { pl ->
                    TextButton(
                        enabled = !busy && playable.isNotEmpty(),
                        onClick = { addAllTo(pl.id, pl.displayName()) },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(Icons.Default.QueueMusic, null, modifier = Modifier.padding(end = 8.dp))
                        Text(
                            pl.displayName(),
                            modifier = Modifier.weight(1f),
                            textAlign = TextAlign.Start,
                        )
                        Text(
                            "${pl.tracks?.size ?: 0}",
                            color = PlayerMuted,
                            style = MaterialTheme.typography.labelMedium,
                        )
                    }
                }
            }
        }
    }
}

/**
 * Cover hero pleine largeur / hauteur dispo.
 * Crop + zoom léger si la zone est plus large que haute (sinon piliers 16:9 YT visibles).
 */
@Composable
private fun NowPlayingHeroCover(
    track: TrackDto,
    coverH: Dp,
    landscape: Boolean,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val fullPx = if (landscape) 720 else 900
    val fullUrl = track.coverUrl(fullPx)
    val thumbUrl = track.coverUrl(520)
    val cacheTag = if (landscape) "np-l" else "np-hero-v5"
    fun coverRequest(url: String?, px: Int) = ImageRequest.Builder(context)
        .data(url)
        .size(px)
        .memoryCacheKey("$cacheTag:$url")
        .diskCacheKey("$cacheTag:$url")
        .build()
    BoxWithConstraints(
        modifier
            .fillMaxWidth()
            .height(coverH)
            .clip(RoundedCornerShape(if (landscape) 12.dp else 0.dp))
            .background(Color.Black),
        contentAlignment = Alignment.Center,
    ) {
        // Zone plus large que haute → Crop seul laisse les piliers du cadre 16:9.
        val boxAspect = if (maxHeight > 0.dp) maxWidth / maxHeight else 1f
        val zoom = when {
            landscape -> 1.08f
            boxAspect > 1.02f -> boxAspect.coerceIn(1.02f, 1.35f)
            else -> 1f
        }
        SubcomposeAsyncImage(
            model = ImageRequest.Builder(context)
                .data(fullUrl)
                .size(fullPx)
                .memoryCacheKey("$cacheTag:$fullUrl")
                .diskCacheKey("$cacheTag:$fullUrl")
                .crossfade(80)
                .build(),
            contentDescription = track.title,
            contentScale = ContentScale.Crop,
            alignment = Alignment.Center,
            modifier = Modifier
                .matchParentSize()
                .then(
                    if (zoom > 1.01f) {
                        Modifier.graphicsLayer {
                            scaleX = zoom
                            scaleY = zoom
                        }
                    } else {
                        Modifier
                    },
                ),
            loading = {
                AsyncImage(
                    model = coverRequest(thumbUrl, 520),
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    alignment = Alignment.Center,
                    modifier = Modifier
                        .matchParentSize()
                        .then(
                            if (zoom > 1.01f) {
                                Modifier.graphicsLayer {
                                    scaleX = zoom
                                    scaleY = zoom
                                }
                            } else {
                                Modifier
                            },
                        ),
                )
            },
            error = {
                AsyncImage(
                    model = coverRequest(thumbUrl, 520),
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    alignment = Alignment.Center,
                    modifier = Modifier
                        .matchParentSize()
                        .then(
                            if (zoom > 1.01f) {
                                Modifier.graphicsLayer {
                                    scaleX = zoom
                                    scaleY = zoom
                                }
                            } else {
                                Modifier
                            },
                        ),
                )
            },
        )
    }
}

/**
 * Barre de progression fiable : tap court et glissé utilisent la position X du doigt.
 * Un seul gestionnaire de gestes (tap vs drag) pour éviter un seek(0) parasite.
 */
@Composable
private fun PlayerSeekBar(
    progress: Float,
    buffered: Float,
    onScrub: (Float) -> Unit,
    onSeekCommit: (Float) -> Unit,
    modifier: Modifier = Modifier,
    touchHeight: Dp = 64.dp,
    trackHeight: Dp = 4.dp,
    thumbSize: Dp = 12.dp,
) {
    val density = LocalDensity.current
    var barWidthPx by remember { mutableFloatStateOf(1f) }
    val thumbPx = with(density) { thumbSize.toPx() }
    val shown = progress.coerceIn(0f, 1f)
    val buf = buffered.coerceIn(0f, 1f)

    fun ratioFromX(x: Float): Float {
        val w = barWidthPx.coerceAtLeast(1f)
        return (x / w).coerceIn(0f, 1f)
    }

    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(touchHeight)
            .clipToBounds()
            .onSizeChanged { barWidthPx = it.width.toFloat().coerceAtLeast(1f) }
            .pointerInput(Unit) {
                awaitPointerEventScope {
                    while (true) {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        var lastRatio = ratioFromX(down.position.x)
                        onScrub(lastRatio)
                        var pointer = down
                        while (pointer.pressed) {
                            val event = awaitPointerEvent()
                            val change = event.changes.firstOrNull { it.id == down.id } ?: break
                            lastRatio = ratioFromX(change.position.x)
                            onScrub(lastRatio)
                            if (change.position != change.previousPosition) change.consume()
                            pointer = change
                        }
                        onSeekCommit(lastRatio)
                    }
                }
            },
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(trackHeight)
                .align(Alignment.Center)
                .clip(RoundedCornerShape(trackHeight / 2))
                .background(PlayerFg.copy(alpha = 0.14f)),
        ) {
            Box(
                Modifier
                    .fillMaxWidth(buf)
                    .height(trackHeight)
                    .background(PlayerFg.copy(alpha = 0.42f)),
            )
            Box(
                Modifier
                    .fillMaxWidth(shown)
                    .height(trackHeight)
                    .background(SeekRed),
            )
        }
        Box(
            Modifier
                .offset {
                    IntOffset(
                        x = ((shown * barWidthPx) - thumbPx / 2f).roundToInt()
                            .coerceIn(0, (barWidthPx - thumbPx).roundToInt().coerceAtLeast(0)),
                        y = 0,
                    )
                }
                .size(thumbSize)
                .align(Alignment.CenterStart)
                .clip(CircleShape)
                .background(Color.White),
        )
    }
}

private fun formatMs(ms: Long): String {
    if (ms <= 0) return "0:00"
    val totalSec = ms / 1000
    val h = totalSec / 3600
    val m = (totalSec % 3600) / 60
    val s = totalSec % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

private fun speedLabel(speed: Float): String {
    val rounded = (kotlin.math.round(speed * 100f) / 100f)
    return "×${"%.2f".format(rounded).trimEnd('0').trimEnd('.')}"
}
