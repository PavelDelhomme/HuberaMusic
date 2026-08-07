package ovh.delhomme.ytmusic.ui.search

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Spacer
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import android.widget.Toast
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.ui.components.TrackRow

data class SearchSection(val title: String, val items: List<TrackDto>)

data class SearchUiState(
    val query: String = "",
    val filter: String = "all",
    val loading: Boolean = false,
    val error: String? = null,
    val sections: List<SearchSection> = emptyList(),
    val recent: List<String> = emptyList(),
    /** Suggestions API tant que l’utilisateur tape (vide = mode historique). */
    val suggestions: List<String> = emptyList(),
)

private val FILTERS = listOf(
    "all" to "Tout",
    "song" to "Titres",
    "artist" to "Artistes",
    "album" to "Albums",
    "playlist" to "Playlists",
    "video" to "Vidéos",
)

class SearchViewModel(private val container: AppContainer) : ViewModel() {
    private val _state = MutableStateFlow(SearchUiState())
    val state: StateFlow<SearchUiState> = _state.asStateFlow()
    private var job: Job? = null
    private var sugJob: Job? = null
    private val recentPrefs by lazy {
        container.sharedPrefs("ytm_search_recent")
    }

    init {
        // Cache local immédiat, puis sync serveur
        readLocalRecent()?.let { local ->
            if (local.isNotEmpty()) _state.value = _state.value.copy(recent = local)
        }
        loadRecent()
    }

    private fun readLocalRecent(): List<String>? {
        val raw = recentPrefs.getString("queries", null)?.takeIf { it.isNotBlank() } ?: return null
        return runCatching {
            raw.split('\n').map { it.trim() }.filter { it.isNotEmpty() }.distinct().take(12)
        }.getOrNull()
    }

    private fun writeLocalRecent(queries: List<String>) {
        recentPrefs.edit()
            .putString("queries", queries.take(12).joinToString("\n"))
            .apply()
    }

    fun loadRecent() {
        viewModelScope.launch {
            val recent = runCatching {
                container.ensureFreshToken()
                val raw = container.api.searchHistory()["history"]
                val list = raw as? List<*> ?: emptyList<Any>()
                val seen = LinkedHashSet<String>()
                val out = ArrayList<String>()
                for (item in list) {
                    val q = when (item) {
                        is Map<*, *> -> item["query"]?.toString()?.trim().orEmpty()
                        else -> ""
                    }
                    if (q.isBlank()) continue
                    val key = q.lowercase()
                    if (!seen.add(key)) continue
                    out += q
                    if (out.size >= 12) break
                }
                out
            }.getOrDefault(_state.value.recent)
            if (recent.isNotEmpty()) writeLocalRecent(recent)
            _state.value = _state.value.copy(recent = recent)
        }
    }

    fun onQuery(q: String) {
        _state.value = _state.value.copy(query = q, error = null)
        scheduleSuggestions()
        scheduleSearch()
    }

    fun clearQuery() {
        job?.cancel()
        sugJob?.cancel()
        _state.value = _state.value.copy(
            query = "",
            sections = emptyList(),
            suggestions = emptyList(),
            error = null,
            loading = false,
        )
    }

    fun onFilter(filter: String) {
        if (_state.value.filter == filter) return
        _state.value = _state.value.copy(filter = filter)
        scheduleSearch()
    }

    /** Recherche confirmée (tap historique / suggestion / soumission) → enregistre l’historique serveur. */
    fun commitSearch(q: String) {
        val query = q.trim()
        if (query.length < 2) return
        val nextRecent = listOf(query) + _state.value.recent.filter {
            !it.equals(query, ignoreCase = true)
        }
        writeLocalRecent(nextRecent)
        _state.value = _state.value.copy(
            query = query,
            error = null,
            recent = nextRecent.take(12),
            suggestions = emptyList(),
        )
        viewModelScope.launch {
            runCatching {
                container.api.recordSearchHistory(mapOf("query" to query))
            }
            loadRecent()
        }
        scheduleSearch(recordLive = false)
    }

    fun retrySearch() {
        scheduleSearch(recordLive = false)
    }

