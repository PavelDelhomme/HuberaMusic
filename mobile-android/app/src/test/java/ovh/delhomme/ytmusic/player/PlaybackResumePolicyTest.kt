package ovh.delhomme.ytmusic.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PlaybackResumePolicyTest {
    private fun obs(
        playing: Boolean,
        readyToPlay: Boolean,
        phase: PlaybackPhase,
    ) = PlaybackObserve(playing, readyToPlay, phase)

    @Test
    fun effectivePlayIsReadyAndAudibleOnly() {
        assertTrue(
            PlaybackResumePolicy.isEffectivePlay(obs(true, true, PlaybackPhase.Ready)),
        )
        assertFalse(
            PlaybackResumePolicy.isEffectivePlay(obs(false, true, PlaybackPhase.Buffering)),
        )
        assertFalse(
            PlaybackResumePolicy.isEffectivePlay(obs(false, true, PlaybackPhase.Ready)),
        )
        assertFalse(
            PlaybackResumePolicy.isEffectivePlay(obs(false, true, PlaybackPhase.Failed)),
        )
        assertFalse(
            PlaybackResumePolicy.isEffectivePlay(obs(false, false, PlaybackPhase.Ready)),
        )
        assertFalse(
            PlaybackResumePolicy.isEffectivePlay(obs(false, false, PlaybackPhase.Idle)),
        )
    }

    @Test
    fun pauseDuringBufferOrLagStaysPausedOnForeground() {
        assertTrue(
            PlaybackResumePolicy.holdSilenceOnForeground(
                wasEffectivePlay = false,
                userPaused = true,
                now = obs(false, false, PlaybackPhase.Buffering),
            ),
        )
        assertTrue(
            PlaybackResumePolicy.holdSilenceOnForeground(
                wasEffectivePlay = true,
                userPaused = true,
                now = obs(false, false, PlaybackPhase.Ready),
            ),
        )
    }

    @Test
    fun silentBufferOrLoadFailureDoesNotRestart() {
        assertTrue(
            PlaybackResumePolicy.holdSilenceOnForeground(
                wasEffectivePlay = false,
                userPaused = false,
                now = obs(false, true, PlaybackPhase.Buffering),
            ),
        )
        assertTrue(
            PlaybackResumePolicy.holdSilenceOnForeground(
                wasEffectivePlay = true,
                userPaused = false,
                now = obs(false, true, PlaybackPhase.Failed),
            ),
        )
    }

    @Test
    fun audiblePlaybackIsLeftAlone() {
        assertFalse(
            PlaybackResumePolicy.holdSilenceOnForeground(
                wasEffectivePlay = true,
                userPaused = false,
                now = obs(true, true, PlaybackPhase.Ready),
            ),
        )
    }

    @Test
    fun userPauseBlocksAutoPlayUntilExplicitPlay() {
        PlaybackResume.noteUserPlay()
        PlaybackResume.noteUserPause()
        assertFalse(PlaybackResume.mayAutoPlay())
        val hold = PlaybackResume.onEnterForeground(
            obs(false, true, PlaybackPhase.Buffering),
        )
        assertTrue(hold)
        assertFalse(PlaybackResume.mayAutoPlay())
        PlaybackResume.noteUserPlay()
        assertTrue(PlaybackResume.mayAutoPlay())
    }

    @Test
    fun leavingDuringSilentLoadBlocksReturn() {
        PlaybackResume.noteUserPlay()
        PlaybackResume.onLeaveForeground(effective = false)
        assertFalse(PlaybackResume.mayAutoPlay())
        val hold = PlaybackResume.onEnterForeground(
            obs(false, true, PlaybackPhase.Buffering),
        )
        assertTrue(hold)
    }

    @Test
    fun leavingWhileAudibleAllowsContinue() {
        PlaybackResume.noteUserPlay()
        PlaybackResume.onLeaveForeground(effective = true)
        val hold = PlaybackResume.onEnterForeground(
            obs(true, true, PlaybackPhase.Ready),
        )
        assertFalse(hold)
        assertTrue(PlaybackResume.mayAutoPlay())
    }
}
