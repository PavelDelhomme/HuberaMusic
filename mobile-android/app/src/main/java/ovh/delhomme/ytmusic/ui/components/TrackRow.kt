package ovh.delhomme.ytmusic.ui.components

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.basicMarquee
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import ovh.delhomme.ytmusic.ui.util.isLandscape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cast
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import ovh.delhomme.ytmusic.data.TrackDto
import kotlin.math.roundToInt

private val SeekRed = Color(0xFFFF0033)

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun TrackRow(
    track: TrackDto,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    onMore: (() -> Unit)? = null,
    onOpenArtist: ((id: String?, name: String) -> Unit)? = null,
    subtitle: String? = null,
    trailing: String? = null,
    indexLabel: String? = null,
    highlighted: Boolean = false,
    /** Lignes plus denses (page album). */
    compact: Boolean = false,
    showCover: Boolean = true,
    /** Affiche le badge épingle (accès rapide) — toujours visible si true. */
    pinned: Boolean = false,
    onTogglePin: (() -> Unit)? = null,
) {
    val vPad = if (compact) 4.dp else 8.dp
    val coverSz = if (compact) 44.dp else 52.dp
    val hPad = if (compact) 12.dp else 16.dp
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(
                if (highlighted || LocalNowPlaying.current.matchesTrack(track.id)) {
                    MaterialTheme.colorScheme.primary.copy(alpha = 0.14f)
                } else Color.Transparent,
            )
            .combinedClickable(
                onClick = onClick,
                onLongClick = { onMore?.invoke() },
            )
            .padding(horizontal = hPad, vertical = vPad),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (indexLabel != null) {
            Text(
                indexLabel,
                modifier = Modifier.width(if (showCover) 28.dp else 32.dp),
                style = MaterialTheme.typography.labelMedium,
                color = if (highlighted || LocalNowPlaying.current.matchesTrack(track.id)) {
                    MaterialTheme.colorScheme.primary
                } else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (showCover) {
            Box {
                MediaCover(track, coverSz)
                if (pinned) {
                    PinnedBadge(
                        modifier = Modifier
                            .align(Alignment.TopStart)
                            .padding(2.dp),
                        onClick = onTogglePin,
                        size = if (compact) 18.dp else 20.dp,
                    )
                }
            }
            Spacer(Modifier.width(if (compact) 10.dp else 12.dp))
        } else if (indexLabel == null) {
            Spacer(Modifier.width(4.dp))
        } else {
            Spacer(Modifier.width(8.dp))
        }
        Column(Modifier.weight(1f)) {
            val now = LocalNowPlaying.current
            val isActive = highlighted || now.matchesTrack(track.id)
            Text(
                track.title,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = if (compact) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                color = if (isActive) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.onSurface,
            )
            when {
                subtitle != null -> {
                    if (subtitle.isNotEmpty()) {
                        Text(
                            subtitle,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                track.isPlaylist() -> Text(
                    "Playlist · ${track.artistLine()}",
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                track.isAlbum() -> Text(
                    "Album · ${track.artistLine()}",
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                track.isArtist() -> Text(
                    "Artiste",
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                onOpenArtist != null -> ArtistLinksText(
                    track = track,
                    onOpenArtist = onOpenArtist,
                )
                else -> Text(
                    track.artistLine(),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        val durationLabel = trailing ?: track.durationLabel()
        if (durationLabel != null) {
            Text(
                durationLabel,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(end = 4.dp),
            )
        }
        if (onMore != null) {
            IconButton(
                onClick = onMore,
                modifier = if (compact) Modifier.size(36.dp) else Modifier,
            ) {
                Icon(
                    Icons.Default.MoreVert,
                    contentDescription = "Plus d'options",
                    tint = Color(0xFFF5F5F5),
                )
            }
        }
    }
}

/** Mini-lecteur style YT / Google Music — seek, prev, play, next. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun MiniPlayerBar(
    track: TrackDto,
    playing: Boolean,
    progress: Float,
    /** Durée totale (ms) pour afficher le temps restant `-3:45`. */
    durationMs: Long = 0L,
    /** Fraction 0–1 déjà bufferisée (gris clair sous le rouge). */
    bufferedProgress: Float = 0f,
    onToggle: () -> Unit,
    onOpen: () -> Unit,
    /** Swipe bas → fermer lecteur + vider la file. */
    onDismiss: (() -> Unit)? = null,
    onCast: (() -> Unit)? = null,
    onSeek: ((Float) -> Unit)? = null,
    onPrev: (() -> Unit)? = null,
    onNext: (() -> Unit)? = null,
    /** Appui long next/prev : delta ms dans le titre courant. */
    onSeekBy: ((Long) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    var scrub by remember(track.id) { mutableFloatStateOf(-1f) }
    val shown = if (scrub >= 0f) scrub else progress.coerceIn(0f, 1f)
    var barWidthPx by remember { mutableFloatStateOf(1f) }
    var dismissDrag by remember { mutableFloatStateOf(0f) }
    val thumbPx = with(LocalDensity.current) { 8.dp.toPx() }
    val remainingLabel = remember(shown, durationMs) {
        formatRemainingMs(durationMs, shown)
    }

    fun seekFromX(x: Float) {
        if (onSeek == null || barWidthPx <= 0f) return
        val ratio = (x / barWidthPx).coerceIn(0f, 1f)
        scrub = ratio
        onSeek(ratio)
    }

    val landscape = isLandscape()
    val barH = if (landscape) 48.dp else 64.dp
    val coverSz = if (landscape) 36.dp else 48.dp

    Column(
        modifier = modifier
            .fillMaxWidth()
            .graphicsLayer {
                val p = (dismissDrag / 140f).coerceIn(0f, 1f)
                translationY = dismissDrag.coerceAtLeast(0f) * 0.55f
                alpha = 1f - p * 0.55f
            },
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = if (landscape) 0.dp else 0.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                remainingLabel,
                style = MaterialTheme.typography.labelSmall,
                color = Color(0xFFBDBDBD),
                maxLines = 1,
                modifier = Modifier.widthIn(min = 36.dp),
            )
            Box(
                modifier = Modifier
                    .weight(1f)
                    .height(if (landscape) 10.dp else 14.dp)
                    .onSizeChanged { barWidthPx = it.width.toFloat().coerceAtLeast(1f) }
                    .pointerInput(track.id, onSeek) {
                        detectTapGestures { offset ->
                            seekFromX(offset.x)
                            scrub = -1f
                        }
                    }
                    .pointerInput(track.id, onSeek) {
                        detectHorizontalDragGestures(
                            onDragStart = { offset -> seekFromX(offset.x) },
                            onDragEnd = { scrub = -1f },
                            onDragCancel = { scrub = -1f },
                            onHorizontalDrag = { change, _ ->
                                change.consume()
                                seekFromX(change.position.x)
                            },
                        )
                    },
                contentAlignment = Alignment.CenterStart,
            ) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(2.dp)
                        .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.14f)),
                )
                Box(
                    Modifier
                        .fillMaxWidth(bufferedProgress.coerceIn(0f, 1f))
                        .height(2.dp)
                        .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)),
                )
                Box(
                    Modifier
                        .fillMaxWidth(shown)
                        .height(2.dp)
                        .background(SeekRed),
                )
                Box(
                    Modifier
                        .offset {
                            IntOffset(
                                x = ((shown * barWidthPx) - thumbPx / 2f).roundToInt()
                                    .coerceIn(0, (barWidthPx - thumbPx).roundToInt().coerceAtLeast(0)),
                                y = 0,
                            )
                        }
                        .size(if (landscape) 6.dp else 8.dp)
                        .align(Alignment.CenterStart)
                        .clip(CircleShape)
                        .background(SeekRed),
                )
            }
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(barH)
                .clickable(onClick = onOpen)
                .pointerInput(onDismiss, onOpen) {
                    var total = 0f
                    detectVerticalDragGestures(
                        onVerticalDrag = { _, amount ->
                            total += amount
                            dismissDrag = total.coerceAtLeast(0f)
                        },
                        onDragEnd = {
                            when {
                                // Swipe vers le bas → fermer lecteur + vider file
                                total > 56f && onDismiss != null -> onDismiss()
                                // Swipe vers le haut → ouvrir le lecteur plein écran
                                total < -48f -> onOpen()
                            }
                            total = 0f
                            dismissDrag = 0f
                        },
                        onDragCancel = {
                            total = 0f
                            dismissDrag = 0f
                        },
                    )
                }
                .padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            MediaCover(
                track,
                coverSz,
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .clickable(onClick = onOpen),
            )
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(horizontal = 8.dp)
                    .clickable(onClick = onOpen),
            ) {
                Text(
                    track.title,
                    maxLines = 1,
                    overflow = TextOverflow.Clip,
                    fontWeight = FontWeight.SemiBold,
                    color = Color(0xFFF5F5F5),
                    modifier = Modifier.basicMarquee(iterations = Int.MAX_VALUE, initialDelayMillis = 1000),
                )
                Text(
                    track.artistLine(),
                    maxLines = 1,
                    overflow = TextOverflow.Clip,
                    style = MaterialTheme.typography.bodySmall,
                    color = Color(0xFFCFCFCF),
                    modifier = Modifier.basicMarquee(iterations = Int.MAX_VALUE, initialDelayMillis = 1400),
                )
            }
            if (onCast != null) {
                IconButton(onClick = onCast) {
                    Icon(
                        Icons.Default.Cast,
                        contentDescription = "Caster",
                        tint = Color(0xFFF5F5F5),
                    )
                }
            }
            if (onPrev != null) {
                if (onSeekBy != null) {
                    HoldSeekIconButton(
                        onClick = onPrev,
                        onHoldTick = { onSeekBy(-2_000L) },
                    ) {
                        Icon(
                            Icons.Default.SkipPrevious,
                            contentDescription = "Précédent · appui long : reculer",
                            tint = Color(0xFFF5F5F5),
                            modifier = Modifier.size(26.dp),
                        )
                    }
                } else {
                    IconButton(onClick = onPrev) {
                        Icon(
                            Icons.Default.SkipPrevious,
                            contentDescription = "Précédent",
                            tint = Color(0xFFF5F5F5),
                            modifier = Modifier.size(26.dp),
                        )
                    }
                }
            }
            IconButton(onClick = onToggle) {
                Icon(
                    if (playing) Icons.Default.Pause else Icons.Default.PlayArrow,
                    contentDescription = if (playing) "Pause" else "Lecture",
                    tint = Color(0xFFF5F5F5),
                    modifier = Modifier.size(28.dp),
                )
            }
            if (onNext != null) {
                if (onSeekBy != null) {
                    HoldSeekIconButton(
                        onClick = onNext,
                        onHoldTick = { onSeekBy(2_000L) },
                    ) {
                        Icon(
                            Icons.Default.SkipNext,
                            contentDescription = "Suivant · appui long : avancer",
                            tint = Color(0xFFF5F5F5),
                            modifier = Modifier.size(26.dp),
                        )
                    }
                } else {
                    IconButton(onClick = onNext) {
                        Icon(
                            Icons.Default.SkipNext,
                            contentDescription = "Suivant",
                            tint = Color(0xFFF5F5F5),
                            modifier = Modifier.size(26.dp),
                        )
                    }
                }
            }
        }
    }
}

/** Temps restant compact : `-3:45` (progressRatio 0..1). */
private fun formatRemainingMs(durationMs: Long, progressRatio: Float): String {
    if (durationMs <= 0L) return "-0:00"
    val leftMs = ((1f - progressRatio.coerceIn(0f, 1f)) * durationMs).toLong().coerceAtLeast(0L)
    val totalSec = (leftMs + 999) / 1000 // ceil secondes
    val h = totalSec / 3600
    val m = (totalSec % 3600) / 60
    val s = totalSec % 60
    val clock = if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
    return "-$clock"
}
