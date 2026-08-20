package ovh.delhomme.ytmusic.data

import com.squareup.moshi.JsonClass
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Query

@JsonClass(generateAdapter = false)
data class PlaylistDto(
    val id: String,
    val name: String? = null,
    val title: String? = null,
    val description: String? = null,
    val tracks: List<TrackDto>? = emptyList(),
    val coverUrl: String? = null,
    val thumbnails: List<Thumb>? = emptyList(),
    val updatedAt: Long? = null,
    val createdAt: Long? = null,
    val trackCount: Int? = null,
) {
    fun displayName(): String = name?.ifBlank { null } ?: title ?: "Playlist"
    fun cover(): String? =
        coverUrl ?: thumbnails?.firstOrNull()?.url ?: tracks?.firstOrNull()?.coverUrl()
    fun resolvedTrackCount(): Int =
        trackCount?.takeIf { it > 0 } ?: tracks?.size ?: 0
}

@JsonClass(generateAdapter = false)
data class LibraryResponse(
    val songs: List<TrackDto> = emptyList(),
    val liked: List<TrackDto> = emptyList(),
    val likedPlaylists: List<TrackDto> = emptyList(),
    val albums: List<TrackDto> = emptyList(),
    val artists: List<TrackDto> = emptyList(),
    val mixes: List<TrackDto> = emptyList(),
    val playlists: List<PlaylistDto> = emptyList(),
    val history: List<TrackDto> = emptyList(),
    val recentEntities: List<TrackDto> = emptyList(),
    val downloaded: List<String> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class LikeResponse(val liked: Boolean, val library: LibraryResponse? = null)

@JsonClass(generateAdapter = false)
data class DeviceLoginStartResponse(
    val id: String,
    val code: String,
    val pollSecret: String,
    val expiresAt: Long,
    val approveUrl: String,
)

@JsonClass(generateAdapter = false)
data class DeviceLoginPollResponse(
    val status: String,
    val error: String? = null,
    val user: UserDto? = null,
    val token: String? = null,
    val refreshToken: String? = null,
)

@JsonClass(generateAdapter = false)
data class DeviceLoginInviteResponse(
    val id: String,
    val claimToken: String,
    val expiresAt: Long,
    val claimUrl: String,
)

@JsonClass(generateAdapter = false)
data class ApkInfoResponse(
    val ready: Boolean? = false,
    val versionName: String? = null,
    val versionCode: Int? = null,
    val apiBaseUrl: String? = null,
    val builtAt: String? = null,
    val sizeBytes: Long? = null,
    val downloadPath: String? = null,
    val downloadUrl: String? = null,
)

@JsonClass(generateAdapter = false)
data class LibrarySongResponse(val saved: Boolean, val library: LibraryResponse? = null)

@JsonClass(generateAdapter = false)
data class CreatePlaylistBody(val name: String, val description: String? = null)

@JsonClass(generateAdapter = false)
data class UpdatePlaylistBody(val name: String? = null, val description: String? = null)

@JsonClass(generateAdapter = false)
data class PlaybackStateDto(
    val current: TrackDto? = null,
    val queue: List<TrackDto> = emptyList(),
    val queueIndex: Int = 0,
    val userQueueEnd: Int? = null,
    val autoplay: Boolean? = null,
    val isPlaying: Boolean = false,
    /** Position en secondes (aligné web / WS). */
    val progress: Double = 0.0,
    val duration: Double = 0.0,
    val volume: Double = 0.9,
    val shuffle: Boolean = false,
    val repeat: String? = "off",
    val updatedAt: Long? = null,
)

@JsonClass(generateAdapter = false)
data class SessionSnapshot(
    val devices: List<DeviceDto> = emptyList(),
    val activePlayerId: String? = null,
    val state: PlaybackStateDto? = null,
)

@JsonClass(generateAdapter = false)
data class DeviceDto(
    val id: String,
    val name: String,
    val type: String? = null,
    val canPlay: Boolean? = true,
    val isActive: Boolean? = false,
)

@JsonClass(generateAdapter = false)
data class AlbumMetaDto(
    val id: String,
    val title: String,
    val year: String? = null,
    val releaseType: String? = null,
    val artists: List<ArtistRef>? = emptyList(),
    val thumbnails: List<Thumb>? = emptyList(),
) {
    fun asTrack(): TrackDto = TrackDto(
        id = id,
        title = title,
        artists = artists,
        thumbnails = thumbnails,
        type = "album",
    )
}

@JsonClass(generateAdapter = false)
data class ArtistMetaDto(
    val id: String,
    val name: String,
    val subscribers: String? = null,
    val thumbnails: List<Thumb>? = emptyList(),
    val description: String? = null,
) {
    fun asTrack(): TrackDto = TrackDto(
        id = id,
        title = name,
        artists = listOf(ArtistRef(name, id)),
        thumbnails = thumbnails,
        type = "artist",
    )
}

@JsonClass(generateAdapter = false)
data class PlaylistDetailResponse(
    val playlist: PlaylistDto? = null,
    val tracks: List<TrackDto> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class AlbumDetailResponse(
    val album: AlbumMetaDto? = null,
    val tracks: List<TrackDto> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class ArtistDetailResponse(
    val artist: ArtistMetaDto? = null,
    val songs: List<TrackDto>? = emptyList(),
    val tracks: List<TrackDto>? = emptyList(),
    val albums: List<TrackDto>? = emptyList(),
    val singles: List<TrackDto>? = emptyList(),
    val videos: List<TrackDto>? = emptyList(),
    val featured: List<TrackDto>? = emptyList(),
    val similar: List<TrackDto>? = emptyList(),
    val playlists: List<TrackDto>? = emptyList(),
)

@JsonClass(generateAdapter = false)
data class ArtistSongsResponse(
    val artist: ArtistMetaDto? = null,
    val tracks: List<TrackDto> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class SimilarResponse(
    val tracks: List<TrackDto> = emptyList(),
    val related: List<TrackDto> = emptyList(),
    val radio: List<TrackDto> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class RelatedResponse(
    val related: List<TrackDto> = emptyList(),
    val radio: List<TrackDto> = emptyList(),
    val tracks: List<TrackDto> = emptyList(),
    val cached: Boolean? = null,
    val target: Int? = null,
    val generatedAt: Long? = null,
)

@JsonClass(generateAdapter = false)
data class TracksResponse(
    val tracks: List<TrackDto> = emptyList(),
    val cached: Boolean? = null,
    val target: Int? = null,
    val generatedAt: Long? = null,
)

@JsonClass(generateAdapter = false)
data class TimedLyricLine(
    /** Accepte Int/Long/Double JSON via Moshi (sinon timed vide → pas de karaoke). */
    val startMs: Double = 0.0,
    val text: String = "",
) {
    fun startMsLong(): Long = startMs.toLong().coerceAtLeast(0L)
}

@JsonClass(generateAdapter = false)
data class LyricsResponse(
    val lyrics: String? = null,
    val timed: List<TimedLyricLine>? = null,
    val source: String? = null,
    val syncOffsetMs: Long? = null,
)

@JsonClass(generateAdapter = false)
data class RecoFeedbackBody(
    val trackId: String,
    val verdict: String,
    val context: String? = null,
)

@JsonClass(generateAdapter = false)
data class UserPrefsDto(
    val genres: List<String> = emptyList(),
    val moods: List<String> = emptyList(),
    val moments: List<String> = emptyList(),
    val onboardingDone: Boolean = false,
    val discoveryBias: Double = 0.1,
    val autoplaySuggestions: Boolean = true,
)

@JsonClass(generateAdapter = false)
data class ArtistFollowDto(
    val artist_id: String? = null,
    val artist_name: String? = null,
    val id: String? = null,
    val name: String? = null,
) {
    fun artistId(): String = artist_id ?: id ?: ""
    fun artistName(): String = artist_name ?: name ?: "Artiste"
}

@JsonClass(generateAdapter = false)
data class PrefsResponse(
    val prefs: UserPrefsDto,
    val follows: List<ArtistFollowDto> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class OfflineJobDto(
    val id: String = "",
    val kind: String? = null,
    val target_id: String? = null,
    val status: String? = null,
    val progress: Int = 0,
    val total: Int = 0,
) {
    fun pct(): Float {
        if (total <= 0) return if (status == "done") 1f else 0f
        return (progress.toFloat() / total).coerceIn(0f, 1f)
    }

    fun done(): Boolean = status == "done" || (total > 0 && progress >= total)
}

@JsonClass(generateAdapter = false)
data class OfflineStatusResponse(val jobs: List<OfflineJobDto> = emptyList())

@JsonClass(generateAdapter = false)
data class OfflineDownloadsResponse(val downloads: List<OfflineDownloadDto> = emptyList())

@JsonClass(generateAdapter = false)
data class PlaylistsContainingResponse(
    val playlistIds: List<String> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class LibraryContainsResponse(
    val liked: Boolean = false,
    val inLibrary: Boolean = false,
    val albumInLibrary: Boolean = false,
)

@JsonClass(generateAdapter = false)
data class OfflineDownloadDto(
    val trackId: String = "",
    val status: String? = null,
    val path: String? = null,
)

@JsonClass(generateAdapter = false)
data class SavePrefsBody(
    val genres: List<String>? = null,
    val moods: List<String>? = null,
    val moments: List<String>? = null,
    val discoveryBias: Double? = null,
    val onboardingDone: Boolean? = null,
    val autoplaySuggestions: Boolean? = null,
)

@JsonClass(generateAdapter = false)
data class OnboardingBody(
    val genres: List<String> = emptyList(),
    val moods: List<String> = emptyList(),
    val moments: List<String> = emptyList(),
    val discoveryBias: Double = 0.15,
    val artists: List<FollowArtistBody> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class FollowArtistBody(
    val id: String,
    val name: String? = null,
)

@JsonClass(generateAdapter = false)
data class ListenBody(
    val trackId: String,
    val event: String,
    val progressPct: Double? = null,
    val durationMs: Long? = null,
    val track: TrackDto? = null,
)

@JsonClass(generateAdapter = false)
data class IdentifySearchBody(
    val audioBase64: String,
    val mimeType: String? = "audio/mp4",
    /** `listen` = micro vers la musique · `hum` = fredonnement */
    val mode: String = "listen",
)

@JsonClass(generateAdapter = false)
data class IdentifySearchResponse(
    val ok: Boolean = false,
    val query: String? = null,
    val title: String? = null,
    val artist: String? = null,
    val album: String? = null,
    val score: Double? = null,
    val provider: String? = null,
    val search: SearchResponse? = null,
    val error: String? = null,
    val hint: String? = null,
)

@JsonClass(generateAdapter = false)
data class HistoryEntityBody(
    val id: String,
    val kind: String,
    val title: String? = null,
    val name: String? = null,
    val thumbnails: List<Thumb>? = null,
    val artists: List<ArtistRef>? = null,
    val type: String? = null,
)

@JsonClass(generateAdapter = false)
data class HistoryEntityResponse(
    val ok: Boolean? = null,
    val entities: List<TrackDto> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class HistoryListResponse(
    val history: List<TrackDto> = emptyList(),
    val entities: List<TrackDto> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class ListenEventDto(
    val id: String = "",
    val trackId: String? = null,
    val event: String? = null,
    val status: String? = null,
    val progressPct: Double? = null,
    val durationMs: Long? = null,
    val createdAt: Long = 0L,
    val track: TrackDto? = null,
)

@JsonClass(generateAdapter = false)
data class HistoryDetailedResponse(
    val events: List<ListenEventDto> = emptyList(),
)

@JsonClass(generateAdapter = false)
data class YtmAccountDto(
    val connected: Boolean = false,
    val canSyncLibrary: Boolean = false,
    val hasCookie: Boolean = false,
    val hasOauth: Boolean = false,
    val connectedAt: Long? = null,
    val lastSyncAt: Long? = null,
    val lastSyncSummary: String? = null,
    val hint: String? = null,
    val syncRunning: Boolean? = false,
    val syncError: String? = null,
)

@JsonClass(generateAdapter = false)
data class YtmStatusResponse(val account: YtmAccountDto)

@JsonClass(generateAdapter = false)
data class YtmCookieBody(val cookie: String)

@JsonClass(generateAdapter = false)
data class YtmOauthStartResponse(
    val verificationUrl: String? = null,
    val userCode: String? = null,
    val expiresIn: Int? = null,
)

@JsonClass(generateAdapter = false)
data class YtmOauthStatusResponse(
    val status: String,
    val verificationUrl: String? = null,
    val userCode: String? = null,
    val error: String? = null,
)

@JsonClass(generateAdapter = false)
data class YtmSyncStats(
    val songs: Int = 0,
    val librarySongs: Int = 0,
    val albums: Int = 0,
    val artists: Int = 0,
    val playlists: Int = 0,
    val playlistTracks: Int = 0,
    val likedSongsPlaylist: Int = 0,
    val history: Int = 0,
)

@JsonClass(generateAdapter = false)
data class YtmSyncResponse(
    val ok: Boolean? = null,
    val running: Boolean? = null,
    val stats: YtmSyncStats? = null,
    val library: LibraryResponse? = null,
    val account: YtmAccountDto? = null,
)

interface YtMusicApi {
    @GET("api/health")
    suspend fun health(): Map<String, Any>

    @GET("api/auth/me")
    suspend fun me(): MeResponse

    @GET("api/auth/config")
    suspend fun authConfig(): AuthConfigResponse

    @POST("api/auth/login")
    suspend fun login(@Body body: LoginBody): AuthResponse

    @POST("api/auth/register")
    suspend fun register(@Body body: RegisterBody): AuthResponse

    @POST("api/auth/refresh")
    suspend fun refresh(@Body body: RefreshBody): AuthResponse

    @POST("api/auth/logout")
    suspend fun logout(@Body body: RefreshBody = RefreshBody(null)): Map<String, Any>

    @POST("api/telemetry")
    suspend fun telemetry(@Body body: Map<String, @JvmSuppressWildcards Any?>): Map<String, Any>

    @POST("api/telemetry/batch")
    suspend fun telemetryBatch(@Body body: Map<String, @JvmSuppressWildcards Any?>): Map<String, Any>

    @POST("api/telemetry/battery-report")
    suspend fun batteryReport(@Body body: Map<String, @JvmSuppressWildcards Any?>): Map<String, Any>

    @POST("api/auth/device-login/approve")
    suspend fun deviceLoginApprove(@Body body: Map<String, String>): Map<String, Any>

    @POST("api/auth/device-login/invite")
    suspend fun deviceLoginInvite(): DeviceLoginInviteResponse

    @POST("api/auth/device-login/claim")
    suspend fun deviceLoginClaim(@Body body: Map<String, String>): AuthResponse

    @POST("api/auth/device-login/start")
    suspend fun deviceLoginStart(): DeviceLoginStartResponse

    @POST("api/auth/device-login/poll")
    suspend fun deviceLoginPoll(@Body body: Map<String, String>): DeviceLoginPollResponse

    @GET("api/deploy/apk/info")
    suspend fun apkInfo(): ApkInfoResponse

    @GET("api/home")
    suspend fun home(): HomeResponse

    @GET("api/home/more")
    suspend fun homeMore(
        @Query("page") page: Int,
        @Query("seeds") seeds: String,
    ): HomeResponse

    @GET("api/explore")
    suspend fun explore(): HomeResponse

    @GET("api/explore/spoken")
    suspend fun exploreSpoken(
        @Query("kind") kind: String = "podcast",
    ): SpokenExploreResponse

    @GET("api/search")
    suspend fun search(
        @Query("q") q: String,
        @Query("filter") filter: String = "all",
        @Query("noHistory") noHistory: String? = null,
    ): SearchResponse

    @POST("api/search/history")
    suspend fun recordSearchClick(@Body body: Map<String, String>): Map<String, Any>

    @GET("api/track/{id}")
    suspend fun track(@Path("id") id: String): TrackInfoResponse

    @GET("api/track/{id}/related")
    suspend fun related(
        @Path("id") id: String,
        @Query("fast") fast: Int? = null,
        @Query("full") full: Int? = null,
    ): RelatedResponse

    @GET("api/track/{id}/upnext")
    suspend fun upNext(@Path("id") id: String): TracksResponse

    @GET("api/track/{id}/lyrics")
    suspend fun lyrics(@Path("id") id: String): LyricsResponse

    @GET("api/reco/similar/{trackId}")
    suspend fun similar(@Path("trackId") trackId: String): SimilarResponse

    @GET("api/library")
    suspend fun library(): LibraryResponse

    @POST("api/library/like")
    suspend fun like(@Body track: TrackDto): LikeResponse

    @POST("api/library/songs")
    suspend fun toggleLibrarySong(@Body track: TrackDto): LibrarySongResponse

    @DELETE("api/library/songs/{id}")
    suspend fun removeLibrarySong(@Path("id") id: String): LibrarySongResponse

    @POST("api/library/like-playlist")
    suspend fun likePlaylist(@Body playlist: TrackDto): LikeResponse

    @POST("api/library/albums")
    suspend fun saveAlbum(@Body album: TrackDto): Map<String, Any>

    @DELETE("api/library/albums/{id}")
    suspend fun removeAlbum(@Path("id") id: String): Map<String, Any>

    @POST("api/library/artists")
    suspend fun saveArtist(@Body artist: TrackDto): Map<String, Any>

    @DELETE("api/library/artists/{id}")
    suspend fun removeArtist(@Path("id") id: String): Map<String, Any>

    @POST("api/library/mixes")
    suspend fun saveMix(@Body body: Map<String, @JvmSuppressWildcards Any>): Map<String, Any>

    @DELETE("api/library/mixes/{id}")
    suspend fun removeMix(@Path("id") id: String): Map<String, Any>

    @POST("api/library/playlists")
    suspend fun createPlaylist(@Body body: CreatePlaylistBody): PlaylistDto

    @GET("api/library/playlists/{id}")
    suspend fun libraryPlaylist(@Path("id") id: String): PlaylistDto

    @PATCH("api/library/playlists/{id}")
    suspend fun updatePlaylist(
        @Path("id") id: String,
        @Body body: UpdatePlaylistBody,
    ): PlaylistDto

    @DELETE("api/library/playlists/{id}")
    suspend fun deletePlaylist(@Path("id") id: String): Map<String, @JvmSuppressWildcards Any>

    @POST("api/library/playlists/{id}/tracks")
    suspend fun addToPlaylist(@Path("id") id: String, @Body track: TrackDto): PlaylistDto

    @DELETE("api/library/playlists/{id}/tracks/{trackId}")
    suspend fun removeFromPlaylist(
        @Path("id") id: String,
        @Path("trackId") trackId: String,
    ): PlaylistDto

    @GET("api/playlist/{id}")
    suspend fun playlist(@Path("id") id: String): PlaylistDetailResponse

    @GET("api/album/{id}")
    suspend fun album(@Path("id") id: String): AlbumDetailResponse

    @GET("api/album/{id}/radio")
    suspend fun albumRadio(
        @Path("id") id: String,
        @Query("full") full: Int? = null,
    ): TracksResponse

    @GET("api/artist/{id}")
    suspend fun artist(@Path("id") id: String): ArtistDetailResponse

    @GET("api/artist/{id}/songs")
    suspend fun artistSongs(
        @Path("id") id: String,
        @Query("limit") limit: Int? = null,
    ): ArtistSongsResponse

    @GET("api/artist/{id}/radio")
    suspend fun artistRadio(
        @Path("id") id: String,
        @Query("full") full: Int? = null,
    ): TracksResponse

    @GET("api/session")
    suspend fun session(): SessionSnapshot

    @PUT("api/session/state")
    suspend fun publishSessionState(@Body body: Map<String, @JvmSuppressWildcards Any?>): SessionSnapshot

    @POST("api/session/device")
    suspend fun registerSessionDevice(@Body body: Map<String, @JvmSuppressWildcards Any?>): SessionSnapshot

    @POST("api/session/active")
    suspend fun setSessionActive(@Body body: Map<String, @JvmSuppressWildcards Any?>): SessionSnapshot

    @POST("api/session/transfer")
    suspend fun transferSession(@Body body: Map<String, @JvmSuppressWildcards Any?>): SessionSnapshot

    @POST("api/download/{id}")
    suspend fun download(
        @Path("id") id: String,
        @Query("ack") ack: Int? = null,
    ): Map<String, Any>

    @GET("api/library/playlists/containing/{trackId}")
    suspend fun playlistsContaining(@Path("trackId") trackId: String): PlaylistsContainingResponse

    @GET("api/library/contains")
    suspend fun libraryContains(
        @Query("trackId") trackId: String? = null,
        @Query("albumId") albumId: String? = null,
    ): LibraryContainsResponse

    @POST("api/offline/start")
    suspend fun offlineStart(@Body body: Map<String, String>): Map<String, Any>

    @GET("api/offline")
    suspend fun offlineStatus(): OfflineStatusResponse

    @GET("api/offline/downloads")
    suspend fun offlineDownloads(): OfflineDownloadsResponse

    @POST("api/reco/feedback")
    suspend fun recoFeedback(@Body body: RecoFeedbackBody): Map<String, Any>

    @GET("api/prefs")
    suspend fun prefs(): PrefsResponse

    @PUT("api/prefs")
    suspend fun savePrefs(@Body body: SavePrefsBody): PrefsResponse

    @POST("api/prefs/onboarding")
    suspend fun onboarding(@Body body: OnboardingBody): PrefsResponse

    @POST("api/artists/{id}/follow")
    suspend fun followArtist(@Path("id") id: String, @Body body: FollowArtistBody): Map<String, Any>

    @DELETE("api/artists/{id}/follow")
    suspend fun unfollowArtist(@Path("id") id: String): Map<String, Any>

    @POST("api/listen")
    suspend fun listen(@Body body: ListenBody): Map<String, Any>

    @GET("api/history")
    suspend fun history(): HistoryListResponse

    @GET("api/history/detailed")
    suspend fun historyDetailed(): HistoryDetailedResponse

    @POST("api/history/entity")
    suspend fun recordEntityPlay(@Body body: HistoryEntityBody): HistoryEntityResponse

    @GET("api/ytm/status")
    suspend fun ytmStatus(): YtmStatusResponse

    @POST("api/ytm/connect/cookie")
    suspend fun ytmConnectCookie(@Body body: YtmCookieBody): YtmStatusResponse

    @POST("api/ytm/connect/oauth")
    suspend fun ytmConnectOauth(): YtmOauthStartResponse

    @GET("api/ytm/oauth/status")
    suspend fun ytmOauthStatus(): YtmOauthStatusResponse

    @POST("api/ytm/sync")
    suspend fun ytmSync(): YtmSyncResponse

    @DELETE("api/ytm/disconnect")
    suspend fun ytmDisconnect(): YtmStatusResponse

    @GET("api/reco/radios")
    suspend fun radios(): Map<String, Any>

    @GET("api/reco/radio/{category}")
    suspend fun recoRadio(
        @Path("category") category: String,
        @Query("preview") preview: Int? = null,
    ): RadioMixResponse

    @GET("api/pins")
    suspend fun pins(): PinsResponse

    @POST("api/pins")
    suspend fun addPin(@Body body: Map<String, @JvmSuppressWildcards Any?>): PinsResponse

    /** Upsert multi-appareils — union serveur. */
    @POST("api/pins/sync")
    suspend fun syncPins(@Body body: Map<String, @JvmSuppressWildcards Any?>): PinsResponse

    @DELETE("api/pins/{id}")
    suspend fun removePin(@Path("id") id: String): PinsResponse

    @GET("api/search/history")
    suspend fun searchHistory(): Map<String, Any>

    @GET("api/search/suggestions")
    suspend fun searchSuggestions(@Query("q") q: String): Map<String, Any>

    @POST("api/search/history")
    suspend fun recordSearchHistory(@Body body: Map<String, @JvmSuppressWildcards Any?>): Map<String, Any>

    /** Reconnaissance audio (écoute / fredonnement) → query + résultats. */
    @POST("api/search/identify")
    suspend fun identifySearch(@Body body: IdentifySearchBody): IdentifySearchResponse

    @GET("api/stream/{id}/url")
    suspend fun streamResolveUrl(
        @Path("id") id: String,
        @Query("type") type: String? = null,
    ): Map<String, Any>
}
