package ovh.delhomme.ytmusic.update

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/**
 * Dialogue MAJ : reste ouvert pendant le téléchargement (barre + %).
 * Fermer sans choisir (back / extérieur) -> [onSoftDismiss] sans snooze,
 * sauf si un DL / install est déjà lancé.
 */
@Composable
fun UpdateAvailableDialog(
    versionName: String?,
    updater: ApkUpdateManager,
    onInstall: () -> Unit,
    onSnooze: (ApkUpdateManager.SnoozeOption) -> Unit,
    onSoftDismiss: () -> Unit,
) {
    val ui by updater.ui.collectAsState()
    var showSnoozePicker by remember { mutableStateOf(false) }
    val busy = ui.phase == ApkUpdateManager.Phase.Checking ||
        ui.phase == ApkUpdateManager.Phase.Downloading ||
        ui.phase == ApkUpdateManager.Phase.Installing
    val showProgress = busy || ui.phase == ApkUpdateManager.Phase.AwaitingConfirm

    LaunchedEffect(ui.phase) {
        if (ui.phase == ApkUpdateManager.Phase.AwaitingConfirm ||
            ui.phase == ApkUpdateManager.Phase.Done
        ) {
            onSoftDismiss()
        }
    }

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
        onDismissRequest = { if (!busy) onSoftDismiss() },
        title = {
            Text(
                when (ui.phase) {
                    ApkUpdateManager.Phase.Downloading ->
                        "Téléchargement… ${(ui.progress * 100).toInt()} %"
                    ApkUpdateManager.Phase.Installing -> "Préparation de l’installateur…"
                    ApkUpdateManager.Phase.Checking -> "Vérification…"
                    ApkUpdateManager.Phase.AwaitingConfirm -> "Confirme l’installation"
                    ApkUpdateManager.Phase.Error -> "Mise à jour"
                    else -> "Mise à jour disponible"
                },
            )
        },
        text = {
            Column {
                Text(
                    ui.message.ifBlank {
                        versionName?.let { "Version $it prête à installer." }
                            ?: "Une nouvelle version PLM est disponible."
                    },
                )
                if (showProgress) {
                    Spacer(Modifier.height(12.dp))
                    if (ui.phase == ApkUpdateManager.Phase.Downloading ||
                        ui.phase == ApkUpdateManager.Phase.Installing
                    ) {
                        LinearProgressIndicator(
                            progress = { ui.progress.coerceIn(0f, 1f) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    } else {
                        LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                    }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy, onClick = onInstall) {
                Text(
                    when {
                        busy -> "En cours…"
                        ui.phase == ApkUpdateManager.Phase.Error -> "Réessayer"
                        else -> "Installer"
                    },
                )
            }
        },
        dismissButton = {
            TextButton(
                enabled = !busy,
                onClick = { showSnoozePicker = true },
            ) { Text("Plus tard") }
        },
    )
}
