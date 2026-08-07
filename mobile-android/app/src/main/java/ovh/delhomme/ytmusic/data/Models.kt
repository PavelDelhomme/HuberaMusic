package ovh.delhomme.ytmusic.data

import com.squareup.moshi.JsonClass

@JsonClass(generateAdapter = false)
data class UserDto(
    val id: String,
    val email: String,
    val name: String? = null,
    val picture: String? = null,
    val isGuest: Boolean? = false,
    val isAdmin: Boolean? = false,
    val emailVerified: Boolean? = false,
)

@JsonClass(generateAdapter = false)
data class AuthResponse(
    val user: UserDto,
    val token: String,
    val refreshToken: String? = null,
    val needsEmailVerification: Boolean? = false,
    val error: String? = null,
    val needs2fa: Boolean? = false,
)

@JsonClass(generateAdapter = false)
data class MeResponse(val user: UserDto?)

@JsonClass(generateAdapter = false)
data class LoginBody(
    val email: String,
    val password: String,
    val totp: String? = null,
)

@JsonClass(generateAdapter = false)
data class RegisterBody(
    val email: String,
    val password: String,
    val name: String? = null,
)

@JsonClass(generateAdapter = false)
data class RefreshBody(val refreshToken: String?)

@JsonClass(generateAdapter = false)
data class ArtistRef(val name: String, val id: String? = null)

@JsonClass(generateAdapter = false)
data class AlbumRef(val name: String? = null, val id: String? = null)

@JsonClass(generateAdapter = false)
data class Thumb(val url: String, val width: Int? = null, val height: Int? = null)

@JsonClass(generateAdapter = false)
data class TrackDto(
    val id: String,
    val title: String,
    val artists: List<ArtistRef>? = emptyList(),
    val album: AlbumRef? = null,
    val duration: String? = null,
    val durationSeconds: Int? = null,
    val thumbnails: List<Thumb>? = emptyList(),
    val type: String? = "song",
) {
    fun artistLine(): String {
        val names = artists?.mapNotNull { it.name.trim().takeIf { n -> n.isNotEmpty() } }
            ?.filter {
                !it.equals("Inconnu", true) &&
                    !it.equals("Unknown", true) &&
                    !it.equals("Artiste", true) &&
                    !it.equals("Artist", true) &&
                    !it.equals("N/A", true)
            }
            .orEmpty()
        return names.joinToString(", ").ifBlank { "Artiste" }
    }

    fun coverUrl(sizeHint: Int = 400): String? {
        val ytimg = if (id.matches(Regex("^[a-zA-Z0-9_-]{11}$"))) {
            when {
                sizeHint <= 200 -> "https://i.ytimg.com/vi/$id/mqdefault.jpg"
                else -> "https://i.ytimg.com/vi/$id/hqdefault.jpg"
            }
        } else {
            null
        }
        val thumbs = thumbnails.orEmpty()
        if (thumbs.isNotEmpty()) {
            val sortedAsc = thumbs.sortedBy { it.width ?: 0 }
            val maxW = sortedAsc.lastOrNull()?.width ?: 0
            // ggpht/yt3 à 60–120px : préférer ytimg (mix Accueil sinon tuiles vides)
            if (ytimg != null && maxW > 0 && maxW < 200) return ytimg
            val fit = sortedAsc.firstOrNull { (it.width ?: 0) >= sizeHint }
            val pick = fit ?: sortedAsc.lastOrNull()
            val url = pick?.url?.takeIf { it.isNotBlank() }
            if (url != null) {
                // Upscale paramètres =sNNN / =wNNN-hNNN quand possible
                val upsized = resizeGoogleThumb(url, sizeHint)
                return upsized
            }
        }
        return ytimg
    }

    private fun resizeGoogleThumb(url: String, sizeHint: Int): String {
        val s = sizeHint.coerceIn(60, 800)
        return when {
            Regex("=[sw]\\d+").containsMatchIn(url) ->
                url.replace(Regex("=[sw]\\d+(-h\\d+)?(-c-k-c0x00ffffff-no-rj)?$"), "=s$s-c-k-c0x00ffffff-no-rj")
                    .let { if (it == url) url.replace(Regex("=w\\d+-h\\d+"), "=w$s-h$s") else it }
            Regex("=w\\d+-h\\d+").containsMatchIn(url) ->
                url.replace(Regex("=w\\d+-h\\d+"), "=w$s-h$s")
            else -> url
        }
    }

    /** Durée en ms pour MediaSession / lockscreen (si connue). */
    fun durationMsOrNull(): Long? {
        durationSeconds?.takeIf { it > 0 }?.let { return it * 1000L }
        val raw = duration?.trim().orEmpty()
        if (raw.isEmpty()) return null
        raw.toLongOrNull()?.takeIf { it > 0 }?.let {
            return if (it < 10_000) it * 1000L else it // secondes vs déjà ms
        }
        val parts = raw.split(':').mapNotNull { it.toIntOrNull() }
        if (parts.isEmpty()) return null
        val sec = when (parts.size) {
            1 -> parts[0]
            2 -> parts[0] * 60 + parts[1]
            else -> parts[0] * 3600 + parts[1] * 60 + parts[2]
        }
        return sec.takeIf { it > 0 }?.times(1000L)
    }

    fun kind(): String = (type ?: "song").lowercase()

    fun isPlaylist(): Boolean = kind() in setOf("playlist", "community_playlist")

    fun isArtist(): Boolean = kind() == "artist"

    fun isAlbum(): Boolean = kind() == "album"

    fun isPlayable(): Boolean =
        !isPlaylist() && !isArtist() && !isAlbum() &&
            id.matches(Regex("^[a-zA-Z0-9_-]{11}$"))
}

@JsonClass(generateAdapter = false)
data class ShelfDto(val title: String, val items: List<TrackDto> = emptyList())

@JsonClass(generateAdapter = false)
data class HomeResponse(
    val shelves: List<ShelfDto> = emptyList(),
    val seeds: List<String>? = emptyList(),
    val hasMore: Boolean? = false,
    val needsOnboarding: Boolean? = false,
    val radios: List<RadioCategoryDto> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class RadioCategoryDto(
    val id: String,
    val title: String,
)

@JsonClass(generateAdapter = false)
data class RadioMixResponse(
    val tracks: List<TrackDto> = emptyList(),
    val seed: TrackDto? = null,
    val cached: Boolean? = null,
    val target: Int? = null,
    val generatedAt: Long? = null,
)

@JsonClass(generateAdapter = false)
data class PinDto(
    val id: String? = null,
    val kind: String? = null,
    val targetId: String? = null,
    val payload: TrackDto? = null,
)

@JsonClass(generateAdapter = false)
data class PinsResponse(
    val pins: List<PinDto> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class SearchResponse(
    val topResult: TrackDto? = null,
    val songs: List<TrackDto> = emptyList(),
    val videos: List<TrackDto> = emptyList(),
    val albums: List<TrackDto> = emptyList(),
    val artists: List<TrackDto> = emptyList(),
    val playlists: List<TrackDto> = emptyList(),
    val podcasts: List<TrackDto> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class SpokenExploreResponse(
    val title: String? = null,
    val items: List<TrackDto> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class TrackInfoResponse(
    val track: TrackDto,
    val streamUrl: String? = null,
    val cached: Boolean? = false,
)
