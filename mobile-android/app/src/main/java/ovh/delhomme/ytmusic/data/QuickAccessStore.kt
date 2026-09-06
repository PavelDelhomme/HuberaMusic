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

/**
 * Pins locaux + sync serveur (`/api/pins`) pour l’Accès rapide.
 * Toujours liés à l’email du [TokenStore] — jamais partagés entre comptes.
 */
class QuickAccessStore(
    private val context: Context,
    private val tokenStore: TokenStore,
) {
    private val key = stringPreferencesKey("pins_json")
    private val boundUserKey = stringPreferencesKey("bound_user_email")
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

    suspend fun boundUserEmail(): String? =
        context.quickAccessStore.data.first()[boundUserKey]?.trim()?.lowercase()?.takeIf { it.isNotBlank() }

    private suspend fun currentEmail(): String? =
        tokenStore.getEmail()?.trim()?.lowercase()?.takeIf { it.isNotBlank() }

    suspend fun isPinned(id: String): Boolean = pins.first().any { it.id == id }

    suspend fun clear() {
        context.quickAccessStore.edit { prefs ->
            prefs.remove(key)
            prefs.remove(boundUserKey)
        }
    }

    suspend fun replaceAll(tracks: List<TrackDto>, boundEmail: String? = null) {
        context.quickAccessStore.edit { prefs ->
            prefs[key] = adapter.toJson(tracks.take(48))
            val email = (boundEmail ?: currentEmail())?.trim()?.lowercase().orEmpty()
            if (email.isNotBlank()) prefs[boundUserKey] = email
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
     * Pull serveur = source de vérité (multi-appareils).
     * Ne plus pousser le cache local en union : ça ré-annulait les pins
     * retirés / ajoutés sur l’autre téléphone au pull-to-refresh.
     * Les ajouts/suppressions passent déjà par addPin/removePin à l’action.
     */
    suspend fun syncFromApi(api: YtMusicApi, userEmail: String? = null) {
        val email = (userEmail ?: currentEmail())?.trim()?.lowercase().orEmpty()
        val bound = boundUserEmail()
        if (email.isNotBlank() && bound != null && bound != email) {
            clear()
        }
        val remote = runCatching { api.pins().pins }.getOrDefault(emptyList())
        val tracks = remote.mapNotNull { pinToTrack(it) }
            .distinctBy { it.id }
            .take(48)
        replaceAll(tracks, boundEmail = email.ifBlank { null })
    }

    /**
     * Pousse l’état local comme vérité serveur (édition offline puis sync explicite).
     * Rare — le flux normal est [syncFromApi] (pull).
     */
    suspend fun pushReplaceToApi(api: YtMusicApi) {
        val local = pins.first()
        val email = currentEmail().orEmpty()
        runCatching {
            api.syncPins(
                mapOf(
                    "mode" to "replace",
                    "pins" to local.map { trackToPinBody(it) },
                ),
            )
        }
        syncFromApi(api, email.ifBlank { null })
    }

    suspend fun toggle(track: TrackDto, api: YtMusicApi? = null): Boolean {
        val email = currentEmail().orEmpty()
        if (email.isNotBlank()) {
            val bound = boundUserEmail()
            if (bound != null && bound != email) {
                clear()
            }
        }
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
            if (email.isNotBlank()) prefs[boundUserKey] = email
        }
        if (api != null) {
            runCatching {
                if (nowPinned) {
                    val pinType = track.type?.takeIf { it != "video" && it.isNotBlank() } ?: "song"
                    val resp = api.addPin(trackToPinBody(track.copy(type = pinType)))
                    replaceAll(
                        resp.pins.mapNotNull { pinToTrack(it) }.distinctBy { it.id }.take(48),
                        boundEmail = email.ifBlank { null },
                    )
                    runCatching {
                        when (pinType) {
                            "album" -> api.saveAlbum(track.copy(type = "album"))
                            "artist" -> api.saveArtist(track.copy(type = "artist"))
                            else -> {
                                val already = runCatching {
                                    api.library().songs.any { it.id == track.id }
                                }.getOrDefault(false)
                                if (!already) {
                                    api.toggleLibrarySong(track.copy(type = "song"))
                                }
                            }
                        }
                    }
                } else {
                    val resp = api.removePin(track.id)
                    val fromServer = resp.pins.mapNotNull { pinToTrack(it) }.distinctBy { it.id }.take(48)
                    replaceAll(fromServer, boundEmail = email.ifBlank { null })
                }
            }
        }
        return nowPinned
    }
}
