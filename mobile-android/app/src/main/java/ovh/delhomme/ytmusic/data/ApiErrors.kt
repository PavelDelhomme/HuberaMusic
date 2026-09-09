package ovh.delhomme.ytmusic.data

import retrofit2.HttpException
import java.net.SocketTimeoutException

/** Lit `{ "error": "…" }` renvoyé par l’API au lieu du seul « HTTP 400 ». */
fun Throwable.apiMessage(): String {
    if (!NetworkMonitor.isOnline()) {
        return "Hors ligne — reconnecte le réseau"
    }
    if (this is SocketTimeoutException ||
        (this is java.io.IOException && (message ?: "").contains("timeout", ignoreCase = true))
    ) {
        return "Délai dépassé — réessaie dans un instant"
    }
    if (this is HttpException) {
        when (code()) {
            401, 403 -> return "Session expirée — reconnecte-toi dans Compte"
            in 500..599 -> return "Serveur indisponible (${code()}) — réessaie"
        }
        val raw = runCatching { response()?.errorBody()?.string().orEmpty() }.getOrDefault("")
        val fromJson = Regex(""""error"\s*:\s*"((?:\\.|[^"\\])*)"""")
            .find(raw)
            ?.groupValues
            ?.getOrNull(1)
            ?.replace("\\\"", "\"")
            ?.replace("\\n", "\n")
            ?.trim()
        if (!fromJson.isNullOrBlank()) return fromJson
        if (raw.isNotBlank() && raw.length < 400 && !raw.trimStart().startsWith('<')) return raw.trim()
        return message() ?: "Erreur HTTP ${code()}"
    }
    val m = message?.takeIf { it.isNotBlank() } ?: return toString()
    return when {
        m.contains("Unable to resolve host", ignoreCase = true) ||
            m.contains("Failed to connect", ignoreCase = true) ->
            "Réseau indisponible — vérifie la connexion"
        else -> m
    }
}
