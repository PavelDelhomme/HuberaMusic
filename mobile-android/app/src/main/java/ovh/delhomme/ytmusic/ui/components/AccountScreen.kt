package ovh.delhomme.ytmusic.ui.components

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material.icons.filled.CloudDownload
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.VpnKey
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
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

/**
 * Page Compte pleine écran (navigable) — pas un bottom sheet qui se referme
 * dès qu’on ouvre Historique / Reco / Téléchargements.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccountScreen(
    container: AppContainer,
    onBack: () -> Unit,
    onOpenRecoPrefs: () -> Unit,
    onOpenDownloads: () -> Unit = {},
    onOpenHistory: () -> Unit = {},
    onOpenDebugLogs: (() -> Unit)? = null,
    onOpenYtmImport: (() -> Unit)? = null,
    onLoggedOut: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var user by remember { mutableStateOf<UserDto?>(null) }
    var passkeyInfo by remember { mutableStateOf<String?>(null) }
    var updateHint by remember { mutableStateOf<String?>(null) }
    var updateAvailable by remember { mutableStateOf(false) }
    var showEqualizer by remember { mutableStateOf(false) }
    var ytmLinked by remember {
        mutableStateOf(container.sharedPrefs("ytm_google").getBoolean("linked", false))
    }

    BackHandler(onBack = onBack)

    LaunchedEffect(Unit) {
        user = runCatching {
            container.ensureFreshToken()
            container.api.me().user
        }.getOrNull()
        val status = runCatching { container.api.ytmStatus().account }.getOrNull()
        val linked = user?.ytmLinked == true || status?.connected == true
        if (user != null || status != null) {
            ytmLinked = linked
            container.sharedPrefs("ytm_google").edit().putBoolean("linked", linked).apply()
        }
        // Statut MAJ pour la ligne Compte (toujours, hors fenêtre horaire)
        runCatching {
            val updater = ovh.delhomme.ytmusic.update.ApkUpdateManager(
                context.applicationContext,
                container,
            )
            val check = updater.check(force = true, respectSnooze = false)
            val remoteCode = check.info?.versionCode ?: 0
            val remoteName = check.info?.versionName
            val local = BuildConfig.VERSION_NAME
            when {
                remoteCode > BuildConfig.VERSION_CODE && !updater.isSnoozed(remoteCode) -> {
                    updateAvailable = true
                    updateHint = "Mettre à jour l'application" +
                        (remoteName?.let { " ($it)" } ?: "")
                }
                remoteCode > BuildConfig.VERSION_CODE -> {
                    updateAvailable = false
                    updateHint = "Installée $local · serveur $remoteName (ignorée)"
                }
                remoteCode > 0 -> {
                    updateAvailable = false
                    updateHint = "Installée $local · serveur ${remoteName ?: local}"
                }
                else -> {
                    updateAvailable = false
                    updateHint = "Installée $local"
                }
            }
        }
    }

    Scaffold(
        contentWindowInsets = WindowInsets.safeDrawing,
        topBar = {
            TopAppBar(
                title = { Text("Compte") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Retour")
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier
                .fillMaxSize()
                .padding(padding),
            contentPadding = PaddingValues(bottom = 24.dp),
        ) {
            item {
                Column(
                    Modifier
                        .fillMaxWidth()
                        .padding(top = 8.dp, bottom = 12.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    if (!user?.picture.isNullOrBlank()) {
                        AsyncImage(
                            model = user!!.picture,
                            contentDescription = null,
                            contentScale = ContentScale.Crop,
                            modifier = Modifier
                                .size(72.dp)
                                .clip(CircleShape),
                        )
                    } else {
                        Icon(
                            Icons.Default.Person,
                            contentDescription = null,
                            modifier = Modifier.size(64.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Spacer(Modifier.height(10.dp))
                    Text(
                        user?.name?.ifBlank { null }
                            ?: user?.email?.substringBefore('@')
                            ?: "Compte",
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
                }
            }

            item {
                HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f))
            }

            // MAJ en haut : visible sur petits écrans sans scroller toute la liste
            item {
                val accentRed = Color(0xFFE53935)
                AccountRow(
                    icon = {
                        Icon(
                            Icons.Default.SystemUpdate,
                            contentDescription = null,
                            tint = if (updateAvailable) accentRed else Color.Unspecified,
                        )
                    },
                    title = if (updateAvailable) {
                        "Mettre à jour l'application"
                    } else {
                        "Mettre à jour l'app"
                    },
                    subtitle = updateHint
                        ?: "Installée ${BuildConfig.VERSION_NAME}",
                    titleColor = if (updateAvailable) accentRed else Color.Unspecified,
                    onClick = {
                        scope.launch {
                            runCatching {
                                val updater = ovh.delhomme.ytmusic.update.ApkUpdateManager(
                                    context.applicationContext,
                                    container,
                                )
                                updateHint = "Vérification…"
                                // Clic manuel : toujours proposer si remote > local (ignore snooze fenêtre)
                                val check = updater.check(force = true, respectSnooze = false)
                                val remote = check.info?.versionCode ?: 0
                                if (remote <= BuildConfig.VERSION_CODE) {
                                    updateAvailable = false
                                    updateHint = check.message
                                        ?: "Installée ${BuildConfig.VERSION_NAME} · à jour"
                                    Toast.makeText(
                                        context,
                                        check.message ?: "Déjà à jour",
                                        Toast.LENGTH_SHORT,
                                    ).show()
                                    return@launch
                                }
                                updateAvailable = true
                                updateHint = "Mettre à jour l'application"
                                Toast.makeText(
                                    context,
                                    "Téléchargement de la mise à jour…",
                                    Toast.LENGTH_SHORT,
                                ).show()
                                val msg = updater.downloadAndInstall(null)
                                updateHint = msg
                                Toast.makeText(context, msg, Toast.LENGTH_LONG).show()
                            }.onFailure {
                                updateHint = it.message
                                Toast.makeText(context, it.message ?: "Échec", Toast.LENGTH_SHORT)
                                    .show()
                            }
                        }
                    },
                )
            }

            item {
                AccountRow(
                    icon = { Icon(Icons.Default.History, contentDescription = null) },
                    title = "Historique d'écoute",
                    subtitle = "Titres écoutés récemment",
                    onClick = onOpenHistory,
                )
            }
            item {
                AccountRow(
                    icon = { Icon(Icons.Default.Download, contentDescription = null) },
                    title = "Téléchargements",
                    subtitle = "Titres prêts hors ligne",
                    onClick = onOpenDownloads,
                )
            }
            item {
                AccountRow(
                    icon = { Icon(Icons.Default.Settings, contentDescription = null) },
                    title = "Recommandations",
                    subtitle = "Affiner ce que l'on te propose",
                    onClick = onOpenRecoPrefs,
                )
            }
            if (onOpenYtmImport != null) {
                item {
                    val linked = user?.ytmLinked == true || ytmLinked
                    AccountRow(
                        icon = { Icon(Icons.Default.CloudDownload, contentDescription = null) },
                        title = if (linked) "Compte Google" else "Connecter Google",
                        subtitle = if (linked) {
                            "Likes, playlists — synchroniser la bibliothèque"
                        } else {
                            "Un bouton — likes et playlists, sans collage"
                        },
                        onClick = onOpenYtmImport,
                    )
                }
            } else {
                // Toujours afficher la ligne (évite UI « vide » si callback omis)
                item {
                    val linked = user?.ytmLinked == true || ytmLinked
                    AccountRow(
                        icon = { Icon(Icons.Default.CloudDownload, contentDescription = null) },
                        title = if (linked) "Compte Google" else "Connecter Google",
                        subtitle = "Indisponible dans cette session — rouvre Compte depuis Accueil",
                        onClick = {},
                    )
                }
            }
            item {
                AccountRow(
                    icon = { Icon(Icons.Default.VpnKey, contentDescription = null) },
                    title = "Enregistrer une passkey",
                    subtitle = "Bitwarden, GPM ou empreinte — sans mot de passe",
                    onClick = {
                        scope.launch {
                            try {
                                val token = container.tokenStore.getAccess()
                                    ?: error("Session expirée")
                                PasskeyAuth(context, container.httpPlain).register(token, "Android")
                                container.sharedPrefs("ytm_passkey").edit()
                                    .putBoolean("ready", true)
                                    .remove("offer_dismissed")
                                    .apply()
                                passkeyInfo = "Passkey enregistrée — disponible au prochain login"
                            } catch (e: Exception) {
                                Toast.makeText(context, e.message ?: "Échec", Toast.LENGTH_SHORT)
                                    .show()
                            }
                        }
                    },
                )
            }
            item {
                AccountRow(
                    icon = { Icon(Icons.Default.Tune, contentDescription = null) },
                    title = "Égaliseur",
                    subtitle = if (ovh.delhomme.ytmusic.player.AudioEqualizer.isEnabled()) {
                        "Actif — graves / médiums / aigus"
                    } else {
                        "Ajuster le son"
                    },
                    onClick = { showEqualizer = true },
                )
            }
            item {
                AccountRow(
                    icon = { Icon(Icons.Default.BugReport, contentDescription = null) },
                    title = "API & logs",
                    subtitle = "${container.apiEnvLabel()} · ${container.resolvedApiBase()}",
                    onClick = {
                        onOpenDebugLogs?.invoke()
                            ?: Toast.makeText(context, "Ouvre Compte depuis Accueil", Toast.LENGTH_SHORT).show()
                    },
                )
            }

            item {
                HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f))
            }

            item {
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
                            onLoggedOut()
                        }
                    },
                )
            }

            item {
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

    if (showEqualizer) {
        EqualizerSheet(onDismiss = { showEqualizer = false })
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
