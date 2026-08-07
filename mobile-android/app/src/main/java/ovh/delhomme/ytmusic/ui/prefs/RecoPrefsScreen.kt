package ovh.delhomme.ytmusic.ui.prefs

import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.FollowArtistBody
import ovh.delhomme.ytmusic.data.OnboardingBody
import ovh.delhomme.ytmusic.data.SavePrefsBody
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.ui.components.MediaCover

val RECO_GENRES = listOf(
    "Pop", "Rock", "Hip-Hop", "R&B", "Électro", "Jazz", "Classique", "Metal",
    "Indie", "Latin", "Afrobeats", "K-Pop", "Country", "Soul", "Lo-Fi", "Rap FR",
)

val RECO_MOODS = listOf(
    "Énergie", "Chill", "Focus", "Fête", "Mélancolie", "Motivation", "Romantique", "Nostalgie",
)

val RECO_MOMENTS = listOf(
    "morning" to "Matin",
    "afternoon" to "Après-midi",
    "evening" to "Soir",
    "night" to "Nuit",
    "weekday" to "Semaine",
    "weekend" to "Week-end",
)

data class FollowedArtistUi(
    val id: String,
    val name: String,
    val thumbnails: List<ovh.delhomme.ytmusic.data.Thumb>? = null,
)