    private fun scheduleSuggestions() {
        sugJob?.cancel()
        val draft = _state.value.query.trim()
        if (draft.isEmpty()) {
            _state.value = _state.value.copy(suggestions = emptyList())
            return
        }
        sugJob = viewModelScope.launch {
            delay(180)
            val q = _state.value.query.trim()
            if (q.isEmpty()) {
                _state.value = _state.value.copy(suggestions = emptyList())
                return@launch
            }
            val list = runCatching {
                container.ensureFreshToken()
                val raw = container.api.searchSuggestions(q)["suggestions"]
                (raw as? List<*>)?.mapNotNull { it?.toString()?.trim()?.takeIf { s -> s.isNotEmpty() } }
                    ?.distinct()
                    ?.take(10)
                    .orEmpty()
            }.getOrDefault(emptyList())
            if (_state.value.query.trim() != q) return@launch
            _state.value = _state.value.copy(suggestions = list)
        }
    }

    private fun scheduleSearch(recordLive: Boolean = true) {
        job?.cancel()
        val q = _state.value.query
        if (q.trim().length < 2) {
            _state.value = _state.value.copy(sections = emptyList(), loading = false)
            return
        }
        val filter = _state.value.filter
        job = viewModelScope.launch {
            delay(280)
            val currentQ = _state.value.query.trim()
            val currentFilter = _state.value.filter
            if (currentQ.length < 2) return@launch
            _state.value = _state.value.copy(loading = true, error = null, sections = emptyList())

            // Toujours chercher d’abord dans les téléchargements locaux (offline-capable)
            val offlineHits = filterOfflineDownloads(currentQ, currentFilter)

            try {
                container.ensureFreshToken()
                val noHist = if (recordLive) "1" else null
                val res = container.api.search(currentQ, currentFilter, noHistory = noHist)
                if (_state.value.query.trim() != currentQ || _state.value.filter != currentFilter) {
                    return@launch
                }
                val offlineIds = offlineHits.map { it.id }.toHashSet()
                val sections = buildList {
                    if (offlineHits.isNotEmpty()) {
                        add(SearchSection("Sur l'appareil", offlineHits.take(30)))
                    }
                    res.topResult?.let {
                        if (it.id !in offlineIds) add(SearchSection("Meilleur résultat", listOf(it)))
                    }
                    val topId = res.topResult?.id
                    val songs = res.songs.filter { it.id != topId && it.id !in offlineIds }
                    val artists = res.artists.filter { it.id != topId }
                    val albums = res.albums.filter { it.id != topId }
                    if (songs.isNotEmpty()) add(SearchSection("Titres", songs.take(20)))
                    if (artists.isNotEmpty()) add(SearchSection("Artistes", artists.take(12)))
                    if (albums.isNotEmpty()) add(SearchSection("Albums", albums.take(12)))
                    if (res.playlists.isNotEmpty()) {
                        add(SearchSection("Playlists", res.playlists.filter { it.id != topId }.take(12)))
                    }
                    if (res.videos.isNotEmpty()) {
                        add(SearchSection("Vidéos", res.videos.filter { it.id != topId }.take(12)))
                    }
                }
                _state.value = _state.value.copy(loading = false, sections = sections, error = null)
            } catch (e: Exception) {
                if (_state.value.query.trim() != currentQ) return@launch
                // Hors-ligne / API KO : on expose quand même les DL locaux
                if (offlineHits.isNotEmpty()) {
                    _state.value = _state.value.copy(
                        loading = false,
                        sections = listOf(SearchSection("Sur l'appareil", offlineHits.take(40))),
                        error = null,
                    )
                } else {
                    _state.value = _state.value.copy(loading = false, error = e.message)
                }
            }
        }
    }

    private fun filterOfflineDownloads(query: String, filter: String): List<TrackDto> {
        if (filter !in setOf("all", "song", "video")) return emptyList()
        val q = query.lowercase()
        return container.offlineStore.listTracks().filter { t ->
            val title = t.title.lowercase()
            val artists = t.artistLine().lowercase()
            val album = t.album?.name.orEmpty().lowercase()
            title.contains(q) || artists.contains(q) || album.contains(q)
        }
    }

    companion object {
        fun factory(c: AppContainer) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = SearchViewModel(c) as T
        }
    }
}

