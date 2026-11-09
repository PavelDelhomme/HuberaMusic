package ovh.delhomme.ytmusic.ui

import ovh.delhomme.ytmusic.ui.components.HOLD_THRESHOLD_MS
import ovh.delhomme.ytmusic.ui.components.HOLD_TICK_MS
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Régression : un tap « un peu lent » ne doit pas devenir un hold
 * (sinon Précédent/Suivant sont avalés — retour Paul oct 2026).
 */
class HoldSeekThresholdTest {
    @Test
    fun holdThreshold_isAboveSlowTap() {
        // Un tap humain lent ~300–400 ms ; seuil ≥ 500 ms.
        assertTrue("HOLD_THRESHOLD_MS=$HOLD_THRESHOLD_MS", HOLD_THRESHOLD_MS >= 500L)
        assertTrue(HOLD_TICK_MS in 200L..400L)
    }
}