/**
 * Affiner / configurer le système de recommandations.
 * @param forceOnboarding true = premier passage (min. requis + POST onboarding)
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun RecoPrefsScreen(
    container: AppContainer,
    forceOnboarding: Boolean,
    onDone: () -> Unit,
    onBack: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var loading by remember { mutableStateOf(true) }
    var saving by remember { mutableStateOf(false) }
    var genres by remember { mutableStateOf(setOf<String>()) }
    var moods by remember { mutableStateOf(setOf<String>()) }
    var moments by remember { mutableStateOf(setOf<String>()) }
    var bias by remember { mutableFloatStateOf(0.15f) }
    var artists by remember { mutableStateOf<List<FollowedArtistUi>>(emptyList()) }
    var artistQ by remember { mutableStateOf("") }
    var artistHits by remember { mutableStateOf<List<TrackDto>>(emptyList()) }
    var searchJob by remember { mutableStateOf<Job?>(null) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        loading = true
        runCatching {
            container.ensureFreshToken()
            container.api.prefs()
        }.onSuccess { res ->
            genres = res.prefs.genres.toSet()
            moods = res.prefs.moods.toSet()
            moments = res.prefs.moments.toSet()
            bias = res.prefs.discoveryBias.toFloat().coerceIn(0f, 0.5f)
            artists = res.follows.mapNotNull { f ->
                val id = f.artistId()
                if (id.isBlank()) null
                else FollowedArtistUi(id, f.artistName())
            }
            loading = false
        }.onFailure {
            error = it.message
            loading = false
        }
    }

    fun toggle(set: Set<String>, v: String): Set<String> =
        if (v in set) set - v else set + v

    fun searchArtists(q: String) {
        artistQ = q
        searchJob?.cancel()
        if (q.trim().length < 2) {
            artistHits = emptyList()
            return
        }
        searchJob = scope.launch {
            delay(280)
            runCatching { container.api.search(q.trim(), "artist") }
                .onSuccess { artistHits = it.artists.take(10) }
                .onFailure { artistHits = emptyList() }
        }
    }

    val canSave = genres.size >= 3 && moods.size >= 2 && moments.isNotEmpty() &&
        (!forceOnboarding || artists.isNotEmpty())

    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (onBack != null && !forceOnboarding) {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Retour")
                }
            } else {
                Spacer(Modifier.width(12.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(
                    if (forceOnboarding) "Personnalise tes recommandations" else "Affiner mes recommandations",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                )
                Text(
                    "Genres, ambiances, moments, découverte et artistes suivis",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        when {
            loading -> {
                Column(
                    Modifier.fillMaxSize(),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) { CircularProgressIndicator() }
            }
            else -> {
                LazyColumn(
                    contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 32.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                    modifier = Modifier.weight(1f),
                ) {
                    item {
                        SectionLabel("Genres · au moins 3")
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                            modifier = Modifier.padding(bottom = 12.dp),
                        ) {
                            RECO_GENRES.forEach { g ->
                                PrefChip(g, g in genres) { genres = toggle(genres, g) }
                            }
                        }
                    }
                    item {
                        SectionLabel("Ambiances · au moins 2")
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                            modifier = Modifier.padding(bottom = 12.dp),
                        ) {
                            RECO_MOODS.forEach { m ->
                                PrefChip(m, m in moods) { moods = toggle(moods, m) }
                            }
                        }
                    }
                    item {
                        SectionLabel("Quand tu écoutes · au moins 1")
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                            modifier = Modifier.padding(bottom = 12.dp),
                        ) {
                            RECO_MOMENTS.forEach { (id, label) ->
                                PrefChip(label, id in moments) { moments = toggle(moments, id) }
                            }
                        }
                    }
                    item {
                        SectionLabel("Familiarité ↔ Découverte")
                        Text(
                            "Plus à droite = plus de nouveautés dans l’accueil et la radio",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Slider(
                            value = bias,
                            onValueChange = { bias = it },
                            valueRange = 0f..0.45f,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Text(
                            "Biais : ${"%.0f".format(bias * 100)} %",
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(bottom = 12.dp),
                        )
                    }
                    item {
                        SectionLabel(
                            if (forceOnboarding) "Artistes à suivre · au moins 1"
                            else "Artistes suivis",
                        )
                        OutlinedTextField(
                            value = artistQ,
                            onValueChange = ::searchArtists,
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            placeholder = { Text("Chercher un artiste…") },
                        )
                        Spacer(Modifier.height(8.dp))
                        if (artists.isNotEmpty()) {
                            FlowRow(
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                                modifier = Modifier.padding(bottom = 8.dp),
                            ) {
                                artists.forEach { a ->
                                    Row(
                                        Modifier
                                            .clip(RoundedCornerShape(50))
                                            .background(MaterialTheme.colorScheme.primary)
                                            .clickable {
                                                artists = artists.filter { it.id != a.id }
                                                if (!forceOnboarding) {
                                                    scope.launch {
                                                        runCatching {
                                                            container.api.unfollowArtist(a.id)
                                                        }
                                                    }
                                                }
                                            }
                                            .padding(horizontal = 10.dp, vertical = 6.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Text(a.name, color = MaterialTheme.colorScheme.onPrimary)
                                        Spacer(Modifier.width(4.dp))
                                        Icon(
                                            Icons.Default.Close,
                                            null,
                                            tint = MaterialTheme.colorScheme.onPrimary,
                                            modifier = Modifier.size(16.dp),
                                        )
                                    }
                                }
                            }
                        }
                    }
                    itemsIndexed(
                        artistHits,
                        key = { index, hit -> "${hit.id}-$index" },
                    ) { _, hit ->
                        val selected = artists.any { it.id == hit.id }
                        Row(
                            Modifier
                                .fillMaxWidth()
                                .clickable {
                                    if (selected) {
                                        artists = artists.filter { it.id != hit.id }
                                        if (!forceOnboarding) {
                                            scope.launch {
                                                runCatching { container.api.unfollowArtist(hit.id) }
                                            }
                                        }
                                    } else {
                                        artists = artists + FollowedArtistUi(
                                            hit.id,
                                            hit.title,
                                            hit.thumbnails,
                                        )
                                        if (!forceOnboarding) {
                                            scope.launch {
                                                runCatching {
                                                    container.api.followArtist(
                                                        hit.id,
                                                        FollowArtistBody(hit.id, hit.title),
                                                    )
                                                }
                                            }
                                        }
                                    }
                                }
                                .padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            MediaCover(hit.copy(type = "artist"), 44.dp, circle = true)
                            Spacer(Modifier.width(12.dp))
                            Text(
                                hit.title,
                                modifier = Modifier.weight(1f),
                                fontWeight = FontWeight.Medium,
                            )
                            Text(
                                if (selected) "Suivi" else "Suivre",
                                color = if (selected) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.labelLarge,
                            )
                        }
                    }
                    item {
                        error?.let {
                            Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 8.dp))
                        }
                        Spacer(Modifier.height(12.dp))
                        Button(
                            onClick = {
                                if (!canSave) {
                                    Toast.makeText(
                                        context,
                                        "Complète genres (≥3), ambiances (≥2), moments (≥1)" +
                                            if (forceOnboarding) " et 1 artiste" else "",
                                        Toast.LENGTH_SHORT,
                                    ).show()
                                    return@Button
                                }
                                saving = true
                                error = null
                                scope.launch {
                                    runCatching {
                                        if (forceOnboarding) {
                                            container.api.onboarding(
                                                OnboardingBody(
                                                    genres = genres.toList(),
                                                    moods = moods.toList(),
                                                    moments = moments.toList(),
                                                    discoveryBias = bias.toDouble(),
                                                    artists = artists.map {
                                                        FollowArtistBody(it.id, it.name)
                                                    },
                                                ),
                                            )
                                        } else {
                                            container.api.savePrefs(
                                                SavePrefsBody(
                                                    genres = genres.toList(),
                                                    moods = moods.toList(),
                                                    moments = moments.toList(),
                                                    discoveryBias = bias.toDouble(),
                                                    onboardingDone = true,
                                                ),
                                            )
                                            // sync follows added during session that weren't API-called yet is already done live
                                        }
                                    }.onSuccess {
                                        Toast.makeText(
                                            context,
                                            "Recommandations mises à jour",
                                            Toast.LENGTH_SHORT,
                                        ).show()
                                        onDone()
                                    }.onFailure {
                                        error = it.message ?: "Erreur"
                                    }
                                    saving = false
                                }
                            },
                            enabled = !saving,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            if (saving) CircularProgressIndicator(
                                Modifier.size(20.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onPrimary,
                            )
                            else Text(if (forceOnboarding) "C’est parti" else "Enregistrer")
                        }
                        if (!forceOnboarding) {
                            TextButton(onClick = onDone, modifier = Modifier.fillMaxWidth()) {
                                Text("Annuler")
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(top = 12.dp, bottom = 8.dp),
    )
}

@Composable
private fun PrefChip(label: String, active: Boolean, onClick: () -> Unit) {
    Text(
        label,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(
                if (active) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.surfaceVariant,
            )
            .border(
                width = if (active) 0.dp else 1.dp,
                color = MaterialTheme.colorScheme.outline.copy(alpha = 0.35f),
                shape = RoundedCornerShape(50),
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        color = if (active) MaterialTheme.colorScheme.onPrimary
        else MaterialTheme.colorScheme.onSurface,
        style = MaterialTheme.typography.bodyMedium,
    )
}
