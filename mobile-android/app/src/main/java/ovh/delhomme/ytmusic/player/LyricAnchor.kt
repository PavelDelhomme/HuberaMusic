package ovh.delhomme.ytmusic.player

import kotlin.math.abs

/** Place la ligne en cours dans le bloc de paroles, au-dessus du milieu. */
object LyricAnchor {
    /** Centre visé de la ligne. Au-dessus du milieu : la suite reste visible. */
    const val CENTER_FRACTION = 0.38f
    const val COMFORT_FRACTION = 0.07f

    fun desiredTopPx(viewportH: Int, lineH: Int): Int {
        val view = viewportH.coerceAtLeast(1)
        val line = lineH.coerceAtLeast(1)
        val center = (view * CENTER_FRACTION).toInt()
        val maxTop = (view - line).coerceAtLeast(0)
        return (center - line / 2).coerceIn(0, maxTop)
    }

    fun shouldRecenter(itemOffset: Int, lineH: Int, viewportH: Int): Boolean {
        val top = desiredTopPx(viewportH, lineH)
        val slack = (viewportH.coerceAtLeast(1) * COMFORT_FRACTION).toInt().coerceAtLeast(16)
        return abs(itemOffset - top) > slack
    }
}
