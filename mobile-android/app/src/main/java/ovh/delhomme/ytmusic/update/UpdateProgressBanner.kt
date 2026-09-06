package ovh.delhomme.ytmusic.update

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/**
 * Vignette au-dessus du mini-lecteur : progression + bouton pour
 * rouvrir l’écran système « Confirmer l’installation » (Nothing le
 * cache souvent derrière PLM).
 */
fun ApkUpdateManager.UiState.showsUpdateBanner(): Boolean {
    return when (phase) {
        ApkUpdateManager.Phase.Checking,
        ApkUpdateManager.Phase.Downloading,
        ApkUpdateManager.Phase.Installing,
        ApkUpdateManager.Phase.AwaitingConfirm,
        -> true
        ApkUpdateManager.Phase.Error -> available
        else -> false
    }
}

@Composable
fun UpdateProgressBanner(
    ui: ApkUpdateManager.UiState,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (!ui.showsUpdateBanner()) return
    val phase = ui.phase
    val awaiting = phase == ApkUpdateManager.Phase.AwaitingConfirm
    val determinate = phase == ApkUpdateManager.Phase.Downloading ||
        phase == ApkUpdateManager.Phase.Installing
    val title = when (phase) {
        ApkUpdateManager.Phase.Downloading ->
            "Téléchargement… ${(ui.progress * 100).toInt()} %"
        ApkUpdateManager.Phase.Installing ->
            "Préparation de l’installateur…"
        ApkUpdateManager.Phase.Checking -> "Vérification de la version…"
        ApkUpdateManager.Phase.AwaitingConfirm -> "Confirmer l’installation"
        ApkUpdateManager.Phase.Error -> "Installation bloquée — réessayer"
        else -> "Mise à jour PLM"
    }
    val cta = when (phase) {
        ApkUpdateManager.Phase.AwaitingConfirm -> "Confirmer"
        ApkUpdateManager.Phase.Error -> "Réessayer"
        else -> null
    }
    Surface(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        color = MaterialTheme.colorScheme.primaryContainer,
        shadowElevation = 6.dp,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 10.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        title,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                    val sub = ui.message.trim()
                    if (sub.isNotEmpty() && sub != title) {
                        Spacer(Modifier.height(2.dp))
                        Text(
                            sub,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.85f),
                        )
                    }
                }
                if (cta != null) {
                    Spacer(Modifier.width(8.dp))
                    Text(
                        cta,
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
            Spacer(Modifier.height(8.dp))
            if (determinate) {
                LinearProgressIndicator(
                    progress = { ui.progress.coerceIn(0f, 1f) },
                    modifier = Modifier.fillMaxWidth(),
                )
            } else if (awaiting) {
                LinearProgressIndicator(
                    progress = { 1f },
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }
        }
    }
}
