package ovh.delhomme.ytmusic.ui.importytm

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.YtmAccountDto
import ovh.delhomme.ytmusic.data.YtmCookieBody
import ovh.delhomme.ytmusic.debug.AppLog
import java.text.DateFormat
import java.util.Date

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun YtmImportScreen(
    container: AppContainer,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var account by remember { mutableStateOf<YtmAccountDto?>(null) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var oauthCode by remember { mutableStateOf<String?>(null) }
    var oauthUrl by remember { mutableStateOf<String?>(null) }
    var cookie by remember { mutableStateOf("") }
    var showOauth by remember { mutableStateOf(false) }

    fun refresh() {
        scope.launch {
            runCatching {
                container.ensureFreshToken()
                container.api.ytmStatus().account
            }.onSuccess { account = it }
                .onFailure { AppLog.e("ytm", "status", it) }
        }
    }

    LaunchedEffect(Unit) { refresh() }

    LaunchedEffect(oauthCode) {
        if (oauthCode.isNullOrBlank()) return@LaunchedEffect
        while (isActive && !oauthCode.isNullOrBlank()) {
            delay(2500)
            val s = runCatching { container.api.ytmOauthStatus() }.getOrNull() ?: continue
            when (s.status) {
                "connected" -> {
                    oauthCode = null
                    oauthUrl = null
                    message =
                        "OAuth OK — la biblio YTM exige des cookies. Colle-les ci-dessous pour synchroniser."
                    refresh()
                    break
                }
                "error" -> {
                    error = s.error ?: "OAuth échoué"
                    oauthCode = null
                    break
                }
            }
        }
    }

    fun saveCookiesAndSync() {
        busy = true
        error = null
        message = null
        scope.launch {
            runCatching {
                container.api.ytmConnectCookie(YtmCookieBody(cookie))
                container.api.ytmSync()
            }.onSuccess { r ->
                account = r.account
                cookie = ""
                message =
                    "Sync OK — ${r.stats.songs} likes, ${r.stats.librarySongs} titres, " +
                        "${r.stats.albums} albums, ${r.stats.artists} artistes, " +
                        "${r.stats.playlists} playlists" +
                        if (r.stats.history > 0) ", ${r.stats.history} récents" else ""
                AppLog.breadcrumb("ytm-sync", message ?: "")
            }.onFailure {
                error = it.message
                AppLog.e("ytm", "sync", it)
            }
            busy = false
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("YouTube Music") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Retour")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "Écouter PLM n’exige pas les cookies YouTube. Les cookies ne servent qu’à importer ta bibliothèque YouTube Music (likes, playlists). La lecture audio passe par le relais VPS / OAuth TV — pas de Premium. Si le collage cookies a échoué sur ce téléphone, connecte-toi simplement : tu peux déjà jouer.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            account?.hint?.let {
                Text(it, color = MaterialTheme.colorScheme.tertiary)
            }

            val acc = account
            val canSync = acc?.canSyncLibrary == true

            if (canSync) {
                Text(
                    buildString {
                        append("Cookies OK — prêt à synchroniser")
                        acc?.lastSyncAt?.let {
                            append(" · dernière sync ")
                            append(DateFormat.getDateTimeInstance().format(Date(it)))
                        }
                    },
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.SemiBold,
                )
                acc?.lastSyncSummary?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        enabled = !busy,
                        onClick = {
                            busy = true
                            error = null
                            message = null
                            scope.launch {
                                runCatching { container.api.ytmSync() }
                                    .onSuccess { r ->
                                        account = r.account
                                        message =
                                            "Sync OK — ${r.stats.songs} likes, ${r.stats.librarySongs} titres, " +
                                                "${r.stats.albums} albums, ${r.stats.artists} artistes"
                                    }
                                    .onFailure { error = it.message }
                                busy = false
                            }
                        },
                    ) {
                        Icon(Icons.Default.Sync, contentDescription = null)
                        Spacer(Modifier.padding(4.dp))
                        Text(if (busy) "Sync…" else "Synchroniser")
                    }
                    OutlinedButton(
                        enabled = !busy,
                        onClick = {
                            scope.launch {
                                runCatching { container.api.ytmDisconnect() }
                                    .onSuccess {
                                        account = it.account
                                        message = "Compte YTM déconnecté"
                                    }
                                    .onFailure { error = it.message }
                            }
                        },
                    ) {
                        Text("Déconnecter")
                    }
                }
                Text(
                    "Renouveler les cookies si la sync échoue :",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = cookie,
                    onValueChange = { cookie = it },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2,
                    label = { Text("Cookie") },
                )
                Button(
                    enabled = !busy && cookie.length >= 20,
                    onClick = { saveCookiesAndSync() },
                ) {
                    Text("Mettre à jour & synchroniser")
                }
            } else {
                if (acc?.connected == true) {
                    Text(
                        "Compte partiellement lié (OAuth) — ajoute les cookies pour importer la biblio.",
                        color = MaterialTheme.colorScheme.tertiary,
                    )
                }

                Text("1. Coller les cookies (requis)", fontWeight = FontWeight.SemiBold)
                Text(
                    "Sur un PC : music.youtube.com connecté → F12 → Réseau → requête browse → En-tête Cookie → copie toute la valeur (SAPISID / __Secure-1PSID…).",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(
                    onClick = {
                        context.startActivity(
                            Intent(Intent.ACTION_VIEW, Uri.parse("https://music.youtube.com")),
                        )
                    },
                ) {
                    Text("Ouvrir music.youtube.com")
                }
                OutlinedTextField(
                    value = cookie,
                    onValueChange = { cookie = it },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 4,
                    label = { Text("Cookie") },
                    placeholder = { Text("SID=…; …; SAPISID=…") },
                )
                Button(
                    enabled = !busy && cookie.length >= 20,
                    onClick = { saveCookiesAndSync() },
                ) {
                    Text("Enregistrer & synchroniser")
                }

                TextButton(onClick = { showOauth = !showOauth }) {
                    Text(
                        if (showOauth) {
                            "Masquer code appareil"
                        } else {
                            "Optionnel : code appareil (ne suffit pas pour la biblio)"
                        },
                    )
                }
                if (showOauth) {
                    Button(
                        enabled = !busy,
                        onClick = {
                            busy = true
                            error = null
                            scope.launch {
                                runCatching { container.api.ytmConnectOauth() }
                                    .onSuccess { r ->
                                        oauthCode = r.userCode
                                        oauthUrl = r.verificationUrl
                                        message = "Ouvre le lien Google, entre le code, puis colle les cookies."
                                    }
                                    .onFailure { error = it.message }
                                busy = false
                            }
                        },
                    ) {
                        Icon(Icons.Default.Link, contentDescription = null)
                        Spacer(Modifier.padding(4.dp))
                        Text("Lier via Google (code appareil)")
                    }
                    oauthCode?.let { code ->
                        val url = oauthUrl ?: "https://www.google.com/device"
                        Text("Code :", style = MaterialTheme.typography.labelMedium)
                        Text(
                            code,
                            style = MaterialTheme.typography.headlineSmall,
                            fontFamily = FontFamily.Monospace,
                            fontWeight = FontWeight.Bold,
                        )
                        TextButton(
                            onClick = {
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                            },
                        ) {
                            Text("Ouvrir $url")
                        }
                    }
                }

                if (acc?.connected == true) {
                    OutlinedButton(
                        enabled = !busy,
                        onClick = {
                            scope.launch {
                                runCatching { container.api.ytmDisconnect() }
                                    .onSuccess {
                                        account = it.account
                                        message = "Compte YTM déconnecté"
                                    }
                                    .onFailure { error = it.message }
                            }
                        },
                    ) {
                        Text("Déconnecter")
                    }
                }
            }

            if (busy) {
                CircularProgressIndicator(Modifier.padding(8.dp))
            }
            message?.let {
                Text(it, color = MaterialTheme.colorScheme.primary)
            }
            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error)
            }
            Spacer(Modifier.height(24.dp))
            OutlinedButton(onClick = { refresh() }) {
                Icon(Icons.Default.Refresh, contentDescription = null)
                Spacer(Modifier.padding(4.dp))
                Text("Rafraîchir le statut")
            }
            Spacer(Modifier.height(32.dp))
        }
    }
}
