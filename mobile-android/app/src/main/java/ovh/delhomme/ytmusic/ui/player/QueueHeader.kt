package ovh.delhomme.ytmusic.ui.player

import ovh.delhomme.ytmusic.player.PlayerUiState

data class QueueHeaderLabels(
    val caption: String,
    val title: String,
)

/** Libellé file d’attente — pas « Mix » sauf radio/mix explicite. */
fun queueHeaderLabels(ui: PlayerUiState): QueueHeaderLabels {
    val qt = ui.queueTitle.ifBlank { "File d'attente" }
    val kind = ui.sourceKind?.lowercase()
    val mixFromTitle = qt.startsWith("Mix à partir de", ignoreCase = true)
    return when {
        kind == "radio" || mixFromTitle -> {
            val seed = Regex("«\\s*(.+?)\\s*»").find(qt)?.groupValues?.getOrNull(1)?.trim()
            QueueHeaderLabels(
                caption = "Mix à partir de",
                title = seed?.takeIf { it.isNotBlank() } ?: ui.track?.title?.takeIf { it.isNotBlank() } ?: qt,
            )
        }
        kind == "mix" -> QueueHeaderLabels("Mix", qt)
        kind == "album" -> QueueHeaderLabels("Album", qt)
        kind == "artist" -> QueueHeaderLabels("Artiste", qt)
        qt != "File d'attente" -> QueueHeaderLabels("File d'attente", qt)
        else -> QueueHeaderLabels("File d'attente", qt)
    }
}

/** Titre court pour [PlayerController.play] depuis un headline biblio (sans compteurs). */
fun libraryQueueTitle(headline: String): String =
    headline.substringBefore(" · ").trim().ifBlank { headline.trim() }
