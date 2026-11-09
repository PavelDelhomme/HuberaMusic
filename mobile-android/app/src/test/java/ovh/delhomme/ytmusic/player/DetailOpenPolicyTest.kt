package ovh.delhomme.ytmusic.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DetailOpenPolicyTest {
    @Test
    fun albumFromPlayerIsADistinctPageAndClosesPlayer() {
        assertTrue(DetailOpenPolicy.isAlbumPage("album"))
        assertFalse(DetailOpenPolicy.isArtistPage("album"))
        assertTrue(DetailOpenPolicy.closesPlayer("album"))
    }

    @Test
    fun artistPageStaysArtistAndAlsoClosesPlayer() {
        assertTrue(DetailOpenPolicy.isArtistPage("artist"))
        assertFalse(DetailOpenPolicy.isAlbumPage("artist"))
        assertTrue(DetailOpenPolicy.closesPlayer("artist"))
    }

    @Test
    fun leakedTapDoesNotReopenPlayerDuringSuppressWindow() {
        val until = 10_000L
        assertTrue(DetailOpenPolicy.shouldIgnorePlayerReopen(10_000L - 1, until))
        assertFalse(DetailOpenPolicy.shouldIgnorePlayerReopen(10_000L, until))
        assertEquals(900L, DetailOpenPolicy.PLAYER_REOPEN_SUPPRESS_MS)
    }
}
