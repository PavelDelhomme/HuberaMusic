package ovh.delhomme.ytmusic.data

import android.content.Context
import com.squareup.moshi.JsonClass
import com.squareup.moshi.Moshi
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory

/** Cache local des mixes précalculés (~200 titres, TTL 12 h). */
class MixCacheStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("ytm_mix_cache", Context.MODE_PRIVATE)
    private val moshi = Moshi.Builder()
        .add(FlexibleStringAdapter())
        .add(KotlinJsonAdapterFactory())
        .build()
    private val entryAdapter = moshi.adapter(CachedMixEntry::class.java)

    fun keyCategory(categoryId: String) = "cat:$categoryId"
    fun keyRadio(kind: String, id: String) = "radio:$kind:$id"

    fun get(key: String): List<TrackDto>? {
        val raw = prefs.getString(key, null)?.takeIf { it.isNotBlank() } ?: return null
        val entry = runCatching { entryAdapter.fromJson(raw) }.getOrNull() ?: return null
        if (System.currentTimeMillis() - entry.generatedAt > TTL_MS) {
            prefs.edit().remove(key).apply()
            return null
        }
        val tracks = entry.tracks.filter { it.isPlayable() }
        return tracks.takeIf { it.isNotEmpty() }?.take(MIX_TARGET)
    }

    fun put(key: String, tracks: List<TrackDto>, generatedAt: Long = System.currentTimeMillis()) {
        val playable = tracks.filter { it.isPlayable() }.distinctBy { it.id }.take(MIX_TARGET)
        if (playable.isEmpty()) return
        val entry = CachedMixEntry(
            tracks = playable,
            generatedAt = generatedAt,
            target = MIX_TARGET,
        )
        runCatching {
            prefs.edit().putString(key, entryAdapter.toJson(entry)).apply()
        }
    }

    fun clear(key: String) {
        prefs.edit().remove(key).apply()
    }

    companion object {
        const val MIX_TARGET = 200
        const val TTL_MS = 12L * 60L * 60L * 1000L
    }
}

@JsonClass(generateAdapter = false)
data class CachedMixEntry(
    val tracks: List<TrackDto> = emptyList(),
    val generatedAt: Long = 0L,
    val target: Int = MixCacheStore.MIX_TARGET,
)

fun isPrecomputedMixSource(sourceKind: String?, remainingUserTracks: Int): Boolean {
    if (sourceKind != "mix" && sourceKind != "radio" && sourceKind != "album" && sourceKind != "artist") {
        return false
    }
    return remainingUserTracks >= 20
}
