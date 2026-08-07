package ovh.delhomme.ytmusic.ui.library

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.libraryFilterStore by preferencesDataStore("library_filters")

/** Filtres horizontaux Bibliothèque — masquables localement. */
enum class LibraryFilter(val label: String) {
    Downloads("Téléchargés"),
    Playlists("Playlists"),
    Mixes("Mixes"),
    Tracks("Titres"),
    Liked("J'aime"),
    Albums("Albums"),
    Artists("Artistes"),
    Profiles("Profils"),
    Podcasts("Podcasts"),
    Audiobooks("Livres audio"),
    Additions("Ajouts"),
    DeviceFiles("Fichiers de l'appareil"),
    ;

    companion object {
        /** Masqués par défaut (stubs « bientôt ») — réaffichables via long-press + Réafficher. */
        val defaultHidden: Set<String> = setOf(
            Profiles.name,
            DeviceFiles.name,
        )
        val defaultVisible: Set<String> = entries.map { it.name }.toSet() - defaultHidden
        val defaultSelected: LibraryFilter = Additions

        /** Demande d’ouverture d’un filtre (ex. depuis Account → Téléchargements). */
        @Volatile
        var pendingSelect: LibraryFilter? = null
    }
}

class LibraryFilterStore(private val context: Context) {
    private val hiddenKey = stringSetPreferencesKey("hidden_filters")

    val hiddenIds: Flow<Set<String>> =
        context.libraryFilterStore.data.map { it[hiddenKey] ?: LibraryFilter.defaultHidden }

    suspend fun hide(filter: LibraryFilter) {
        context.libraryFilterStore.edit { prefs ->
            val cur = (prefs[hiddenKey] ?: LibraryFilter.defaultHidden).toMutableSet()
            cur.add(filter.name)
            prefs[hiddenKey] = cur
        }
    }

    suspend fun resetHidden() {
        // Réaffiche tout (y compris Profils / Podcasts / Fichiers)
        context.libraryFilterStore.edit { prefs ->
            prefs[hiddenKey] = emptySet()
        }
    }
}
