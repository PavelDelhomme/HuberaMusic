package ovh.delhomme.ytmusic.data

import android.content.Context
import com.squareup.moshi.JsonClass
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory

/** Cache disque Accueil — lecture sync au cold start (évite skeleton si déjà vu). */
class HomeCacheStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("ytm_home_cache", Context.MODE_PRIVATE)
    private val moshi = Moshi.Builder()
        .add(FlexibleStringAdapter())
        .add(KotlinJsonAdapterFactory())
        .build()
    private val adapter = moshi.adapter(CachedHome::class.java)

    fun read(): CachedHome? {
        val raw = prefs.getString(KEY, null)?.takeIf { it.isNotBlank() } ?: return null
        return runCatching { adapter.fromJson(raw) }.getOrNull()
            ?.takeIf { it.shelves.isNotEmpty() }
    }

    fun write(home: HomeResponse, radioPreviews: Map<String, List<TrackDto>> = emptyMap()) {
        val trimmedPreviews = radioPreviews
            .mapValues { (_, tracks) -> tracks.take(4) }
            .filterValues { it.isNotEmpty() }
            .entries
            .take(12)
            .associate { it.key to it.value }
        val trimmed = CachedHome(
            shelves = home.shelves
                .filter { it.items.isNotEmpty() }
                .take(14)
                .map { shelf ->
                    shelf.copy(items = shelf.items.take(16))
                },
            radios = home.radios.take(12),
            radioPreviews = trimmedPreviews,
            seeds = home.seeds.orEmpty().take(32),
            hasMore = home.hasMore == true,
            at = System.currentTimeMillis(),
        )
        runCatching {
            prefs.edit().putString(KEY, adapter.toJson(trimmed)).apply()
        }
    }

    companion object {
        private const val KEY = "home_v2"
    }
}

@JsonClass(generateAdapter = false)
data class CachedHome(
    val shelves: List<ShelfDto> = emptyList(),
    val radios: List<RadioCategoryDto> = emptyList(),
    val radioPreviews: Map<String, List<TrackDto>> = emptyMap(),
    val seeds: List<String> = emptyList(),
    val hasMore: Boolean = false,
    val at: Long = 0L,
)
