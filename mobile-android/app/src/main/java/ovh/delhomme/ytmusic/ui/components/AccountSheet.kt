package ovh.delhomme.ytmusic.ui.components

import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material.icons.filled.CloudDownload
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.VpnKey
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.BuildConfig
import ovh.delhomme.ytmusic.auth.PasskeyAuth
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.RefreshBody
import ovh.delhomme.ytmusic.data.UserDto

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccountSheet(
    container: AppContainer,
    onDismiss: () -> Unit,
    onOpenRecoPrefs: () -> Unit,
    onOpenHistory: () -> Unit,
    onOpenDownloads: () -> Unit = {},
    onOpenDebugLogs: (() -> Unit)? = null,
    onOpenYtmImport: (() -> Unit)? = null,
    onLoggedOut: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var user by remember { mutableStateOf<UserDto?>(null) }
    var passkeyInfo by remember { mutableStateOf<String?>(null) }
    var updateHint by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        user = runCatching {
            container.ensureFreshToken()
            container.api.me().user
        }.getOrNull()
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(bottom = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (!user?.picture.isNullOrBlank()) {
                AsyncImage(
                    model = user!!.picture,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier
                        .size(64.dp)
                        .clip(CircleShape),
                )
            } else {
                Icon(
                    Icons.Default.Person,
                    contentDescription = null,
                    modifier = Modifier.size(56.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(10.dp))
            Text(
                user?.name?.ifBlank { null } ?: user?.email?.substringBefore('@') ?: "Compte",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.SemiBold,
            )
            user?.email?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            passkeyInfo?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.primary,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
            Spacer(Modifier.height(16.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f))

            AccountRow(
                icon = { Icon(Icons.Default.History, contentDescription = null) },
                title = "Historique d'écoute",
                subtitle = "Titres écoutés récemment",
                onClick = {
                    onDismiss()
                    onOpenHistory()
                },
            )
            // TODO(stats): page Stats dans ce menu (à côté Reco / déconnexion) —
            // artistes les + écoutés, heures/jours/mois d’écoute, total titres,
            // taux de couverture biblio. Ne pas implémenter maintenant.
            AccountRow(
                icon = { Icon(Icons.Default.Download, contentDescription = null) },
                title = "Téléchargements",
                subtitle = "Titres prêts hors ligne",
                onClick = {
                    onDismiss()
                    onOpenDownloads()
                },
            )
            AccountRow(
                icon = { Icon(Icons.Default.Settings, contentDescription = null) },
                title = "Recommandations",
                subtitle = "Affiner ce que l'on te propose",
                onClick = {
                    onDismiss()
                    onOpenRecoPrefs()
                },
            )
            if (onOpenYtmImport != null) {
                val linked = user?.ytmLinked == true
                AccountRow(
                    icon = { Icon(Icons.Default.CloudDownload, contentDescription = null) },
                    title = if (linked) "Compte Google" else "Connecter Google",
                    subtitle = if (linked) {
                        "Likes, playlists — synchroniser la bibliothèque"
                    } else {
                        "Un bouton — likes et playlists, sans collage"
                    },
                    onClick = {
                        onDismiss()
                        onOpenYtmImport()
                    },
                )
            }
            AccountRow(
                icon = { Icon(Icons.Default.VpnKey, contentDescription = null) },
                title = "Enregistrer une passkey",
                subtitle = "Bitwarden, GPM ou empreinte — sans mot de passe",
                onClick = {
                    scope.launch {
                        try {
                            val token = container.tokenStore.getAccess() ?: error("Session expirée")
                            PasskeyAuth(context, container.httpPlain).register(token, "Android")
                            container.sharedPrefs("ytm_passkey").edit()
                                .putBoolean("ready", true)
                                .remove("offer_dismissed")
                                .apply()
                            passkeyInfo = "Passkey enregistrée — disponible au prochain login"
                        } catch (e: Exception) {
                            Toast.makeText(context, e.message ?: "Échec", Toast.LENGTH_SHORT).show()
                        }
                    }
                },
            )
            AccountRow(
                icon = { Icon(Icons.Default.BugReport, contentDescription = null) },
                title = "API & logs",
                subtitle = "${container.apiEnvLabel()} · ${container.resolvedApiBase()}",
                onClick = {
                    onDismiss()
                    onOpenDebugLogs?.invoke()
                },
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f))
            AccountRow(
                icon = {
                    Icon(
                        Icons.AutoMirrored.Filled.Logout,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.error,
                    )
                },
                title = "Se déconnecter",
                titleColor = MaterialTheme.colorScheme.error,
                onClick = {
                    scope.launch {
                        runCatching {
                            container.api.logout(RefreshBody(container.tokenStore.getRefresh()))
                        }
                        container.tokenStore.clear()
                        onDismiss()
                        onLoggedOut()
                    }
                },
            )
            AccountRow(
                icon = { Icon(Icons.Default.Download, contentDescription = null) },
                title = "Mettre à jour l'app",
                subtitle = updateHint ?: "Vérifier / installer depuis le serveur (in-app)",
                onClick = {
                    scope.launch {
                        runCatching {
                            val updater = ovh.delhomme.ytmusic.update.ApkUpdateManager(
                                context.applicationContext,
                                container,
                            )
                            updateHint = "Vérification…"
                            val check = updater.check(force = true)
                            if (!check.available) {
                                updateHint = check.message ?: "À jour"
                                Toast.makeText(
                                    context,
                                    check.message ?: "Déjà à jour",
                                    Toast.LENGTH_SHORT,
                                ).show()
                                return@launch
                            }
                            updateHint = check.message ?: "Téléchargement…"
                            Toast.makeText(context, "Téléchargement de la mise à jour…", Toast.LENGTH_SHORT).show()
                            val msg = updater.downloadAndInstall(check.info)
                            updateHint = msg
                            Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
                        }.onFailure {
                            updateHint = it.message
                            Toast.makeText(context, it.message ?: "Échec", Toast.LENGTH_SHORT).show()
                        }
                    }
                },
            )
            Text(
                "Version ${BuildConfig.APP_VERSION_LABEL}  ·  code ${BuildConfig.VERSION_CODE}",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp, vertical = 12.dp),
            )
        }
    }
}

@Composable
private fun AccountRow(
    icon: @Composable () -> Unit,
    title: String,
    subtitle: String? = null,
    titleColor: Color = Color.Unspecified,
    onClick: () -> Unit,
) {
    ListItem(
        headlineContent = {
            Text(
                title,
                color = if (titleColor == Color.Unspecified) {
                    MaterialTheme.colorScheme.onSurface
                } else {
                    titleColor
                },
            )
        },
        supportingContent = subtitle?.let { { Text(it) } },
        leadingContent = icon,
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
    )
}
