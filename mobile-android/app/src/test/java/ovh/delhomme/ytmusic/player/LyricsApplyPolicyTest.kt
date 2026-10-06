package ovh.delhomme.ytmusic.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LyricsApplyPolicyTest {
    @Test
    fun blankDoesNotReplaceSyncedCache() {
        assertFalse(LyricsApplyPolicy.shouldReplaceCachedLyrics(""))
        assertFalse(LyricsApplyPolicy.shouldReplaceCachedLyrics(null))
        assertFalse(LyricsApplyPolicy.shouldReplaceCachedLyrics("ok"))
        assertTrue(LyricsApplyPolicy.shouldReplaceCachedLyrics("Couplet un\nCouplet deux"))
    }

    @Test
    fun coldTrackWaitsForYtdlp() {
        assertEquals(55_000L, LyricsApplyPolicy.COLD_GRACE_MS)
        assertTrue(LyricsApplyPolicy.COLD_GRACE_MS >= 40_000L)
    }
}
