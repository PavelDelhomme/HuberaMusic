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
    private const val MAX_EVENTS = 2_500
    private const val MAX_BYTES = 2 * 1024 * 1024
    /** Horodatages conservés par groupe : assez pour lire le rythme d'une rafale. */
    private const val MAX_TIMES = 500
    private val lock = Any()

    private fun file(ctx: Context): File = File(ctx.applicationContext.filesDir, "telemetry-buffer.json")

    private fun load(ctx: Context): JSONArray {
        val f = file(ctx)
        if (!f.exists() || f.length() == 0L) return JSONArray()
        return runCatching { JSONArray(f.readText()) }.getOrDefault(JSONArray())
    }

    /**
     * Sous la contrainte de taille, on sacrifie d'abord le journal des entrées
     * les plus anciennes : perdre du contexte vaut mieux que perdre l'erreur.
     */
    private fun persist(ctx: Context, arr: JSONArray) {
        var raw = arr.toString()
        var i = 0
        while (raw.length > MAX_BYTES && i < arr.length()) {
            val item = arr.optJSONObject(i)
            if (item != null && (item.has("recentLogs") || item.has("breadcrumbs"))) {
                item.remove("recentLogs")
                item.remove("breadcrumbs")
                raw = arr.toString()
            }
            i++
        }
        while (raw.length > MAX_BYTES && arr.length() > 1) {
            arr.remove(0)
            raw = arr.toString()
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
