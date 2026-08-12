package ovh.delhomme.ytmusic.data

import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * Comme le web `proxiedThumbUrl` : passe par `/api/img` pour éviter
 * les pochettes vides (ggpht flaky / ytimg bloqué selon réseau).
 */
object CoverUrlProxy {
    @Volatile
    var baseProvider: () -> String? = { null }

    fun apiBase(): String? = baseProvider()?.trim()?.trimEnd('/')?.takeIf { it.isNotBlank() }

    fun video(id: String, size: Int): String? {
        val base = apiBase() ?: return null
        val s = size.coerceIn(60, 800)
        return "$base/api/img?v=${enc(id)}&s=$s"
    }

    fun remote(url: String, size: Int): String? {
        val base = apiBase() ?: return null
        val s = size.coerceIn(60, 800)
        val vi = Regex("""i\.ytimg\.com/vi(?:_webp)?/([^/]+)/""", RegexOption.IGNORE_CASE)
            .find(url)
        if (vi != null) return "$base/api/img?v=${enc(vi.groupValues[1])}&s=$s"
        if (Regex("""googleusercontent|ggpht|yt3\.""", RegexOption.IGNORE_CASE).containsMatchIn(url)) {
            return "$base/api/img?u=${enc(url)}&s=$s"
        }
        return null
    }

    private fun enc(v: String): String =
        URLEncoder.encode(v, StandardCharsets.UTF_8.name())
}
