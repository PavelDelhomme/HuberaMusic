package ovh.delhomme.ytmusic.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import ovh.delhomme.ytmusic.BuildConfig
import ovh.delhomme.ytmusic.data.AppContainer
import java.util.concurrent.TimeUnit

data class VersionNoteEntry(
    val version: String,
    val date: String,
    val title: String,
    val notes: List<String>,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VersionNotesSheet(
    container: AppContainer,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    var entries by remember { mutableStateOf<List<VersionNoteEntry>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    LaunchedEffect(Unit) {
        entries = withContext(Dispatchers.IO) {
            loadVersionNotes(container.resolvedApiBase(), context)
        }
        loading = false
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 28.dp)) {
            Text(
                "Notes de version",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
            )
            Text(
                "Build ${BuildConfig.APP_VERSION_LABEL}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp, bottom = 16.dp),
            )
            if (loading) {
                Text("Chargement…", color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else if (entries.isEmpty()) {
                Text(
                    "Aucune note disponible pour le moment.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                LazyColumn(
                    contentPadding = PaddingValues(bottom = 24.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    items(entries, key = { it.version }) { entry ->
                        VersionNoteCard(entry)
                    }
                }
            }
        }
    }
}

@Composable
private fun VersionNoteCard(entry: VersionNoteEntry) {
    Column(Modifier.fillMaxWidth()) {
        Text(
            "v${entry.version}",
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.primary,
        )
        if (entry.title.isNotBlank()) {
            Text(
                entry.title,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        if (entry.date.isNotBlank()) {
            Text(
                entry.date,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 2.dp, bottom = 6.dp),
            )
        }
        entry.notes.forEach { note ->
            Text(
                "· $note",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(vertical = 2.dp),
            )
        }
        Spacer(Modifier.height(8.dp))
        HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f))
    }
}

private fun loadVersionNotes(apiBase: String, context: android.content.Context): List<VersionNoteEntry> {
    // 1) API prod/local
    if (apiBase.isNotBlank()) {
        runCatching {
            val client = OkHttpClient.Builder()
                .connectTimeout(6, TimeUnit.SECONDS)
                .readTimeout(8, TimeUnit.SECONDS)
                .build()
            val url = apiBase.trimEnd('/') + "/api/version-notes"
            val req = Request.Builder().url(url).get().build()
            client.newCall(req).execute().use { resp ->
                if (resp.isSuccessful) {
                    val body = resp.body?.string().orEmpty()
                    parseVersionNotes(body)?.let { return it }
                }
            }
        }
    }
    // 2) Asset bundlé
    return runCatching {
        context.assets.open("version-notes.json").bufferedReader().use { it.readText() }
            .let { parseVersionNotes(it).orEmpty() }
    }.getOrDefault(emptyList())
}

private fun parseVersionNotes(raw: String): List<VersionNoteEntry>? {
    if (raw.isBlank()) return null
    val root = JSONObject(raw)
    val arr = root.optJSONArray("versions") ?: return null
    val out = ArrayList<VersionNoteEntry>(arr.length())
    for (i in 0 until arr.length()) {
        val o = arr.optJSONObject(i) ?: continue
        val notesArr = o.optJSONArray("notes")
        val notes = buildList {
            if (notesArr != null) {
                for (j in 0 until notesArr.length()) {
                    notesArr.optString(j)?.takeIf { it.isNotBlank() }?.let { add(it) }
                }
            }
        }
        out.add(
            VersionNoteEntry(
                version = o.optString("version"),
                date = o.optString("date"),
                title = o.optString("title"),
                notes = notes,
            ),
        )
    }
    return out
}