@Composable
fun SearchScreen(
    container: AppContainer,
    onPlay: (List<TrackDto>, Int) -> Unit,
    onMore: (TrackDto) -> Unit,
    onOpenDetail: (TrackDto) -> Unit,
    onOpenArtist: ((String?, String) -> Unit)? = null,
    vm: SearchViewModel = viewModel(factory = SearchViewModel.factory(container)),
) {
    val state by vm.state.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val pins by container.quickAccess.pins.collectAsState(initial = emptyList())
    val pinIds = remember(pins) { pins.map { it.id }.toHashSet() }
    var showIdentify by remember { mutableStateOf(false) }
    val startVoiceSearch = rememberVoiceSearchLauncher(
        onResult = { spoken -> vm.commitSearch(spoken) },
        onError = { msg -> Toast.makeText(context, msg, Toast.LENGTH_SHORT).show() },
    )

    Column(Modifier.fillMaxSize()) {
        Text(
            "Recherche",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
        )
        OutlinedTextField(
            value = state.query,
            onValueChange = vm::onQuery,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .heightIn(max = 52.dp),
            singleLine = true,
            textStyle = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp),
            placeholder = {
                Text(
                    "Titres, artistes…",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            },
            leadingIcon = {
                Icon(
                    Icons.Default.Search,
                    contentDescription = null,
                    modifier = Modifier.size(20.dp),
                )
            },
            trailingIcon = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (state.query.isNotEmpty()) {
                        IconButton(
                            onClick = vm::clearQuery,
                            modifier = Modifier.size(36.dp),
                        ) {
                            Icon(
                                Icons.Default.Close,
                                contentDescription = "Effacer",
                                modifier = Modifier.size(18.dp),
                            )
                        }
                    }
                    IconButton(
                        onClick = startVoiceSearch,
                        modifier = Modifier.size(36.dp),
                    ) {
                        Icon(
                            Icons.Default.Mic,
                            contentDescription = "Dictée",
                            modifier = Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    IconButton(
                        onClick = { showIdentify = true },
                        modifier = Modifier.size(36.dp),
                    ) {
                        Icon(
                            Icons.Default.MusicNote,
                            contentDescription = "Identifier",
                            modifier = Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            },
            shape = RoundedCornerShape(12.dp),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(
                onSearch = { vm.commitSearch(state.query) },
            ),
        )
        Row(
            Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            FILTERS.forEach { (id, label) ->
                FilterChip(
                    selected = state.filter == id,
                    onClick = { vm.onFilter(id) },
                    label = {
                        Text(
                            label,
                            style = MaterialTheme.typography.labelMedium,
                            fontSize = 12.sp,
                        )
                    },
                    modifier = Modifier.heightIn(max = 32.dp),
                    colors = FilterChipDefaults.filterChipColors(),
                )
            }
        }
        when {
            state.loading && state.query.trim().length >= 2 && state.sections.isEmpty() -> {
                Column(Modifier.fillMaxSize()) {
                    SearchSuggestionsBlock(
                        draft = state.query.trim(),
                        suggestions = state.suggestions,
                        onPick = vm::commitSearch,
                    )
                    SearchLoadingSkeleton()
                }
            }
            state.error != null -> {
                Column(
                    Modifier
                        .fillMaxSize()
                        .padding(24.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        state.error!!,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = vm::retrySearch) {
                        Text("Réessayer")
                    }
                }
            }
            state.query.isBlank() -> {
                if (state.recent.isEmpty()) {
                    Text(
                        "Cherche un titre ou un artiste — ex. « Poto Demi Portion ».",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(24.dp),
                    )
                } else {
                    LazyColumn(contentPadding = PaddingValues(bottom = 24.dp, top = 8.dp)) {
                        item {
                            Text(
                                "Récentes",
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                            )
                        }
                        items(state.recent, key = { it }) { q ->
                            Row(
                                Modifier
                                    .fillMaxWidth()
                                    .clickable { vm.commitSearch(q) }
                                    .padding(horizontal = 16.dp, vertical = 12.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                Icon(
                                    Icons.Default.History,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Text(q, style = MaterialTheme.typography.bodyLarge)
                            }
                        }
                    }
                }
            }
            state.query.trim().length < 2 ||
                (!state.loading && state.sections.isEmpty() && state.suggestions.isNotEmpty()) -> {
                // Texte tapé : suggestions seulement (pas l’historique mélangé)
                SearchSuggestionsBlock(
                    draft = state.query.trim(),
                    suggestions = state.suggestions,
                    onPick = vm::commitSearch,
                    fill = true,
                )
            }
            !state.loading && state.sections.isEmpty() -> {
                Column(Modifier.fillMaxSize()) {
                    SearchSuggestionsBlock(
                        draft = state.query.trim(),
                        suggestions = state.suggestions,
                        onPick = vm::commitSearch,
                    )
                    Text(
                        "Aucun résultat pour « ${state.query} ». Essaie un autre filtre.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(24.dp),
                    )
                }
            }
            else -> {
                LazyColumn(contentPadding = PaddingValues(bottom = 24.dp, top = 4.dp)) {
                    if (state.suggestions.isNotEmpty()) {
                        item(key = "sug-header") {
                            SearchSuggestionsBlock(
                                draft = state.query.trim(),
                                suggestions = state.suggestions,
                                onPick = vm::commitSearch,
                            )
                        }
                    }
                    state.sections.forEachIndexed { sectionIndex, section ->
                        item(key = "sec-title-$sectionIndex-${section.title}") {
                            Text(
                                section.title,
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                            )
                        }
                        itemsIndexed(
                            section.items,
                            key = { index, track -> "sec-$sectionIndex-${track.id}-$index" },
                        ) { _, track ->
                            TrackRow(
                                track = track,
                                highlighted = section.title == "Meilleur résultat",
                                pinned = track.id in pinIds,
                                onTogglePin = {
                                    scope.launch {
                                        container.quickAccess.toggle(track, container.api)
                                    }
                                },
                                onClick = {
                                    val q = state.query.trim()
                                    if (q.length >= 2) {
                                        scope.launch {
                                            runCatching {
                                                container.api.recordSearchClick(
                                                    mapOf(
                                                        "query" to q,
                                                        "clickedId" to track.id,
                                                        "clickedKind" to (track.type ?: "song"),
                                                    ),
                                                )
                                            }
                                        }
                                    }
                                    if (track.isPlaylist() || track.isAlbum() || track.isArtist()) {
                                        onOpenDetail(track)
                                        return@TrackRow
                                    }
                                    scope.launch {
                                        if (track.isPlayable()) {
                                            val playable = section.items.filter { it.isPlayable() }
                                            val idx = playable.indexOfFirst { it.id == track.id }
                                                .coerceAtLeast(0)
                                            onPlay(playable.ifEmpty { listOf(track) }, idx)
                                        } else {
                                            onOpenDetail(track)
                                        }
                                    }
                                },
                                onMore = { onMore(track) },
                                onOpenArtist = onOpenArtist,
                            )
                        }
                    }
                }
            }
        }
    }

    if (showIdentify) {
        SearchIdentifySheet(
            container = container,
            onDismiss = { showIdentify = false },
            onQuery = { q ->
                showIdentify = false
                vm.commitSearch(q)
            },
        )
    }
}

@Composable
private fun SearchSuggestionsBlock(
    draft: String,
    suggestions: List<String>,
    onPick: (String) -> Unit,
    fill: Boolean = false,
) {
    val draftNorm = draft.trim()
    if (draftNorm.isEmpty() && suggestions.isEmpty()) return
    val opts = buildList {
        if (draftNorm.isNotEmpty()) add(draftNorm to true)
        suggestions
            .filter { it.trim().lowercase() != draftNorm.lowercase() }
            .forEach { add(it to false) }
    }
    if (opts.isEmpty()) return
    Column(
        modifier = if (fill) Modifier.fillMaxSize() else Modifier.fillMaxWidth(),
    ) {
        Text(
            "Suggestions",
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
        )
        opts.forEach { (label, typed) ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable { onPick(label) }
                    .padding(horizontal = 16.dp, vertical = 11.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(
                    Icons.Default.Search,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    if (typed) "Rechercher « $label »" else label,
                    style = MaterialTheme.typography.bodyLarge,
                    color = if (typed) {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    } else {
                        MaterialTheme.colorScheme.onSurface
                    },
                    fontWeight = if (typed) FontWeight.Normal else FontWeight.Medium,
                )
            }
        }
    }
}

@Composable
private fun SearchLoadingSkeleton() {
    Column(
        Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        repeat(7) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(
                    Modifier
                        .size(48.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f)),
                )
                Column(Modifier.weight(1f)) {
                    Box(
                        Modifier
                            .fillMaxWidth(0.7f)
                            .height(12.dp)
                            .clip(RoundedCornerShape(4.dp))
                            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f)),
                    )
                    Spacer(Modifier.height(8.dp))
                    Box(
                        Modifier
                            .fillMaxWidth(0.4f)
                            .height(10.dp)
                            .clip(RoundedCornerShape(4.dp))
                            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f)),
                    )
                }
            }
        }
    }
}
