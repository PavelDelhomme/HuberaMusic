package ovh.delhomme.ytmusic.ui.components

import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cast
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material.icons.filled.SyncDisabled
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.DeviceDto
import ovh.delhomme.ytmusic.player.PlayerController
import ovh.delhomme.ytmusic.player.RepeatMode

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CastSheet(
    container: AppContainer,
    player: PlayerController? = null,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var devices by remember { mutableStateOf<List<DeviceDto>>(emptyList()) }
    var activeId by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var receiveRemoteSync by remember { mutableStateOf(container.receiveRemoteSync()) }

    LaunchedEffect(Unit) {
        runCatching {
            container.api.registerSessionDevice(
                mapOf(
                    "deviceId" to container.deviceId,
                    "name" to (android.os.Build.MODEL ?: "Android"),
                    "deviceType" to "mobile",
                    "canPlay" to true,
                ),
            )
            container.api.session()
        }.onSuccess {
            devices = it.devices
            activeId = it.activePlayerId
        }
    }

    fun transferTo(targetId: String, label: String) {
        if (busy) return
        busy = true
        scope.launch {
            runCatching {
                val ui = player?.state?.value
                val state = if (ui?.track != null) {
                    mapOf(
                        "current" to ui.track,
                        "queue" to ui.queue,
                        "queueIndex" to ui.queueIndex,
                        "userQueueEnd" to ui.userQueueEnd,
                        "autoplay" to ui.autoplaySuggestions,
                        "isPlaying" to true,
                        "progress" to (ui.positionMs / 1000.0),
                        "duration" to (ui.durationMs / 1000.0).coerceAtLeast(0.0),
                        "shuffle" to ui.shuffle,
                        "repeat" to when (ui.repeat) {
                            RepeatMode.Off -> "off"
                            RepeatMode.All -> "all"
                            RepeatMode.One -> "one"
                        },
                        "updatedAt" to System.currentTimeMillis(),
                    )
                } else null
                container.api.transferSession(
                    buildMap {
                        put("targetId", targetId)
                        if (state != null) put("state", state)
                    },
                )
            }.onSuccess {
                activeId = it.activePlayerId
                Toast.makeText(context, "Lecture sur « $label »", Toast.LENGTH_SHORT).show()
                onDismiss()
            }.onFailure {
                Toast.makeText(context, "Cast impossible : ${it.message}", Toast.LENGTH_LONG).show()
            }
            busy = false
        }
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        Text(
            "Appareils de lecture",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
        )
        Text(
            if (activeId == container.deviceId || activeId.isNullOrBlank()) {
                "Lecture ici — tape un autre appareil pour y envoyer la file"
            } else {
                "Musique ailleurs — « Cet appareil » pour reprendre ici"
            },
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 20.dp),
        )
        Spacer(Modifier.height(12.dp))

        Row(
            Modifier
                .fillMaxWidth()
                .clickable {
                    val next = !receiveRemoteSync
                    container.setReceiveRemoteSync(next)
                    receiveRemoteSync = next
                    Toast.makeText(
                        context,
                        if (next) "Sync lecture activée" else "Sync lecture désactivée — file locale",
                        Toast.LENGTH_SHORT,
                    ).show()
                }
                .padding(horizontal = 20.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                if (receiveRemoteSync) Icons.Default.Sync else Icons.Default.SyncDisabled,
                null,
                tint = if (receiveRemoteSync) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.width(16.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    if (receiveRemoteSync) "Sync lecture activée" else "Sync lecture désactivée",
                    fontWeight = FontWeight.Medium,
                )
                Text(
                    if (receiveRemoteSync) {
                        "File, titre et position partagés entre tes appareils"
                    } else {
                        "Chaque appareil a sa propre file — le compte reste partagé"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f))

        Row(
            Modifier
                .fillMaxWidth()
                .clickable(enabled = !busy) {
                    busy = true
                    scope.launch {
                        runCatching {
                            container.api.setSessionActive(mapOf("targetId" to container.deviceId))
                        }.onSuccess {
                            activeId = it.activePlayerId
                            Toast.makeText(context, "Lecture ici — file reprise", Toast.LENGTH_SHORT).show()
                            // Reprend la session locale si on avait une file
                            player?.let { ctrl ->
                                val q = ctrl.state.value.queue
                                if (q.isNotEmpty()) {
                                    ctrl.playResume()
                                }
                            }
                            onDismiss()
                        }.onFailure {
                            Toast.makeText(context, "Impossible : ${it.message}", Toast.LENGTH_SHORT).show()
                        }
                        busy = false
                    }
                }
                .padding(horizontal = 20.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.PhoneAndroid, null)
            Spacer(Modifier.width(16.dp))
            Column(Modifier.weight(1f)) {
                Text("Cet appareil", fontWeight = FontWeight.Medium)
                Text(
                    "Android · ${container.deviceId.take(8)}…",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (activeId == null || activeId == container.deviceId) {
                Icon(Icons.Default.Check, null, tint = MaterialTheme.colorScheme.primary)
            }
        }

        if (devices.none { it.id != container.deviceId }) {
            Text(
                "Aucun autre appareil connecté. Ouvre PLM sur le web (même compte) pour caster.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(20.dp),
            )
        } else {
            devices.filter { it.id != container.deviceId }.forEach { d ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable(enabled = !busy) { transferTo(d.id, d.name) }
                        .padding(horizontal = 20.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        if (d.type == "tv" || d.type == "desktop") Icons.Default.Tv else Icons.Default.Cast,
                        null,
                    )
                    Spacer(Modifier.width(16.dp))
                    Column(Modifier.weight(1f)) {
                        Text(d.name, fontWeight = FontWeight.Medium)
                        Text(
                            d.type ?: "appareil",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (d.id == activeId || d.isActive == true) {
                        Icon(Icons.Default.Check, null, tint = MaterialTheme.colorScheme.primary)
                    }
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}
