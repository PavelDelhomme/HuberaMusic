package ovh.delhomme.ytmusic.ui.debug

import android.content.Intent
import android.widget.Toast
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.BuildConfig
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.NetworkMonitor
import ovh.delhomme.ytmusic.debug.AppLog
import ovh.delhomme.ytmusic.debug.PerfSnapshot

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DebugLogsScreen(
    container: AppContainer,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var tab by remember { mutableStateOf(0) } // 0 crash, 1 log, 2 perf
    var content by remember { mutableStateOf("") }
    var apiUrl by remember { mutableStateOf(container.resolvedApiBase()) }
    var probeMsg by remember { mutableStateOf<String?>(null) }
    var probing by remember { mutableStateOf(false) }

    fun reload() {
        content = when (tab) {
            0 -> AppLog.lastCrashText()
            2 -> PerfSnapshot.capture(context)
            else -> AppLog.recentLogText()
        }
    }

    LaunchedEffect(tab) {
        reload()
        if (tab != 2) return@LaunchedEffect
        while (true) {
            kotlinx.coroutines.delay(5_000)
            content = PerfSnapshot.capture(context)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Réglages & logs") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Retour")
                    }
                },
                actions = {
                    IconButton(onClick = { reload() }) {
                        Icon(Icons.Default.Refresh, contentDescription = "Rafraîchir")
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 12.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            Text(
                "Build ${BuildConfig.VERSION_NAME}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                "Mode ${container.apiEnvLabel()} · ${container.resolvedApiBase()}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                "BuildConfig : ${BuildConfig.API_BASE_URL}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(10.dp))
            Text("URL API", fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
            Text(
                "Samsung = DEV (LAN). Bascule PROD via PUBLIC_API_URL (.env) sans rebuilder.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedTextField(
                value = apiUrl,
                onValueChange = { apiUrl = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                label = { Text("http://IP:8787 ou https://…") },
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    enabled = !probing && apiUrl.length > 8,
                    onClick = {
                        probing = true
                        probeMsg = null
                        scope.launch {
                            val r = container.probeApiHealth(apiUrl.trim().trimEnd('/'))
                            probeMsg = r.fold(
                                onSuccess = { "OK — $it" },
                                onFailure = { "Échec : ${it.message}" },
                            )
                            probing = false
                        }
                    },
                ) { Text(if (probing) "Test…" else "Tester") }
                Button(
                    enabled = apiUrl.length > 8,
                    onClick = {
                        var u = apiUrl.trim().trimEnd('/')
                        if (!u.startsWith("http")) u = "http://$u"
                        val prevKind = container.apiEnvKind()
                        container.setApiBaseOverride(u)
                        apiUrl = u
                        val nextKind = container.apiEnvKind(u)
                        if (prevKind != nextKind) {
                            scope.launch { container.tokenStore.clear() }
                            Toast.makeText(
                                context,
                                "API $nextKind — reconnecte-toi (JWT différent)",
                                Toast.LENGTH_LONG,
                            ).show()
                        } else {
                            Toast.makeText(context, "API → $u", Toast.LENGTH_SHORT).show()
                        }
                        AppLog.breadcrumb("api-url", u)
                    },
                ) { Text("Enregistrer") }
                OutlinedButton(
                    onClick = {
                        container.setApiBaseOverride(null)
                        apiUrl = BuildConfig.API_BASE_URL.trimEnd('/')
                        Toast.makeText(context, "Reset BuildConfig", Toast.LENGTH_SHORT).show()
                    },
                ) { Text("Reset") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        val u = BuildConfig.API_BASE_URL.trimEnd('/')
                        val prevKind = container.apiEnvKind()
                        container.setApiBaseOverride(null)
                        apiUrl = u
                        if (prevKind != "dev") {
                            scope.launch { container.tokenStore.clear() }
                            Toast.makeText(context, "Mode DEV (build) — reconnecte-toi", Toast.LENGTH_LONG).show()
                        } else {
                            Toast.makeText(context, "Mode DEV · $u", Toast.LENGTH_SHORT).show()
                        }
                    },
                ) { Text("DEV LAN") }
                Button(
                    onClick = {
                        val u = BuildConfig.PUBLIC_API_URL.trimEnd('/').ifBlank {
                            Toast.makeText(context, "PUBLIC_API_URL manquant (.env)", Toast.LENGTH_LONG).show()
                            return@Button
                        }
                        val prevKind = container.apiEnvKind()
                        container.setApiBaseOverride(u)
                        apiUrl = u
                        if (prevKind != "prod") {
                            scope.launch { container.tokenStore.clear() }
                            Toast.makeText(context, "Mode PROD — reconnecte-toi", Toast.LENGTH_LONG).show()
                        } else {
                            Toast.makeText(context, "Mode PROD", Toast.LENGTH_SHORT).show()
                        }
                    },
                ) { Text("PROD") }
            }
            probeMsg?.let {
                Text(
                    it,
                    color = if (it.startsWith("OK")) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.error
                    },
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            Spacer(Modifier.height(12.dp))
            var forceOffline by remember { mutableStateOf(NetworkMonitor.isForceOffline()) }
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f).padding(end = 12.dp)) {
                    Text("Simuler hors-ligne", fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
                    Text(
                        "Préfetch stoppé, UI hors-ligne — Wi‑Fi ADB intact",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(
                    checked = forceOffline,
                    onCheckedChange = {
                        forceOffline = it
                        NetworkMonitor.setForceOffline(it)
                        Toast.makeText(
                            context,
                            if (it) "Hors-ligne simulé" else "Réseau normal",
                            Toast.LENGTH_SHORT,
                        ).show()
                    },
                )
            }

            Spacer(Modifier.height(12.dp))
            Text(
                "Récupération PC : make android-logs · make battery-report-mail",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            OutlinedButton(
                onClick = {
                    scope.launch {
                        runCatching {
                            val bm = context.getSystemService(android.content.Context.BATTERY_SERVICE) as android.os.BatteryManager
                            val level = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
                            val chargeCounter = bm.getLongProperty(android.os.BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER)
                            val body = mapOf(
                                "device" to mapOf(
                                    "model" to android.os.Build.MODEL,
                                    "serial" to android.os.Build.MODEL,
                                    "android" to android.os.Build.VERSION.RELEASE,
                                    "name" to (android.provider.Settings.Global.getString(context.contentResolver, "device_name") ?: android.os.Build.MODEL),
                                    "transport" to "app",
                                ),
                                "app" to mapOf(
                                    "versionName" to BuildConfig.VERSION_NAME,
                                    "package" to context.packageName,
                                    "apiBase" to BuildConfig.API_BASE_URL,
                                ),
                                "session" to mapOf(
                                    "stamp" to java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US).format(java.util.Date()),
                                    "durationSec" to 0,
                                    "unplugged" to true,
                                ),
                                "stats" to mapOf(
                                    "levelStart" to level,
                                    "levelEnd" to level,
                                    "levelDelta" to 0,
                                    "chargeCounterStart" to chargeCounter,
                                    "chargeCounterEnd" to chargeCounter,
                                ),
                                "notes" to "Snapshot manuel Debug → email BATTERY_REPORT_TO / SEED_EMAIL",
                                "samples" to mapOf(
                                    "exportBundle" to AppLog.exportBundle().take(10_000),
                                ),
                            )
                            container.api.batteryReport(body)
                            Toast.makeText(context, "Rapport batterie envoyé par email", Toast.LENGTH_LONG).show()
                        }.onFailure {
                            Toast.makeText(context, it.message ?: "Échec envoi", Toast.LENGTH_LONG).show()
                        }
                    }
                },
            ) { Text("Email rapport batterie") }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (tab == 0) Button(onClick = { tab = 0 }) { Text("Crash") }
                else OutlinedButton(onClick = { tab = 0 }) { Text("Crash") }
                if (tab == 1) Button(onClick = { tab = 1 }) { Text("Journal") }
                else OutlinedButton(onClick = { tab = 1 }) { Text("Journal") }
                if (tab == 2) Button(onClick = { tab = 2 }) { Text("Perf") }
                else OutlinedButton(onClick = { tab = 2 }) { Text("Perf") }
            }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = {
                        clipboard.setText(AnnotatedString(AppLog.exportBundle()))
                        Toast.makeText(context, "Export copié", Toast.LENGTH_SHORT).show()
                    },
                ) {
                    Icon(Icons.Default.ContentCopy, contentDescription = null)
                    Spacer(Modifier.padding(4.dp))
                    Text("Copier")
                }
                OutlinedButton(
                    onClick = {
                        val send = Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_SUBJECT, "PLM debug logs")
                            putExtra(Intent.EXTRA_TEXT, AppLog.exportBundle())
                        }
                        context.startActivity(Intent.createChooser(send, "Partager les logs"))
                    },
                ) {
                    Icon(Icons.Default.Share, contentDescription = null)
                    Spacer(Modifier.padding(4.dp))
                    Text("Partager")
                }
                OutlinedButton(
                    onClick = {
                        AppLog.clearLogs()
                        reload()
                        Toast.makeText(context, "Logs effacés", Toast.LENGTH_SHORT).show()
                    },
                ) {
                    Icon(Icons.Default.Delete, contentDescription = null)
                    Spacer(Modifier.padding(4.dp))
                    Text("Effacer")
                }
            }
            Spacer(Modifier.height(8.dp))
            Text(
                content.ifBlank { "(vide)" },
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 420.dp),
                fontFamily = FontFamily.Monospace,
                fontSize = 11.sp,
                lineHeight = 14.sp,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}
