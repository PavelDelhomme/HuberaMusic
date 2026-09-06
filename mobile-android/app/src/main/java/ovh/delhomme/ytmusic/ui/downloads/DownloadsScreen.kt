package ovh.delhomme.ytmusic.ui.downloads

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.TrackDto

/**
 * Écran dédié Téléchargements : progression, retry, suppression, lecture.
 * Complète le filtre Biblio → Téléchargés.
 */
@Composable
fun DownloadsScreen(
    container: AppContainer,
    onBack: () -> Unit,
    onPlay: (List<TrackDto>, Int) -> Unit,
    onOpenDetail: ((TrackDto) -> Unit)? = null,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val revision by container.offlineStore.revision.collectAsState()
    val progress by container.downloadManager.progress.collectAsState()
    val errors by container.downloadManager.errors.collectAsState()

    val tracks = remember(revision) {
        container.offlineStore.listTracks().sortedBy { it.title.lowercase() }
    }
    val downloadingIds = progress.keys.toList()
    val activeCount = downloadingIds.size
    val readyCount = tracks.size

    Column(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 12.dp),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(top = 8.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Retour")
            }
            Column(Modifier.weight(1f)) {
                Text(
                    "Téléchargements",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    when {
                        activeCount > 0 -> "$readyCount hors-ligne · $activeCount en cours"
                        readyCount > 0 -> "$readyCount titres hors-ligne"
                        else -> "Aucun fichier local"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (tracks.isNotEmpty()) {
                TextButton(
                    onClick = {
                        onPlay(tracks.filter { it.isPlayable() }, 0)
                    },
                ) {
                    Icon(Icons.Default.PlayArrow, null, Modifier.size(18.dp))
                    Spacer(Modifier.width(4.dp))
                    Text("Tout lire")
                }
            }
        }

        if (activeCount > 0) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .padding(vertical = 8.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f))
                    .padding(12.dp),
            ) {
                Text(
                    "En cours",
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.height(8.dp))
                downloadingIds.forEach { id ->
                    val pct = progress[id] ?: 0f
                    val err = errors[id]
                    Text(
                        tracks.firstOrNull { it.id == id }?.title ?: id,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    LinearProgressIndicator(
                        progress = { pct.coerceIn(0.02f, 1f) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(vertical = 4.dp),
                    )
                    if (!err.isNullOrBlank()) {
                        Text(
                            err,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            }
        }

        if (tracks.isEmpty() && activeCount == 0) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(
                        Icons.Default.Download,
                        contentDescription = null,
                        modifier = Modifier.size(40.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(12.dp))
                    Text(
                        "Aucun téléchargement",
                        style = MaterialTheme.typography.titleMedium,
                    )
                    Text(
                        "Menu ⋮ d’un titre → Télécharger",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        } else {
            LazyColumn(
                contentPadding = PaddingValues(bottom = 96.dp, top = 8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                items(tracks, key = { it.id }) { track ->
                    val err = errors[track.id]
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .clickable {
                                val idx = tracks.indexOfFirst { it.id == track.id }.coerceAtLeast(0)
                                onPlay(tracks, idx)
                            }
                            .padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        AsyncImage(
                            model = track.coverUrl(120),
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier
                                .size(52.dp)
                                .clip(RoundedCornerShape(8.dp)),
                        )
                        Spacer(Modifier.width(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                track.title,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                fontWeight = FontWeight.Medium,
                            )
                            Text(
                                track.artistLine(),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            if (!err.isNullOrBlank()) {
                                Text(
                                    err,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.error,
                                )
                            }
                        }
                        if (progress.containsKey(track.id)) {
                            CircularProgressIndicator(
                                progress = { (progress[track.id] ?: 0f).coerceIn(0.02f, 1f) },
                                modifier = Modifier.size(22.dp),
                                strokeWidth = 2.dp,
                            )
                        } else if (!err.isNullOrBlank()) {
                            IconButton(
                                onClick = {
                                    container.downloadManager.enqueue(track)
                                    Toast.makeText(context, "Nouvelle tentative…", Toast.LENGTH_SHORT).show()
                                },
                            ) {
                                Icon(Icons.Default.Refresh, contentDescription = "Réessayer")
                            }
                        }
                        IconButton(
                            onClick = {
                                scope.launch {
                                    container.offlineStore.remove(track.id)
                                    Toast.makeText(context, "Supprimé", Toast.LENGTH_SHORT).show()
                                }
                            },
                        ) {
                            Icon(
                                Icons.Default.Delete,
                                contentDescription = "Supprimer",
                                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }
}
