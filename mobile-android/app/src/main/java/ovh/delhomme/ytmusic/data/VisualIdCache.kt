package ovh.delhomme.ytmusic.data

import android.content.Context

/**
 * Cache local audioId → visualId (complète l’index serveur visual_cache).
 * Skip resolve réseau au 2ᵉ passage mode Vidéo.
 */
object VisualIdCache {
    private const val PREFS = "plm_visual_id_v1"

    fun get(context: Context, audioId: String): String? {
        val id = audioId.trim()
        if (id.length != 11) return null
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(id, null)
            ?.takeIf { it.length == 11 }
    }

    fun put(context: Context, audioId: String, visualId: String) {
        val a = audioId.trim()
        val v = visualId.trim()
        if (a.length != 11 || v.length != 11) return
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(a, v)
            .apply()
    }
}
