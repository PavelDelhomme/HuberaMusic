package ovh.delhomme.ytmusic.ui.quickaccess

import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.data.resolvePlayableTracks
import ovh.delhomme.ytmusic.ui.components.TrackRow

@Composable
fun QuickAccessScreen(
    container: AppContainer,
    onPlay: (List<TrackDto>, Int) -> Unit,
    onMore: (TrackDto) -> Unit,
    onOpenDetail: (TrackDto) -> Unit = {},
) {
    val pins by container.quickAccess.pins.collectAsState(initial = emptyList())
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    Column(Modifier.fillMaxSize()) {
        Text(
            "Accès rapide",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(16.dp),
        )
        Text(
            "Épingle titres, playlists et artistes depuis le menu ⋮",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 16.dp),
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
                    "Utilise « Épingler dans l'accès rapide » sur un titre.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        } else {
            LazyColumn(contentPadding = PaddingValues(top = 12.dp, bottom = 24.dp)) {
                itemsIndexed(pins, key = { index, track -> "${track.id}-$index" }) { _, track ->
                    TrackRow(
                        track = track,
                        onClick = {
                            if (track.isPlaylist() || track.isAlbum() || track.isArtist()) {
                                onOpenDetail(track)
                                return@TrackRow
                            }
                            scope.launch {
                                if (track.isPlayable()) {
                                    onPlay(listOf(track), 0)
                                } else {
                                    onOpenDetail(track)
                                }
                            }
                        },
                        onMore = { onMore(track) },
                    )
                }
            }
        }
    }
}
