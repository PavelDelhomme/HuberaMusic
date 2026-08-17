package ovh.delhomme.ytmusic.ui.importytm

import android.widget.Toast
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
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
    var showLogin by remember { mutableStateOf(false) }
    var showPaste by remember { mutableStateOf(false) }
    var cookie by remember { mutableStateOf("") }

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

    fun applyCookieAndSync(raw: String, fromWebView: Boolean) {
        busy = true
        error = null
        message = null
        scope.launch {
            runCatching {
                container.ensureFreshToken()
                container.api.ytmConnectCookie(YtmCookieBody(raw))
                container.api.ytmSync()
            }.onSuccess { r ->
                account = r.account
                cookie = ""
                showLogin = false
                message =
                    "Google lié — ${r.stats.songs} likes, ${r.stats.librarySongs} titres, " +
                        "${r.stats.albums} albums, ${r.stats.artists} artistes, " +
                        "${r.stats.playlists} playlists" +
                        if (r.stats.history > 0) ", ${r.stats.history} récents" else ""
                AppLog.breadcrumb("ytm-sync", message ?: "")
                Toast.makeText(context, "Compte Google connecté", Toast.LENGTH_SHORT).show()
            }.onFailure {
                error = it.message
                AppLog.e("ytm", "sync", it)
                if (fromWebView) {
                    showLogin = false
                }
            }
            busy = false
        }
    }

    if (showLogin) {
        YtmGoogleLoginWebView(
            onCaptured = { applyCookieAndSync(it, fromWebView = true) },
            onCancel = { showLogin = false },
        )
        return
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Compte Google") },
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
                "Un bouton : tu te connectes à Google dans l’app, PLM récupère tout seul " +
                    "likes, playlists et albums. Compte Google gratuit — YouTube Premium n’est pas requis.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            val acc = account
            val canSync = acc?.canSyncLibrary == true

            if (canSync) {
                Text(
                    buildString {
                        append("Google connecté")
                        acc?.lastSyncAt?.let {
                            append(" · ")
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
                                        message = "Compte Google déconnecté"
                                    }
                                    .onFailure { error = it.message }
                            }
                        },
                    ) {
                        Text("Déconnecter")
                    }
                }
                OutlinedButton(
                    enabled = !busy,
                    onClick = {
                        YtmCookieCapture.clearSession()
                        showLogin = true
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Reconnecter Google")
                }
            } else {
                if (acc?.connected == true) {
                    Text(
                        "Liaison incomplète — reconnecte Google (un tap, sans collage).",
                        color = MaterialTheme.colorScheme.tertiary,
                    )
                }
                Button(
                    enabled = !busy,
                    onClick = {
                        error = null
                        YtmCookieCapture.clearSession()
                        showLogin = true
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Connecter Google")
                }
                Text(
                    "Tu valides le compte dans la page Google. Dès que YouTube Music s’ouvre, " +
                        "la bibliothèque se synchronise toute seule.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (acc?.connected == true) {
                    OutlinedButton(
                        enabled = !busy,
                        onClick = {
                            scope.launch {
                                runCatching { container.api.ytmDisconnect() }
                                    .onSuccess {
                                        account = it.account
                                        message = "Compte Google déconnecté"
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

            TextButton(onClick = { showPaste = !showPaste }) {
                Text(if (showPaste) "Masquer le collage manuel" else "Dépannage : coller les cookies (PC)")
            }
            if (showPaste) {
                Text(
                    "Uniquement si la page Google refuse l’app. Sur un PC : music.youtube.com → F12 → Cookie.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = cookie,
                    onValueChange = { cookie = it },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 3,
                    label = { Text("Cookie") },
                )
                Button(
                    enabled = !busy && cookie.length >= 20,
                    onClick = { applyCookieAndSync(cookie, fromWebView = false) },
                ) {
                    Text("Enregistrer & synchroniser")
                }
            }

            OutlinedButton(onClick = { refresh() }) {
                Icon(Icons.Default.Refresh, contentDescription = null)
                Spacer(Modifier.padding(4.dp))
                Text("Rafraîchir le statut")
            }
            Spacer(Modifier.height(32.dp))
        }
    }
}
