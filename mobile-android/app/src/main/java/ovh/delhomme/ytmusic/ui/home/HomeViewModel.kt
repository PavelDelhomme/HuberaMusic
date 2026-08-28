package ovh.delhomme.ytmusic.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import ovh.delhomme.ytmusic.data.AppContainer
import ovh.delhomme.ytmusic.data.NetworkMonitor
import ovh.delhomme.ytmusic.data.RadioCategoryDto
import ovh.delhomme.ytmusic.data.ShelfDto
import ovh.delhomme.ytmusic.data.TrackDto
import ovh.delhomme.ytmusic.update.ApkUpdateManager

data class HomeUiState(
    val loading: Boolean = true,
    val refreshing: Boolean = false,
    val loadingMore: Boolean = false,
    val error: String? = null,
    val shelves: List<ShelfDto> = emptyList(),
    val radios: List<RadioCategoryDto> = emptyList(),
    /** Previews 4 covers pour mosaïque « Mixés pour toi ». */
    val radioPreviews: Map<String, List<TrackDto>> = emptyMap(),
    val savedMixIds: Set<String> = emptySet(),
    val needsOnboarding: Boolean = false,
    val radioLoadingId: String? = null,
    val seeds: List<String> = emptyList(),
    val hasMore: Boolean = false,
    val page: Int = 0,
    /** Résultat MAJ éventuel (fenêtre 7h / 17h uniquement). */
    val updatePrompt: ApkUpdateManager.CheckResult? = null,
)

class HomeViewModel(private val container: AppContainer) : ViewModel() {
    private val _state = MutableStateFlow(HomeUiState())
    val state: StateFlow<HomeUiState> = _state.asStateFlow()

    init {
        // Cache-first : contenu immédiat au cold start, refresh réseau derrière
        container.homeCache.read()?.let { cached ->
            val seededPreviews = cached.radioPreviews.ifEmpty {
                cached.radios.associate { radio ->
                    radio.id to (container.mixCache.get(container.mixCache.keyCategory(radio.id))?.take(4).orEmpty())
                }.filterValues { it.isNotEmpty() }
            }
            _state.value = HomeUiState(
                loading = false,
                shelves = cached.shelves,
                radios = cached.radios,
                radioPreviews = seededPreviews,
                seeds = cached.seeds,
                hasMore = cached.hasMore,
            )
        }
        refresh()
    }

    /** Ferme le dialogue sans snooze (back / extérieur / kill app). */
    fun dismissUpdatePrompt() {
        _state.value = _state.value.copy(updatePrompt = null)
    }

    fun snoozeUpdatePrompt(option: ApkUpdateManager.SnoozeOption) {
        val code = _state.value.updatePrompt?.info?.versionCode ?: 0
        if (code > 0) {
            ApkUpdateManager(container.appContext, container).snooze(option, code)
        }
        _state.value = _state.value.copy(updatePrompt = null)
    }

    fun consumeUpdatePrompt() {
        _state.value = _state.value.copy(updatePrompt = null)
    }

