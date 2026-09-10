package ovh.delhomme.ytmusic.update

import android.content.Intent
import android.net.Uri
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/**
 * Dialogue MAJ : **reste ouvert** pendant vérif / téléchargement / préparation
 * (barre + %) pour que l’utilisateur sache où il en est.
 * Fermeture auto seulement après install réussie (Done).
 */
@Composable
fun UpdateAvailableDialog(
    versionName: String?,
    updater: ApkUpdateManager,
    onInstall: () -> Unit,
    onSnooze: (ApkUpdateManager.SnoozeOption) -> Unit,
    onSoftDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val ui by updater.ui.collectAsState()
    var showSnoozePicker by remember { mutableStateOf(false) }
    val busy = ui.phase == ApkUpdateManager.Phase.Checking ||
        ui.phase == ApkUpdateManager.Phase.Downloading ||
        ui.phase == ApkUpdateManager.Phase.Installing
    val showProgress = busy ||
        ui.phase == ApkUpdateManager.Phase.AwaitingConfirm ||
        ui.phase == ApkUpdateManager.Phase.Done

    // Ne fermer auto qu’à la fin — pas pendant Downloading (sinon popup « bloquée »
    // sans barre : l’utilisateur ne voit plus où il en est).
    LaunchedEffect(ui.phase) {
        when (ui.phase) {
            ApkUpdateManager.Phase.Done -> {
                delay(900L)
                onSoftDismiss()
            }
            else -> Unit
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
        onDismissRequest = {
            // Pendant DL : back ferme juste le dialogue (le DL continue + vignette mini).
            onSoftDismiss()
        },
        title = {
            Text(
                when (ui.phase) {
                    ApkUpdateManager.Phase.Downloading ->
                        "Téléchargement… ${(ui.progress * 100).toInt()} %"
                    ApkUpdateManager.Phase.Installing ->
                        "Préparation… ${(ui.progress * 100).toInt()} %"
                    ApkUpdateManager.Phase.Checking -> "Vérification…"
                    ApkUpdateManager.Phase.AwaitingConfirm -> "Confirme l’installation"
                    ApkUpdateManager.Phase.Done -> "Mise à jour installée"
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
                    when (ui.phase) {
                        ApkUpdateManager.Phase.Downloading,
                        ApkUpdateManager.Phase.Installing,
                        -> {
                            LinearProgressIndicator(
                                progress = { ui.progress.coerceIn(0.02f, 1f) },
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Spacer(Modifier.height(6.dp))
                            Text("${(ui.progress * 100).toInt().coerceIn(0, 100)} %")
                        }
                        ApkUpdateManager.Phase.Checking,
                        ApkUpdateManager.Phase.AwaitingConfirm,
                        -> {
                            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                        }
                        ApkUpdateManager.Phase.Done -> {
                            LinearProgressIndicator(
                                progress = { 1f },
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                        else -> Unit
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !busy && ui.phase != ApkUpdateManager.Phase.AwaitingConfirm,
                onClick = onInstall,
            ) {
                Text(
                    when {
                        busy -> "En cours…"
                        ui.phase == ApkUpdateManager.Phase.AwaitingConfirm -> "En attente…"
                        ui.phase == ApkUpdateManager.Phase.Error -> "Réessayer"
                        ui.phase == ApkUpdateManager.Phase.Done -> "OK"
                        else -> "Télécharger"
                    },
                )
            }
        },
        dismissButton = {
            Column {
                TextButton(
                    enabled = !busy,
                    onClick = {
                        runCatching {
                            context.startActivity(
                                Intent(
                                    Intent.ACTION_VIEW,
                                    Uri.parse("https://plm.delhomme.ovh/install"),
                                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                            )
                        }
                        onSoftDismiss()
                    },
                ) { Text("Via navigateur") }
                TextButton(
                    enabled = !busy,
                    onClick = {
                        if (ui.phase == ApkUpdateManager.Phase.AwaitingConfirm ||
                            ui.phase == ApkUpdateManager.Phase.Done
                        ) {
                            onSoftDismiss()
                        } else {
                            showSnoozePicker = true
                        }
                    },
                ) {
                    Text(
                        when (ui.phase) {
                            ApkUpdateManager.Phase.AwaitingConfirm,
                            ApkUpdateManager.Phase.Done,
                            -> "Fermer"
                            else -> "Plus tard"
                        },
                    )
                }
            }
        },
    )
}
