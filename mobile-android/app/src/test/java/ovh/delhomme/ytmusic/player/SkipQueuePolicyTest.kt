package ovh.delhomme.ytmusic.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Régression : bouton Précédent (titre d’avant, pas restart Media3 à 3 s).
 */
class SkipQueuePolicyTest {

    @Test
    fun prev_midQueue_goesToImmediatePredecessor() {
        assertEquals(4, resolvePreviousQueueIndex(curExo = 5, exoCount = 20, holderIndex = 5, holderQueueSize = 20))
    }

    @Test
    fun prev_atExoZero_wrapsWithinExoWindow() {
        assertEquals(9, resolvePreviousQueueIndex(curExo = 0, exoCount = 10, holderIndex = 0, holderQueueSize = 10))
    }

    @Test
    fun prev_singleTrack_returnsNull_forRestart() {
        assertNull(resolvePreviousQueueIndex(curExo = 0, exoCount = 1, holderIndex = 0, holderQueueSize = 1))
    }

    @Test
    fun prev_exoWindowStart_usesHolderWhenQueueLarger() {
        // Exo index 0 mais file logique à l’index 40 → précédent logique 39
        assertEquals(39, resolvePreviousQueueIndex(curExo = 0, exoCount = 1, holderIndex = 40, holderQueueSize = 80))
    }

    @Test
    fun prevTarget_neverStaysOnCurrentWhenPrevExists() {
        assertEquals(3, resolvePrevSkipTarget(cur = 4, askedPrev = 3, pickReady = 4))
        assertEquals(2, resolvePrevSkipTarget(cur = 4, askedPrev = 3, pickReady = 2))
        assertEquals(3, resolvePrevSkipTarget(cur = 4, askedPrev = 3, pickReady = 3))
    }

    @Test
    fun prevTarget_alone_stays() {
        assertEquals(0, resolvePrevSkipTarget(cur = 0, askedPrev = 0, pickReady = 0))
    }
}
