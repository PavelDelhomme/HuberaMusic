package ovh.delhomme.ytmusic.update

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

/**
 * Dialogue MAJ : Installer / Plus tard (choix de timer).
 * Fermer sans choisir (back / exterieur) -> [onSoftDismiss] sans snooze.
 */
@Composable
fun UpdateAvailableDialog(
    versionName: String?,
    installing: Boolean,
    onInstall: () -> Unit,
    onSnooze: (ApkUpdateManager.SnoozeOption) -> Unit,
    onSoftDismiss: () -> Unit,
) {
    var showSnoozePicker by remember { mutableStateOf(false) }

    if (showSnoozePicker) {
        AlertDialog(
            onDismissRequest = { showSnoozePicker = false },
            title = { Text("Me le rappeler…") },
            text = {
                Column {
                    ApkUpdateManager.SnoozeOption.entries.forEach { opt ->
                        TextButton(
                            onClick = {
                                onSnooze(opt)
                                showSnoozePicker = false
                            },
                        ) {
                            Text(opt.label)
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showSnoozePicker = false }) { Text("Annuler") }
            },
        )
        return
    }

    AlertDialog(
        onDismissRequest = onSoftDismiss,
        title = { Text("Mise à jour disponible") },
        text = {
            Text(
                versionName?.let { "Version $it prête à installer." }
                    ?: "Une nouvelle version PLM est disponible.",
            )
        },
        confirmButton = {
            TextButton(enabled = !installing, onClick = onInstall) {
                Text(if (installing) "…" else "Installer")
            }
        },
        dismissButton = {
            TextButton(
                enabled = !installing,
                onClick = { showSnoozePicker = true },
            ) { Text("Plus tard") }
        },
    )
}
