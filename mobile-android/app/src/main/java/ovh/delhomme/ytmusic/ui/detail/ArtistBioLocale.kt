package ovh.delhomme.ytmusic.ui.detail

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.Normalizer
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * La fiche artiste arrive avec le texte déjà connu (souvent en anglais).
 * Si le téléphone est dans une autre langue et qu’une page Wikipédia correspond,
 * on remplace ensuite. Un échec laisse le texte d’origine.
 */
object ArtistBioLocale {
    private val cache = ConcurrentHashMap<String, String>()

    fun languageCode(locale: Locale = Locale.getDefault()): String {
        val lang = locale.language.lowercase(Locale.ROOT)
        return if (lang == "iw") "he" else lang
    }

    fun accepts(
        artistName: String,
        current: String,
        title: String,
        shortDescription: String,
        extract: String,
        type: String,
    ): Boolean {
        if (type != "standard") return false
        val bio = extract.trim()
        if (bio.length < 40) return false
        if (bio.equals(current.trim(), ignoreCase = true)) return false
        val name = fold(artistName)
        val page = fold(title)
        if (name.length < 2) return false
        val samePage = page == name || page.startsWith("$name ") || page.startsWith("$name (")
        if (!samePage) return false
        if (!fold(bio).contains(name)) return false
        if (looksMusical(current) && !looksMusical("$shortDescription $bio")) return false
        return true
    }

    /** null = garder le texte déjà affiché. */
    fun localized(
        artistName: String,
        current: String,
        lang: String = languageCode(),
    ): String? {
        val name = artistName.trim()
        val source = current.trim()
        if (name.isEmpty() || source.isEmpty()) return null
        if (lang.isBlank() || lang == "en" || lang == "und") return null
        if (lang == "fr" && alreadyFrench(source)) return null
        val key = "$lang\u0000${fold(name)}"
        cache[key]?.let { cached -> return cached.takeIf { it.isNotBlank() } }
        val encoded = URLEncoder.encode(name, "UTF-8").replace("+", "%20")
        val url = URL("https://$lang.wikipedia.org/api/rest_v1/page/summary/$encoded")
        val conn = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = 2_500
            readTimeout = 4_000
            instanceFollowRedirects = true
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "HuberaMusic (https://music.hubera.cloud)")
        }
        return try {
            if (conn.responseCode != 200) {
                cache[key] = ""
                return null
            }
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val json = JSONObject(body)
            val extract = json.optString("extract")
            if (!accepts(
                    name,
                    source,
                    json.optString("title"),
                    json.optString("description"),
                    extract,
                    json.optString("type"),
                )
            ) {
                cache[key] = ""
                return null
            }
            val text = extract.trim()
            cache[key] = text
            text
        } catch (_: Exception) {
            null
        } finally {
            conn.disconnect()
        }
    }

    private fun alreadyFrench(text: String): Boolean {
        val f = fold(text)
        val french = listOf("chanteur", "chanteuse", "est un ", "est une ", "auteur-compositeur")
        val english = listOf("better known", "singer", "songwriter", "is a ")
        return french.any { f.contains(it) } && english.none { f.contains(it) }
    }

    private fun looksMusical(text: String): Boolean {
        val f = fold(text)
        return listOf(
            "singer", "rapper", "songwriter", "producer", "musician", "band",
            "chanteur", "chanteuse", "rappeur", "rappeuse", "auteur", "compositeur",
            "musicien", "musicienne", "groupe", "interprete", "producteur",
        ).any { f.contains(it) }
    }

    private fun fold(value: String): String =
        Normalizer.normalize(value, Normalizer.Form.NFD)
            .replace(Regex("\\p{M}+"), "")
            .lowercase(Locale.ROOT)
            .trim()
}
