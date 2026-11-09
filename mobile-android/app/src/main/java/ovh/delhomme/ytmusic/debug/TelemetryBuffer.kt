package ovh.delhomme.ytmusic.debug

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Tampon disque des erreurs survenues sans réseau, vidé au retour de la
 * connexion.
 *
 * Il ne gardait qu'une vingtaine d'entrées réduites à un message de deux cent
 * quarante caractères : au retour du réseau, le mail d'alerte n'avait plus rien
 * à raconter. On conserve désormais le détail complet de chaque erreur
 * distincte — pile d'appels, diagnostic, journal — dans la limite d'un demi-
 * mégaoctet.
 *
 * Les répétitions strictement identiques ne sont pas dupliquées : elles
 * incrémentent un compteur et déposent leur horodatage, ce qui restitue la
 * chronologie d'une avalanche sans en payer le poids mille fois.
 */
object TelemetryBuffer {
    /** Digest compact au retour réseau (E21) — assez pour un mail, pas une avalanche. */
    private const val MAX_EVENTS = 80
    private const val MAX_BYTES = 256 * 1024
    /** Horodatages conservés par groupe : assez pour lire le rythme d’une rafale. */
    private const val MAX_TIMES = 40
    private val lock = Any()

    private fun file(ctx: Context): File = File(ctx.applicationContext.filesDir, "telemetry-buffer.json")

    private fun load(ctx: Context): JSONArray {
        val f = file(ctx)
        if (!f.exists() || f.length() == 0L) return JSONArray()
        return runCatching { JSONArray(f.readText()) }.getOrDefault(JSONArray())
    }

    /**
     * Sous la contrainte de taille : d’abord jeter les **plus anciennes** erreurs
     * entières, puis seulement rogner logs/crumbs des entrées restantes (jamais
     * la plus récente — c’est elle qui alimente le mail au retour réseau).
     */
    private fun persist(ctx: Context, arr: JSONArray) {
        var raw = arr.toString()
        while (raw.length > MAX_BYTES && arr.length() > 1) {
            arr.remove(0)
            raw = arr.toString()
        }
        var i = 0
        val last = (arr.length() - 1).coerceAtLeast(0)
        while (raw.length > MAX_BYTES && i < arr.length()) {
            if (i == last && arr.length() == 1) break
            if (i == last) {
                i++
                continue
            }
            val item = arr.optJSONObject(i)
            if (item != null && (item.has("recentLogs") || item.has("breadcrumbs"))) {
                item.remove("recentLogs")
                item.remove("breadcrumbs")
                raw = arr.toString()
            }
            i++
        }
        // Dernier recours : tronquer les logs de la dernière entrée (garder breadcrumbs).
        if (raw.length > MAX_BYTES) {
            val item = arr.optJSONObject(last)
            if (item != null && item.has("recentLogs")) {
                val logs = item.optString("recentLogs")
                if (logs.length > 4_000) item.put("recentLogs", logs.takeLast(4_000))
                raw = arr.toString()
            }
        }
        file(ctx).writeText(raw.take(MAX_BYTES))
    }

    fun enqueue(ctx: Context, compact: JSONObject) {
        synchronized(lock) {
            val arr = load(ctx)
            val key = compact.optString("key")
            val now = compact.optLong("ts", System.currentTimeMillis())
            if (key.isNotBlank()) {
                for (i in 0 until arr.length()) {
                    val it = arr.optJSONObject(i) ?: continue
                    if (it.optString("key") != key) continue
                    it.put("count", it.optInt("count", 1) + compact.optInt("count", 1))
                    it.put("ts", now)
                    val times = it.optJSONArray("times") ?: JSONArray().also { a ->
                        a.put(it.optLong("firstTs", now))
                    }
                    if (times.length() < MAX_TIMES) times.put(now)
                    it.put("times", times)
                    if (compact.has("message")) it.put("message", compact.optString("message"))
                    // Rafraîchir crumbs/logs avec la dernière occurrence (sinon mail vide).
                    if (compact.has("breadcrumbs")) it.put("breadcrumbs", compact.get("breadcrumbs"))
                    if (compact.has("recentLogs")) it.put("recentLogs", compact.get("recentLogs"))
                    if (compact.has("stack")) it.put("stack", compact.optString("stack"))
                    if (compact.has("diagnosis")) it.put("diagnosis", compact.optString("diagnosis"))
                    persist(ctx, arr)
                    return
                }
            }
            compact.put("firstTs", now)
            while (arr.length() >= MAX_EVENTS) arr.remove(0)
            arr.put(compact)
            persist(ctx, arr)
        }
    }

    fun drain(ctx: Context): List<Map<String, Any?>> {
        synchronized(lock) {
            val arr = load(ctx)
            file(ctx).delete()
            val out = ArrayList<Map<String, Any?>>(arr.length())
            for (i in 0 until arr.length()) {
                val it = arr.optJSONObject(i) ?: continue
                val map = mutableMapOf<String, Any?>()
                it.keys().forEach { k ->
                    val v = it.opt(k)
                    // Retrofit sérialise mal les types org.json : on remet en types Kotlin.
                    map[k] = when (v) {
                        is JSONArray -> (0 until v.length()).map { idx -> v.opt(idx) }
                        else -> v
                    }
                }
                out.add(map)
            }
            return out
        }
    }

    fun pendingCount(ctx: Context): Int = synchronized(lock) { load(ctx).length() }
}
