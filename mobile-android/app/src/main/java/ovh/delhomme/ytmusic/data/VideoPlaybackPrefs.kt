package ovh.delhomme.ytmusic.data

import android.content.Context

/** Préférences lecture vidéo (persistées). */
object VideoPlaybackPrefs {
    private const val PREFS = "plm_video_playback_v1"
    private const val KEY_FS_CONTROLS = "fs_media_controls"

    /** Overlay type lecteur multimédia en plein écran (seek + play/pause/prev/next). Défaut : on. */
    fun fullscreenControls(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(KEY_FS_CONTROLS, true)

    fun setFullscreenControls(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_FS_CONTROLS, enabled)
            .apply()
    }
}
