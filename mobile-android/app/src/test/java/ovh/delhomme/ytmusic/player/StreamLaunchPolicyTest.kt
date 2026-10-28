package ovh.delhomme.ytmusic.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StreamLaunchPolicyTest {
    @Test
    fun launchWaitsUntilCurrentHeadIsReady() {
        assertFalse(
            StreamLaunchPolicy.mayStartUpcoming(
                currentReady = false,
                currentLoading = true,
            ),
        )
        assertEquals(
            0,
            StreamLaunchPolicy.upcomingCount(
                requestedAhead = 8,
                currentReady = false,
                currentLoading = false,
                playbackActive = false,
            ),
        )
        assertEquals(
            0,
            StreamLaunchPolicy.upcomingCount(
                requestedAhead = 4,
                currentReady = true,
                currentLoading = true,
                playbackActive = true,
            ),
        )
    }

    @Test
    fun quietBlocksUpcomingSoCurrentKeepsTheBandwidth() {
        assertFalse(
            StreamLaunchPolicy.mayStartUpcoming(
                currentReady = true,
                currentLoading = false,
                quiet = true,
            ),
        )
        assertEquals(
            0,
            StreamLaunchPolicy.upcomingCount(
                requestedAhead = 6,
                currentReady = true,
                currentLoading = false,
                playbackActive = true,
                quiet = true,
            ),
        )
    }

    @Test
    fun warmPlaybackPrefetchesOnePrefixNotABurst() {
        assertEquals(
            1,
            StreamLaunchPolicy.upcomingCount(
                requestedAhead = 8,
                currentReady = true,
                currentLoading = false,
                playbackActive = true,
            ),
        )
        assertEquals(StreamLaunchPolicy.WARM_PREFIX_AHEAD, 1)
        assertFalse(StreamLaunchPolicy.allowFullFileDownload(playbackActive = true))
        assertTrue(StreamLaunchPolicy.allowFullFileDownload(playbackActive = false))
    }
}