    fun refresh(fromUser: Boolean = false) {
        viewModelScope.launch {
            if (!NetworkMonitor.isOnline()) {
                _state.value = _state.value.copy(
                    loading = false,
                    refreshing = false,
                    radios = emptyList(),
                    shelves = emptyList(),
                    radioPreviews = emptyMap(),
                    error = "Hors ligne — ouvre Bibliothèque → Téléchargés",
                )
                return@launch
            }
            val hadContent = _state.value.shelves.isNotEmpty() || _state.value.radios.isNotEmpty()
            val keepPreviews = _state.value.radioPreviews
            _state.value = _state.value.copy(
                loading = !fromUser && !hadContent,
                refreshing = fromUser,
                error = null,
                // Garde les mosaïques pendant le pull — remplacées au fur et à mesure
            )
            if (fromUser) {
                runCatching { container.mixCache.clearAll() }
            }
            // MAJ : check léger en parallèle (prompt seulement 7h / 17h, snooze respecté)
            val updateJob = if (fromUser) {
                async {
                    runCatching {
                        ApkUpdateManager(container.appContext, container)
                            .checkOnPullRefresh()
                    }.getOrNull()
                }
            } else {
                null
            }
            try {
                container.ensureFreshToken()
                // Pins / quick access + home en parallèle
                val pinsJob = async {
                    runCatching { container.quickAccess.syncFromApi(container.api) }
                }
                val homeJob = async { container.api.home() }
                val savedJob = async {
                    val fromRepo = container.libraryRepo.library.value?.mixes?.map { it.id }?.toSet()
                    if (!fromRepo.isNullOrEmpty()) fromRepo
                    else runCatching {
                        container.api.library(light = 1, limit = 12).mixes.map { it.id }.toSet()
                    }.getOrDefault(emptySet())
                }
                pinsJob.await()
                val home = homeJob.await()
                val savedMixes = savedJob.await()
                // Seed mosaïques depuis MixCache pendant que /home vient d’arriver
                val cachePreviews = home.radios.associate { radio ->
                    radio.id to (container.mixCache.get(container.mixCache.keyCategory(radio.id))?.take(4).orEmpty())
                }.filterValues { it.isNotEmpty() }
                val mergedPreviews = keepPreviews.filterKeys { id ->
                    home.radios.any { it.id == id }
                } + cachePreviews
                container.homeCache.write(home, mergedPreviews)

                // 1ʳᵉ peinture immédiate : shelves + radios (spinner peut tomber)
                _state.value = _state.value.copy(
                    loading = false,
                    refreshing = fromUser,
                    shelves = home.shelves.filter {
                        it.items.isNotEmpty() && !it.title.equals("Épinglé", ignoreCase = true)
                    },
                    radios = home.radios,
                    savedMixIds = savedMixes,
                    needsOnboarding = home.needsOnboarding == true,
                    seeds = home.seeds.orEmpty(),
                    hasMore = home.hasMore == true,
                    page = 0,
                    radioPreviews = mergedPreviews,
                )

                // Spoken + MAJ en parallèle des previews
                launch {
                    val spokenShelves = buildList {
                        runCatching { container.api.exploreSpoken("podcast") }.getOrNull()
                            ?.items?.takeIf { it.isNotEmpty() }
                            ?.let { add(ShelfDto("Podcasts", it.take(12))) }
                        runCatching { container.api.exploreSpoken("audiobook") }.getOrNull()
                            ?.items?.takeIf { it.isNotEmpty() }
                            ?.let { add(ShelfDto("Livres audio", it.take(12))) }
                    }
                    if (spokenShelves.isNotEmpty()) {
                        _state.value = _state.value.copy(
                            shelves = (_state.value.shelves + spokenShelves).distinctBy { it.title },
                        )
                    }
                }

                suspend fun loadPreview(radioId: String): Pair<String, List<TrackDto>>? =
                    runCatching {
                        radioId to container.api.recoRadio(radioId, preview = 1).tracks.take(4)
                    }.getOrNull()?.takeIf { it.second.isNotEmpty() }

                // Mosaïques : 2 visibles d’abord (UI se met à jour une par une), puis le reste
                coroutineScope {
                    home.radios.take(2).map { radio ->
                        async { loadPreview(radio.id) }
                    }.awaitAll().filterNotNull().forEach { (id, tracks) ->
                        _state.value = _state.value.copy(
                            radioPreviews = _state.value.radioPreviews + (id to tracks),
                        )
                    }
                }
                // Spinner pull : on le coupe dès que le cœur + 2 mosaïques sont là
                _state.value = _state.value.copy(refreshing = false)

                val upd = updateJob?.await()
                if (upd?.available == true) {
                    _state.value = _state.value.copy(updatePrompt = upd)
                }

                launch {
                    val more = coroutineScope {
                        home.radios.drop(2).take(6).map { radio ->
                            async { loadPreview(radio.id) }
                        }.awaitAll().filterNotNull().toMap()
                    }
                    if (more.isNotEmpty()) {
                        val next = _state.value.radioPreviews + more
                        _state.value = _state.value.copy(radioPreviews = next)
                        runCatching {
                            container.homeCache.write(
                                ovh.delhomme.ytmusic.data.HomeResponse(
                                    shelves = _state.value.shelves,
                                    radios = _state.value.radios,
                                    seeds = _state.value.seeds,
                                    hasMore = _state.value.hasMore,
                                ),
                                next,
                            )
                        }
                    }
                }
            } catch (e: Exception) {
                val offline = !NetworkMonitor.isOnline()
                _state.value = _state.value.copy(
                    loading = false,
                    refreshing = false,
                    radios = if (offline) emptyList() else _state.value.radios,
                    shelves = if (offline) emptyList() else _state.value.shelves,
                    error = when {
                        hadContent && !offline -> null
                        offline -> "Hors ligne — ouvre Bibliothèque → Téléchargés"
                        else -> (e.message ?: "Erreur accueil")
                    },
                )
            }
        }
    }

