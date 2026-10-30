package ovh.delhomme.ytmusic.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LyricAnchorTest {
    @Test
    fun uneLigneTropBasseRemonteVersLeCentre() {
        val viewport = 800
        val line = 80
        assertTrue(LyricAnchor.shouldRecenter(560, line, viewport))
        val top = LyricAnchor.desiredTopPx(viewport, line)
        assertTrue(top + line / 2 < viewport / 2)
        assertFalse(LyricAnchor.shouldRecenter(top, line, viewport))
    }
}
