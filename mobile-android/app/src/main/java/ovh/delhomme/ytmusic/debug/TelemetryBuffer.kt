package ovh.delhomme.ytmusic.debug

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Tampon disque compact pour télémétrie hors-ligne.
 * ≤ 20 events, ≤ 64 Ko, coalescé — un flush unique au retour réseau.
 */
object TelemetryBuffer {
    private const val MAX_EVENTS = 20
    private const val MAX_BYTES = 64 * 1024
    private val lock = Any()

    private fun file(ctx: Context): File = File(ctx.applicationContext.filesDir, "telemetry-buffer.json")

    private fun load(ctx: Context): JSONArray {
        val f = file(ctx)
        if (!f.exists() || f.length() == 0L) return JSONArray()
        return runCatching { JSONArray(f.readText()) }.getOrDefault(JSONArray())
    }

    private fun persist(ctx: Context, arr: JSONArray) {
        val f = file(ctx)
        var raw = arr.toString()
        while (raw.length > MAX_BYTES && arr.length() > 1) {
            arr.remove(0)
            raw = arr.toString()
        }
        f.writeText(raw.take(MAX_BYTES))
    }

    fun enqueue(ctx: Context, compact: JSONObject) {
        synchronized(lock) {
            val arr = load(ctx)
            val key = compact.optString("key")
            if (key.isNotBlank()) {
                for (i in 0 until arr.length()) {
                    val it = arr.optJSONObject(i) ?: continue
                    if (it.optString("key") == key) {
                        it.put("count", it.optInt("count", 1) + compact.optInt("count", 1))
                        it.put("ts", compact.optLong("ts", System.currentTimeMillis()))
                        if (compact.has("message")) it.put("message", compact.optString("message"))
                        persist(ctx, arr)
                        return
                    }
                }
            }
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
                it.keys().forEach { k -> map[k] = it.opt(k) }
                out.add(map)
            }
            return out
        }
    }

    fun pendingCount(ctx: Context): Int = synchronized(lock) { load(ctx).length() }
}
