package ovh.delhomme.ytmusic.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Cache léger des têtes Aléatoire / Tout lire (ids seulement).
 * Évite de reshuffle + warm froid à chaque tap — refresh en arrière-plan.
 */
object ShuffleHeadStore {
    private const val PREFS = "plm_shuffle_heads"
    private const val TTL_MS = 45 * 60_000L
    private const val HEAD_N = 12

    private fun prefs(ctx: Context) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun keyFor(source: String, fingerprint: String): String =
        "$source:${fingerprint.take(48)}"

    /** Empreinte stable d’une file (taille + quelques ids). */
    fun fingerprint(tracks: List<TrackDto>): String {
        if (tracks.isEmpty()) return "empty"
        val n = tracks.size
        val a = tracks.firstOrNull()?.id.orEmpty()
        val b = tracks.getOrNull(n / 2)?.id.orEmpty()
        val c = tracks.lastOrNull()?.id.orEmpty()
        return "$n:$a:$b:$c"
    }

    fun loadHead(ctx: Context, key: String): List<String>? {
        val raw = prefs(ctx).getString(key, null) ?: return null
        return runCatching {
            val o = JSONObject(raw)
            val at = o.optLong("at", 0L)
            if (at > 0L && System.currentTimeMillis() - at > TTL_MS) return null
            val arr = o.getJSONArray("ids")
            buildList {
                for (i in 0 until arr.length()) {
                    val id = arr.optString(i)
                    if (id.length == 11) add(id)
                }
            }.takeIf { it.isNotEmpty() }
        }.getOrNull()
    }

    fun saveHead(ctx: Context, key: String, ids: List<String>) {
        val trimmed = ids.filter { it.length == 11 }.distinct().take(HEAD_N)
        if (trimmed.isEmpty()) return
        val o = JSONObject()
            .put("at", System.currentTimeMillis())
            .put("ids", JSONArray(trimmed))
        prefs(ctx).edit().putString(key, o.toString()).apply()
    }

    /** Réordonne [all] pour commencer par [headIds] (présents), reste shuffled. */
    fun applyHead(all: List<TrackDto>, headIds: List<String>): List<TrackDto> {
        if (all.isEmpty() || headIds.isEmpty()) return all
        val byId = all.associateBy { it.id }
        val head = headIds.mapNotNull { byId[it] }
        val seen = head.map { it.id }.toHashSet()
        val rest = all.filter { it.id !in seen }.shuffled()
        return head + rest
    }
}
