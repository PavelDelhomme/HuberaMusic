package ovh.delhomme.ytmusic.data

import retrofit2.HttpException
import java.net.SocketTimeoutException

/** Lit `{ "error": "…" }` renvoyé par l’API au lieu du seul « HTTP 400 ». */
fun Throwable.apiMessage(): String {
    if (this is SocketTimeoutException ||
        (this is java.io.IOException && (message ?: "").contains("timeout", ignoreCase = true))
    ) {
        return "Sync trop longue. Le compte Google reste lié — l’import continue côté serveur."
    }
    if (this is HttpException) {
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
    return message?.takeIf { it.isNotBlank() } ?: toString()
}
