package ovh.delhomme.ytmusic.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ovh.delhomme.ytmusic.player.AudioEqualizer

private val BAND_LABELS = listOf("Graves", "Bas-méd.", "Médiums", "Haut-méd.", "Aigus")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EqualizerSheet(onDismiss: () -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var enabled by remember { mutableStateOf(AudioEqualizer.isEnabled()) }
    val gainsMb = remember { AudioEqualizer.uiGains() }
    var sliders by remember {
        mutableStateOf(FloatArray(5) { i -> gainsMb[i] / 100f })
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 8.dp),
        ) {
            Text("Égaliseur", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(8.dp))
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Activer", modifier = Modifier.weight(1f))
                Switch(
                    checked = enabled,
                    onCheckedChange = {
                        enabled = it
                        AudioEqualizer.setEnabled(it)
                    },
                )
            }
            HorizontalDivider(Modifier.padding(vertical = 12.dp))
            BAND_LABELS.forEachIndexed { i, label ->
                Text(label, style = MaterialTheme.typography.labelMedium)
                Slider(
                    value = sliders[i],
                    onValueChange = { v ->
                        sliders = sliders.copyOf().also { it[i] = v }
                        AudioEqualizer.setUiGain(i, (v * 100f).toInt())
                    },
                    valueRange = -12f..12f,
                    enabled = enabled,
                )
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}
