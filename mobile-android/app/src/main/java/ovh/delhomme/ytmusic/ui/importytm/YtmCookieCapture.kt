package ovh.delhomme.ytmusic.ui.importytm

import android.webkit.CookieManager

/**
 * Agrège les cookies WebView YouTube / Google (y compris HttpOnly).
 * SAPISID ou __Secure-1PSID suffisent pour Innertube getLibrary — pas de Premium.
 */
object YtmCookieCapture {
    private val sources = listOf(
        "https://music.youtube.com",
        "https://www.youtube.com",
        "https://youtube.com",
        "https://m.youtube.com",
        "https://accounts.google.com",
        "https://www.google.com",
    )

    fun collect(): String {
        val cm = CookieManager.getInstance()
        val map = LinkedHashMap<String, String>()
        for (url in sources) {
            val raw = runCatching { cm.getCookie(url) }.getOrNull() ?: continue
            for (part in raw.split(';')) {
                val kv = part.trim()
                val eq = kv.indexOf('=')
                if (eq <= 0) continue
                val key = kv.substring(0, eq).trim()
                val value = kv.substring(eq + 1).trim()
                if (key.isBlank() || value.isBlank()) continue
                val prev = map[key]
                if (prev == null || value.length > prev.length) map[key] = value
            }
        }
        return map.entries.joinToString("; ") { "${it.key}=${it.value}" }
    }

    fun isComplete(cookie: String): Boolean {
        if (cookie.length < 40) return false
        val sapisid = Regex("""(?:^|;\s*)SAPISID=""").containsMatchIn(cookie)
        val psid = Regex("""(?:^|;\s*)__Secure-[13]PSID=""").containsMatchIn(cookie)
        return sapisid || psid
    }

    fun flush() {
        runCatching { CookieManager.getInstance().flush() }
    }

    fun clearSession() {
        val cm = CookieManager.getInstance()
        runCatching { cm.removeAllCookies(null) }
        runCatching { cm.flush() }
    }
}