    fun loadMore() {
        val cur = _state.value
        if (!cur.hasMore || cur.loadingMore || cur.loading || cur.seeds.isEmpty()) return
        viewModelScope.launch {
            _state.value = cur.copy(loadingMore = true)
            try {
                container.ensureFreshToken()
                val nextPage = cur.page + 1
                val more = container.api.homeMore(nextPage, cur.seeds.joinToString(","))
                val extra = more.shelves.filter { it.items.isNotEmpty() }
                val merged = (cur.shelves + extra).distinctBy { it.title }
                _state.value = _state.value.copy(
                    loadingMore = false,
                    shelves = merged,
                    page = nextPage,
                    hasMore = more.hasMore != false && extra.isNotEmpty(),
                )
            } catch (_: Exception) {
                _state.value = _state.value.copy(loadingMore = false, hasMore = false)
            }
        }
    }

    fun playRadio(
        categoryId: String,
        onQueue: (List<TrackDto>, String) -> Unit,
    ) {
        viewModelScope.launch {
            val title = _state.value.radios.find { it.id == categoryId }?.title ?: "Mix"
            val cacheKey = container.mixCache.keyCategory(categoryId)
            // Preview déjà en mémoire → feedback immédiat, puis file complète
            val preview = _state.value.radioPreviews[categoryId]
                .orEmpty()
                .filter { it.isPlayable() }
            if (preview.isNotEmpty()) {
                onQueue(preview, title)
            } else {
                _state.value = _state.value.copy(radioLoadingId = categoryId)
            }
            val cached = container.mixCache.get(cacheKey)
            if (cached != null && cached.isNotEmpty()) {
                onQueue(cached, title)
                // Rafraîchit en arrière-plan
                runCatching {
                    container.ensureFreshToken()
                    val mix = container.api.recoRadio(categoryId)
                    val tracks = mix.tracks.filter { it.isPlayable() }
                    if (tracks.isNotEmpty()) {
                        container.mixCache.put(cacheKey, tracks, mix.generatedAt ?: System.currentTimeMillis())
                    }
                }
                _state.value = _state.value.copy(radioLoadingId = null)
                return@launch
            }
            runCatching {
                container.ensureFreshToken()
                val mix = container.api.recoRadio(categoryId)
                val tracks = mix.tracks.filter { it.isPlayable() }
                if (tracks.isNotEmpty()) {
                    container.mixCache.put(cacheKey, tracks, mix.generatedAt ?: System.currentTimeMillis())
                    onQueue(tracks, title)
                }
            }
            _state.value = _state.value.copy(radioLoadingId = null)
        }
    }

    fun saveMix(categoryId: String, title: String, covers: List<TrackDto>) {
        viewModelScope.launch {
            runCatching {
                container.ensureFreshToken()
                container.api.saveMix(
                    mapOf(
                        "id" to categoryId,
                        "title" to title,
                        "covers" to covers,
                        "tracks" to covers,
                    ),
                )
                _state.value = _state.value.copy(
                    savedMixIds = _state.value.savedMixIds + categoryId,
                )
                container.bumpLibraryEpoch()
            }
        }
    }

    fun clearOnboardingFlag() {
        _state.value = _state.value.copy(needsOnboarding = false)
    }

    fun playableFrom(track: TrackDto, shelf: ShelfDto): Pair<List<TrackDto>, Int> {
        val list = shelf.items.filter { it.isPlayable() }
        val idx = list.indexOfFirst { it.id == track.id }.coerceAtLeast(0)
        return list to idx
    }

    companion object {
        fun factory(c: AppContainer) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T = HomeViewModel(c) as T
        }
    }
}
