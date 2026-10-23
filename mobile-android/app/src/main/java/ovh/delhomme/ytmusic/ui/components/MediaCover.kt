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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import coil.compose.SubcomposeAsyncImage
import coil.request.CachePolicy
import coil.request.ImageRequest
import java.io.File
import ovh.delhomme.ytmusic.data.BatterySaver
import ovh.delhomme.ytmusic.data.CoverStore
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
    val context = LocalContext.current
    val onDisk = remember(track.id) { CoverStore.peek(context, track.id) != null }
    // Économiseur : pas de réseau pour une grille, mais une pochette déjà vue reste affichée.
    val skipNetworkImage = saverOn && !active && size < 140.dp && !onDisk
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
            CachedCoverImage(
                track = track,
                sizeHint = thumbPx,
                contentDescription = track.title,
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

/** Mosaïque 2×2 des 4 premières covers — carte mix style album.
 *  Préférer des tracks issus de [MixCacheStore] (Home seed) pour un collage immédiat.
 */
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
                            CachedCoverImage(
                                track = t,
                                sizeHint = 200,
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
                            CachedCoverImage(
                                track = t,
                                sizeHint = 200,
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

/**
 * Requête Coil stable : une nouvelle instance à chaque recomposition annulait
 * le chargement (le listener entre dans equals) et la pochette restait vide.
 * Fichier déjà vu d’abord, sinon une seule URL.
 */
@Composable
fun rememberCoverRequest(track: TrackDto, sizeHint: Int): ImageRequest? {
    val context = LocalContext.current
    val localPath = remember(track.id, track.canonicalId) {
        val direct = CoverStore.peek(context, track.id)
        val canon = track.canonicalId
            ?.takeIf { it.isNotBlank() && it != track.id }
            ?.let { CoverStore.peek(context, it) }
        (direct ?: canon)?.absolutePath
    }
    val remote = if (localPath == null) track.coverUrl(sizeHint) else null
    if (localPath == null && remote == null) return null
    val px = sizeHint.coerceIn(60, 800)
    return remember(track.id, localPath, remote, px) {
        if (localPath != null) {
            ImageRequest.Builder(context)
                .data(File(localPath))
                .size(px)
                .allowHardware(false)
                .memoryCacheKey("cover-file:${track.id}")
                .diskCachePolicy(CachePolicy.DISABLED)
                .networkCachePolicy(CachePolicy.DISABLED)
                .build()
        } else {
            ImageRequest.Builder(context)
                .data(remote)
                .size(px)
                .allowHardware(false)
                .memoryCacheKey("cover:${track.id}")
                .diskCacheKey("cover:${track.id}")
                .listener(
                    onSuccess = { _, result ->
                        CoverStore.saveDrawable(context, track.id, result.drawable)
                        CoverStore.importCoilDisk(context, track.id)
                    },
                )
                .build()
        }
    }
}

@Composable
fun CachedCoverImage(
    track: TrackDto,
    modifier: Modifier = Modifier,
    sizeHint: Int = 320,
    contentDescription: String? = null,
    contentScale: ContentScale = ContentScale.Crop,
    loading: @Composable () -> Unit = {},
    error: @Composable () -> Unit = {},
) {
    val request = rememberCoverRequest(track, sizeHint)
    if (request == null) {
        error()
        return
    }
    SubcomposeAsyncImage(
        model = request,
        contentDescription = contentDescription,
        contentScale = contentScale,
        modifier = modifier,
        loading = { loading() },
        error = { error() },
    )
}
