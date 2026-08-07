package ovh.delhomme.ytmusic.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.squareup.moshi.Moshi
import com.squareup.moshi.Types
import com.squareup.moshi.kotlin.reflect.KotlinJsonAdapterFactory
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.quickAccessStore by preferencesDataStore("ytmusic_quick_access")

/** Pins locaux + sync serveur (`/api/pins`) pour le rayon Accueil « Accès rapide ». */
class QuickAccessStore(private val context: Context) {
    private val key = stringPreferencesKey("pins_json")
    private val moshi = Moshi.Builder().add(KotlinJsonAdapterFactory()).build()
    private val adapter = moshi.adapter<List<TrackDto>>(
        Types.newParameterizedType(List::class.java, TrackDto::class.java),
    )

    val pins: Flow<List<TrackDto>> = context.quickAccessStore.data.map { prefs ->
        val raw = prefs[key].orEmpty()
        if (raw.isBlank()) emptyList()
        else runCatching { adapter.fromJson(raw).orEmpty() }.getOrDefault(emptyList())
            .distinctBy { it.id }
    }

    suspend fun isPinned(id: String): Boolean = pins.first().any { it.id == id }

    suspend fun replaceAll(tracks: List<TrackDto>) {
        context.quickAccessStore.edit { prefs ->
            prefs[key] = adapter.toJson(tracks.take(48))
        }
    }

    private fun pinToTrack(pin: PinDto): TrackDto? {
        val payload = pin.payload
        val id = payload?.id?.takeIf { it.isNotBlank() }
            ?: pin.targetId?.takeIf { it.isNotBlank() }
            ?: return null
        val title = payload?.title?.takeIf { it.isNotBlank() } ?: id
        return TrackDto(
            id = id,
            title = title,
            artists = payload?.artists,
            album = payload?.album,
            duration = payload?.duration,
            durationSeconds = payload?.durationSeconds,
            thumbnails = payload?.thumbnails,
            type = payload?.type ?: pin.kind ?: "song",
        )
    }

    private fun trackToPinBody(track: TrackDto): Map<String, Any?> =
        mapOf(
            "kind" to (track.type ?: "song"),
            "targetId" to track.id,
            "id" to track.id,
            "payload" to mapOf(
                "id" to track.id,
                "title" to track.title,
                "type" to (track.type ?: "song"),
                "artists" to (track.artists?.map { mapOf("name" to it.name, "id" to it.id) } ?: emptyList<Map<String, String?>>()),
                "album" to track.album?.let { mapOf("name" to it.name, "id" to it.id) },
                "duration" to track.duration,
                "durationSeconds" to track.durationSeconds,
                "thumbnails" to (
                    track.thumbnails?.map {
                        mapOf("url" to it.url, "width" to it.width, "height" to it.height)
                    } ?: emptyList<Map<String, Any?>>()
                    ),
            ),
        )

    /**
     * Sync bidirectionnelle :
     * 1) lit le serveur
     * 2) pousse les pins locaux absents du serveur
     * 3) remplace le cache local par l’union serveur
     */
    suspend fun syncFromApi(api: YtMusicApi) {
        val local = pins.first()
        val remote = runCatching { api.pins().pins }.getOrDefault(emptyList())
        val remoteTracks = remote.mapNotNull { pinToTrack(it) }
        val remoteIds = remoteTracks.map { it.id }.toSet()
        val localOnly = local.filter { it.id.isNotBlank() && it.id !in remoteIds }
        val toSync = (remoteTracks + localOnly).distinctBy { it.id }

        val synced = if (toSync.isNotEmpty()) {
            runCatching {
                api.syncPins(mapOf("pins" to toSync.map { trackToPinBody(it) })).pins
            }.getOrDefault(remote)
        } else {
            remote
        }

        val tracks = synced.mapNotNull { pinToTrack(it) }
            .ifEmpty { toSync }
            .distinctBy { it.id }
            .take(48)
        replaceAll(tracks)
    }

    suspend fun toggle(track: TrackDto, api: YtMusicApi? = null): Boolean {
        var nowPinned = false
        context.quickAccessStore.edit { prefs ->
            val current = prefs[key].orEmpty().let { raw ->
                if (raw.isBlank()) emptyList()
                else runCatching { adapter.fromJson(raw).orEmpty() }.getOrDefault(emptyList())
            }.toMutableList()
            val idx = current.indexOfFirst { it.id == track.id }
            if (idx >= 0) {
                current.removeAt(idx)
                nowPinned = false
            } else {
                current.add(0, track.copy(type = when (track.type) {
                    "video", null, "" -> "song"
                    else -> track.type
                }))
                nowPinned = true
            }
            prefs[key] = adapter.toJson(current.distinctBy { it.id }.take(48))
        }
        if (api != null) {
            runCatching {
                if (nowPinned) {
                    api.addPin(trackToPinBody(track.copy(type = track.type?.takeIf { it != "video" } ?: "song")))
                } else {
                    api.removePin(track.id)
                }
            }
        }
        return nowPinned
    }
}
