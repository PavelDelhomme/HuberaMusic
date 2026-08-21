package ovh.delhomme.ytmusic.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Album
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.QueueMusic
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import coil.compose.SubcomposeAsyncImage
import ovh.delhomme.ytmusic.data.BatterySaver
import ovh.delhomme.ytmusic.data.TrackDto

@Composable
fun MediaCover(
    track: TrackDto,
    size: Dp,
    modifier: Modifier = Modifier,
    circle: Boolean = false,
    /** Force l’overlay ; sinon déduit de [LocalNowPlaying]. */
    playingOverlay: Boolean? = null,
) {
    val saverOn by BatterySaver.active.collectAsState()
    val now = LocalNowPlaying.current
    val active = playingOverlay
        ?: when {
            now.matchesTrack(track.id) -> true
            track.isAlbum() && now.matchesAlbum(track.id) -> true
            (track.isPlaylist() || track.type.equals("mix", true)) &&
                now.matchesSource(track.id) -> true
            track.isAlbum() && now.matchesAlbum(track.album?.id) -> true
            else -> false
        }
    val animating = active && now.playing && !saverOn
    val shape = when {
        circle || track.isArtist() -> CircleShape
        else -> RoundedCornerShape(8.dp)
    }
    val placeholderIcon = when {
        track.isArtist() -> Icons.Default.Person
        track.isPlaylist() -> Icons.Default.QueueMusic
        track.isAlbum() -> Icons.Default.Album
        else -> Icons.Default.MusicNote
    }
    val barH = when {
        size >= 160.dp -> 28.dp
        size >= 80.dp -> 20.dp
        else -> 14.dp
    }
    val thumbPx = BatterySaver.coverSizeHint(size.value.toInt().coerceAtLeast(120))
    // Économiseur : listes / grilles → placeholder (sauf titre en lecture)
    val skipNetworkImage = saverOn && !active && size < 140.dp
    Box(
        modifier = modifier
            .size(size)
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        if (skipNetworkImage) {
            Icon(
                placeholderIcon,
                contentDescription = track.title,
                tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f),
                modifier = Modifier.size((size.value * 0.42f).dp.coerceAtLeast(18.dp)),
            )
        } else {
            SubcomposeAsyncImage(
                model = track.coverUrl(thumbPx),
                contentDescription = track.title,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
                loading = {
                    Icon(
                        placeholderIcon,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f),
                    )
                },
                error = {
                    Icon(
                        placeholderIcon,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f),
                    )
                },
            )
        }
        PlayingCoverOverlay(
            active = active,
            playing = animating,
            barHeight = barH,
        )
    }
}

/** Mosaïque 2×2 des 4 premières covers — carte mix style album. */
@Composable
fun MixCollageCover(
    tracks: List<TrackDto>,
    size: Dp,
    modifier: Modifier = Modifier,
    titleFallback: String = "M",
    mixId: String? = null,
) {
    val now = LocalNowPlaying.current
    val active = when {
        mixId != null && now.matchesSource(mixId) -> true
        tracks.any { now.matchesTrack(it.id) } -> true
        else -> false
    }
    val covers = tracks.take(4).toMutableList()
    if (covers.isNotEmpty()) {
        while (covers.size < 4) covers.add(covers[covers.size % tracks.size.coerceAtLeast(1)])
    }
    Box(
        modifier = modifier
            .size(size)
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant),
        contentAlignment = Alignment.Center,
    ) {
        if (covers.isEmpty()) {
            Text(
                titleFallback.trim().take(1).uppercase().ifBlank { "M" },
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.55f),
            )
        } else {
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.weight(1f).fillMaxWidth()) {
                    covers.take(2).forEach { t ->
                        Box(Modifier.weight(1f).fillMaxSize()) {
                            SubcomposeAsyncImage(
                                model = t.coverUrl(200),
                                contentDescription = null,
                                contentScale = ContentScale.Crop,
                                modifier = Modifier.fillMaxSize(),
                                error = {
                                    Box(
                                        Modifier
                                            .fillMaxSize()
                                            .background(MaterialTheme.colorScheme.surface),
                                    )
                                },
                            )
                        }
                    }
                }
                Row(Modifier.weight(1f).fillMaxWidth()) {
                    covers.drop(2).take(2).forEach { t ->
                        Box(Modifier.weight(1f).fillMaxSize()) {
                            SubcomposeAsyncImage(
                                model = t.coverUrl(200),
                                contentDescription = null,
                                contentScale = ContentScale.Crop,
                                modifier = Modifier.fillMaxSize(),
                                error = {
                                    Box(
                                        Modifier
                                            .fillMaxSize()
                                            .background(MaterialTheme.colorScheme.surface),
                                    )
                                },
                            )
                        }
                    }
                }
            }
        }
        PlayingCoverOverlay(
            active = active,
            playing = active && now.playing,
            barHeight = if (size >= 120.dp) 22.dp else 14.dp,
        )
    }
}
