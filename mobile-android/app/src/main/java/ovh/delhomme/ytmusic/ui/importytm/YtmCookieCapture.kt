package ovh.delhomme.ytmusic.ui.importytm

import android.webkit.CookieManager
import android.webkit.WebView

/**
 * Cookies **YouTube Music** uniquement (pas accounts.google.com).
 * youtubei.js n’envoie SAPISIDHASH que si `SAPISID` est présent — Chrome
 * n’expose souvent que `__Secure-1PAPISID`. Un PSID Google tout seul → HTTP 400.
 */
object YtmCookieCapture {
    private val youtubeOrigins = listOf(
        "https://music.youtube.com",
        "https://www.youtube.com",
        "https://youtube.com",
        "https://m.youtube.com",
    )

    fun collect(): String {
        val map = LinkedHashMap<String, String>()
        ingest(map, youtubeOrigins, overwrite = true)
        return ensureSapisid(serialize(map))
    }

    fun isYtmHub(url: String?): Boolean {
        val parsed = runCatching { android.net.Uri.parse(url) }.getOrNull() ?: return false
        val host = parsed.host.orEmpty().lowercase()
        if (host != "music.youtube.com" && !host.endsWith(".music.youtube.com")) return false
        val path = parsed.path.orEmpty().lowercase()
        return "signin" !in path && "servicelogin" !in path
    }

    fun isConsent(url: String?): Boolean {
        val u = url.orEmpty().lowercase()
        return "consent.youtube.com" in u || "consent.google.com" in u
    }

    /** Login Google déjà passé : continue URL perdue → on ouvre YTM nous-mêmes. */
    fun isPostGoogleLogin(url: String?): Boolean {
        val u = url.orEmpty().lowercase()
        if (u.isBlank()) return false
        if ("checkcookie" in u) return true
        if ("myaccount.google.com" in u) return true
        if ("accounts.google.com" in u && ("signin/success" in u || "manageaccount" in u)) return true
        val onYoutube =
            "youtube.com" in u &&
                "music.youtube.com" !in u &&
                "accounts." !in u &&
                "consent." !in u &&
                "signin" !in u &&
                "servicelogin" !in u
        return onYoutube
    }

    fun hasGoogleSession(): Boolean {
        val raw = runCatching {
            CookieManager.getInstance().getCookie("https://accounts.google.com")
        }.getOrNull().orEmpty()
        return Regex("""(?:^|;\s*)(SID|__Secure-1PSID|LSID)=""").containsMatchIn(raw)
    }

    fun isComplete(cookie: String): Boolean {
        if (cookie.length < 40) return false
        return hasAuthCookie(cookie)
    }

    fun hasAuthCookie(cookie: String): Boolean {
        val sapisid = Regex("""(?:^|;\s*)SAPISID=""").containsMatchIn(cookie)
        val papisid = Regex("""(?:^|;\s*)__Secure-[13]PAPISID=""").containsMatchIn(cookie)
        return sapisid || papisid
    }

    fun keySummary(cookie: String): String =
        cookie.split(';').mapNotNull { part ->
            val eq = part.indexOf('=')
            if (eq <= 0) null else part.substring(0, eq).trim().takeIf { it.isNotEmpty() }
        }.joinToString(",")

    fun ingestJsCookies(webView: WebView, header: String) {
        val url = webView.url?.takeIf { it.startsWith("http") } ?: "https://music.youtube.com"
        val cm = CookieManager.getInstance()
        for (part in header.split(';')) {
            val kv = part.trim()
            if (kv.contains('=')) runCatching { cm.setCookie(url, kv) }
        }
    }

    fun decodeJsCookieString(raw: String?): String {
        if (raw.isNullOrBlank() || raw == "null") return ""
        var s = raw.trim()
        if (s.length >= 2 && s.first() == '"' && s.last() == '"') {
            s = s.substring(1, s.length - 1)
                .replace("\\\"", "\"")
                .replace("\\\\", "\\")
        }
        return s
    }

    fun ensureSapisid(cookie: String): String {
        if (Regex("""(?:^|;\s*)SAPISID=""").containsMatchIn(cookie)) return cookie
        val papisid = Regex("""(?:^|;\s*)__Secure-1PAPISID=([^;]+)""")
            .find(cookie)?.groupValues?.getOrNull(1)?.trim()
            ?: Regex("""(?:^|;\s*)__Secure-3PAPISID=([^;]+)""")
                .find(cookie)?.groupValues?.getOrNull(1)?.trim()
        if (papisid.isNullOrBlank()) return cookie
        return "SAPISID=$papisid; $cookie"
    }

    fun flush() {
        runCatching { CookieManager.getInstance().flush() }
    }

    fun clearThen(done: () -> Unit) {
        val cm = CookieManager.getInstance()
        val once = java.util.concurrent.atomic.AtomicBoolean(false)
        val run = {
            if (once.compareAndSet(false, true)) done()
        }
        runCatching {
            cm.removeAllCookies {
                runCatching { cm.flush() }
                run()
            }
        }.onFailure { run() }
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ run() }, 4_000)
    }

    fun clearSession() {
        clearThen {}
    }

    private fun ingest(map: LinkedHashMap<String, String>, urls: List<String>, overwrite: Boolean) {
        val cm = CookieManager.getInstance()
        for (url in urls) {
            val raw = runCatching { cm.getCookie(url) }.getOrNull() ?: continue
            for (part in raw.split(';')) {
                val kv = part.trim()
                val eq = kv.indexOf('=')
                if (eq <= 0) continue
                val key = kv.substring(0, eq).trim()
                val value = kv.substring(eq + 1).trim()
                if (key.isBlank() || value.isBlank()) continue
                if (overwrite || !map.containsKey(key)) map[key] = value
            }
        }
    }

    private fun serialize(map: Map<String, String>): String =
        map.entries.joinToString("; ") { "${it.key}=${it.value}" }
}
