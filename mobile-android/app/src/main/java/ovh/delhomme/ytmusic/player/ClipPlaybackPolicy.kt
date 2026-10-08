package ovh.delhomme.ytmusic.player

/**
 * Clip officiel Hubera / YouTube Music : TextureView (SurfaceView = image noire
 * sous Compose) et pas le SimpleCache audio (octets titre ≠ piste vidéo).
 */
object ClipPlaybackPolicy {
    const val USE_TEXTURE_VIEW = true

    fun shouldUseSimpleCacheForClip(uri: String?): Boolean {
        if (uri.isNullOrBlank()) return false
        if (LocalPlaybackPolicy.shouldKeepLocalFileUri(uri)) return false
        return false
    }

    fun clipOwnsTimeline(videoMode: Boolean, musicDucked: Boolean): Boolean =
        videoMode && musicDucked
}
