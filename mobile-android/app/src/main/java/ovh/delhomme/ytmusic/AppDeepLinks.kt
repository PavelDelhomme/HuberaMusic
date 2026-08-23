package ovh.delhomme.ytmusic

import android.net.Uri

/**
 * Liens https://ytmusic.delhomme.ovh/… (et schéma ytmusic://) → navigation in-app.
 * Sans app installée, le navigateur ouvre la page web normalement.
 */
sealed class AppDeepLink {
    data class Watch(val trackId: String) : AppDeepLink()
    data class Detail(val kind: String, val id: String) : AppDeepLink()
    data object Library : AppDeepLink()
    data object Search : AppDeepLink()
    data object Home : AppDeepLink()
    data object Explore : AppDeepLink()
    data object Profile : AppDeepLink()
}

object AppDeepLinks {
    private val APP_HOSTS = setOf(
        "ytmusic.delhomme.ovh",
        "ytmusic-preprod.delhomme.ovh",
        "www.ytmusic.delhomme.ovh",
    )

    fun isOurHost(host: String?): Boolean {
        val h = host?.lowercase()?.trim().orEmpty()
        return h in APP_HOSTS || h.endsWith(".delhomme.ovh") && h.contains("ytmusic")
    }

    fun parse(uri: Uri?): AppDeepLink? {
        if (uri == null) return null
        val scheme = uri.scheme?.lowercase().orEmpty()
        return when (scheme) {
            "https", "http" -> parseHttps(uri)
            "ytmusic" -> parseCustom(uri)
            else -> null
        }
    }

    private fun parseHttps(uri: Uri): AppDeepLink? {
        if (!isOurHost(uri.host)) return null
        // login-device géré à part (DeviceLoginDeepLink)
        if (uri.path?.startsWith("/login-device") == true) return null
        return parsePath(uri.path.orEmpty(), uri)
    }

    private fun parseCustom(uri: Uri): AppDeepLink? {
        // ytmusic://login-device → DeviceLogin
        if (uri.host.equals("login-device", ignoreCase = true)) return null
        // ytmusic://watch/<id>  ou  ytmusic://open/watch/<id>
        val host = uri.host?.lowercase().orEmpty()
        val segs = uri.pathSegments.orEmpty().filter { it.isNotBlank() }
        if (host in setOf("watch", "artist", "album", "playlist", "mix", "library", "search", "explore", "profile", "home")) {
            return when (host) {
                "watch" -> segs.firstOrNull()?.let { AppDeepLink.Watch(it) }
                "artist", "album", "playlist", "mix" -> segs.firstOrNull()?.let { AppDeepLink.Detail(host, it) }
                "library" -> AppDeepLink.Library
                "search" -> AppDeepLink.Search
                "explore" -> AppDeepLink.Explore
                "profile" -> AppDeepLink.Profile
                "home" -> AppDeepLink.Home
                else -> null
            }
        }
        if (host == "open" || host.isEmpty()) {
            return parsePath("/" + segs.joinToString("/"), uri)
        }
        return null
    }

    private fun parsePath(rawPath: String, uri: Uri): AppDeepLink? {
        val path = rawPath.trimEnd('/').ifBlank { "/" }
        val parts = path.trim('/').split('/').filter { it.isNotBlank() }
        if (parts.isEmpty()) return AppDeepLink.Home
        return when (parts[0].lowercase()) {
            "watch" -> parts.getOrNull(1)?.takeIf { it.length >= 6 }?.let { AppDeepLink.Watch(it) }
            "artist" -> parts.getOrNull(1)?.let { AppDeepLink.Detail("artist", it) }
            "album" -> parts.getOrNull(1)?.let { AppDeepLink.Detail("album", it) }
            "playlist", "local-playlist" -> parts.getOrNull(1)?.let { AppDeepLink.Detail("playlist", it) }
            "mix", "mood" -> parts.getOrNull(1)?.let { AppDeepLink.Detail("mix", it) }
            "library", "offline", "import" -> AppDeepLink.Library
            "search" -> AppDeepLink.Search
            "explore" -> AppDeepLink.Explore
            "profile", "account", "admin" -> AppDeepLink.Profile
            "install" -> AppDeepLink.Home
            else -> {
                // ?v=ID style
                uri.getQueryParameter("v")?.takeIf { it.length == 11 }?.let { AppDeepLink.Watch(it) }
            }
        }
    }
}
