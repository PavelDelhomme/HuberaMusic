package ovh.delhomme.ytmusic.player

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LocalPlaybackPolicyTest {
    private val local = "file:///data/user/0/cloud.hubera.music/files/offline/dEaDvideo01.m4a"
    private val http = "https://music.hubera.cloud/api/stream/dEaDvideo01"

    @Test
    fun keepsFileSchemeAndPath() {
        assertTrue(LocalPlaybackPolicy.shouldKeepLocalFileUri("file"))
        assertTrue(LocalPlaybackPolicy.shouldKeepLocalFileUri(local))
        assertTrue(LocalPlaybackPolicy.shouldKeepLocalFileUri("/data/user/0/x/files/offline/abc.mp4"))
        assertFalse(LocalPlaybackPolicy.shouldKeepLocalFileUri(http))
        assertFalse(LocalPlaybackPolicy.shouldKeepLocalFileUri("http"))
        assertFalse(LocalPlaybackPolicy.shouldKeepLocalFileUri(null))
    }

    @Test
    fun seekToStartPromotesHttpItemToLocalFile() {
        // Régression lab 361 : 43 DL, seek-to-start → BUFFERING 0:00 (URI HTTP / SimpleCache).
        assertEquals(local, LocalPlaybackPolicy.uriAfterSeek(http, local))
        assertEquals(local, LocalPlaybackPolicy.uriAfterSeek(local, local))
        assertEquals(http, LocalPlaybackPolicy.uriAfterSeek(http, null))
    }

    @Test
    fun neverRebindLocalOrOfflineToProxy() {
        assertFalse(LocalPlaybackPolicy.allowRemoteRebind("file", hasLocalFile = true))
        assertFalse(LocalPlaybackPolicy.allowRemoteRebind(http, hasLocalFile = true))
        assertFalse(LocalPlaybackPolicy.allowRemoteRebind(local, hasLocalFile = false))
        assertTrue(LocalPlaybackPolicy.allowRemoteRebind(http, hasLocalFile = false))
        assertFalse(
            LocalPlaybackPolicy.shouldEscalateLocalStallToRemote(
                isLocal = true,
                hasLocalFile = true,
                offline = true,
            ),
        )
        assertFalse(
            LocalPlaybackPolicy.shouldEscalateLocalStallToRemote(
                isLocal = false,
                hasLocalFile = true,
                offline = false,
            ),
        )
    }

    @Test
    fun endedOrIdleNeedsPrepareAfterSeekToStart() {
        assertTrue(LocalPlaybackPolicy.needsPrepareAfterSeek(1))
        assertTrue(LocalPlaybackPolicy.needsPrepareAfterSeek(4))
        assertFalse(LocalPlaybackPolicy.needsPrepareAfterSeek(3))
    }

    @Test
    fun clipDoesNotShareAudioSimpleCache() {
        assertTrue(ClipPlaybackPolicy.USE_TEXTURE_VIEW)
        assertFalse(ClipPlaybackPolicy.shouldUseSimpleCacheForClip(http))
        assertFalse(ClipPlaybackPolicy.shouldUseSimpleCacheForClip(local))
        assertTrue(ClipPlaybackPolicy.clipOwnsTimeline(videoMode = true, musicDucked = true))
        assertFalse(ClipPlaybackPolicy.clipOwnsTimeline(videoMode = true, musicDucked = false))
    }
}
