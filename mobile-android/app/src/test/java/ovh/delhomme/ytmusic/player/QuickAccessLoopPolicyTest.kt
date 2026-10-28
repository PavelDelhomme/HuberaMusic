package ovh.delhomme.ytmusic.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QuickAccessLoopPolicyTest {
    private val pins = listOf(
        "aaaaaaaaaaa" to true,
        "bbbbbbbbbbb" to true,
        "short" to true,
        "ccccccccccc" to false,
        "ddddddddddd" to true,
    )

    @Test
    fun playAndShuffleStayOnPlayablePins() {
        val ids = QuickAccessLoopPolicy.playbackIds(pins)
        assertEquals(listOf("aaaaaaaaaaa", "bbbbbbbbbbb", "ddddddddddd"), ids)
        val shuffled = ids.shuffled(kotlin.random.Random(7))
        assertTrue(QuickAccessLoopPolicy.isPinPermutation(shuffled, ids))
        assertFalse(QuickAccessLoopPolicy.isPinPermutation(ids + "eeeeeeeeeee", ids))
        assertFalse(QuickAccessLoopPolicy.isPinPermutation(ids.drop(1), ids))
    }

    @Test
    fun followingAndSimilarStayOutsideThePinLoop() {
        assertFalse(QuickAccessLoopPolicy.acceptsFollowing("pins"))
        assertFalse(QuickAccessLoopPolicy.acceptsFollowing("album", pinLoop = true))
        assertFalse(QuickAccessLoopPolicy.acceptsSimilarIntoLoop("pins"))
        assertTrue(QuickAccessLoopPolicy.acceptsFollowing("album"))
        assertTrue(QuickAccessLoopPolicy.acceptsFollowing(null))
        assertTrue(QuickAccessLoopPolicy.acceptsSimilarIntoLoop("radio"))
    }
}
