package ovh.delhomme.ytmusic.player

import kotlinx.coroutines.CancellationException

/**
 * Une coroutine UI (LaunchedEffect / viewModelScope) qui se termine ne doit
 * pas faire passer le titre pour « cassé ». Le resolve / play vit dans le
 * scope service ou application.
 */
object CancellationPolicy {
    fun isScopeCancellation(t: Throwable?): Boolean {
        var cur = t
        while (cur != null) {
            if (cur is CancellationException) return true
            val m = cur.message.orEmpty()
            if (m.contains("left the scope", ignoreCase = true)) return true
            if (m.contains("Job was cancelled", ignoreCase = true)) return true
            cur = cur.cause
        }
        return false
    }

    /** runCatching avale CancellationException — à relancer systématiquement. */
    fun rethrowIfCancelled(t: Throwable) {
        if (isScopeCancellation(t)) {
            if (t is CancellationException) throw t
            throw CancellationException(t.message).initCause(t)
        }
    }
}
