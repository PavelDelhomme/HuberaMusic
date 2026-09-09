package ovh.delhomme.ytmusic.ui.components

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
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
import androidx.compose.material.icons.automirrored.filled.HelpOutline
import androidx.compose.material.icons.filled.BugReport
import androidx.compose.material.icons.filled.CloudDownload
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.QrCode
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.VpnKey
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import coil.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import ovh.delhomme.ytmusic.BuildConfig
import ovh.delhomme.ytmusic.DeviceLoginDeepLink
import ovh.delhomme.ytmusic.auth.DeviceLoginQr
import ovh.delhomme.ytmusic.auth.PasskeyAuth
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.RefreshBody
import ovh.delhomme.ytmusic.data.UserDto
import ovh.delhomme.ytmusic.ui.auth.QrScannerScreen
import ovh.delhomme.ytmusic.ui.util.toastMain
import ovh.delhomme.ytmusic.update.ApkUpdateManager

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
    onOpenHelp: (() -> Unit)? = null,
    onOpenDebugLogs: (() -> Unit)? = null,
    onOpenYtmImport: (() -> Unit)? = null,
    onLoggedOut: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var user by remember { mutableStateOf<UserDto?>(null) }
    var passkeyInfo by remember { mutableStateOf<String?>(null) }
    var showEqualizer by remember { mutableStateOf(false) }
    var showVersionNotes by remember { mutableStateOf(false) }
    var showQrScanner by remember { mutableStateOf(false) }
    var inviteClaimUrl by remember { mutableStateOf<String?>(null) }
    var inviteBusy by remember { mutableStateOf(false) }
    var ytmLinked by remember {
        mutableStateOf(container.sharedPrefs("ytm_google").getBoolean("linked", false))
    }
    val updater = remember { container.apkUpdateManager }
    val updateUi by updater.ui.collectAsState()
    val lifecycleOwner = LocalLifecycleOwner.current
    var listenStats by remember { mutableStateOf<String?>(null) }
    var downloadsSubtitle by remember { mutableStateOf("Titres prêts hors ligne") }

    LaunchedEffect(Unit) {
        downloadsSubtitle = withContext(Dispatchers.IO) {
            val n = runCatching { container.offlineStore.listTracks().size }.getOrDefault(0)
            var freeMb = -1L
            runCatching {
                var free = container.appContext.filesDir.usableSpace
                if (android.os.Build.VERSION.SDK_INT >= 26) {
                    val sm = container.appContext.getSystemService(android.app.usage.StorageStatsManager::class.java)
                    free = sm.getFreeBytes(android.os.storage.StorageManager.UUID_DEFAULT)
                }
                freeMb = free / (1024 * 1024)
            }
            when {
                n <= 0 && freeMb >= 0 -> "Aucun fichier · ${freeMb} Mo libres"
                n <= 0 -> "Aucun titre hors ligne"
                freeMb >= 0 -> "$n hors ligne · ${freeMb} Mo libres"
                else -> "$n titres hors ligne"
            }
        }
    }

    LaunchedEffect(Unit) {
        listenStats = withContext(Dispatchers.IO) {
            runCatching {
                container.ensureFreshToken()
                val detailed = container.api.historyDetailed()
                val weekAgo = System.currentTimeMillis() - 7L * 24 * 60 * 60 * 1000
                val recent = detailed.events.filter { it.createdAt >= weekAgo }
                if (recent.isEmpty()) {
                    val hist = container.api.history().history
                    if (hist.isEmpty()) null
                    else "Historique · ${hist.size} titres récents"
                } else {
                    val top = recent
                        .groupingBy { it.track?.title?.takeIf { t -> t.isNotBlank() } ?: it.trackId }
                        .eachCount()
                        .maxByOrNull { it.value }
                    val topLabel = top?.key?.let { " · top : $it" }.orEmpty()
                    "${recent.size} écoutes (7 j)$topLabel"
                }
            }.getOrNull()
        }
    }

    BackHandler(onBack = onBack)

    if (showQrScanner) {
        QrScannerScreen(
            title = "Autoriser un appareil",
            onCancel = { showQrScanner = false },
            onResult = { raw ->
                showQrScanner = false
                when (val link = DeviceLoginQr.parse(raw)) {
                    is DeviceLoginDeepLink.Approve -> {
                        scope.launch {
                            runCatching {
                                container.ensureFreshToken()
                                container.api.deviceLoginApprove(
                                    mapOf("id" to link.id, "code" to link.code),
                                )
                                context.toastMain("Appareil autorisé")
                            }.onFailure {
                                Toast.makeText(
                                    context,
                                    it.message ?: "Échec autorisation",
                                    Toast.LENGTH_LONG,
                                ).show()
                            }
                        }
                    }
                    is DeviceLoginDeepLink.Claim -> {
                        context.toastMain("Ce QR est une invite — scanne-le depuis l’écran de login")
                    }
                    null -> context.toastMain("QR non reconnu")
                }
            },
        )
        return
    }

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
    }

    // À chaque entrée / retour sur Compte : resync statut (sans tuer un DL en cours)
    LaunchedEffect(lifecycleOwner) {
        lifecycleOwner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            runCatching { updater.refreshAccountStatus() }
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
                .padding(padding)
                .padding(top = 4.dp),
            contentPadding = PaddingValues(bottom = 32.dp),
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
                val phase = updateUi.phase
                val busy = phase == ApkUpdateManager.Phase.Checking ||
                    phase == ApkUpdateManager.Phase.Downloading ||
                    phase == ApkUpdateManager.Phase.Installing
                val title = when (phase) {
                    ApkUpdateManager.Phase.Downloading ->
                        "Téléchargement… ${(updateUi.progress * 100).toInt()} %"
                    ApkUpdateManager.Phase.Installing ->
                        "Préparation installateur… ${(updateUi.progress * 100).toInt()} %"
                    ApkUpdateManager.Phase.AwaitingConfirm -> "Confirmer l’installation"
                    ApkUpdateManager.Phase.Available -> "Mettre à jour l’application"
                    ApkUpdateManager.Phase.UpToDate -> "Application à jour"
                    ApkUpdateManager.Phase.Error -> "Réessayer la mise à jour"
                    ApkUpdateManager.Phase.Done -> "Mise à jour installée"
                    ApkUpdateManager.Phase.Checking -> "Vérification…"
                    ApkUpdateManager.Phase.Idle ->
                        if (updateUi.available) "Mettre à jour l’application"
                        else "Mise à jour de l’app"
                }
                val subtitle = updateUi.message.ifBlank {
                    "Installée ${BuildConfig.VERSION_NAME}"
                }
                val highlight = updateUi.available ||
                    phase == ApkUpdateManager.Phase.Downloading ||
                    phase == ApkUpdateManager.Phase.Installing ||
                    phase == ApkUpdateManager.Phase.Checking ||
                    phase == ApkUpdateManager.Phase.AwaitingConfirm ||
                    phase == ApkUpdateManager.Phase.Error
                Column(Modifier.fillMaxWidth()) {
                    AccountRow(
                        icon = {
                            Icon(
                                Icons.Default.SystemUpdate,
                                contentDescription = null,
                                tint = if (highlight) accentRed else Color.Unspecified,
                            )
                        },
                        title = title,
                        subtitle = subtitle,
                        titleColor = if (highlight) accentRed else Color.Unspecified,
                        onClick = {
                            when (phase) {
                                ApkUpdateManager.Phase.AwaitingConfirm -> {
                                    val ok = updater.reopenConfirmInstall()
                                    context.toastMain(
                                        if (ok) {
                                            "Ouvre l’écran Confirmer l’installation"
                                        } else {
                                            "Écran système perdu — appuie long ici pour annuler"
                                        },
                                    )
                                    if (!ok) updater.dismissAwaitingConfirm(snooze = false)
                                }
                                ApkUpdateManager.Phase.Checking,
                                ApkUpdateManager.Phase.Downloading,
                                ApkUpdateManager.Phase.Installing,
                                -> {
                                    context.toastMain(subtitle.ifBlank { "Mise à jour en cours…" })
                                }
                                else -> {
                                    context.toastMain("Mise à jour… la barre avance sous le lecteur")
                                    updater.startManualUpdate()
                                }
                            }
                        },
                    )
                    if (busy || phase == ApkUpdateManager.Phase.AwaitingConfirm) {
                        val determinate = phase == ApkUpdateManager.Phase.Downloading ||
                            phase == ApkUpdateManager.Phase.Installing
                        if (determinate) {
                            LinearProgressIndicator(
                                progress = { updateUi.progress.coerceIn(0f, 1f) },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 16.dp, vertical = 4.dp),
                            )
                        } else {
                            LinearProgressIndicator(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(horizontal = 16.dp, vertical = 4.dp),
                            )
                        }
                        if (phase == ApkUpdateManager.Phase.AwaitingConfirm) {
                            TextButton(
                                onClick = {
                                    updater.dismissAwaitingConfirm(snooze = true)
                                    context.toastMain("Mise à jour reportée")
                                },
                                modifier = Modifier.padding(horizontal = 8.dp),
                            ) {
                                Text("Plus tard — masquer la confirmation")
                            }
                        }
                        if (phase == ApkUpdateManager.Phase.Error ||
                            phase == ApkUpdateManager.Phase.Available ||
                            (phase == ApkUpdateManager.Phase.Idle && updateUi.available)
                        ) {
                            TextButton(
                                onClick = {
                                    runCatching {
                                        context.startActivity(
                                            android.content.Intent(
                                                android.content.Intent.ACTION_VIEW,
                                                android.net.Uri.parse("https://plm.delhomme.ovh/install"),
                                            ),
                                        )
                                    }
                                },
                                modifier = Modifier.padding(horizontal = 8.dp),
                            ) {
                                Text("Installer via navigateur (1 fenêtre)")
                            }
                        }
                    }
                }
            }

            item {
                AccountRow(
                    icon = { Icon(Icons.AutoMirrored.Filled.HelpOutline, contentDescription = null) },
                    title = "Aide & limites",
                    subtitle = "Pourquoi un titre charge lentement, hors-ligne, versions…",
                    onClick = {
                        onOpenHelp?.invoke()
                            ?: context.toastMain("Ouvre Compte depuis Accueil")
                    },
                )
            }

            item {
                AccountRow(
                    icon = { Icon(Icons.Default.History, contentDescription = null) },
                    title = "Historique d'écoute",
                    subtitle = listenStats ?: "Titres écoutés récemment",
                    onClick = onOpenHistory,
                )
            }
            item {
                AccountRow(
                    icon = { Icon(Icons.Default.Download, contentDescription = null) },
                    title = "Téléchargements",
                    subtitle = downloadsSubtitle,
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
                Column(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                ) {
                    Text(
                        "Connecter un autre appareil",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        "Affiche un QR d’invite (à scanner sur l’écran login) ou scanne le QR du login de l’autre appareil.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp, bottom = 10.dp),
                    )
                    OutlinedButton(
                        onClick = {
                            scope.launch {
                                inviteBusy = true
                                runCatching {
                                    container.ensureFreshToken()
                                    val r = container.api.deviceLoginInvite()
                                    inviteClaimUrl = r.claimUrl
                                }.onFailure {
                                    Toast.makeText(
                                        context,
                                        it.message ?: "Échec invite",
                                        Toast.LENGTH_LONG,
                                    ).show()
                                }
                                inviteBusy = false
                            }
                        },
                        enabled = !inviteBusy,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(Icons.Default.QrCode, contentDescription = null)
                        Text(
                            if (inviteClaimUrl != null) "  Régénérer le QR d’invite"
                            else "  Afficher un QR d’invite",
                        )
                    }
                    inviteClaimUrl?.let { url ->
                        val bmp = remember(url) { DeviceLoginQr.bitmap(url, 512) }
                        Image(
                            bitmap = bmp.asImageBitmap(),
                            contentDescription = "QR invite",
                            modifier = Modifier
                                .padding(top = 12.dp)
                                .size(168.dp)
                                .align(Alignment.CenterHorizontally),
                        )
                        Text(
                            "Valable ~2 min — à scanner depuis l’écran de connexion de l’autre appareil.",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 8.dp),
                        )
                    }
                    Spacer(Modifier.height(8.dp))
                    Button(
                        onClick = { showQrScanner = true },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Icon(Icons.Default.QrCodeScanner, contentDescription = null)
                        Text("  Scanner le QR du login")
                    }
                }
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
                            runCatching { container.quickAccess.clear() }
                            runCatching { container.mixCache.clearAll() }
                            runCatching { container.homeCache.clear() }
                            runCatching { container.libraryCache.clear() }
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
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { showVersionNotes = true }
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                )
                Text(
                    "Appuyer pour les notes de version",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { showVersionNotes = true }
                        .padding(horizontal = 16.dp)
                        .padding(bottom = 16.dp),
                )
            }

        }
    }

    if (showEqualizer) {
        EqualizerSheet(onDismiss = { showEqualizer = false })
    }
    if (showVersionNotes) {
        VersionNotesSheet(container = container, onDismiss = { showVersionNotes = false })
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
