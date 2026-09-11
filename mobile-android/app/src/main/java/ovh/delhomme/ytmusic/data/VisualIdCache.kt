package ovh.delhomme.ytmusic.data

import android.content.Context

/**
 * Cache local audioId → visualId (complète l’index serveur visual_cache).
 * Skip resolve réseau au 2ᵉ passage mode Vidéo.
 * Stocke aussi la durée clip mesurée (comme durationSeconds sur le titre audio).
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

    /** Durée clip associée au titre audio (ms), si déjà mesurée. */
    fun getClipDurationMs(context: Context, audioId: String): Long? {
        val id = audioId.trim()
        if (id.length != 11) return null
        val sec = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getInt("dur:$id", 0)
        return sec.takeIf { it > 0 }?.times(1000L)
    }

    fun putClipDurationMs(context: Context, audioId: String, durationMs: Long) {
        val a = audioId.trim()
        if (a.length != 11 || durationMs < 5_000L) return
        val sec = ((durationMs + 500L) / 1000L).toInt().coerceAtLeast(1)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putInt("dur:$a", sec)
            .apply()
    }

    fun remove(context: Context, audioId: String) {
        val a = audioId.trim()
        if (a.length != 11) return
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .remove(a)
            .remove("dur:$a")
            .apply()
    }
}
